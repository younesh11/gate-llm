import { id, now, passwordHash } from '../server/store.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.ts';
import { awsCatalogClient, type CatalogClientFactory } from '../server/aws-catalog.ts';

async function fixture(t: any, send: (command: any, options: any) => Promise<any>, availability?: (command: any) => Promise<any>) {
  const directory = mkdtempSync(join(tmpdir(), 'gate-aws-catalog-'));
  const regions: string[] = [], logs: string[] = []; let destroyed = 0;
  const factory: CatalogClientFactory = region => {
    regions.push(region);
    return { send: (command: any, options: any) => command.constructor.name === 'GetFoundationModelAvailabilityCommand' ? (availability ? availability(command) : Promise.resolve({ modelId:command.input.modelId, regionAvailability:'AVAILABLE' })) : send(command,options), destroy: () => { destroyed++; } } as ReturnType<CatalogClientFactory>;
  };
  const { app, db } = await createApp({ directory, catalogClientFactory: factory, logDestination: { write: line => { logs.push(line); } } });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { workspace: 'Catalog test', name: 'Owner', email: 'owner@example.test', password: 'synthetic-test-password' } });
  const cookie = String(setup.headers['set-cookie']).split(';')[0];
  const call = (payload: any = { region: 'eu-west-2' }, headers = { cookie }, url = '/api/admin/aws/catalog') => app.inject({ method: 'POST', url, headers, payload });
  return { app, db, cookie, call, regions, logs, destroyed: () => destroyed };
}

test('AWS catalog lists normalized metadata without inference, usage changes or secret exposure', async t => {
  const commands: string[] = [];
  const f = await fixture(t, async (command, options) => {
    commands.push(command.constructor.name); assert.ok(options.abortSignal);
    return { modelSummaries: [{ modelId: 'meta.example-v1:0', modelArn:'arn:aws:bedrock:eu-west-2::foundation-model/meta.example-v1:0', modelName: 'Example model', providerName: 'Meta', inputModalities: ['TEXT'], outputModalities: ['TEXT'], responseStreamingSupported: true, modelLifecycle: { status: 'ACTIVE' }, inferenceTypesSupported: ['ON_DEMAND'], ignoredSecret: 'private-response-detail' }] };
  });
  const before = JSON.stringify(['requests', 'reservations', 'usage_daily', 'providers', 'deployments', 'virtual_keys', 'audit'].map(table => f.db.all(`SELECT * FROM ${table}`)));
  const response = await f.call();
  assert.equal(response.statusCode, 200, response.body); assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(commands, ['ListFoundationModelsCommand']); assert.deepEqual(f.regions, ['eu-west-2']);
  assert.equal(response.json().items[0].id, 'meta.example-v1:0'); assert.equal(response.json().items[0].streaming, true);
  assert.equal(response.json().truncated, false); assert.equal(response.json().kind, 'models');
  assert.ok(!response.body.includes('private-response-detail')); assert.ok(!f.logs.join('').includes('private-response-detail'));
  assert.equal(f.destroyed(), 1);
  assert.equal(JSON.stringify(['requests', 'reservations', 'usage_daily', 'providers', 'deployments', 'virtual_keys', 'audit'].map(table => f.db.all(`SELECT * FROM ${table}`))), before);
});

