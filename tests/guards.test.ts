import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPolicy, inspectPolicy, GuardrailError } from '../server/guards.ts';
import { Store, HttpError, now } from '../server/store.ts';

const baseline = { blocked_terms: [], block_secrets: true, redact_pii: true };
const body = (content: string) => ({ model: 'chat', messages: [{ role: 'user', content }] });
test('credential families block without echoing matched values', () => {
  const samples = ['gsk_' + 'x'.repeat(40), 'sk-proj-' + 'a'.repeat(30), 'rk_' + 'b'.repeat(36), 'sk_live_' + 'c'.repeat(24), 'hf_' + 'd'.repeat(30), 'AIza' + 'e'.repeat(35), 'ghp_' + 'f'.repeat(30), 'github_pat_' + 'g'.repeat(30), 'glpat-' + 'h'.repeat(24), 'xoxb-' + 'i'.repeat(24), 'AKIA' + 'A'.repeat(16), 'ASIA' + 'B'.repeat(16), '-----BEGIN OPENSSH PRIVATE KEY-----'];
  for (const secret of samples) {
    const result = inspectPolicy(body('Example ' + secret), baseline);
    assert.equal(result.action, 'block', secret.split('_')[0]);
    assert.equal(result.result, 'blocked:secret'); assert.equal(result.body, null);
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.throws(() => applyPolicy(body(secret), baseline), GuardrailError);
  }
  assert.equal(inspectPolicy(body('sk-short gsk_example a public-key discussion'), baseline).action, 'allow');
  assert.equal(inspectPolicy(body(samples[0]), { ...baseline, block_secrets: false }).action, 'allow');
  assert.equal(inspectPolicy(body('gsk_\u200b' + 'x'.repeat(40)), baseline).action, 'block');
});
test('term normalization and matching mode respect text and Unicode word boundaries', () => {
  const policy = { ...baseline, blocked_terms: ['forbidden phrase', 'cat'], term_match: 'word' };
  for (const text of ['FORBIDDEN   PHRASE', 'forbidden\nphrase', 'ｆｏｒｂｉｄｄｅｎ phrase', 'for\u200bbidden phrase', 'a cat!', 'cat']) assert.equal(inspectPolicy(body(text), policy).action, 'block', text);
  for (const text of ['concatenate', 'catfish', 'écat', 'caté', '𐐀cat', 'cat𐐀', '_cat_', 'catalog']) assert.equal(inspectPolicy(body(text), policy).action, 'allow', text);
  assert.equal(inspectPolicy(body('catalog'), { ...policy, term_match: 'substring' }).action, 'block');
  assert.equal(inspectPolicy(body('hello'), { ...policy, blocked_terms: ['messages', 'content'] }).action, 'allow');
  assert.equal(inspectPolicy(body('{"forbidden phrase":"value"}'), policy).action, 'block');
  const escaped = '{"value":"forbidden\\u0020phrase"}';
  assert.equal(inspectPolicy(body(escaped), policy).action, 'block');
});
test('optional PII categories redact valid examples without rewriting the original request', () => {
  const text = 'sample@example.com / 123-45-6789 / +44 20 7946 0958 / 4111 1111 1111 1111';
  const input = body(text);
  const basic = inspectPolicy(input, baseline);
  assert.equal(basic.body.messages[0].content, '[EMAIL REDACTED] / [ID REDACTED] / +44 20 7946 0958 / 4111 1111 1111 1111');
  const result = inspectPolicy(input, { ...baseline, pii_types: ['email', 'us_ssn', 'phone', 'credit_card'] });
  assert.equal(result.body.messages[0].content, '[EMAIL REDACTED] / [ID REDACTED] / [PHONE REDACTED] / [PAYMENT CARD REDACTED]');
  assert.equal(result.result, 'redacted:4'); assert.equal(input.messages[0].content, text);
  for (const value of ['4111 1111 1111 1112', '0000 0000 0000 0000', '+1234', '+1234567890123456', '2026-10-02']) assert.equal(inspectPolicy(body(value), { ...baseline, pii_types: ['phone', 'credit_card'] }).action, 'allow', value);
  assert.equal(inspectPolicy(input, { ...baseline, pii_types: [] }).action, 'allow');
  assert.equal(inspectPolicy(input, { ...baseline, redact_pii: false }).action, 'allow');
  assert.equal(applyPolicy(input).body, input);
});
test('nested tool argument JSON is decoded, redacted and kept valid while routing identifiers survive', () => {
  const input = { model: 'chat', messages: [{ role: 'assistant', content: null, name: 'mail@example.com', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'send_email', arguments: '{ "contact": "sample\\u0040example.com", "nested": ["123-45-6789"], "count": 5 }' } }] }], tools: [{ type: 'function', function: { name: 'send_email', parameters: { type: 'object' } } }] };
  const result = inspectPolicy(input, baseline);
  const message = result.body.messages[0];
  assert.equal(message.name, 'mail@example.com'); assert.equal(message.content, null);
  assert.deepEqual(JSON.parse(message.tool_calls[0].function.arguments), { contact: '[EMAIL REDACTED]', nested: ['[ID REDACTED]'], count: 5 });
  assert.deepEqual(result.body.tools, input.tools);
  assert.ok(input.messages[0].tool_calls[0].function.arguments.includes('sample'));
  input.messages[0].tool_calls[0].function.arguments = '{"token":"gsk_\\u0078' + 'x'.repeat(39) + '"}';
  assert.equal(inspectPolicy(input, baseline).result, 'blocked:secret');
  assert.equal(inspectPolicy(body('{"sample@example.com":"value"}'), baseline).result, 'blocked:pii_field_name');
  const unchanged = '{ "value": "ordinary text" }';
  assert.equal(inspectPolicy(body(unchanged), baseline).body.messages[0].content, unchanged);
});
test('secrets are also checked in other input fields and overdeep structured inputs fail closed', () => {
  const input: any = body('hello');
  input.tools = [{ description: 'gsk_' + 'x'.repeat(40) }];
  assert.equal(inspectPolicy(input, baseline).action, 'block');
  input.tools = { ['gsk_' + 'x'.repeat(40)]: 'value' };
  assert.equal(inspectPolicy(input, baseline).action, 'block');
  let nested: any = 'hello'; for (let i = 0; i < 70; i++) nested = [nested];
  assert.throws(() => inspectPolicy(body(JSON.stringify(nested)), baseline), (error: any) => error instanceof HttpError && error.status === 400 && error.code === 'guardrail_input_too_deep');
});
test('schema 2 policies migrate with their existing choices and assignments intact', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gate-policy-migration-'));
  let db = new Store(directory);
  try {
    db.run('INSERT INTO policies (id,workspace_id,name,blocked_terms,redact_pii,block_secrets,created_at) VALUES (?,?,?,?,?,?,?)', 'old-policy', 'default', 'Old policy', '["term"]', 0, 1, now());
    db.run('INSERT INTO virtual_keys (id,workspace_id,name,owner,token_hash,prefix,models,policy_id,rpm,max_request_tokens,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', 'old-key', 'default', 'Old key', 'Team', 'hash', 'rk_old', '["chat"]', 'old-policy', 60, 8192, now());
    db.db.exec('ALTER TABLE policies DROP COLUMN pii_types; ALTER TABLE policies DROP COLUMN term_match; PRAGMA user_version=2;');
    db.close(); db = new Store(directory);
    const policy = db.get('SELECT * FROM policies WHERE id=?', 'old-policy')!;
    assert.equal(policy.blocked_terms, '["term"]'); assert.equal(policy.redact_pii, 0); assert.equal(policy.block_secrets, 1);
    assert.deepEqual(JSON.parse(policy.pii_types), ['email', 'us_ssn']); assert.equal(policy.term_match, 'substring');
    assert.equal(db.get('SELECT policy_id FROM virtual_keys WHERE id=?', 'old-key')!.policy_id, 'old-policy');
    assert.equal(db.get('PRAGMA user_version')!.user_version, 3);
    db.close(); db = new Store(directory);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM policies')!.count, 1);
  } finally { db.close(); rmSync(directory, { recursive: true }); }
});
