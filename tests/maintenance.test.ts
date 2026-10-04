import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync, existsSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createApp } from '../server/app.ts';
import { Store, passwordMatches } from '../server/store.ts';
import { backupState, verifyBackup, restoreState, resetPassword, backupManifestFile, restoreMarkerFile } from '../server/maintenance.ts';

async function fixture(directory: string) {
  const { app, db } = await createApp({ directory, logLevel: 'silent' });
  try {
    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { workspace: 'Recovery test', name: 'Owner', email: 'owner@example.test', password: 'original-test-password' } });
    assert.equal(setup.statusCode, 200);
    const cookie = String(setup.headers['set-cookie']).split(';')[0];
    const create = async (path: string, payload: object) => {
      const response = await app.inject({ method: 'POST', url: `/api/admin/${path}`, headers: { cookie }, payload });
      assert.equal(response.statusCode, 200, response.body); return response.json();
    };
    const provider = await create('providers', { name: 'Synthetic provider', base_url: 'https://example.com/v1', api_key: 'synthetic-provider-secret' });
    await create('deployments', { provider_id: provider.id, alias: 'chat', upstream_model: 'synthetic-model', weight: 1, input_price: 0.2, output_price: 0.3 });
    const policy = await create('policies', { name: 'Secret protection', blocked_terms: ['private'], block_secrets: true, redact_pii: true });
    const key = await create('keys', { name: 'Recovery key', owner: 'Test', models: ['chat'], policy_id: policy.id, budget: 20, token_limit: 10000, rpm: 60, max_request_tokens: 2000 });
    db.run('UPDATE virtual_keys SET spent=200, reserved=100 WHERE id=?', key.id);
    db.recordUsage(key.id, '2026-10-04T00:00:00.000Z', 200, 40, 30, 10);
    db.run('INSERT INTO reservations (id,workspace_id,key_id,model,amount,created_at,token_amount) VALUES (?,?,?,?,?,?,?)', 'pending', 'default', key.id, 'chat', 100, '2026-10-04T00:00:00.000Z', 50);
    const viewer = await create('users', { name: 'Viewer', email: 'viewer@example.test', password: 'viewer-test-password', role: 'viewer' });
    // Account endpoints return the member; the extra session is useful for reset isolation.
    const viewerRow = db.get('SELECT id FROM users WHERE email=?', 'viewer@example.test')!;
    db.run('INSERT INTO sessions VALUES (?,?,?)', 'viewer-session-hash', viewerRow.id, Date.now() + 3600000);
    return { cookie, provider, policy, key, viewer };
  } finally { await app.close(); }
}

test('backup/restore retains configuration, credentials, usage and pending reservations, but clears browser sessions', async t => {
  const root = mkdtempSync(join(tmpdir(), 'gate-backup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'), backup = join(root, 'snapshot'), destination = join(root, 'restored');
  const { cookie, provider, policy, key } = await fixture(source);
  assert.equal(backupState(source, backup).status, 'backup_created');
  assert.equal(verifyBackup(backup).schema_version, 3);
  assert.deepEqual(readdirSync(backup).sort(), [backupManifestFile, 'encryption.key', 'relay.sqlite'].sort());
  if (process.platform !== 'win32') {
    assert.equal(statSync(backup).mode & 0o777, 0o700);
    for (const name of readdirSync(backup)) assert.equal(statSync(join(backup, name)).mode & 0o777, 0o600);
  }
  assert.throws(() => new Store(backup), /This is a backup/);
  verifyBackup(backup); // A mistaken server startup must not modify the snapshot.
  assert.equal(restoreState(backup, destination).status, 'backup_restored');
  assert.equal(existsSync(join(destination, restoreMarkerFile)), false);
  verifyBackup(backup);
  const { app, db } = await createApp({ directory: destination, logLevel: 'silent' });
  try {
    assert.equal((await app.inject({ url: '/api/admin/state', headers: { cookie } })).statusCode, 401);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM sessions')!.n, 0);
    const restored = db.get('SELECT * FROM virtual_keys WHERE id=?', key.id)!;
    assert.equal(restored.budget, 20000000); assert.equal(restored.token_limit, 10000);
    assert.equal(restored.spent, 300); assert.equal(restored.reserved, 0);
    assert.equal(db.limitSummary(restored).tokens_used, 90);
    assert.equal(restored.policy_id, policy.id);
    assert.equal(db.get('SELECT block_secrets FROM policies WHERE id=?', policy.id)!.block_secrets, 1);
    assert.equal(db.unseal(db.get('SELECT secret FROM providers WHERE id=?', provider.id)!.secret), 'synthetic-provider-secret');
    assert.equal(db.get('SELECT COUNT(*) AS n FROM audit WHERE action=?', 'backup.restore')!.n, 1);
    db.recoverReservations();
    assert.equal(db.get('SELECT spent FROM virtual_keys WHERE id=?', key.id)!.spent, 300);
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'owner@example.test', password: 'original-test-password' } });
    assert.equal(login.statusCode, 200);
  } finally { await app.close(); }
  const original = new Store(source);
  try {
    assert.equal(original.get('SELECT spent FROM virtual_keys WHERE id=?', key.id)!.spent, 200);
    assert.equal(original.get('SELECT COUNT(*) AS n FROM reservations')!.n, 1);
    assert.equal(original.get('SELECT COUNT(*) AS n FROM sessions')!.n, 2);
  } finally { original.close(); }
});