test('catalog discovery requires owner authorization including encoded URLs, and rejects endpoint/credential input', async t => {
  const f = await fixture(t, async () => ({ modelSummaries: [] }));
  f.db.run('INSERT INTO users VALUES (?,?,?,?,?,?,?)',id(),'default','Viewer','viewer@example.test',passwordHash('synthetic-test-password'),'viewer',now());
  const login = await f.app.inject({ method: 'POST', url: '/api/login', payload: { email: 'viewer@example.test', password: 'synthetic-test-password' } });
  const viewer = String(login.headers['set-cookie']).split(';')[0];
  for (const url of ['/api/admin/aws/catalog', '/%61pi/%61dmin/aws/catalog']) {
    assert.equal((await f.call({ region: 'eu-west-2' }, { cookie: '' }, url)).statusCode, 401);
    assert.equal((await f.call({ region: 'eu-west-2' }, { cookie: viewer }, url)).statusCode, 403);
  }
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/admin/aws/catalog', headers: { cookie: f.cookie, origin: 'https://attacker.test' }, payload: { region: 'eu-west-2' } })).statusCode, 403);
  for (const payload of [{ region: 'evil.example' }, { region: 'us-gov-west-1' }, { region: 'eu-west-2', endpoint: 'http://127.0.0.1' }, { region: 'eu-west-2', credentials: {} }, { region: 'eu-west-2', profile: 'another-account' }, { region: 'eu-west-2', kind: 'unknown' }]) assert.equal((await f.call(payload)).statusCode, 400);
  assert.equal(f.regions.length, 0);
});

