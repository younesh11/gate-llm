import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.ts';
import { mockProvider } from '../scripts/mock-provider.ts';
import { Store, hash, id, now } from '../server/store.ts';

test('gateway integration and security boundaries', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-test-'));
  const mock = mockProvider();
  await new Promise<void>(resolve => mock.server.listen(0, '127.0.0.1', resolve));
  const address = mock.server.address() as { port: number };
  const { app, db } = await createApp({ directory, allowPrivate: true, timeoutMs: 3000, random: () => 0 });
  t.after(async () => { await app.close(); await new Promise<void>(resolve => mock.server.close(() => resolve())); rmSync(directory, { recursive: true }); });
  const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { workspace: 'Test team', name: 'Owner', email: 'owner@example.test', password: 'test-password-long' } });
  assert.equal(setup.statusCode, 200, setup.body);
  const cookie = String(setup.headers['set-cookie']).split(';')[0];
  const admin = async (path: string, body?: any, method: any = body === undefined ? 'GET' : 'POST', session = cookie) => app.inject({ method, url: '/api/admin/' + path, headers: { cookie: session }, ...(body === undefined ? {} : { payload: body }) });
  const create = async (path: string, body: any) => { const response = await admin(path, body); assert.equal(response.statusCode, 200, response.body); return response.json(); };
  const secret = 'upstream-test-secret-not-public';
  const provider = await create('providers', { name: 'Test upstream', base_url: `http://127.0.0.1:${address.port}/v1`, api_key: secret });
  const deploy = (alias: string, upstream_model: string, price = 1) => create('deployments', { provider_id: provider.id, alias, upstream_model, weight: 1, input_price: price, output_price: price });
  const primary = await deploy('chat', 'fast');
  const policy = await create('policies', { name: 'Protected', blocked_terms: ['forbidden phrase'], redact_pii: true, block_secrets: true });
  const makeKey = (extra: any = {}) => create('keys', { name: 'Application', owner: 'Engineering', models: ['chat'], policy_id: policy.id, budget: 10, rpm: 100, max_request_tokens: 8192, ...extra });
  const key = await makeKey();
  const chat = (token: string, extra: any = {}, content = 'hello') => app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${token}` }, payload: { model: 'chat', max_tokens: 512, messages: [{ role: 'user', content }], ...extra } });

  await t.test('credentials are encrypted or hashed and administration requires its own session', async () => {
    const response = await app.inject({ url: '/api/admin/state' }); assert.equal(response.statusCode, 401);
    assert.equal((await app.inject({ url: '/api/admin/state', headers: { authorization: `Bearer ${key.token}` } })).statusCode, 401);
    const state = await admin('state'); assert.ok(!state.body.includes(secret)); assert.ok(!state.body.includes(key.token)); assert.ok(!state.body.includes('token_hash')); assert.ok(!state.body.includes('password_hash'));
    const providerRow = db.get('SELECT secret FROM providers WHERE id=?', provider.id)!;
    assert.notEqual(providerRow.secret, secret); assert.equal(db.unseal(providerRow.secret), secret);
    assert.equal(db.get('SELECT token_hash FROM virtual_keys WHERE id=?', key.id)!.token_hash, hash(key.token));
    assert.equal((await app.inject({ method: 'POST', url: '/api/setup', payload: {} })).statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/keys', headers: { cookie, origin: 'https://attacker.test', host: '127.0.0.1' }, payload: {} })).statusCode, 403);
  });
  await t.test('virtual keys scope models and tokens', async () => {
    assert.equal((await chat('rk_invalid')).statusCode, 401);
    assert.equal((await chat(key.token, { model: 'unauthorized-model' })).statusCode, 403);
    assert.equal((await chat(key.token, { max_tokens: 8192 })).statusCode, 400);
    assert.equal((await chat(key.token, { messages: [{ role: 'user', content: [{ type: 'image_url' }] }] })).statusCode, 400);
    const response = await chat(key.token); assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().model, 'chat');
    assert.equal(db.get('SELECT reserved FROM virtual_keys WHERE id=?', key.id)!.reserved, 0);
    assert.equal(db.get('SELECT spent FROM virtual_keys WHERE id=?', key.id)!.spent, 160);
  });
  await t.test('policies block before upstream and redact input without storing prompts', async () => {
    const before = mock.captured.length;
    assert.equal((await chat(key.token, {}, 'FORBIDDEN PHRASE')).statusCode, 422);
    assert.equal((await chat(key.token, {}, 'sk-abcdefghijklmnopqrstuvwxyz123456')).statusCode, 422);
    assert.equal(mock.captured.length, before);
    const response = await chat(key.token, {}, 'Reach me at private@example.com or 123-45-6789');
    assert.equal(response.statusCode, 200);
    assert.ok(!JSON.stringify(mock.captured.at(-1)).includes('private@example.com'));
    assert.ok(JSON.stringify(mock.captured.at(-1)).includes('[EMAIL REDACTED]'));
    assert.ok(!(await admin('state')).body.includes('private@example.com'));
  });
  await t.test('policy testing is private, validates input and has no upstream or accounting side effects', async () => {
    const snapshot = () => JSON.stringify(['requests', 'audit', 'reservations', 'usage_daily', 'rate_windows', 'policies'].map(table => db.all(`SELECT * FROM ${table}`)));
    const before = snapshot(), upstream = mock.captured.length;
    const draft = { blocked_terms: ['internal only'], block_secrets: true, redact_pii: true, pii_types: ['email', 'phone', 'credit_card'], term_match: 'word' };
    const blocked = await admin('policies/test', { policy: draft, text: 'gsk_' + 'x'.repeat(40) });
    assert.equal(blocked.statusCode, 200); assert.equal(blocked.json().action, 'block'); assert.equal(blocked.json().text, null);
    assert.ok(!blocked.body.includes('gsk_')); assert.equal(blocked.headers['cache-control'], 'no-store');
    const redacted = await admin('policies/test', { policy: draft, text: 'sample@example.com and +44 20 7946 0958' });
    assert.equal(redacted.json().text, '[EMAIL REDACTED] and [PHONE REDACTED]');
    assert.equal((await admin('policies/test', { policy: { ...draft, pii_types: ['invalid'] }, text: 'hello' })).statusCode, 400);
    assert.equal((await admin('policies/test', { policy: { ...draft, term_match: 'regex' }, text: 'hello' })).statusCode, 400);
    assert.equal((await admin('policies/test', { policy: draft, text: 'x'.repeat(20001) })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/policies/test', payload: { policy: draft, text: 'hello' } })).statusCode, 401);
    assert.equal(snapshot(), before); assert.equal(mock.captured.length, upstream);
  });
  await t.test('saved policies apply only to assigned keys and updates take effect on new requests', async () => {
    const draft = { name: 'Restricted local checks', blocked_terms: ['alpha'], term_match: 'word', block_secrets: true, redact_pii: true, pii_types: ['email', 'phone', 'credit_card'] };
    const saved = await create('policies', draft);
    const protectedKey = await makeKey({ policy_id: null }), otherKey = await makeKey({ policy_id: null });
    const before = db.get('SELECT * FROM virtual_keys WHERE id=?', protectedKey.id)!;
    assert.equal((await admin(`keys/${protectedKey.id}/policy`, { policy_id: saved.id }, 'PATCH')).statusCode, 200);
    assert.deepEqual({ ...db.get('SELECT * FROM virtual_keys WHERE id=?', protectedKey.id) }, { ...before, policy_id: saved.id });
    assert.equal((await chat(protectedKey.token, {}, 'alpha')).statusCode, 422);
    assert.equal(db.get('SELECT guardrail FROM requests WHERE key_id=? ORDER BY created_at DESC LIMIT 1', protectedKey.id)!.guardrail, 'blocked:term');
    assert.equal(db.get('SELECT COUNT(*) AS count FROM rate_windows WHERE key_id=?', protectedKey.id)!.count, 0);
    assert.equal((await chat(otherKey.token, {}, 'alpha')).statusCode, 200);
    assert.equal((await chat(protectedKey.token, {}, 'alphabet')).statusCode, 200);
    assert.equal((await chat(protectedKey.token, {}, '+44 20 7946 0958 / 4111 1111 1111 1111')).statusCode, 200);
    assert.equal(mock.captured.at(-1).messages[0].content, '[PHONE REDACTED] / [PAYMENT CARD REDACTED]');
    assert.equal((await admin(`policies/${saved.id}`, { ...draft, blocked_terms: ['beta'] }, 'PUT')).statusCode, 200);
    assert.equal((await chat(protectedKey.token, {}, 'beta')).statusCode, 422);
    assert.equal((await chat(protectedKey.token, {}, 'alpha')).statusCode, 200);
    assert.equal((await chat(protectedKey.token, { policy_id: null }, 'beta')).statusCode, 400);
    assert.equal((await chat(protectedKey.token, { stream: true }, 'gsk_' + 'x'.repeat(40))).statusCode, 422);
    assert.equal((await admin(`keys/${protectedKey.id}/policy`, { policy_id: null }, 'PATCH')).statusCode, 200);
    assert.equal((await chat(protectedKey.token, {}, 'beta')).statusCode, 200);
    const stored = (await admin('state')).json().policies.find((p: any) => p.id === saved.id);
    assert.deepEqual(stored.pii_types, draft.pii_types); assert.equal(stored.term_match, 'word');
    await admin(`keys/${protectedKey.id}/revoke`, {});
    assert.equal((await admin(`keys/${protectedKey.id}/policy`, { policy_id: saved.id }, 'PATCH')).statusCode, 400);
    assert.equal((await admin(`keys/missing/policy`, { policy_id: saved.id }, 'PATCH')).statusCode, 404);
  });
  await t.test('request limits count input and output and reject before upstream or accounting', async () => {
    const k = await makeKey({ max_request_tokens: 2000 });
    const before = mock.captured.length;
    for (const extra of [{ max_tokens: 1000 }, { max_tokens: 1, messages: [{ role: 'user', content: 'x'.repeat(2100) }] }, { max_total_tokens: 2001 }]) {
      const response = await chat(k.token, extra);
      assert.equal(response.statusCode, 400); assert.equal(response.json().error.code, 'request_token_limit_exceeded');
    }
    assert.equal(mock.captured.length, before);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM reservations WHERE key_id=?', k.id)!.count, 0);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM rate_windows WHERE key_id=?', k.id)!.count, 0);
    assert.equal((await chat(k.token, { max_tokens: 400 })).statusCode, 200);
    assert.equal(mock.captured.at(-1).max_tokens, 400);
  });
  await t.test('collective playground limits leave only remaining capacity for upstream output', async () => {
    const k = await makeKey({ max_request_tokens: 2200 });
    const response = await chat(k.token, { max_tokens: undefined, max_total_tokens: 2000, stream: true });
    assert.equal(response.statusCode, 200, response.body);
    const payload = mock.captured.at(-1);
    assert.ok(payload.max_tokens > 0 && payload.max_tokens < 1000);
    assert.ok(!('max_total_tokens' in payload));
    assert.equal((await chat(k.token, { max_tokens: undefined, max_completion_tokens: 400 })).statusCode, 200);
    assert.equal(mock.captured.at(-1).max_completion_tokens, 400);
    assert.ok(!('max_tokens' in mock.captured.at(-1)));
  });
  await t.test('streaming retains the protocol and settles reported usage', async () => {
    const response = await chat(key.token, { stream: true });
    assert.equal(response.statusCode, 200, response.body);
    assert.match(String(response.headers['content-type']), /text\/event-stream/);
    assert.ok(response.body.includes('data: [DONE]')); assert.ok(response.body.includes('completion_tokens'));
    assert.equal(db.get('SELECT reserved FROM virtual_keys WHERE id=?', key.id)!.reserved, 0);
  });
  await t.test('rotation preserves accounting and immediately invalidates the previous token', async () => {
    const row = await makeKey(); await chat(row.token);
    const spent = db.get('SELECT spent FROM virtual_keys WHERE id=?', row.id)!.spent;
    const rotated = await create(`keys/${row.id}/rotate`, {});
    assert.equal((await chat(row.token)).statusCode, 401); assert.equal((await chat(rotated.token)).statusCode, 200);
    assert.equal(db.get('SELECT spent FROM virtual_keys WHERE id=?', row.id)!.spent, spent + 160);
    await create(`keys/${row.id}/revoke`, {}); assert.equal((await chat(rotated.token)).statusCode, 401);
  });
  await t.test('rate limiting and expiry reject calls', async () => {
    const limited = await makeKey({ rpm: 1 }); assert.equal((await chat(limited.token)).statusCode, 200); assert.equal((await chat(limited.token)).statusCode, 429);
    db.run('UPDATE virtual_keys SET expires_at=? WHERE id=?', '2000-01-01T00:00:00.000Z', limited.id); assert.equal((await chat(limited.token)).statusCode, 401);
  });
  await t.test('budget reservation prevents concurrent overspend and insufficient requests never reach upstream', async () => {
    await deploy('expensive', 'slow', 10);
    const limited = await makeKey({ models: ['expensive'], budget: 0.03, max_request_tokens: 8192 });
    const results = await Promise.all([chat(limited.token, { model: 'expensive' }), chat(limited.token, { model: 'expensive' })]);
    assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 429]);
    assert.equal(db.get('SELECT reserved FROM virtual_keys WHERE id=?', limited.id)!.reserved, 0);
    const before = mock.captured.length;
    const tiny = await makeKey({ models: ['expensive'], budget: 0.01 });
    const response = await chat(tiny.token, { model: 'expensive' }); assert.equal(response.statusCode, 429); assert.equal(response.json().error.code, 'budget_exceeded'); assert.equal(mock.captured.length, before);
  });
  await t.test('explicit rate limits trigger fallback and cooldown', async () => {
    const first = await deploy('fallback', 'rate-limit'); await deploy('fallback', 'fast');
    const k = await makeKey({ models: ['fallback'] }); const before = mock.captured.length;
    const response = await chat(k.token, { model: 'fallback' }); assert.equal(response.statusCode, 200, response.body);
    assert.equal(mock.captured.length, before + 2);
    assert.ok(db.get('SELECT cooldown_until FROM deployments WHERE id=?', first.id)!.cooldown_until > Date.now());
    assert.equal(db.get('SELECT attempts FROM requests WHERE key_id=?', k.id)!.attempts, 2);
  });
  await t.test('ambiguous server failures are not replayed and retain a conservative charge', async () => {
    await deploy('failure', 'server-error'); await deploy('failure', 'fast');
    const k = await makeKey({ models: ['failure'] }); const before = mock.captured.length;
    assert.equal((await chat(k.token, { model: 'failure' })).statusCode, 502);
    assert.equal(mock.captured.length, before + 1);
    const log = db.get('SELECT * FROM requests WHERE key_id=?', k.id)!; assert.equal(log.estimated, 1); assert.ok(log.cost > 0); assert.equal(log.status, 'error');
  });
  await t.test('truncated streaming responses are surfaced and accounted for', async () => {
    await deploy('broken', 'broken-stream'); const k = await makeKey({ models: ['broken'] });
    const response = await chat(k.token, { model: 'broken', stream: true });
    assert.ok(response.body.includes('stream_interrupted')); assert.ok(!response.body.includes('[DONE]'));
    const log = db.get('SELECT * FROM requests WHERE key_id=?', k.id)!; assert.equal(log.status, 'error'); assert.equal(log.estimated, 1);
  });
  await t.test('viewer role reads metadata but cannot mutate, and removal invalidates sessions', async () => {
    await create('users', { name: 'Viewer', email: 'viewer@example.test', password: 'viewer-password-long', role: 'viewer' });
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'viewer@example.test', password: 'viewer-password-long' } });
    const viewerCookie = String(login.headers['set-cookie']).split(';')[0];
    assert.equal((await admin('state', undefined, 'GET', viewerCookie)).statusCode, 200);
    assert.equal((await admin('usage', undefined, 'GET', viewerCookie)).statusCode, 200);
    assert.equal((await admin('keys', {}, 'POST', viewerCookie)).statusCode, 403);
    assert.equal((await admin('policies/test', {}, 'POST', viewerCookie)).statusCode, 403);
    assert.equal((await admin(`keys/${key.id}/policy`, { policy_id: null }, 'PATCH', viewerCookie)).statusCode, 403);
    const viewer = db.get('SELECT id FROM users WHERE email=?', 'viewer@example.test')!;
    assert.equal((await admin(`users/${viewer.id}`, undefined, 'DELETE')).statusCode, 200);
    assert.equal((await admin('state', undefined, 'GET', viewerCookie)).statusCode, 401);
  });
  await t.test('workspace scope rejects references to another workspace', async () => {
    db.run('INSERT INTO workspaces VALUES (?,?)', 'other', 'Other');
    const foreign = id(); db.run('INSERT INTO policies (id,workspace_id,name,blocked_terms,redact_pii,block_secrets,created_at) VALUES (?,?,?,?,?,?,?)', foreign, 'other', 'Foreign', '[]', 0, 0, now());
    const response = await admin('keys', { name: 'Bad scope', owner: 'test', models: ['chat'], policy_id: foreign, budget: 10, rpm: 60, max_request_tokens: 8192 });
    assert.equal(response.statusCode, 400);
    assert.equal((await admin(`keys/${key.id}/policy`, { policy_id: foreign }, 'PATCH')).statusCode, 400);
    assert.equal((await admin(`policies/${foreign}`, { name: 'Tampered', blocked_terms: [], redact_pii: false, block_secrets: false }, 'PUT')).statusCode, 404);
  });
  await t.test('money and token allowances are independent gates on the same key', async () => {
    const tokenLimited = await makeKey({ budget: 100, token_limit: 1000 });
    const before = mock.captured.length;
    const tokenResponse = await chat(tokenLimited.token);
    assert.equal(tokenResponse.statusCode, 429); assert.equal(tokenResponse.json().error.code, 'token_quota_exceeded');
    const moneyLimited = await makeKey({ models: ['expensive'], budget: 0.01, token_limit: 1_000_000 });
    const moneyResponse = await chat(moneyLimited.token, { model: 'expensive' });
    assert.equal(moneyResponse.statusCode, 429); assert.equal(moneyResponse.json().error.code, 'budget_exceeded');
    assert.equal(mock.captured.length, before);
  });
  await t.test('free models still consume token quotas and streaming reconciles token reservations', async () => {
    await deploy('free-chat', 'fast', 0);
    const k = await makeKey({ models: ['free-chat'], budget: 10, token_limit: 4000, tpm: 5000 });
    const response = await chat(k.token, { model: 'free-chat', stream: true }); assert.equal(response.statusCode, 200);
    const current = db.get('SELECT * FROM virtual_keys WHERE id=?', k.id)!;
    const usage = db.limitSummary(current); assert.equal(usage.period_spent, 0); assert.equal(usage.tokens_used, 160); assert.equal(usage.tokens_reserved, 0);
    assert.equal(db.get('SELECT tokens FROM rate_windows WHERE key_id=?', k.id)!.tokens, 160);
    const zero = await makeKey({ models: ['free-chat'], budget: null, token_limit: 0 });
    assert.equal((await chat(zero.token, { model: 'free-chat' })).json().error.code, 'token_quota_exceeded');
  });
  await t.test('concurrent calls cannot reserve the same tokens twice', async () => {
    await deploy('quota-slow', 'slow', 0);
    const k = await makeKey({ models: ['quota-slow'], budget: 10, token_limit: 2000 });
    const results = await Promise.all([chat(k.token, { model: 'quota-slow' }), chat(k.token, { model: 'quota-slow' })]);
    assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 429]);
    assert.equal(results.find(r => r.statusCode === 429)!.json().error.code, 'token_quota_exceeded');
    const allocation = db.limitSummary(db.get('SELECT * FROM virtual_keys WHERE id=?', k.id)!);
    assert.equal(allocation.tokens_used, 160); assert.equal(allocation.tokens_reserved, 0);
  });
  await t.test('TPM is enforced separately from token quota and request rate', async () => {
    const k = await makeKey({ models: ['quota-slow'], token_limit: 1_000_000, tpm: 2000, rpm: 100 });
    const results = await Promise.all([chat(k.token, { model: 'quota-slow' }), chat(k.token, { model: 'quota-slow' })]);
    assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 429]);
    assert.equal(results.find(r => r.statusCode === 429)!.json().error.code, 'token_rate_limit_exceeded');
    assert.equal(db.get('SELECT requests FROM rate_windows WHERE key_id=?', k.id)!.requests, 1);
    assert.equal(db.get('SELECT tokens FROM rate_windows WHERE key_id=?', k.id)!.tokens, 160);
  });
  await t.test('calendar periods count current usage and reset both limits at UTC boundaries', async () => {
    const k = await makeKey({ models: ['free-chat'], budget: 1, token_limit: 5000, limit_period: 'monthly' });
    const date = new Date(), previous = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 0, 12)).toISOString();
    db.recordUsage(k.id, previous, 2_000_000, 10000); db.run('UPDATE virtual_keys SET spent=2000000 WHERE id=?', k.id);
    assert.equal((await chat(k.token, { model: 'free-chat' })).statusCode, 200);
    let current = db.get('SELECT * FROM virtual_keys WHERE id=?', k.id)!;
    assert.equal(db.limitSummary(current).period_spent, 0); assert.equal(db.limitSummary(current).tokens_used, 160);
    db.recordUsage(k.id, now(), 0, 5000);
    assert.equal((await chat(k.token, { model: 'free-chat' })).json().error.code, 'token_quota_exceeded');
    const nextMonth = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    assert.equal(db.limitSummary(current, nextMonth).tokens_used, 0); assert.equal(db.limitSummary(current, nextMonth).period_spent, 0);
    current = { ...current, limit_period: 'daily' };
    const tomorrow = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
    assert.equal(db.limitSummary(current, tomorrow).tokens_used, 0); assert.equal(db.limitSummary(current, tomorrow).period_spent, 0);
  });
  await t.test('switching allocation modes clears inactive caps without resetting usage', async () => {
    const k = await makeKey({ budget: 10, token_limit: 0 });
    assert.equal((await chat(k.token)).json().error.code, 'token_quota_exceeded');
    const update = async (budget: number | null, token_limit: number | null) => {
      const response = await admin(`keys/${k.id}`, { name: 'Allocation modes', owner: 'Engineering', models: ['chat'], policy_id: policy.id, budget, token_limit, rpm: 100, max_request_tokens: 8192 }, 'PUT');
      assert.equal(response.statusCode, 200, response.body);
      return db.get('SELECT * FROM virtual_keys WHERE id=?', k.id)!;
    };
    let current = await update(10, null);
    assert.equal(current.token_limit, null);
    assert.equal((await chat(k.token)).statusCode, 200);
    const spent = db.limitSummary(db.get('SELECT * FROM virtual_keys WHERE id=?', k.id)!).period_spent;
    assert.ok(spent > 0);
    current = await update(null, 10000);
    assert.equal(current.budget, null); assert.equal(current.token_limit, 10000);
    assert.equal(db.limitSummary(current).period_spent, spent); assert.equal(db.limitSummary(current).tokens_used, 160);
    assert.equal((await chat(k.token)).statusCode, 200);
    await update(null, 0);
    assert.equal((await chat(k.token)).json().error.code, 'token_quota_exceeded');
    current = await update(null, null);
    assert.equal(db.limitSummary(current).tokens_used, 320);
    assert.equal((await chat(k.token)).statusCode, 200);
  });
  await t.test('editing or rotating a key preserves token usage and omitted limits', async () => {
    const k = await makeKey({ token_limit: 10000, tpm: 5000, limit_period: 'daily' });
    await chat(k.token);
    const response = await admin(`keys/${k.id}`, { name: 'Renamed', owner: 'Engineering', models: ['chat'], policy_id: policy.id, budget: 20, rpm: 100, max_request_tokens: 8192 }, 'PUT');
    assert.equal(response.statusCode, 200, response.body);
    const rotated = await create(`keys/${k.id}/rotate`, {});
    const current = db.get('SELECT * FROM virtual_keys WHERE id=?', k.id)!;
    assert.equal(current.token_limit, 10000); assert.equal(current.tpm, 5000); assert.equal(current.limit_period, 'daily');
    assert.equal(db.limitSummary(current).tokens_used, 160); assert.equal((await chat(k.token)).statusCode, 401);
    assert.equal((await chat(rotated.token)).statusCode, 200);
    const visible = (await admin('state')).json().keys.find((row: any) => row.id === k.id);
    assert.equal(visible.tokens_used, 320); assert.equal(visible.token_limit, 10000); assert.ok(visible.resets_at.endsWith('T00:00:00.000Z'));
  });
  await t.test('usage dashboard keeps split accounting beyond log cleanup, groups assignments and filters dates', async () => {
    const owner = db.get('SELECT id FROM users WHERE email=?', 'owner@example.test')!;
    const k = await makeKey({ name: 'Usage report', user_id: owner.id });
    assert.equal((await chat(k.token)).statusCode, 200);
    db.recordUsage(k.id, now(), 123, 100);
    db.recordUsage(k.id, '2000-01-01T12:00:00Z', 80, 80, 30, 50);
    db.run('DELETE FROM requests WHERE key_id=?', k.id);
    await create(`keys/${k.id}/revoke`, {});
    const response = await admin('usage?period=today');
    assert.equal(response.statusCode, 200);
    const row = response.json().by_key.find((row: any) => row.id === k.id);
    assert.equal(row.tokens, 260); assert.equal(row.input_tokens, 32); assert.equal(row.output_tokens, 128);
    assert.equal(row.cost, 283); assert.equal(row.user_id, owner.id); assert.equal(row.user_name, 'Owner'); assert.equal(row.revoked, 1);
    assert.equal(response.json().daily.find((row: any) => row.key_id === k.id).tokens, 260);
    const all = (await admin('usage?period=all')).json().by_key.find((row: any) => row.id === k.id);
    assert.equal(all.tokens, 340); assert.equal(all.input_tokens, 62); assert.equal(all.output_tokens, 178);
    assert.equal((await admin('usage?period=invalid')).statusCode, 400);
    assert.equal((await app.inject({ url: '/api/admin/usage' })).statusCode, 401);
  });
  await t.test('usage and member assignment cannot cross workspaces and member removal retains usage', async () => {
    const member = id();
    db.run('INSERT INTO users VALUES (?,?,?,?,?,?,?)', member, 'other', 'Foreign member', 'foreign@example.test', 'unused', 'viewer', now());
    const bad = await admin('keys', { name: 'Invalid assignment', owner: 'Team', models: ['chat'], budget: 10, rpm: 60, max_request_tokens: 8192, user_id: member });
    assert.equal(bad.statusCode, 400);
    const foreign = await makeKey({ name: 'Foreign usage marker' });
    db.run('UPDATE virtual_keys SET workspace_id=?,user_id=? WHERE id=?', 'other', member, foreign.id);
    db.recordUsage(foreign.id, now(), 100, 200, 50, 150);
    const report = await admin('usage?period=all');
    assert.ok(!report.body.includes(foreign.id)); assert.ok(!report.body.includes('Foreign usage marker'));
    await create('users', { name: 'Removable', email: 'removable@example.test', password: 'removable-password', role: 'viewer' });
    const local = db.get('SELECT id FROM users WHERE email=?', 'removable@example.test')!;
    const k = await makeKey({ user_id: local.id }); await chat(k.token);
    assert.equal((await admin(`users/${local.id}`, undefined, 'DELETE')).statusCode, 200);
    const retained = (await admin('usage?period=all')).json().by_key.find((row: any) => row.id === k.id);
    assert.equal(retained.user_id, null); assert.equal(retained.tokens, 160);
  });
});

test('restart recovery retains unresolved charges and prevents two writers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-recovery-'));
  let db = new Store(directory);
  try {
    assert.throws(() => new Store(directory), /already in use/);
    const keyId = id();
    db.run('INSERT INTO virtual_keys (id,workspace_id,name,owner,token_hash,prefix,models,policy_id,budget,spent,reserved,rpm,max_request_tokens,expires_at,revoked,created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 400, ?, ?, ?, 0, ?)', keyId, 'default', 'Recovered key', 'Test', hash('example-token'), 'rk_example', '["chat"]', null, 1000000, 60, 512, null, now());
    db.run('INSERT INTO reservations (id,workspace_id,key_id,model,amount,created_at,token_amount) VALUES (?, ?, ?, ?, ?, ?, ?)', id(), 'default', keyId, 'chat', 400, now(), 3000);
    db.close(); db = new Store(directory); db.recoverReservations();
    const key = db.get('SELECT * FROM virtual_keys WHERE id=?', keyId)!;
    assert.equal(key.spent, 400); assert.equal(key.reserved, 0);
    assert.equal(db.limitSummary(key).tokens_used, 3000); assert.equal(db.limitSummary(key).tokens_reserved, 0);
    const log = db.get('SELECT * FROM requests WHERE key_id=?', keyId)!;
    assert.equal(log.status, 'interrupted'); assert.equal(log.estimated, 1);
    db.recoverReservations(); assert.equal(db.get('SELECT spent FROM virtual_keys WHERE id=?', keyId)!.spent, 400); assert.equal(db.limitSummary(key).tokens_used, 3000);
  } finally { db.close(); rmSync(directory, { recursive: true }); }
});

test('existing databases migrate per-request limits and reported token splits without losing quotas', () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-migration-'));
  let db = new Store(directory);
  try {
    const keyId = id();
    db.run('INSERT INTO virtual_keys (id,workspace_id,name,owner,token_hash,prefix,models,budget,rpm,max_request_tokens,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', keyId, 'default', 'Old key', 'Team', hash('old-key'), 'rk_old', '["chat"]', 10000000, 60, 2048, now());
    db.recordUsage(keyId, now(), 50, 200, 30, 70);
    db.log({ key_id: keyId, input_tokens: 30, output_tokens: 70, cost: 50 });
    db.db.exec('ALTER TABLE virtual_keys RENAME COLUMN max_request_tokens TO max_output; ALTER TABLE virtual_keys DROP COLUMN user_id; ALTER TABLE usage_daily DROP COLUMN input_tokens; ALTER TABLE usage_daily DROP COLUMN output_tokens; ALTER TABLE policies DROP COLUMN pii_types; ALTER TABLE policies DROP COLUMN term_match; PRAGMA user_version=1;');
    db.close(); db = new Store(directory);
    const key = db.get('SELECT * FROM virtual_keys WHERE id=?', keyId)!;
    assert.equal(key.max_request_tokens, 2048); assert.equal(key.budget, 10000000); assert.equal(key.user_id, null);
    const ledger = db.get('SELECT * FROM usage_daily WHERE key_id=?', keyId)!;
    assert.equal(ledger.tokens, 200); assert.equal(ledger.input_tokens, 30); assert.equal(ledger.output_tokens, 70);
    db.close(); db = new Store(directory);
    assert.equal(db.get('SELECT tokens FROM usage_daily WHERE key_id=?', keyId)!.tokens, 200);
  } finally { db.close(); rmSync(directory, { recursive: true }); }
});
