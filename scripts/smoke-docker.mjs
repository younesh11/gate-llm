// Uses disposable containers and a dedicated volume; never the user's Compose state.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const image = process.argv[2] ?? `gate-llm:${version}`;
const name = `gate-restart-${randomUUID()}`;
const contender = `${name}-contender`, volume = `${name}-data`;
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
const origin = () => {
  const ports = JSON.parse(docker('inspect', '--format', '{{json .NetworkSettings.Ports}}', name));
  return `http://127.0.0.1:${ports['4310/tcp'][0].HostPort}`;
};
try {
  docker('volume', 'create', volume);
  docker('run', '--detach', '--init', '--name', name, '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '-e', 'ALLOW_REMOTE_SETUP=true', '--publish', '127.0.0.1::4310', '--volume', `${volume}:/app/data`, image);
  await ready(origin());
  const setup = await fetch(`${origin()}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: 'Restart test', name: 'Owner', email: 'restart@example.test', password: 'synthetic-restart-password' }) });
  assert.equal(setup.status, 200);
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
  console.log(`Container restart passed; Node PID before/after: ${before.pid}/${starts.at(-1).pid}. State preserved and concurrent owner refused.`);
} finally {
  for (const container of [contender, name]) { try { docker('rm', '--force', container); } catch {} }
  try { docker('volume', 'rm', volume); } catch {}
}