test('inference-profile discovery paginates without exposing continuation tokens', async t => {
  const inputs: any[] = [];
  const f = await fixture(t, async command => {
    assert.equal(command.constructor.name, 'ListInferenceProfilesCommand'); inputs.push(command.input);
    return { inferenceProfileSummaries: [{ inferenceProfileId: command.input.nextToken ? 'second' : 'first', inferenceProfileName: 'Profile', type: 'SYSTEM_DEFINED', status: 'ACTIVE', models: [{ modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/example' }] }], ...(command.input.nextToken ? {} : { nextToken: 'private-page-token' }) };
  });
  const response = await f.call({ region: 'us-east-1', kind: 'profiles' });
  assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().items.length, 2);
  assert.equal(inputs[1].nextToken, 'private-page-token'); assert.equal(response.json().truncated, false);
  assert.ok(!response.body.includes('private-page-token')); assert.ok(!f.logs.join('').includes('private-page-token'));
});

test('catalog failures are actionable and omit raw AWS error messages', async t => {
  let name = '';
  const f = await fixture(t, async () => { throw Object.assign(new Error('private-token and account details'), { name }); });
  for (const [error, status, code] of [
    ['CredentialsProviderError', 503, 'aws_credentials_unavailable'], ['ExpiredTokenException', 503, 'aws_credentials_invalid'],
    ['AccessDeniedException', 403, 'aws_catalog_access_denied'], ['ThrottlingException', 429, 'aws_catalog_throttled'],
    ['TimeoutError', 504, 'aws_catalog_timeout'], ['UnexpectedError', 502, 'aws_catalog_unavailable']
  ] as const) {
    name = error; const response = await f.call();
    assert.equal(response.statusCode, status); assert.equal(response.json().error.code, code);
    assert.ok(!response.body.includes('private-token'));
  }
  assert.equal(f.destroyed(), 6); assert.ok(!f.logs.join('').includes('private-token'));
});

test('catalog work is bounded by refresh, concurrency and pagination limits', async t => {
  let release: (() => void) | undefined, paginating = false, pages = 0;
  const f = await fixture(t, async () => {
    if (paginating) return { inferenceProfileSummaries: [], nextToken: `page-${++pages}` };
    await new Promise<void>(resolve => { release = resolve; }); return { modelSummaries: [] };
  });
  const first = f.call().then(response => response);
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal((await f.call()).statusCode, 429); release(); assert.equal((await first).statusCode, 200);
  paginating = true;
  const paged = await f.call({ region: 'eu-west-2', kind: 'profiles' });
  assert.equal(paged.statusCode, 200); assert.equal(paged.json().truncated, true); assert.equal(pages, 20);
  for (let i = 0; i < 8; i++) assert.equal((await f.call({ region: 'eu-west-2', kind: 'profiles' })).statusCode, 200);
  assert.equal((await f.call()).statusCode, 429); assert.equal(f.regions.length, 10);
});

test('repeated profile pagination tokens fail closed', async t => {
  const f = await fixture(t, async () => ({ inferenceProfileSummaries: [], nextToken: 'same-private-token' }));
  const response = await f.call({ region: 'eu-west-2', kind: 'profiles' });
  assert.equal(response.statusCode, 502); assert.ok(!response.body.includes('same-private-token'));
});

test('AWS client pins the regional HTTPS endpoint and disables automatic retries', async () => {
  const client = awsCatalogClient('eu-west-2') as import('@aws-sdk/client-bedrock').BedrockClient;
  try {
    assert.equal(await client.config.region(), 'eu-west-2');
    assert.equal(await client.config.maxAttempts(), 1);
    const endpoint = await client.config.endpoint!();
    assert.equal(endpoint.protocol, 'https:'); assert.equal(endpoint.hostname, 'bedrock.eu-west-2.amazonaws.com');
  } finally { client.destroy(); }
});


test('regional catalog excludes absent, wrong-region, inactive, profile-only and provisioned-only models even when AWS returns them', async t => {
  const row = (id: string, extra: any = {}) => ({modelId:id,modelArn:`arn:aws:bedrock:eu-west-2::foundation-model/${id}`,modelLifecycle:{status:'ACTIVE'},inferenceTypesSupported:['ON_DEMAND'],...extra});
  const verified: string[] = [];
  const f = await fixture(t, async command => {
    assert.equal(command.input.byInferenceType,'ON_DEMAND');
    return {modelSummaries:[row('meta.local'),row('meta.default-v1:0'),row('meta.other-v1:1'),row('meta.unavailable'),row('meta.unknown'),row('meta.failed'),row('meta.wrong',{modelArn:'arn:aws:bedrock:us-west-2::foundation-model/meta.wrong'}),row('meta.legacy',{modelLifecycle:{status:'LEGACY'}}),row('meta.provisioned',{inferenceTypesSupported:['PROVISIONED']}),row('meta.profile',{inferenceTypesSupported:['INFERENCE_PROFILE']}),row('meta.noarn',{modelArn:undefined}),row('meta.local')]};
  }, async command => {
    const id=command.input.modelId;verified.push(id);
    if(id==='meta.failed')throw Object.assign(new Error('hidden IAM details'),{name:'AccessDeniedException'});
    if(id==='meta.default-v1:0' || id==='meta.other-v1:1')return {modelId:id.slice(0,-2),regionAvailability:'AVAILABLE'};
    return {modelId:id,regionAvailability:id==='meta.local'?'AVAILABLE':id==='meta.unavailable'?'NOT_AVAILABLE':undefined};
  });
  const r=await f.call(); assert.equal(r.statusCode,200,r.body);
  assert.deepEqual(r.json().items.map((r:any)=>r.id),['meta.local','meta.default-v1:0']);
  assert.deepEqual(verified.sort(),['meta.default-v1:0','meta.failed','meta.local','meta.other-v1:1','meta.unavailable','meta.unknown']);
  assert.equal(r.json().availability.unverified,3);assert.equal(r.json().availability.permission_required,true);
  assert.ok(!r.body.includes('hidden IAM'));
});

test('availability checks have bounded concurrency and reject mismatched model responses', async t => {
  let active=0, peak=0;
  const f=await fixture(t,async()=>({modelSummaries:Array.from({length:12},(_,i)=>({modelId:`meta.m${i}`,modelArn:`arn:aws:bedrock:eu-west-2::foundation-model/meta.m${i}`,modelLifecycle:{status:'ACTIVE'},inferenceTypesSupported:['ON_DEMAND']}))}),async command=>{
    active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,2));active--;
    return {modelId:'mismatched',regionAvailability:'AVAILABLE'};
  });
  const r=await f.call();assert.equal(r.statusCode,200);assert.equal(r.json().items.length,0);assert.equal(r.json().availability.unverified,12);assert.ok(peak<=4);
});
