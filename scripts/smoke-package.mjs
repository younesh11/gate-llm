import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const manifest = JSON.parse(readFileSync('artifacts/npm/manifest.json', 'utf8'));
const directory = mkdtempSync(join(tmpdir(), 'relay-package-'));
let child;
try {
  execFileSync('tar', ['-xzf', resolve('artifacts/npm', manifest.filename), '-C', directory]);
  const cli = join(directory, 'package/build/cli.js');
  assert.equal(execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8', cwd: tmpdir() }).trim(), manifest.version);
  child = spawn(process.execPath, [cli, 'serve', '--port', '0', '--data-dir', join(directory, 'state')], { cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
  const origin = await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(new Error('Packaged server startup timed out.')), 15000);
    child.stdout.on('data', chunk => { output += chunk; const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Packaged server exited: ${code}`)); });
    child.stderr.on('data', () => {});
  });
  assert.equal((await (await fetch(`${origin}/health`)).json()).version, manifest.version);
  assert.equal((await (await fetch(`${origin}/ready`)).json()).status, 'ready');
  assert.equal((await (await fetch(`${origin}/api/session`)).json()).setup, true);
  const html = await (await fetch(origin)).text(); assert.ok(html.includes('id="root"'));
  const asset = html.match(/src="([^\"]+\.js)"/)[1]; assert.equal((await fetch(origin + asset)).status, 200);
  const setup = await fetch(`${origin}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: 'Package test', name: 'Owner', email: 'package@example.test', password: 'synthetic-package-password' }) });
  assert.equal(setup.status, 200);
  await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
  const run = (args, input) => JSON.parse(execFileSync(process.execPath, [cli, ...args], { cwd: tmpdir(), encoding: 'utf8', input, timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }));
  assert.equal(run(['backup', '--data-dir', join(directory, 'state'), '--output', join(directory, 'backup')]).status, 'backup_created');
  assert.equal(run(['verify-backup', '--input', join(directory, 'backup')]).status, 'backup_verified');
  assert.equal(run(['restore', '--input', join(directory, 'backup'), '--data-dir', join(directory, 'restored')]).status, 'backup_restored');
  assert.equal(run(['reset-password', '--data-dir', join(directory, 'restored'), '--email', 'package@example.test', '--password-stdin'], 'synthetic-replacement-password\n').status, 'password_reset');
  console.log('Packaged CLI passes: server, setup, dashboard, backup verification, restore and password recovery from an unrelated working directory.');
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
  rmSync(directory, { recursive: true, force: true });
}
