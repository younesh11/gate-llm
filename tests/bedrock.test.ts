import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.ts';
import { bedrockClient, converseInput, fetchBedrock, type BedrockFactory } from '../server/bedrock.ts';
import { Store, now } from '../server/store.ts';

const text = { model: 'meta.llama3-1-8b-instruct-v1:0', messages: [{ role: 'system', content: 'Be helpful.' }, { role: 'user', content: 'Hello' }], max_tokens: 32, temperature: 0.7 };
const answer = { output: { message: { role: 'assistant', content: [{ text: 'Hello!' }] } }, stopReason: 'end_turn', usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 } };
const events = [{ messageStart: { role: 'assistant' } }, { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hello!' } } }, { messageStop: { stopReason: 'end_turn' } }, { metadata: { usage: answer.usage } }];
function mock(send: (cmd: any, options: any) => Promise<any>) {
  let destroyed = 0;
  const regions: string[] = [];
  const factory: BedrockFactory = region => { regions.push(region); return { send, destroy: () => destroyed++ } as ReturnType<BedrockFactory>; };
  return { factory, regions, destroyed: () => destroyed };
}
async function* stream(items = events) { for (const item of items) yield item; }

test('native requests use fixed regional endpoint, SigV4 and no SDK retries', async () => {
  const client = bedrockClient('us-west-2') as any;
  try {
    assert.equal(await client.config.maxAttempts(), 1);
    assert.deepEqual(await client.config.authSchemePreference(), ['sigv4']);
    assert.equal((await client.config.endpoint()).hostname, 'bedrock-runtime.us-west-2.amazonaws.com');
  } finally { client.destroy(); }
  assert.throws(() => bedrockClient('evil.example'));
});

test('Converse maps text, system, stop and generation limits without dropping unsupported fields', () => {
  const input = converseInput({ ...text, stop: 'END', top_p: 0.9 });
  assert.deepEqual(input.system, [{ text: 'Be helpful.' }]);
  assert.deepEqual(input.messages, [{ role: 'user', content: [{ text: 'Hello' }] }]);
  assert.deepEqual(input.inferenceConfig, { maxTokens: 32, temperature: 0.7, topP: 0.9, stopSequences: ['END'] });
  for (const key of ['tools','tool_choice','parallel_tool_calls','response_format','seed','frequency_penalty','presence_penalty']) assert.throws(() => converseInput({ ...text, [key]: [] }), /does not yet support/);
  for (const messages of [[{ role: 'tool', content: 'result' }], [{ role: 'user', content: '' }], [{ role: 'assistant', content: 'first' }], [{ role: 'user', content: 'hi' }, { role: 'system', content: 'late' }]]) assert.throws(() => converseInput({ ...text, messages }));
  assert.throws(() => converseInput({ ...text, temperature: 1.5 }));
});

test('Bedrock JSON and SSE translate content, finish reason and input/output usage and clean up clients', async () => {
  const captured: any[] = [];
  const m = mock(async (command, options) => { captured.push(command); assert.ok(options.abortSignal); return command.constructor.name === 'ConverseCommand' ? answer : { stream: stream() }; });
  const response = await fetchBedrock('us-west-2', text, new AbortController().signal, m.factory);
  const json = await response.json();
  assert.equal(json.choices[0].message.content, 'Hello!'); assert.deepEqual(json.usage, { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 });
  assert.equal(m.destroyed(), 1);
  const sse = await fetchBedrock('us-west-2', { ...text, stream: true }, new AbortController().signal, m.factory);
  const body = await sse.text();
  assert.match(body, /"content":"Hello!"/); assert.match(body, /"finish_reason":"stop"/); assert.match(body, /"prompt_tokens":12/); assert.ok(body.endsWith('data: [DONE]\n\n'));
  assert.equal(m.destroyed(), 2); assert.deepEqual(captured.map(c=>c.constructor.name), ['ConverseCommand','ConverseStreamCommand']);
});

test('truncated and exception streams fail without DONE; cancelling destroys the client', async () => {
  for (const parts of [events.slice(0,2), [...events.slice(0,2), { internalServerException: { message: 'private service detail' } }] as any]) {
    const m = mock(async () => ({ stream: stream(parts) }));
    const result = await fetchBedrock('us-west-2', { ...text, stream: true }, new AbortController().signal, m.factory);
    await assert.rejects(result.text()); assert.equal(m.destroyed(), 1);
  }
  const m = mock(async () => ({ stream: stream() }));
  const controller = new AbortController();
  const result = await fetchBedrock('us-west-2', { ...text, stream: true }, controller.signal, m.factory);
  controller.abort(); await result.body?.cancel(); assert.equal(m.destroyed(), 1);
});

async function fixture(t: any) {
  const directory = mkdtempSync(join(tmpdir(), 'gate-bedrock-test-'));
  let mode = 'ok'; const captured: any[] = [], logs: string[] = [];
  const m = mock(async (command, options) => {
    captured.push(command.input); assert.ok(options.abortSignal);
    if (mode === 'credentials') throw Object.assign(new Error('private secret'), { name: 'CredentialsProviderError' });
    if (mode === 'denied') throw Object.assign(new Error('private secret'), { name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } });
    if (mode === 'throttled' && captured.at(-1).modelId === 'throttled') throw Object.assign(new Error('private secret'), { $metadata: { httpStatusCode: 429 } });
    return command.constructor.name === 'ConverseCommand' ? answer : { stream: stream(mode === 'broken' ? events.slice(0,2) : events) };
  });
  const { app, db } = await createApp({ directory, bedrockClientFactory: m.factory, random: () => 0, logDestination: { write: line => { logs.push(line); } } });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true }); });
  const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { workspace: 'Bedrock', name: 'Owner', email: 'owner@example.test', password: 'synthetic-test-password' } });
  const cookie = String(setup.headers['set-cookie']).split(';')[0];
  const admin = (path: string, payload?: any, method: any = payload ? 'POST' : 'GET') => app.inject({ method, url: '/api/admin/'+path, headers: { cookie }, payload });
  const create = async (path: string, payload: any) => { const res = await admin(path,payload); assert.equal(res.statusCode,200,res.body); return res.json(); };
  const provider = await create('providers', { name: 'AWS', provider_type: 'bedrock', aws_region: 'us-west-2' });
  const deployment = await create('deployments', { provider_id: provider.id, alias: 'llama', upstream_model: text.model, input_price: 0.22, output_price: 0.44, weight: 1 });
  const policy = await create('policies', { name: 'PII', blocked_terms: ['forbidden'], redact_pii: true, block_secrets: true });
  const key = await create('keys', { name: 'Test app', owner: 'Owner', models: ['llama'], budget: 1, token_limit: 10000, rpm: 100, max_request_tokens: 4096, policy_id: policy.id });
  const chat = (extra = {}) => app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${key.token}` }, payload: { ...text, model: 'llama', ...extra } });
  return { db, app, admin, create, provider, deployment, key, chat, captured, logs, mode: (value: string) => { mode = value; } };
}

test('Bedrock gateway preserves key access, guardrails, real usage and budgets in JSON and streaming', async t => {
  const f = await fixture(t);
  assert.equal((await f.chat({ model: 'not-allowed' })).statusCode, 403);
  assert.equal((await f.chat({ tools: [] })).statusCode, 400);
  assert.equal((await f.chat({ messages: [{ role: 'user', content: 'forbidden' }] })).statusCode, 422);
  assert.equal(f.captured.length, 0);
  assert.equal(f.db.get('SELECT count(*) AS n FROM reservations')!.n, 0);
  const response = await f.chat({ messages: [{ role: 'user', content: 'Contact person@example.com' }] });
  assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().model, 'llama');
  assert.match(JSON.stringify(f.captured[0]), /EMAIL REDACTED/); assert.ok(!JSON.stringify(f.captured[0]).includes('person@example.com'));
  const streamed = await f.chat({ stream: true }); assert.equal(streamed.statusCode, 200); assert.match(streamed.body, /\[DONE\]/); assert.match(streamed.body, /"model":"llama"/);
  const records = f.db.all("SELECT * FROM requests WHERE status='success'"); assert.equal(records.length, 2);
  for (const r of records) { assert.equal(r.input_tokens,12); assert.equal(r.output_tokens,4); assert.equal(r.cost,5); assert.equal(r.estimated,0); }
  assert.equal(f.db.get('SELECT spent,reserved FROM virtual_keys WHERE id=?',f.key.id)!.spent,10);
  assert.equal(f.db.get('SELECT count(*) AS n FROM reservations')!.n,0);
  f.db.run('UPDATE virtual_keys SET token_limit=32 WHERE id=?', f.key.id);
  assert.equal((await f.chat()).statusCode,429); assert.equal(f.captured.length,2);
});

test('AWS rejections release allowance, do not expose raw errors, and interrupted inference is conservatively settled', async t => {
  const f = await fixture(t);
  for (const mode of ['credentials','denied']) {
    f.mode(mode); const res = await f.chat(); assert.equal(res.statusCode,502,res.body); assert.ok(!res.body.includes('private secret'));
    const row = f.db.get('SELECT * FROM virtual_keys WHERE id=?',f.key.id)!; assert.equal(row.spent,0); assert.equal(row.reserved,0);
  }
  f.mode('broken'); const result = await f.chat({ stream: true });
  assert.match(result.body,/stream_interrupted/); assert.ok(!result.body.includes('[DONE]'));
  const record = f.db.get("SELECT * FROM requests WHERE estimated=1")!; assert.ok(record.cost>0); assert.equal(record.status,'error');
  assert.equal(f.db.get('SELECT count(*) AS n FROM reservations')!.n,0);
  assert.ok(!f.logs.join('').includes('private secret'));
});

test('explicit Bedrock throttling can fall back once; access failures do not retry', async t => {
  const f = await fixture(t);
  f.db.run('UPDATE deployments SET upstream_model=? WHERE id=?','throttled',f.deployment.id);
  await f.create('deployments', { provider_id:f.provider.id,alias:'llama',upstream_model:text.model,input_price:0.22,output_price:0.44,weight:1 });
  f.mode('throttled');
  const response=await f.chat();assert.equal(response.statusCode,200,response.body);
  assert.equal(f.captured.length,2);assert.equal(f.captured[0].modelId,'throttled');
  assert.equal(f.db.get('SELECT attempts FROM requests WHERE key_id=?',f.key.id)!.attempts,2);
  assert.ok(f.db.get('SELECT cooldown_until FROM deployments WHERE id=?',f.deployment.id)!.cooldown_until>Date.now());
  f.mode('denied');const denied=await f.chat();assert.equal(denied.statusCode,502);assert.equal(f.captured.length,3);
});

test('provider conversion is explicit, clears old bearer secret, resets cooldown and rejects custom Bedrock endpoints', async t => {
  const f = await fixture(t);
  for (const extra of [{ aws_region: 'evil.example' }, { api_key: 'never-accept' }, { base_url: 'https://evil.example' }, { token_counting: 'vllm' }]) {
    assert.equal((await f.admin('providers', { name: 'Bad', provider_type: 'bedrock', aws_region: 'us-west-2', ...extra })).statusCode,400);
  }
  f.db.run("UPDATE providers SET provider_type='openai',secret=?,aws_region=NULL WHERE id=?",f.db.seal('previous-key'),f.provider.id);
  f.db.run('UPDATE deployments SET cooldown_until=? WHERE id=?',Date.now()+50000,f.deployment.id);
  const res = await f.admin('providers/'+f.provider.id, { name: 'AWS', provider_type: 'bedrock', aws_region: 'us-east-1' }, 'PUT');
  assert.equal(res.statusCode,200,res.body);
  const provider = f.db.get('SELECT * FROM providers WHERE id=?',f.provider.id)!;
  assert.equal(provider.secret,''); assert.equal(provider.base_url,'https://bedrock-runtime.us-east-1.amazonaws.com');
  assert.equal(f.db.get('SELECT cooldown_until FROM deployments WHERE id=?',f.deployment.id)!.cooldown_until,0);
  const state = await f.admin('state'); assert.ok(!state.body.includes('previous-key')); assert.equal(state.json().providers[0].provider_type,'bedrock');
  assert.equal((await f.app.inject({ method:'POST', url:'/api/admin/providers', payload:{name:'AWS',provider_type:'bedrock',aws_region:'us-west-2'} })).statusCode,401);
});

test('SQLite version 5 upgrades providers without changing existing credentials or endpoints', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gate-bedrock-migrate-'));
  let db = new Store(directory);
  try {
    db.run('INSERT INTO providers (id,workspace_id,name,base_url,secret,created_at) VALUES (?,?,?,?,?,?)','old','default','Old','https://old.example/v1',db.seal('preserved'),now());
    db.db.exec('ALTER TABLE providers DROP COLUMN provider_type; ALTER TABLE providers DROP COLUMN aws_region; PRAGMA user_version=5;');
    db.close(); db = new Store(directory);
    const row=db.get('SELECT * FROM providers WHERE id=?','old')!;
    assert.equal(row.provider_type,'openai'); assert.equal(row.aws_region,null); assert.equal(db.unseal(row.secret),'preserved'); assert.equal(row.base_url,'https://old.example/v1');
  } finally { db.close(); rmSync(directory,{recursive:true}); }
});
