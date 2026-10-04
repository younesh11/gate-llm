import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.ts';

test('provider token counting respects combined limits, policies, accounting and failures', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'gate-token-count-'));
  const counted: any[] = [], generated: any[] = [];
  let failure: string | undefined, countDelay = 0, rejectFast = false, unexpected = 0;
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text || '{}'), count = body.model === 'backup' ? 70 : 40;
    if (request.url === '/proxy/tokenize') {
      counted.push({ body, authorization: request.headers.authorization });
      if (countDelay) await new Promise(resolve => setTimeout(resolve, countDelay));
      if (response.destroyed) return;
      if (failure === 'redirect') { response.writeHead(307, { Location: '/unexpected' }); response.end(); return; }
      if (failure === 'error') { response.writeHead(500); response.end('private upstream diagnostic'); return; }
      if (failure === 'large') { response.end('x'.repeat(4_000_001)); return; }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ count: failure === 'negative' ? -1 : failure === 'fraction' ? 1.5 : failure === 'string' ? '40' : count, tokens: Array(failure === 'mismatch' ? count - 1 : count).fill(1), max_model_len: 16384 })); return;
    }
    if (request.url !== '/proxy/v1/chat/completions') { unexpected++; response.writeHead(404); response.end(); return; }
    generated.push(body);
    if (rejectFast && body.model === 'fast') { response.writeHead(429); response.end(); return; }
    await new Promise(resolve => setTimeout(resolve, 60));
    const output = Math.min(7, body.max_tokens ?? body.max_completion_tokens);
    const usage = { prompt_tokens: count, completion_tokens: output, total_tokens: count + output };
    if (body.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] })}\n\ndata: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`);
    } else {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }], usage }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base_url = `http://127.0.0.1:${(server.address() as { port: number }).port}/proxy/v1`;
  const { app, db } = await createApp({ directory, allowPrivate: true, timeoutMs: 1000, random: () => 0, logLevel: 'silent' });
  t.after(async () => { await app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); });
  const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { workspace: 'Tokenizer test', name: 'Owner', email: 'owner@example.test', password: 'synthetic-test-password' } });
  const cookie = String(setup.headers['set-cookie']).split(';')[0];
  const admin = (path: string, payload?: any, method: any = payload === undefined ? 'GET' : 'POST') => app.inject({ method, url: '/api/admin/' + path, headers: { cookie }, ...(payload === undefined ? {} : { payload }) });
  const create = async (path: string, payload: any) => { const r = await admin(path, payload); assert.equal(r.statusCode, 200, r.body); return r.json(); };
  const provider = await create('providers', { name: 'vLLM', base_url, api_key: 'synthetic-tokenizer-secret', token_counting: 'vllm' });
  const deploy = (alias: string, upstream_model = 'fast', provider_id = provider.id, price = 1) => create('deployments', { alias, upstream_model, provider_id, weight: 1, input_price: price, output_price: price });
  await deploy('counted');
  const policy = (await admin('state')).json().policies[0];
  const makeKey = (extra: any = {}) => create('keys', { name: 'Tokenizer key', owner: 'Test', models: ['counted'], policy_id: policy.id, budget: null, token_limit: 10000, tpm: 10000, rpm: 100, max_request_tokens: 500, ...extra });
  const chat = (key: any, extra: any = {}) => app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${key.token}` }, payload: { model: 'counted', messages: [{ role: 'user', content: 'hello' }], max_total_tokens: 500, ...extra } });

  await t.test('500 combined tokens uses the chat tokenizer, preserves the proxy prefix and settles actual usage', async () => {
    const key = await makeKey(), response = await chat(key);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(generated.at(-1).max_tokens, 460);
    assert.ok(!('max_total_tokens' in generated.at(-1)));
    assert.equal(counted.at(-1).body.add_generation_prompt, true);
    assert.equal(counted.at(-1).body.add_special_tokens, false);
    assert.equal(counted.at(-1).authorization, 'Bearer synthetic-tokenizer-secret');
    const log = db.get('SELECT * FROM requests WHERE key_id=?', key.id)!;
    assert.equal(log.input_tokens, 40); assert.equal(log.output_tokens, 7); assert.equal(log.cost, 47); assert.equal(log.estimated, 0);
    assert.equal(db.limitSummary(db.get('SELECT * FROM virtual_keys WHERE id=?', key.id)!).tokens_used, 47);
  });
  await t.test('streaming and explicit output limits share the same combined allowance', async () => {
    const key = await makeKey();
    const stream = await chat(key, { max_total_tokens: 45, stream: true });
    assert.equal(stream.statusCode, 200, stream.body); assert.match(stream.body, /\[DONE\]/);
    assert.equal(generated.at(-1).max_tokens, 5);
    assert.equal((await chat(key, { max_completion_tokens: 10 })).statusCode, 200);
    assert.equal(generated.at(-1).max_completion_tokens, 10); assert.ok(!('max_tokens' in generated.at(-1)));
    const before = generated.length;
    assert.equal((await chat(key, { max_tokens: 461 })).statusCode, 400);
    const noRoom = await chat(key, { max_total_tokens: 40 });
    assert.equal(noRoom.statusCode, 400); assert.match(noRoom.json().error.message, /Counted input \(40\) leaves no room/);
    assert.equal(generated.length, before);
  });
  await t.test('secret blocks precede counting, and redaction precedes both counting and generation', async () => {
    const key = await makeKey(), before = counted.length;
    const secret = await chat(key, { messages: [{ role: 'user', content: 'gsk_' + 'x'.repeat(40) }] });
    assert.equal(secret.statusCode, 422); assert.equal(counted.length, before);
    assert.equal((await chat(key, { messages: [{ role: 'user', content: 'Email test@example.test' }] })).statusCode, 200);
    assert.equal(counted.at(-1).body.messages[0].content, 'Email [EMAIL REDACTED]');
    assert.deepEqual(counted.at(-1).body.messages, generated.at(-1).messages);
  });
  await t.test('quotas, budgets and concurrent calls cannot bypass reservations with counted input', async () => {
    const before = generated.length;
    assert.equal((await chat(await makeKey({ token_limit: 499 }))).json().error.code, 'token_quota_exceeded');
    assert.equal((await chat(await makeKey({ tpm: 499 }))).json().error.code, 'token_rate_limit_exceeded');
    await deploy('expensive-counted', 'fast', provider.id, 100);
    assert.equal((await chat(await makeKey({ models: ['expensive-counted'], budget: 0.01 }), { model: 'expensive-counted' })).json().error.code, 'budget_exceeded');
    assert.equal(generated.length, before);
    const key = await makeKey({ token_limit: 500 });
    const responses = await Promise.all([chat(key), chat(key)]);
    assert.deepEqual(responses.map(r => r.statusCode).sort(), [200, 429]);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM reservations WHERE key_id=?', key.id)!.count, 0);
  });
  await t.test('fallback reserves the largest input count across selected deployments', async () => {
    await deploy('fallback-counted'); await deploy('fallback-counted', 'backup');
    const key = await makeKey({ models: ['fallback-counted'] });
    rejectFast = true;
    try { assert.equal((await chat(key, { model: 'fallback-counted' })).statusCode, 200); }
    finally { rejectFast = false; }
    assert.equal(generated.at(-2).max_tokens, 430); assert.equal(generated.at(-1).max_tokens, 430);
    assert.equal(db.get('SELECT input_tokens FROM requests WHERE key_id=?', key.id)!.input_tokens, 70);
  });
  await t.test('invalid, failed, oversized, redirected and timed-out counts fail before generation', async () => {
    const key = await makeKey(), before = generated.length;
    try {
      for (failure of ['negative', 'fraction', 'string', 'mismatch', 'error', 'large', 'redirect']) {
        const result = await chat(key);
        assert.equal(result.statusCode, 503, failure + ': ' + result.body);
        assert.equal(result.json().error.code, 'token_count_unavailable');
        assert.ok(!result.body.includes('private upstream diagnostic'));
      }
      failure = undefined; countDelay = 1200;
      assert.equal((await chat(key)).statusCode, 503);
    } finally { failure = undefined; countDelay = 0; }
    assert.equal(generated.length, before); assert.equal(unexpected, 0);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM reservations WHERE key_id=?', key.id)!.count, 0);
  });
  await t.test('token-counting work has its own per-key request cap, including rejected generations', async () => {
    const key = await makeKey({ rpm: 1 }), before = counted.length;
    assert.equal((await chat(key, { max_total_tokens: 10 })).statusCode, 400);
    assert.equal((await chat(key)).json().error.code, 'token_count_rate_limit');
    assert.equal(counted.length, before + 1);
  });
  await t.test('revoking a key during counting prevents generation', async () => {
    const key = await makeKey(), before = generated.length;
    countDelay = 100;
    try {
      const pending = chat(key); void pending.then(() => {});
      await new Promise(resolve => setTimeout(resolve, 30));
      await create(`keys/${key.id}/revoke`, {});
      assert.equal((await pending).statusCode, 401);
    } finally { countDelay = 0; }
    assert.equal(generated.length, before);
  });
  await t.test('unsupported prompt features retain conservative accounting and clients cannot choose a counting mode', async () => {
    const key = await makeKey(), before = counted.length;
    const result = await chat(key, { tools: [{ type: 'function', function: { name: 'test', parameters: {} } }] });
    assert.equal(result.statusCode, 400); assert.match(result.json().error.message, /conservative estimate/);
    assert.equal(counted.length, before);
    assert.equal((await chat(key, { token_counting: 'vllm' })).statusCode, 400);
  });
  await t.test('provider mode defaults to estimates, validates URLs, and survives updates without the field', async () => {
    const ordinary = await create('providers', { name: 'Ordinary', base_url });
    assert.equal(db.get('SELECT token_counting FROM providers WHERE id=?', ordinary.id)!.token_counting, 'estimate');
    await deploy('mixed-counted', 'fast'); await deploy('mixed-counted', 'fast', ordinary.id);
    const result = await chat(await makeKey({ models: ['mixed-counted'] }), { model: 'mixed-counted' });
    assert.equal(result.statusCode, 400); assert.match(result.json().error.message, /Estimated input/);
    assert.equal((await admin(`providers/${provider.id}`, { name: 'Renamed', base_url }, 'PUT')).statusCode, 200);
    assert.equal(db.get('SELECT token_counting FROM providers WHERE id=?', provider.id)!.token_counting, 'vllm');
    assert.equal((await admin('providers', { name: 'Invalid', base_url: base_url + '/chat/completions', token_counting: 'vllm' })).statusCode, 400);
  });
});