test('maintenance refuses live state, missing state, nested destinations, existing targets and incomplete restores', async t => {
  const root = mkdtempSync(join(tmpdir(), 'gate-maintenance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'), backup = join(root, 'backup');
  await fixture(source);
  const live = new Store(source);
  try {
    assert.throws(() => backupState(source, backup), /already in use/);
    assert.throws(() => resetPassword(source, 'owner@example.test', 'replacement-password'), /already in use/);
    assert.equal(existsSync(backup), false);
  } finally { live.close(); }
  assert.throws(() => backupState(source, join(source, 'nested')), /outside the source/);
  assert.throws(() => resetPassword(join(root, 'missing'), 'owner@example.test', 'replacement-password'), /ENOENT/);
  assert.equal(existsSync(join(root, 'missing')), false);
  backupState(source, backup);
  assert.throws(() => backupState(source, backup), /EEXIST/);
  const before = readFileSync(join(source, 'relay.sqlite'));
  assert.throws(() => restoreState(backup, source), /EEXIST/);
  assert.deepEqual(readFileSync(join(source, 'relay.sqlite')), before);
  const empty = join(root, 'empty'); mkdirSync(empty);
  assert.throws(() => restoreState(backup, empty), /EEXIST/);
  const interrupted = join(root, 'interrupted'); mkdirSync(interrupted);
  writeFileSync(join(interrupted, restoreMarkerFile), 'interrupted');
  assert.throws(() => new Store(interrupted), /Restore is incomplete/);
  assert.equal(existsSync(join(interrupted, 'relay.sqlite')), false);
  assert.throws(() => backupState(interrupted, join(root, 'bad')), /Restore is incomplete/);
});

test('verification refuses corruption, incomplete snapshots, links, future schemas and mismatched encryption keys', async t => {
  const root = mkdtempSync(join(tmpdir(), 'gate-corrupt-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'), backup = join(root, 'backup');
  await fixture(source); backupState(source, backup);
  const manifestPath = join(backup, backupManifestFile), manifestText = readFileSync(manifestPath, 'utf8');
  const keyPath = join(backup, 'encryption.key'), key = readFileSync(keyPath);
  writeFileSync(keyPath, randomBytes(32));
  assert.throws(() => verifyBackup(backup), /checksum mismatch/);
  assert.throws(() => restoreState(backup, join(root, 'bad-target')), /checksum mismatch/);
  assert.equal(existsSync(join(root, 'bad-target')), false);
  const manifest = JSON.parse(manifestText);
  manifest.files['encryption.key'] = createHash('sha256').update(readFileSync(keyPath)).digest('hex');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => verifyBackup(backup), /cannot decrypt/);
  writeFileSync(keyPath, key); writeFileSync(manifestPath, manifestText);
  rmSync(keyPath); symlinkSync(join(source, 'encryption.key'), keyPath);
  assert.throws(() => verifyBackup(backup), /without symbolic or hard links/);
  rmSync(keyPath); writeFileSync(keyPath, key);
  writeFileSync(join(backup, 'relay.sqlite-wal'), 'unexpected');
  assert.throws(() => verifyBackup(backup), /unexpected files/);
  rmSync(join(backup, 'relay.sqlite-wal'));
  manifest.schema_version = 999; writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => verifyBackup(backup), /unsupported backup manifest/);
  rmSync(manifestPath);
  assert.throws(() => verifyBackup(backup), /Incomplete backup/);
  const db = new Store(source); db.db.exec('PRAGMA user_version=999'); db.close();
  assert.throws(() => backupState(source, join(root, 'future')), /Unsupported database schema/);
  assert.throws(() => new Store(source), /schema is newer/);
});

