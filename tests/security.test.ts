import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createApp } from '../server/app.ts';
import { createUpstreamClient, isPrivateAddress, validateUpstream } from '../server/upstream.ts';

test('matched routes enforce owner permissions and CSRF for encoded administration URLs', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'gate-security-'));
  const { app, db } = await createApp({ directory, logLevel: 'silent' });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const rebindingSetup = await app.inject({ method: 'POST', url: '/api/setup', headers: { host: 'rebind.example.test', origin: 'http://rebind.example.test' }, payload: { workspace: 'Unexpected owner', name: 'Owner', email: 'intruder@example.test', password: 'synthetic-test-password' } });
  assert.equal(rebindingSetup.statusCode, 403);
  assert.equal(db.get('SELECT COUNT(*) AS count FROM users')!.count, 0);
  const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { workspace: 'Audit', name: 'Owner', email: 'owner@example.test', password: 'synthetic-test-password' } });
  const owner = String(setup.headers['set-cookie']).split(';')[0];
  assert.match(String(setup.headers['set-cookie']), /HttpOnly/);
  assert.match(String(setup.headers['set-cookie']), /SameSite=Strict/i);
  await app.inject({ method: 'POST', url: '/api/admin/users', headers: { cookie: owner }, payload: { name: 'Viewer', email: 'viewer@example.test', password: 'synthetic-test-password', role: 'viewer' } });
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'viewer@example.test', password: 'synthetic-test-password' } });
  const viewer = String(login.headers['set-cookie']).split(';')[0];
  const actions = [
    ['PUT', 'workspace'], ['POST', 'providers'], ['PUT', 'providers/missing'],
    ['POST', 'deployments'], ['PUT', 'deployments/missing'], ['POST', 'policies'],
    ['PUT', 'policies/missing'], ['POST', 'policies/test'], ['POST', 'keys'],
    ['PUT', 'keys/missing'], ['PATCH', 'keys/missing/policy'], ['POST', 'keys/missing/rotate'],
    ['POST', 'keys/missing/revoke'], ['POST', 'users'], ['DELETE', 'users/missing']
  ] as const;
  for (const prefix of ['/api/admin/', '/api/%61dmin/', '/%61pi/admin/']) {
    for (const [method, action] of actions) {
      const url = prefix + action;
      for (const [cookie, status] of [[viewer, 403], ['', 401]] as const) {
        const result = await app.inject({ method, url, headers: { cookie }, payload: { name: 'Unauthorized rename' } });
        assert.equal(result.statusCode, status, `${method} ${url}: ${result.body}`);
        assert.equal(result.headers['cache-control'], 'no-store');
      }
    }
    const read = await app.inject({ url: prefix + 'state', headers: { cookie: viewer } });
    assert.equal(read.statusCode, 200); assert.equal(read.headers['cache-control'], 'no-store');
    for (const origin of ['https://attacker.test', 'https://localhost:80', 'null', 'not a URL']) {
      const result = await app.inject({ method: 'PUT', url: prefix + 'workspace', headers: { cookie: owner, host: 'localhost:80', origin }, payload: { name: 'Cross-origin rename' } });
      assert.equal(result.statusCode, 403, `${prefix} with ${origin}`);
    }
  }
  assert.equal((await app.inject({ method: 'PUT', url: '/api/admin/workspace', headers: { cookie: owner, 'sec-fetch-site': 'cross-site' }, payload: { name: 'Cross-site rename' } })).statusCode, 403);
  assert.equal(db.get('SELECT name FROM workspaces WHERE id=?', 'default')!.name, 'Audit');
  const allowed = await app.inject({ method: 'PUT', url: '/api/%61dmin/workspace', headers: { cookie: owner, host: 'localhost:80', origin: 'http://localhost' }, payload: { name: 'Owner change' } });
  assert.equal(allowed.statusCode, 200, allowed.body);
  assert.equal(db.get('SELECT name FROM workspaces WHERE id=?', 'default')!.name, 'Owner change');
});

