import { createHash } from 'node:crypto';
import { id, now, passwordHash } from '../../server/store.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/app.ts';
import { PostgresAppStore } from '../../server/postgres/app-store.ts';
import { PostgresDatabase } from '../../server/postgres/database.ts';
import { mockProvider } from '../../scripts/mock-provider.ts';
import { postgresConfiguration } from '../../server/config.ts';

const url = process.env.GATE_TEST_POSTGRES_URL!;
const parsed = new URL(url);
if (parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/gate_test') throw new Error('Use the disposable PostgreSQL test runner.');
const postgres = { url, localPlaintext: true };

test('PostgreSQL application: authentication, permissions, proxy, accounting and restart', async t => {
  const directory = mkdtempSync(join(tmpdir(),'gate-pg-app-'));
  const other = mkdtempSync(join(tmpdir(),'gate-pg-other-'));
  const mock = mockProvider();
  await new Promise<void>(resolve => mock.server.listen(0,'127.0.0.1',resolve));
  const opened = await createApp({ directory, postgres, allowPrivate:true, logLevel:'silent' }).catch(error=>{
    mock.server.close();rmSync(directory,{recursive:true});rmSync(other,{recursive:true});throw error;
  });
  let { app, db } = opened;
  t.after(async () => { await app.close(); await new Promise<void>(resolve=>mock.server.close(()=>resolve())); rmSync(directory,{recursive:true});rmSync(other,{recursive:true}); });
  let owner = '', memberCookie = '', memberId = '', key: any, second: any;
  const call = (url:string, payload?:any, cookie=owner, method:any=payload===undefined?'GET':'POST') => app.inject({url,method,headers:{cookie},...(payload===undefined?{}:{payload})});
  const ok = async (url:string, payload?:any, cookie=owner, method?:any) => { const r=await call(url,payload,cookie,method);assert.equal(r.statusCode,200,r.body);return r.json(); };
  const chat=(token:string,extra:any={})=>app.inject({method:'POST',url:'/v1/chat/completions',headers:{authorization:'Bearer '+token},payload:{model:'chat',messages:[{role:'user',content:'hello'}],max_tokens:700,...extra}});
  await t.test('only one first owner wins concurrent setup; state and credentials persist', async()=>{
    const setup = await Promise.all([1,2].map(i=>call('/api/setup',{workspace:'PostgreSQL',name:'Owner',email:`owner${i}@example.test`,password:'owner-test-password'})));
    assert.deepEqual(setup.map(r=>r.statusCode).sort(),[200,409]);
    owner=String(setup.find(r=>r.statusCode===200)!.headers['set-cookie']).split(';')[0];
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM users'))!.count,1);
    assert.equal((await ok('/api/admin/state')).settings.storage,'PostgreSQL · single gateway instance');
    const provider=await ok('/api/admin/providers',{name:'Private',base_url:`http://127.0.0.1:${(mock.server.address() as any).port}/v1`,api_key:'synthetic-provider-secret'});
    const stored=await db.get('SELECT secret FROM providers WHERE id=?',provider.id);
    assert.notEqual(stored!.secret,'synthetic-provider-secret');assert.equal(db.unseal(stored!.secret),'synthetic-provider-secret');
    await ok('/api/admin/deployments',{provider_id:provider.id,alias:'chat',upstream_model:'slow',weight:1,input_price:2,output_price:4});
    await ok('/api/admin/deployments',{provider_id:provider.id,alias:'owner-only',upstream_model:'fast',weight:1,input_price:0,output_price:0});
    await db.run('INSERT INTO users VALUES (?,?,?,?,?,?,?)',id(),'default','Member','member@example.test',passwordHash('member-test-password'),'member',now());
    const login=await call('/api/login',{email:'member@example.test',password:'member-test-password'});assert.equal(login.statusCode,200,login.body);
    memberCookie=String(login.headers['set-cookie']).split(';')[0];memberId=(await db.get('SELECT id FROM users WHERE email=?','member@example.test'))!.id;
  });
  await t.test('owners grant models and allowances; members cannot bypass assignments',async()=>{
    assert.equal((await call('/api/admin/providers',{},memberCookie)).statusCode,403);
    await ok(`/api/admin/users/${memberId}/access`,{models:['chat'],provider_ids:[],policy_id:null,suspended:false},owner,'PUT');
    assert.equal((await call('/api/member/keys',{name:'Early',models:['chat']},memberCookie)).statusCode,403);
    await ok('/api/member/allowance-requests',{budget:null,token_limit:3000,limit_period:'lifetime',reason:'Test app'},memberCookie);
    const request=(await ok('/api/admin/team')).requests[0];
    await ok(`/api/admin/allowance-requests/${request.id}/resolve`,{decision:'approved',budget:1,token_limit:3000,limit_period:'lifetime'});
    const duplicate=await call(`/api/admin/allowance-requests/${request.id}/resolve`,{decision:'approved',budget:1,token_limit:3000,limit_period:'lifetime'});assert.equal(duplicate.statusCode,409);
    key=await ok('/api/member/keys',{name:'App',models:['chat']},memberCookie);second=await ok('/api/member/keys',{name:'Another app',models:['chat']},memberCookie);
    assert.equal((await call('/api/member/keys',{name:'Bypass',models:['owner-only']},memberCookie)).statusCode,403);
    const models=await app.inject({url:'/v1/models',headers:{authorization:'Bearer '+key.token}});assert.deepEqual(models.json().data.map((x:any)=>x.id),['chat']);
  });
  await t.test('concurrent application keys share one member cap; exact usage settles atomically',async()=>{
    const responses=await Promise.all([chat(key.token),chat(second.token)]);
    assert.deepEqual(responses.map(r=>r.statusCode).sort(),[200,429]);
    assert.equal((await db.memberSummary(memberId)).tokens_used,160);
    assert.equal((await db.memberSummary(memberId)).tokens_reserved,0);
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM reservations'))!.count,0);
    const usage=await ok('/api/admin/usage?period=all');assert.equal(usage.by_key.reduce((n:number,k:any)=>n+k.tokens,0),160);
    const stream=await chat(key.token,{max_tokens:128,stream:true});assert.equal(stream.statusCode,200);assert.match(stream.body,/\[DONE\]/);
    // Streaming sends its final bytes before async settlement; observe the committed ledger.
    for(let i=0;i<100 && (await db.memberSummary(memberId)).tokens_used!==320;i++)await new Promise(r=>setTimeout(r,10));
    assert.equal((await db.memberSummary(memberId)).tokens_used,320);
    assert.equal((await ok('/api/admin/state',undefined,memberCookie)).keys.length,2);
  });
  await t.test('key budget, guardrails, rotation and suspension still enforce access',async()=>{
    const policy=await ok('/api/admin/policies',{name:'No secret words',blocked_terms:['blockedphrase'],redact_pii:false,block_secrets:true});
    await ok(`/api/admin/keys/${key.id}/policy`,{policy_id:policy.id},owner,'PATCH');
    assert.equal((await chat(key.token,{messages:[{role:'user',content:'blockedphrase'}]})).statusCode,422);
    await db.run('UPDATE virtual_keys SET budget=1 WHERE id=?',key.id);
    assert.equal((await chat(key.token)).json().error.code,'budget_exceeded');
    await db.run('UPDATE virtual_keys SET budget=NULL WHERE id=?',key.id);
    const old=key.token;key.token=(await ok(`/api/member/keys/${key.id}/rotate`,{},memberCookie)).token;
    assert.equal((await chat(old)).statusCode,401);
    await ok(`/api/admin/users/${memberId}/access`,{models:['chat'],provider_ids:[],policy_id:null,suspended:true},owner,'PUT');
    assert.equal((await chat(key.token)).statusCode,403);
    assert.equal((await call('/api/admin/state',undefined,memberCookie)).statusCode,401);
    await ok(`/api/admin/users/${memberId}/access`,{models:['chat'],provider_ids:[],policy_id:null,suspended:false},owner,'PUT');
  });
  await t.test('second process cannot run recovery; restart retains sessions, secrets and usage',async()=>{
    await assert.rejects(PostgresAppStore.open(other,postgres),/conflict/);
    const prior=await db.memberSummary(memberId);
    await app.close();
    ({app,db}=await createApp({directory,postgres,allowPrivate:true,logLevel:'silent'}));
    assert.equal((await ok('/api/session')).setup,false);
    assert.equal((await db.memberSummary(memberId)).tokens_used,prior.tokens_used);
    assert.equal(db.unseal((await db.get('SELECT secret FROM providers LIMIT 1'))!.secret),'synthetic-provider-secret');
  });
  await t.test('database loss fails readiness and authentication closed without leaking connection strings',async()=>{
    // Kill the dedicated ownership connection, not the disposable database server.
    const admin=new PostgresDatabase(postgres);
    await admin.transaction(async tx=>{ await tx.query('SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype=\'advisory\' AND objid=719430103 AND pid<>pg_backend_pid()'); });
    await admin.close();
    for(let i=0;i<100;i++) {const r=await call('/ready');if(r.statusCode===503)break;await new Promise(r=>setTimeout(r,10));}
    assert.equal((await call('/ready')).statusCode,503);
    const r=await chat(key.token);assert.equal(r.statusCode,503);assert.ok(!r.body.includes(parsed.password));
    await app.close();
    const original=readFileSync(join(directory,'encryption.key'));
    writeFileSync(join(directory,'encryption.key'),Buffer.alloc(32));
    await assert.rejects(PostgresAppStore.open(directory,postgres),/invalid/);
    writeFileSync(join(directory,'encryption.key'),original);
  });
});

test('storage selection is explicit and cannot silently fall back to SQLite',()=>{
  assert.equal(postgresConfiguration({}),undefined);
  assert.throws(()=>postgresConfiguration({DATABASE_URL:url}),/GATE_STORAGE/);
  assert.throws(()=>postgresConfiguration({GATE_STORAGE:'postgres'}),/DATABASE_URL/);
  assert.throws(()=>postgresConfiguration({GATE_STORAGE:'postgres',DATABASE_URL:url,DATABASE_SSL_MODE:'prefer'}),/SSL_MODE/);
  assert.equal(postgresConfiguration({GATE_STORAGE:'postgres',DATABASE_URL:url})!.privateNetworkPlaintext,false);
});

test('verified SQLite backup imports atomically; keys, encrypted credentials and pending usage survive', async t=>{
  const { Store, id, now, hash, issueToken, passwordHash } = await import('../../server/store.ts');
  const { backupState, verifyBackup } = await import('../../server/maintenance.ts');
  const { importSqlite } = await import('../../server/postgres/import-sqlite.ts');
  const root=mkdtempSync(join(tmpdir(),'gate-pg-import-')),source=join(root,'source'),backup=join(root,'backup'),destination=join(root,'target');
  t.after(()=>rmSync(root,{recursive:true}));
  const admin=new PostgresDatabase(postgres);
  await admin.transaction(async tx=>{await tx.query('DROP SCHEMA gate_app CASCADE');});await admin.close();
  const sqlite=new Store(source),user=id(),provider=id(),keyId=id(),token=issueToken(),reservation=id();
  sqlite.run('INSERT INTO users VALUES (?,?,?,?,?,?,?)',user,'default','Imported owner','import@example.test',passwordHash('import-test-password'),'owner',now());
  sqlite.run('INSERT INTO providers (id,workspace_id,name,base_url,secret,created_at) VALUES (?,?,?,?,?,?)',provider,'default','Private','https://provider.example/v1',sqlite.seal('import-secret'),now());
  sqlite.run('INSERT INTO virtual_keys (id,workspace_id,name,owner,token_hash,prefix,models,budget,spent,reserved,rpm,max_request_tokens,created_at,user_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',keyId,'default','App','Owner',hash(token),token.slice(0,11),'["chat"]',1000000,7,5,60,2048,now(),user);
  sqlite.recordUsage(keyId,now(),7,100,60,40);sqlite.recordMemberUsage(user,now(),7,100);
  sqlite.run('INSERT INTO member_keys VALUES (?,?)',keyId,user);
  sqlite.run('INSERT INTO reservations (id,workspace_id,key_id,model,amount,created_at,token_amount) VALUES (?,?,?,?,?,?,?)',reservation,'default',keyId,'chat',5,now(),50);
  sqlite.run('INSERT INTO member_holds VALUES (?,?)',reservation,user);
  sqlite.run('INSERT INTO sessions VALUES (?,?,?)',hash('old-cookie'),user,Date.now()+60000);
  sqlite.close();backupState(source,backup);const before=verifyBackup(backup);
  const result=await importSqlite(backup,destination,postgres);assert.equal(result.counts.virtual_keys,1);
  const {app,db}=await createApp({directory:destination,postgres,logLevel:'silent'});
  try {
    const imported=await db.get('SELECT * FROM virtual_keys WHERE token_hash=?',hash(token));assert.equal(imported!.id,keyId);assert.equal(imported!.spent,12);assert.equal(imported!.reserved,0);
    assert.equal((await db.memberSummary(user)).tokens_used,150);
    assert.equal((await db.limitSummary(imported!)).tokens_used,150);
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM sessions'))!.count,0);
    assert.equal(db.unseal((await db.get('SELECT secret FROM providers WHERE id=?',provider))!.secret),'import-secret');
    const login=await app.inject({method:'POST',url:'/api/login',payload:{email:'import@example.test',password:'import-test-password'}});assert.equal(login.statusCode,200,login.body);
    assert.equal((await db.get("SELECT COUNT(*) AS count FROM requests WHERE status='interrupted'"))!.count,1);
  } finally {await app.close();}
  const reopened=await PostgresAppStore.open(destination,postgres);
  await reopened.recoverReservations();assert.equal((await reopened.memberSummary(user)).tokens_used,150);await reopened.close();
  // Exercise real pg_dump/pg_restore into a second disposable database.
  const container=process.env.GATE_TEST_POSTGRES_CONTAINER!;
  assert.match(container,/^gate-pg-test-[a-f0-9-]+$/);
  const dump=execFileSync('docker',['exec',container,'pg_dump','-U','postgres','-d','gate_test','-n','gate_app','-Fc']);
  execFileSync('docker',['exec',container,'createdb','-U','postgres','gate_restore']);
  execFileSync('docker',['exec','-i',container,'pg_restore','-U','postgres','-d','gate_restore','--exit-on-error','--no-owner','--no-privileges'],{input:dump});
  const restoredDirectory=join(root,'restored');mkdirSync(restoredDirectory,{mode:0o700});copyFileSync(join(destination,'encryption.key'),join(restoredDirectory,'encryption.key'));
  const restoreUrl=new URL(url);restoreUrl.pathname='/gate_restore';const restoredOptions={url:restoreUrl.toString(),localPlaintext:true};
  const {resetPostgresPassword}=await import('../../server/postgres/maintenance.ts');
  await resetPostgresPassword(restoredDirectory,restoredOptions,'import@example.test','restored-owner-password');
  const restored=await createApp({directory:restoredDirectory,postgres:restoredOptions,logLevel:'silent'});
  try {
    assert.equal((await restored.db.memberSummary(user)).tokens_used,150);
    assert.equal(restored.db.unseal((await restored.db.get('SELECT secret FROM providers WHERE id=?',provider))!.secret),'import-secret');
    assert.equal((await restored.db.get('SELECT COUNT(*) AS count FROM sessions'))!.count,0);
    const response=await restored.app.inject({method:'POST',url:'/api/login',payload:{email:'import@example.test',password:'restored-owner-password'}});assert.equal(response.statusCode,200,response.body);
  } finally {await restored.app.close();}
  // A second import must not append, overwrite or reset an existing installation.
  const refused=join(root,'refused');await assert.rejects(importSqlite(backup,refused,postgres));
  await assert.rejects(PostgresAppStore.open(refused,postgres),/did not complete/);
  assert.deepEqual(verifyBackup(backup),before);
  const untouched=new Store(source);assert.equal(untouched.get('SELECT spent FROM virtual_keys WHERE id=?',keyId)!.spent,7);assert.equal(untouched.get('SELECT COUNT(*) AS count FROM reservations')!.count,1);untouched.close();
});

test('PostgreSQL Bedrock migration preserves existing providers; native streaming settles the shared ledger', async t => {
  const { createHash } = await import('node:crypto');
  const { applicationSchema } = await import('../../server/postgres/app-schema.ts');
  const { now, issueToken, hash } = await import('../../server/store.ts');
  const directory = mkdtempSync(join(tmpdir(),'gate-pg-bedrock-'));
  t.after(()=>rmSync(directory,{recursive:true}));
  const admin = new PostgresDatabase(postgres);
  await admin.transaction(async tx=>{ await tx.query('DROP SCHEMA gate_app CASCADE'); });
  let db = await PostgresAppStore.open(directory,postgres);
  await db.run('INSERT INTO providers (id,workspace_id,name,base_url,secret,created_at) VALUES (?,?,?,?,?,?)','legacy','default','Legacy','https://old.example/v1',db.seal('legacy-secret'),now());
  await db.close();
  // Recreate the exact deployed version-1 schema metadata, keeping real data.
  await admin.transaction(async tx=>{
    await tx.query('ALTER TABLE gate_app.providers DROP COLUMN provider_type');
    await tx.query('ALTER TABLE gate_app.providers DROP COLUMN aws_region');
    await tx.query('DELETE FROM gate_app.schema_migrations WHERE version>=2');
  });
  db = await PostgresAppStore.open(directory,postgres);
  const old=await db.get('SELECT * FROM providers WHERE id=?','legacy');
  assert.equal(old!.provider_type,'openai'); assert.equal(old!.aws_region,null); assert.equal(db.unseal(old!.secret),'legacy-secret');
  const baseline=await db.get('SELECT checksum FROM schema_migrations WHERE version=1');
  assert.equal(baseline!.checksum,createHash('sha256').update(applicationSchema).digest('hex'));
  await db.run("UPDATE providers SET provider_type='bedrock',aws_region='us-west-2',secret='',base_url='https://bedrock-runtime.us-west-2.amazonaws.com' WHERE id='legacy'");
  await db.run('INSERT INTO deployments VALUES (?,?,?,?,?,?,?,?,?,0,0,?)','bedrock','default','legacy','llama','meta.llama3-1-8b-instruct-v1:0',1,0.22,0.44,1,now());
  const token=issueToken();
  await db.run('INSERT INTO virtual_keys (id,workspace_id,name,owner,token_hash,prefix,models,budget,rpm,max_request_tokens,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)','native-key','default','App','Owner',hash(token),token.slice(0,11),'["llama"]',1000000,60,2048,now());
  await db.close();
  const opened=await createApp({directory,postgres,logLevel:'silent',bedrockClientFactory:()=>({send:async()=>({stream:(async function*(){yield {messageStart:{role:'assistant'}};yield {contentBlockDelta:{delta:{text:'Hello'}}};yield {messageStop:{stopReason:'end_turn'}};yield {metadata:{usage:{inputTokens:12,outputTokens:4}}};})()}),destroy(){}} as any)});
  try {
    const response=await opened.app.inject({method:'POST',url:'/v1/chat/completions',headers:{authorization:'Bearer '+token},payload:{model:'llama',messages:[{role:'user',content:'hello'}],stream:true,max_tokens:32}});
    assert.equal(response.statusCode,200,response.body); assert.match(response.body,/\[DONE\]/);
    // Streaming closes the response before the final accounting transaction commits.
    let log;
    for(let attempt=0;attempt<100;attempt++){
      log=await opened.db.get('SELECT * FROM requests WHERE key_id=?','native-key');
      if(log)break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.ok(log,'Streaming accounting must commit within the bounded observation window.');
    assert.equal(log.cost,5);assert.equal(log!.input_tokens,12);assert.equal(log!.output_tokens,4);assert.equal(log!.estimated,0);
    assert.equal((await opened.db.get('SELECT reserved FROM virtual_keys WHERE id=?','native-key'))!.reserved,0);
  } finally {await opened.app.close();await admin.close();}
});

test('PostgreSQL invitations and notifications survive restart with atomic acceptance and durable retries',async t=>{
  const admin=new PostgresDatabase(postgres);await admin.transaction(async tx=>{await tx.query('DROP SCHEMA gate_app CASCADE');});await admin.close();
  const directory=mkdtempSync(join(tmpdir(),'gate-pg-notifications-'));let sends=0,fail=true;
  const transport={email:true,sns:false,async send(){if(fail)throw new Error('private SES error');sends++;return 'provider-accepted';}};
  const options={directory,postgres,publicBaseUrl:'http://localhost:4310',notificationWorker:false,notificationTransport:transport,logLevel:'silent' as const};
  let current=await createApp(options);
  t.after(async()=>{await current.app.close();rmSync(directory,{recursive:true,force:true});});
  const setup=await current.app.inject({method:'POST',url:'/api/setup',payload:{workspace:'Queue test',name:'Owner',email:'owner@example.test',password:'owner-test-password'}});assert.equal(setup.statusCode,200,setup.body);
  const cookie=String(setup.headers['set-cookie']).split(';')[0];
  const call=(path:string,payload?:any,method:any=payload===undefined?'GET':'POST')=>current.app.inject({url:'/api'+path,method,headers:{cookie},...(payload===undefined?{}:{payload})});
  const invite=await call('/admin/invitations',{name:'Member',email:'invited@example.test',send_email:true});assert.equal(invite.statusCode,200,invite.body);
  const link=invite.json().link,token=new URL(link).hash.slice(7);
  await current.notifications.tick();assert.equal((await current.db.get('SELECT attempts FROM notification_deliveries'))!.attempts,1);
  await current.app.close();current=await createApp(options);
  assert.equal((await current.db.get('SELECT COUNT(*) AS n FROM invitations'))!.n,1);
  fail=false;await current.db.run('UPDATE notification_deliveries SET next_at=0');await current.notifications.tick();assert.equal(sends,1);assert.equal((await current.db.get('SELECT payload FROM notification_deliveries'))!.payload,'');
  const accept=()=>call('/invitations/accept',{token,password:'new-member-password',confirm_password:'new-member-password'});
  const results=await Promise.all([accept(),accept()]);assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,400]);
  const user=(await current.db.get("SELECT * FROM users WHERE email='invited@example.test'"))!;
  assert.equal((await current.db.get('SELECT COUNT(*) AS n FROM member_allowances'))!.n,0);
  await current.db.run('INSERT INTO member_allowances VALUES (?,?,?,?,?)',user.id,1000000,1000,'monthly',null);
  await current.db.transaction(async()=>{await current.db.recordMemberUsage(user.id,'2026-10-29T00:00:00.000Z',900000,900);});
  await current.notifications.tick();assert.equal((await current.db.get('SELECT COUNT(*) AS n FROM notifications'))!.n,4);
  await current.db.transaction(async()=>{await current.db.recordMemberUsage(user.id,'2026-10-29T00:00:00.000Z',1,1);});await current.notifications.tick();assert.equal((await current.db.get('SELECT COUNT(*) AS n FROM notifications'))!.n,4);
  // Recovered worker claims are retried after a lease expires; no raw token leaks through history.
  const queued=await call('/admin/invitations',{name:'Recovery',email:'recovery@example.test',send_email:true});assert.equal(queued.statusCode,200,queued.body);
  await current.db.run("UPDATE notification_deliveries SET status='sending',lease_until=0,claim='crashed-worker' WHERE invitation_id=?",queued.json().id);
  await current.notifications.tick();assert.equal(sends,2);
  const history=await call('/admin/notifications');assert.equal(history.statusCode,200);assert.ok(!history.body.includes(token));assert.ok(!history.body.includes('private SES error'));
});