test('password reset changes only the selected account, invalidates its sessions and commits with an audit event', async t => {
  const root = mkdtempSync(join(tmpdir(), 'gate-reset-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const { cookie } = await fixture(source);
  assert.throws(() => resetPassword(source, 'owner@example.test', 'too-short'), /12–200/);
  assert.throws(() => resetPassword(source, 'unknown@example.test', 'replacement-password'), /Account not found/);
  assert.equal(resetPassword(source, ' OWNER@example.test ', 'replacement-password').sessions_invalidated, 1);
  const { app, db } = await createApp({ directory: source, logLevel: 'silent' });
  try {
    assert.equal(db.get('SELECT COUNT(*) AS n FROM sessions')!.n, 1);
    assert.ok(db.get('SELECT * FROM sessions WHERE token_hash=?', 'viewer-session-hash'));
    assert.equal(db.get('SELECT role FROM users WHERE email=?', 'owner@example.test')!.role, 'owner');
    assert.equal(db.get('SELECT COUNT(*) AS n FROM audit WHERE action=?', 'account.password_reset')!.n, 1);
    assert.ok(!JSON.stringify(db.all('SELECT * FROM audit')).includes('replacement-password'));
    assert.equal((await app.inject({ url: '/api/admin/state', headers: { cookie } })).statusCode, 401);
    for (const [password, status] of [['original-test-password', 401], ['replacement-password', 200]] as const) {
      assert.equal((await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'owner@example.test', password } })).statusCode, status);
    }
  } finally { await app.close(); }
});

test('failed audit write rolls back the password change and session revocation together', async t => {
  const root = mkdtempSync(join(tmpdir(), 'gate-reset-atomic-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'); await fixture(source);
  const db = new Store(source);
  db.db.exec("CREATE TRIGGER reject_reset BEFORE INSERT ON audit WHEN NEW.action='account.password_reset' BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END;");
  db.close();
  assert.throws(() => resetPassword(source, 'owner@example.test', 'replacement-password'), /synthetic audit failure/);
  const after = new Store(source);
  try {
    assert.ok(passwordMatches('original-test-password', after.get('SELECT password_hash FROM users WHERE email=?', 'owner@example.test')!.password_hash));
    assert.equal(after.get('SELECT COUNT(*) AS n FROM sessions')!.n, 2);
  } finally { after.close(); }
});

test('a restore failure leaves a persistent startup block and preserves the backup', async t => {
  const root = mkdtempSync(join(tmpdir(), 'gate-restore-failure-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'), backup = join(root, 'backup'), destination = join(root, 'partial');
  await fixture(source);
  const db = new Store(source);
  db.db.exec("CREATE TRIGGER reject_restore BEFORE INSERT ON audit WHEN NEW.action='backup.restore' BEGIN SELECT RAISE(ABORT, 'synthetic restore failure'); END;");
  db.close(); backupState(source, backup);
  assert.throws(() => restoreState(backup, destination), /synthetic restore failure/);
  assert.equal(existsSync(join(destination, restoreMarkerFile)), true);
  assert.throws(() => new Store(destination), /Restore is incomplete/);
  assert.throws(() => restoreState(backup, destination), /EEXIST/);
  verifyBackup(backup);
});

test('CLI stdin recovery never prints the password and rejects accidental noninteractive or multiline input', async t => {
  const root = mkdtempSync(join(tmpdir(), 'gate-reset-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'); await fixture(source);
  const base = ['--import', 'tsx', 'server/cli.ts', 'reset-password', '--data-dir', source, '--email', 'owner@example.test'];
  for (const input of ['secret-first-line\nsecret-second-line\n', 'x'.repeat(2048)]) {
    const result = spawnSync(process.execPath, [...base, '--password-stdin'], { input, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 1); assert.ok(!result.stderr.includes(input.slice(0, 15)));
  }
  const noPrompt = spawnSync(process.execPath, base, { encoding: 'utf8', timeout: 15000 });
  assert.equal(noPrompt.status, 1); assert.match(noPrompt.stderr, /interactive terminal/);
  const password = 'synthetic-cli-password';
  const result = spawnSync(process.execPath, [...base, '--password-stdin'], { input: password + '\n', encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'password_reset');
  assert.ok(!(result.stdout + result.stderr).includes(password));
});