test('upstream validation handles alternate IP forms and always rejects cloud metadata', async () => {
  for (const value of ['127.0.0.1', '::ffff:7f00:1', '::ffff:127.0.0.1', '0:0:0:0:0:0:0:1', '::1', '::', '::127.0.0.1', 'fe80::1', 'fc00::1', '192.0.0.1', '2001:db8::1', '2002:7f00:1::', '64:ff9b::7f00:1', 'invalid']) assert.equal(isPrivateAddress(value), true, value);
  for (const value of ['8.8.8.8', '::ffff:808:808', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(value), false, value);
  for (const allowPrivate of [true, false]) {
    for (const host of ['169.254.169.254', '2852039166', '0xa9fea9fe', '[::ffff:169.254.169.254]', '[::ffff:a9fe:a9fe]', '[fd00:ec2::254]', '100.100.100.200', 'metadata.google.internal', 'metadata.google.internal.', 'metadata']) {
      await assert.rejects(validateUpstream(`https://${host}/v1`, allowPrivate), /metadata/, host);
    }
    await assert.rejects(validateUpstream('https://provider.example.test/v1', allowPrivate, async () => [{ address: '169.254.169.254', family: 4 }]), /metadata/);
  }
  await assert.rejects(validateUpstream('https://provider.example.test/v1', false, async () => [{ address: '8.8.8.8', family: 4 }, { address: '::ffff:7f00:1', family: 6 }]), /Private/);
  for (const url of ['file:///etc/passwd', 'https://user:password@example.test/v1', 'https://example.test/v1?key=secret', 'https://example.test/v1#fragment']) await assert.rejects(validateUpstream(url, true), /HTTP/);
});

test('DNS rebinding is rejected on the actual socket before contacting a private server', async t => {
  const server = createServer((_req, res) => res.end('private server'));
  let connections = 0, lookups = 0;
  server.on('connection', () => { connections++; });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const resolve = async () => [{ address: ++lookups === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }];
  const client = createUpstreamClient(false, resolve);
  t.after(async () => { await client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const url = `https://rebind.example.test:${port}/v1`;
  await validateUpstream(url, false, resolve);
  await assert.rejects(client.fetch(url, { signal: AbortSignal.timeout(2000) }));
  assert.equal(lookups, 2); assert.equal(connections, 0);
});

test('private opt-in keeps local models working while metadata and redirects remain blocked', async t => {
  let hits = 0, redirected = 0;
  const server = createServer((req, res) => {
    hits++;
    if (req.url === '/redirect') { res.writeHead(307, { Location: '/credential-trap' }); res.end(); return; }
    if (req.url === '/credential-trap') redirected++;
    res.end('OK');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const client = createUpstreamClient(true, async hostname => [{ address: hostname === 'metadata-alias.test' ? '169.254.169.254' : '127.0.0.1', family: 4 }]);
  t.after(async () => { await client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  assert.equal(await (await client.fetch(`http://local-model.test:${port}/v1`)).text(), 'OK');
  await assert.rejects(client.fetch(`http://local-model.test:${port}/redirect`, { headers: { Authorization: 'Bearer synthetic-secret' } }));
  await assert.rejects(client.fetch(`http://metadata-alias.test:${port}/v1`, { signal: AbortSignal.timeout(2000) }));
  assert.equal(hits, 2); assert.equal(redirected, 0);
});

test('PII inspection bounds work for adversarial maximum-length text', () => {
  // Run in a child so a regex regression is killed instead of stalling the suite.
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { inspectPolicy } from './server/guards.ts';
    const text = 'a.'.repeat(49000) + ' person@example.test';
    const result = inspectPolicy({ messages: [{ role: 'user', content: text }] }, { blocked_terms: [], block_secrets: true, redact_pii: true, pii_types: ['email', 'phone', 'us_ssn', 'credit_card'] });
    assert.equal(result.action, 'redact');
    assert.ok(result.body.messages[0].content.endsWith(' [EMAIL REDACTED]'));
  `], { timeout: 5000, encoding: 'utf8', cwd: new URL('..', import.meta.url) });
  assert.equal(result.error, undefined, 'PII inspection exceeded its bounded test deadline');
  assert.equal(result.status, 0, result.stderr);
});
