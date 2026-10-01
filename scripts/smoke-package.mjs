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
  assert.equal((await (await fetch(`${origin}/api/session`)).json()).setup, true);
  const html = await (await fetch(origin)).text(); assert.ok(html.includes('id="root"'));
  const asset = html.match(/src="([^\"]+\.js)"/)[1]; assert.equal((await fetch(origin + asset)).status, 200);
  console.log('Packaged CLI, server, fresh setup, dashboard and assets pass from an unrelated working directory.');
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
  rmSync(directory, { recursive: true, force: true });
}
