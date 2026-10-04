// Uses disposable containers and a dedicated volume; never the user's Compose state.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const image = process.argv[2] ?? `gate-llm:${version}`;
const name = `gate-restart-${randomUUID()}`;
const contender = `${name}-contender`, volume = `${name}-data`;
const backupVolume = `${name}-backup`, restoredVolume = `${name}-restored`, recovered = `${name}-recovered`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function ready(origin) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`${origin}/ready`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) { assert.equal((await response.json()).version, version); return; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Container did not become ready.');
}
const origin = (container = name) => {
  const ports = JSON.parse(docker('inspect', '--format', '{{json .NetworkSettings.Ports}}', container));
  return `http://127.0.0.1:${ports['4310/tcp'][0].HostPort}`;
};
try {
  docker('volume', 'create', volume);
  docker('run', '--detach', '--init', '--name', name, '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '-e', 'ALLOW_REMOTE_SETUP=true', '--publish', '127.0.0.1::4310', '--volume', `${volume}:/app/data`, image);
  await ready(origin());
  const setup = await fetch(`${origin()}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: 'Restart test', name: 'Owner', email: 'restart@example.test', password: 'synthetic-restart-password' }) });
  assert.equal(setup.status, 200);
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  const before = docker('logs', name).split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).find(row => row.event === 'gateway_started');
  assert.ok(before);
  assert.throws(() => docker('run', '--rm', '--init', '--name', contender, '--volume', `${volume}:/app/data`, image), error => error.status !== 0 && String(error.stderr).includes('already in use'));
  await ready(origin());
  docker('kill', '--signal=KILL', name);
  docker('start', name);
  await ready(origin());
  const session = await (await fetch(`${origin()}/api/session`)).json();
  assert.equal(session.setup, false, 'existing owner survives the restart');
  const starts = docker('logs', name).split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).filter(row => row.event === 'gateway_started');
  assert.equal(starts.length, 2);
  docker('stop', name);
  for (const item of [backupVolume, restoredVolume]) docker('volume', 'create', item);
  const maintenance = (...args) => JSON.parse(docker('run', '--rm', '--init', '--read-only', ...args));
  assert.equal(maintenance('--volume', `${volume}:/source`, '--volume', `${backupVolume}:/app/data`, image, 'backup', '--data-dir', '/source', '--output', '/app/data/snapshot').status, 'backup_created');
  assert.equal(maintenance('--volume', `${backupVolume}:/app/data:ro`, image, 'verify-backup', '--input', '/app/data/snapshot').status, 'backup_verified');
  assert.equal(maintenance('--volume', `${backupVolume}:/backups:ro`, '--volume', `${restoredVolume}:/app/data`, image, 'restore', '--input', '/backups/snapshot', '--data-dir', '/app/data/restored').status, 'backup_restored');
  const password = 'synthetic-recovered-password';
  const reset = execFileSync('docker', ['run', '--rm', '--init', '--read-only', '--interactive', '--volume', `${restoredVolume}:/app/data`, image, 'reset-password', '--data-dir', '/app/data/restored', '--email', 'restart@example.test', '--password-stdin'], { input: password + '\n', encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
  assert.equal(JSON.parse(reset).status, 'password_reset'); assert.ok(!reset.includes(password));
  docker('run', '--detach', '--init', '--name', recovered, '--read-only', '--publish', '127.0.0.1::4310', '--volume', `${restoredVolume}:/app/data`, image, 'serve', '--data-dir', '/app/data/restored');
  await ready(origin(recovered));
  assert.equal((await fetch(`${origin(recovered)}/api/admin/state`, { headers: { cookie } })).status, 401);
  const login = await fetch(`${origin(recovered)}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'restart@example.test', password }) });
  assert.equal(login.status, 200);
  console.log(`Container recovery passed; Node PID before/after: ${before.pid}/${starts.at(-1).pid}. Restart, ownership, backup, restore, session invalidation and password recovery verified.`);
} finally {
  for (const container of [contender, name, recovered]) { try { docker('rm', '--force', container); } catch {} }
  for (const item of [volume, backupVolume, restoredVolume]) { try { docker('volume', 'rm', item); } catch {} }
}