// Shares exactly the same role contract with SQLite.
import { adminScenario } from '../fixtures/admin-scenario.ts';
import { notificationSchema } from '../../server/notification-schema.ts';
test('PostgreSQL admin authorization and schema 3 upgrade',async t=>{
  const maintenance=new PostgresDatabase(postgres);
  await maintenance.transaction(async tx=>{await tx.query('DROP SCHEMA gate_app CASCADE');});
  const directory=mkdtempSync(join(tmpdir(),'gate-pg-admin-'));
  let storage=await PostgresAppStore.open(directory,postgres);
  // Simulate the previous published constraint and metadata, retaining pending data.
  await storage.run('INSERT INTO invitations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)','legacy-invite','default','old-issuer','Legacy','legacy@roles.test','member','legacy-hash','[]',null,'pending',Date.now()+86400000,now());
  await storage.run('INSERT INTO notification_deliveries (id,workspace_id,invitation_id,channel,dedupe,title,payload,status,next_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)','legacy-delivery','default','legacy-invite','email','legacy','Invite','ciphertext','pending',0,now());
  await storage.close();
  await maintenance.transaction(async tx=>{
    await tx.query('ALTER TABLE gate_app.invitations DROP CONSTRAINT invitations_role_check');
    await tx.query("ALTER TABLE gate_app.invitations ADD CONSTRAINT invitations_role_check CHECK(role IN ('member','viewer'))");
    await tx.query('DELETE FROM gate_app.schema_migrations WHERE version=4');
  });
  await maintenance.close();
  const opened=await createApp({directory,postgres,allowPrivate:true,logLevel:'silent',publicBaseUrl:'http://localhost:4310',notificationWorker:false,notificationTransport:{email:true,sns:false,async send(){return 'test';}}});
  t.after(async()=>{await opened.app.close();rmSync(directory,{recursive:true});});
  assert.equal((await opened.db.get("SELECT token_hash FROM invitations WHERE id='legacy-invite'"))!.token_hash,'legacy-hash');
  assert.equal((await opened.db.get("SELECT invitation_id FROM notification_deliveries WHERE id='legacy-delivery'"))!.invitation_id,'legacy-invite');
  assert.equal((await opened.db.get('SELECT checksum FROM schema_migrations WHERE version=3'))!.checksum,createHash('sha256').update(notificationSchema).digest('hex'));
  await adminScenario(t,opened);
});
