import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.ts';
import { Store } from '../server/store.ts';
import { parseLogLevel } from '../server/operations.ts';
import { backupState, restoreState } from '../server/maintenance.ts';

const fixture = fileURLToPath(new URL('./fixtures/lock-worker.ts', import.meta.url));
function worker(directory: string, seed = false) {
  const child = spawn(process.execPath, ['--import', 'tsx', fixture, directory, ...(seed ? ['seed'] : [])], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const ready = new Promise<{ origin: string }>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Worker startup timed out.')); }, 15000);
    let errors = '';
    child.stderr!.on('data', chunk => { errors += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Worker exited ${code}: ${errors}`)); });
    child.once('message', (message: any) => { clearTimeout(timer); resolve(message); });
  });
  return { child, ready };
}
async function stop(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Worker shutdown timed out.')); }, 10000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill(signal);
  });
}

test('a killed gateway releases its directory lock and recovers reservations once', { timeout: 30000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'gate-crash-'));
  const first = worker(directory, true);
  t.after(async () => { await stop(first.child, 'SIGKILL'); rmSync(directory, { recursive: true, force: true }); });
  const firstAddress = await first.ready;
  assert.equal((await fetch(`${firstAddress.origin}/ready`)).status, 200);
  const contender = worker(directory);
  await assert.rejects(contender.ready, /already in use/);
  await stop(first.child, 'SIGKILL');
  assert.equal(existsSync(join(directory, 'process.lock')), true, 'abrupt death leaves the marker');
  const snapshot = directory + '-backup', restored = directory + '-restored';
  t.after(() => { rmSync(snapshot, { recursive: true, force: true }); rmSync(restored, { recursive: true, force: true }); });
  assert.ok(readFileSync(join(directory, 'relay.sqlite-wal')).length > 0, 'crash leaves committed data in WAL');
  backupState(directory, snapshot); restoreState(snapshot, restored);
  const snapshotDb = new Store(restored);
  try {
    snapshotDb.recoverReservations();
    assert.equal(snapshotDb.get('SELECT spent FROM virtual_keys WHERE id=?', 'crash-key')!.spent, 400);
    assert.equal(snapshotDb.limitSummary(snapshotDb.get('SELECT * FROM virtual_keys WHERE id=?', 'crash-key')!).tokens_used, 3000);
  } finally { snapshotDb.close(); }
  // A recycled PID must not prevent a restart: the SQLite lock is authoritative.
  writeFileSync(join(directory, 'process.lock'), `GATE_SQLITE_LOCK_V1 ${process.pid} previous-container\n`);
  const second = worker(directory);
  try {
    const secondAddress = await second.ready;
    assert.equal((await fetch(`${secondAddress.origin}/ready`)).status, 200);
  } finally { await stop(second.child); }
  const db = new Store(directory);
  try {
    const key = db.get('SELECT * FROM virtual_keys WHERE id=?', 'crash-key')!;
    assert.equal(key.spent, 400); assert.equal(key.reserved, 0);
    assert.equal(db.limitSummary(key).tokens_used, 3000);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM reservations')!.count, 0);
    db.recoverReservations();
    assert.equal(db.get('SELECT spent FROM virtual_keys WHERE id=?', key.id)!.spent, 400);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM requests WHERE key_id=?', key.id)!.count, 1);
    assert.equal(db.get('SELECT estimated FROM requests WHERE key_id=?', key.id)!.estimated, 1);
  } finally { db.close(); }
});

test('failed storage initialization releases ownership and legacy owners remain protected', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gate-startup-'));
  try {
    writeFileSync(join(directory, 'process.lock'), String(process.pid));
    assert.throws(() => new Store(directory), /legacy process.lock/);
    assert.equal(readFileSync(join(directory, 'process.lock'), 'utf8'), String(process.pid));
    rmSync(join(directory, 'process.lock'));
    const initial = new Store(directory); initial.close();
    const key = readFileSync(join(directory, 'encryption.key'));
    writeFileSync(join(directory, 'encryption.key'), 'invalid');
    assert.throws(() => new Store(directory), /Invalid encryption key/);
    assert.equal(existsSync(join(directory, 'process.lock')), false);
    writeFileSync(join(directory, 'encryption.key'), key);
    const recovered = new Store(directory); recovered.close(); recovered.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('readiness checks storage separately from liveness and never caches a probe', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'gate-ready-'));
  const { app, db } = await createApp({ directory, logLevel: 'silent' });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const ready = await app.inject('/ready');
  assert.equal(ready.statusCode, 200); assert.equal(ready.json().status, 'ready');
  assert.equal(ready.headers['cache-control'], 'no-store');
  db.close();
  const failed = await app.inject('/ready');
  assert.equal(failed.statusCode, 503); assert.equal(failed.json().status, 'not_ready');
  assert.equal(failed.headers['cache-control'], 'no-store');
  assert.equal((await app.inject('/health')).statusCode, 200);
  assert.ok(!failed.body.includes(directory));
});

test('operational logs correlate requests without exposing untrusted payloads or errors', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'gate-logs-'));
  const lines: string[] = [];
  const { app } = await createApp({ directory, logDestination: { write: line => { lines.push(line); } } });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const sensitive = 'NEVER_LOG_THIS_PRIVATE_VALUE';
  app.get('/test-error/:id', async () => { throw new Error(sensitive); });
  const failed = await app.inject({ url: `/test-error/${sensitive}?key=${sensitive}`, headers: { authorization: `Bearer ${sensitive}`, cookie: `relay_session=${sensitive}`, 'x-request-id': sensitive } });
  assert.equal(failed.statusCode, 500);
  const requestId = failed.headers['x-request-id'];
  assert.match(String(requestId), /^[0-9a-f-]{36}$/);
  const payload = await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'synthetic@example.test', password: sensitive } });
  assert.equal(payload.statusCode, 401);
  await app.inject({ url: `/api/unknown/${sensitive}` });
  await app.inject({ method: 'POST', url: '/api/login', headers: { 'content-type': 'application/json' }, payload: `{"${sensitive}":` });
  const records = lines.map(line => JSON.parse(line));
  const correlated = records.filter(record => record.request_id === requestId);
  assert.ok(correlated.some(record => record.event === 'request_failed' && record.error.code === 'internal_error'));
  assert.ok(correlated.some(record => record.event === 'http_request_completed' && record.route === '/test-error/:id' && record.status === 500));
  assert.ok(!lines.join('').includes(sensitive));
  assert.ok(!lines.join('').includes('synthetic@example.test'));
  assert.equal(parseLogLevel(), 'info');
  assert.equal(parseLogLevel('silent'), 'silent');
  assert.throws(() => parseLogLevel(sensitive), error => error instanceof Error && !error.message.includes(sensitive));
});
