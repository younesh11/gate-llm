import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.ts';
import { Store, id, now } from '../server/store.ts';
import { mockProvider } from '../scripts/mock-provider.ts';

test('members control only their own keys and share owner-approved spending authority', async t=>{
  const directory=mkdtempSync(join(tmpdir(),'gate-members-')),mock=mockProvider();
  await new Promise<void>(resolve=>mock.server.listen(0,'127.0.0.1',resolve));
  const {app,db}=await createApp({directory,allowPrivate:true,logLevel:'silent'});
  t.after(async()=>{await app.close();await new Promise<void>(resolve=>mock.server.close(()=>resolve()));rmSync(directory,{recursive:true});});
  const setup=await app.inject({method:'POST',url:'/api/setup',payload:{workspace:'Test',name:'Owner',email:'owner@example.test',password:'owner-test-password'}});
  const owner=String(setup.headers['set-cookie']).split(';')[0];
  const call=(path:string,body?:any,cookie=owner,method:any=body===undefined?'GET':'POST')=>app.inject({url:'/api'+path,method,headers:{cookie},...(body===undefined?{}:{payload:body})});
  const ok=async(path:string,body?:any,cookie=owner,method?:any)=>{const r=await call(path,body,cookie,method);assert.equal(r.statusCode,200,r.body);return r.json();};
  const provider=await ok('/admin/providers',{name:'Private provider',base_url:`http://127.0.0.1:${(mock.server.address() as any).port}/v1`,api_key:'private-provider-token'});
  await ok('/admin/deployments',{provider_id:provider.id,alias:'chat',upstream_model:'slow',weight:1,input_price:1000,output_price:1000});
  await ok('/admin/deployments',{provider_id:provider.id,alias:'owner-only',upstream_model:'fast',weight:1,input_price:0,output_price:0});
  const ownerKey=await ok('/admin/keys',{name:'Owner key secret name',owner:'Owner',models:['chat'],budget:10,rpm:60,max_request_tokens:8192});
  async function account(name:string){await ok('/admin/users',{name,email:name+'@example.test',password:'member-test-password',role:'member'});const response=await call('/login',{email:name+'@example.test',password:'member-test-password'});assert.equal(response.statusCode,200);return {cookie:String(response.headers['set-cookie']).split(';')[0],id:db.get('SELECT id FROM users WHERE email=?',name.toLowerCase()+'@example.test')!.id};}
  const alice=await account('Alice'),bob=await account('Bob');
  const access=(user=alice,extra:any={})=>ok(`/admin/users/${user.id}/access`,{models:['chat'],provider_ids:[],policy_id:null,suspended:false,...extra},owner,'PUT');
  const requestAllowance=async(user=alice,extra:any={})=>{await ok('/member/allowance-requests',{budget:null,token_limit:3000,limit_period:'lifetime',reason:'Development',...extra},user.cookie);return db.get("SELECT * FROM allowance_requests WHERE user_id=? AND status='pending'",user.id)!;};
  const approve=async(user=alice,extra:any={})=>{const request=await requestAllowance(user);await ok(`/admin/allowance-requests/${request.id}/resolve`,{decision:'approved',budget:null,token_limit:3000,limit_period:'lifetime',...extra});return request;};
  const makeKey=(user=alice)=>ok('/member/keys',{name:'Personal '+user.id,models:['chat'],max_request_tokens:2048},user.cookie);
  const chat=(token:string,extra:any={})=>app.inject({method:'POST',url:'/v1/chat/completions',headers:{authorization:'Bearer '+token},payload:{model:'chat',messages:[{role:'user',content:'hello'}],max_tokens:128,...extra}});
  let a:any,b:any;
  await t.test('members default to no model or budget authority; admin and CSRF boundaries cannot be bypassed',async()=>{
    assert.equal((await call('/member/keys',{name:'No access',models:['chat']},alice.cookie)).statusCode,403);
    for(const path of ['/admin/deployments','/admin/%64eployments','/admin/users','/admin/providers','/admin/keys'])assert.equal((await call(path,{},alice.cookie)).statusCode,403);
    assert.equal((await call('/admin/team',undefined,alice.cookie)).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:'/api/member/allowance-requests',headers:{cookie:alice.cookie,origin:'https://evil.test'},payload:{}})).statusCode,403);
    await access();assert.equal((await call('/member/keys',{name:'No allowance',models:['chat']},alice.cookie)).statusCode,403);
    const ownerAssigned=await ok('/admin/keys',{name:'Assigned',owner:'Alice',user_id:alice.id,models:['chat'],budget:null,rpm:60,max_request_tokens:2048});
    assert.equal((await chat(ownerAssigned.token)).json().error.code,'member_allowance_required');
  });
  await t.test('owner resolves a single request atomically; member cannot approve or set caps while creating keys',async()=>{
    const r=await requestAllowance();assert.equal((await call('/member/allowance-requests',{budget:1,token_limit:null,limit_period:'daily',reason:'Duplicate'},alice.cookie)).statusCode,409);
    assert.equal((await call(`/admin/allowance-requests/${r.id}/resolve`,{},alice.cookie)).statusCode,403);
    await ok(`/admin/allowance-requests/${r.id}/resolve`,{decision:'approved',budget:null,token_limit:3000,limit_period:'lifetime'});
    assert.equal((await call(`/admin/allowance-requests/${r.id}/resolve`,{decision:'approved',budget:null,token_limit:3000,limit_period:'lifetime'})).statusCode,409);
    assert.equal((await call('/member/keys',{name:'Bypass',models:['chat'],budget:100000,user_id:bob.id},alice.cookie)).statusCode,400);
    assert.equal((await call('/member/keys',{name:'Bypass',models:['owner-only']},alice.cookie)).statusCode,403);
    a=await makeKey();await access(bob);await approve(bob);b=await makeKey(bob);
  });
  await t.test('state, usage, key IDs and rotation cannot expose another member or owner',async()=>{
    const state=await ok('/admin/state',undefined,alice.cookie);assert.equal(state.keys.length,1);assert.equal(state.keys[0].id,a.id);assert.equal(state.models.length,1);
    for(const marker of [b.id,ownerKey.id,'Owner key secret name','private-provider-token','owner-only','password_hash','token_hash'])assert.ok(!JSON.stringify(state).includes(marker),marker);
    assert.deepEqual(state.providers,[]);
    for(const action of ['rotate','revoke'])assert.equal((await call(`/member/keys/${b.id}/${action}`,{},alice.cookie)).statusCode,404);
    assert.equal((await call(`/member/keys/${b.id}`,{name:'stolen',models:['chat']},alice.cookie,'PUT')).statusCode,404);
    const report=await ok('/admin/usage?period=all',undefined,alice.cookie);assert.deepEqual(report.by_key.map((r:any)=>r.id),[a.id]);
    const models=await app.inject({url:'/v1/models',headers:{authorization:'Bearer '+a.token}});assert.deepEqual(models.json().data.map((r:any)=>r.id),['chat']);
  });
  await t.test('simultaneous calls on different keys cannot reserve the same shared tokens',async()=>{
    const second=await makeKey();
    const results=await Promise.all([chat(a.token,{max_tokens:700}),chat(second.token,{max_tokens:700})]);
    assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,429]);assert.equal(db.memberSummary(alice.id).tokens_used,160);assert.equal(db.memberSummary(alice.id).tokens_reserved,0);
    await ok(`/member/keys/${second.id}/revoke`,{},alice.cookie);
    const rotated=await ok(`/member/keys/${a.id}/rotate`,{},alice.cookie);assert.equal((await chat(a.token)).statusCode,401);a.token=rotated.token;
    assert.equal(db.memberSummary(alice.id).tokens_used,160);
    assert.equal((await chat(a.token,{stream:true})).statusCode,200);assert.equal(db.memberSummary(alice.id).tokens_used,320);
    assert.equal((await chat(b.token)).statusCode,200);assert.equal(db.memberSummary(bob.id).tokens_used,160);
  });
  await t.test('budget and combined tokens both gate admission; approvals retain previous usage',async()=>{
    await approve(alice,{budget:0.32,token_limit:10000});
    assert.equal((await chat(a.token)).json().error.code,'member_budget_exceeded');
    await approve(alice,{budget:100,token_limit:320});
    assert.equal((await chat(a.token)).json().error.code,'member_tokens_exceeded');
    assert.equal(db.memberSummary(alice.id).tokens_used,320);
    await approve(alice,{budget:null,token_limit:10000});
    const r=await requestAllowance();await ok(`/admin/allowance-requests/${r.id}/resolve`,{decision:'rejected',budget:null,token_limit:1,limit_period:'daily',note:'Keep current limits'});
    assert.equal(db.memberSummary(alice.id).token_limit,10000);assert.equal(db.memberSummary(alice.id).limit_period,'lifetime');
    db.run('UPDATE member_allowances SET expires_at=? WHERE user_id=?','2000-01-01T00:00:00Z',alice.id);assert.equal((await chat(a.token)).json().error.code,'member_allowance_required');
    db.run('UPDATE member_allowances SET expires_at=NULL WHERE user_id=?',alice.id);
  });
  await t.test('model removal, required guardrails and suspension apply to existing keys',async()=>{
    await access(alice,{models:[]});assert.equal((await chat(a.token)).json().error.code,'model_not_assigned');
    const p=await ok('/admin/policies',{name:'Required',blocked_terms:['forbidden'],redact_pii:true,block_secrets:true});
    await access(alice,{policy_id:p.id});const before=mock.captured.length;assert.equal((await chat(a.token,{messages:[{role:'user',content:'forbidden'}]})).statusCode,422);assert.equal(mock.captured.length,before);
    assert.equal((await call(`/member/keys/${a.id}`,{name:'Try bypass',models:['chat'],policy_id:null},alice.cookie,'PUT')).statusCode,400);
    await access(alice,{suspended:true});assert.equal((await call('/admin/state',undefined,alice.cookie)).statusCode,401);assert.equal((await chat(a.token)).json().error.code,'member_suspended');
    await access();const login=await call('/login',{email:'Alice@example.test',password:'member-test-password'});alice.cookie=String(login.headers['set-cookie']).split(';')[0];assert.equal(login.statusCode,200);
  });
  await t.test('delegation is provider-scoped and requires owner pricing; approval grants neither access nor budget',async()=>{
    const body={provider_id:provider.id,alias:'alice-new',upstream_model:'fast'};
    assert.equal((await call('/member/deployment-requests',body,alice.cookie)).statusCode,403);
    await access(alice,{provider_ids:[provider.id]});assert.equal((await call('/member/deployment-requests',{...body,input_price:0},alice.cookie)).statusCode,400);
    assert.equal((await call('/member/deployment-requests',{...body,alias:'chat'},alice.cookie)).statusCode,409);
    await ok('/member/deployment-requests',body,alice.cookie);
    assert.equal(db.get('SELECT id FROM deployments WHERE alias=?',body.alias),undefined);
    const r=db.get('SELECT id FROM deployment_requests WHERE alias=?',body.alias)!;
    await ok(`/admin/deployment-requests/${r.id}/resolve`,{decision:'approved',input_price:0.25,output_price:0.75});
    const deployed=db.get('SELECT * FROM deployments WHERE alias=?',body.alias)!;assert.equal(deployed.input_price,0.25);assert.equal(deployed.output_price,0.75);
    assert.ok(!(await ok('/admin/state',undefined,alice.cookie)).models.some((m:any)=>m.alias===body.alias));
  });
  await t.test('removal revokes personal keys and preserves usage rather than freeing their allowance',async()=>{
    const before=db.memberSummary(alice.id).tokens_used;
    await ok(`/admin/users/${alice.id}`,undefined,owner,'DELETE');assert.equal((await chat(a.token)).statusCode,401);assert.equal(db.get('SELECT SUM(tokens) AS tokens FROM member_usage WHERE user_id=?',alice.id)!.tokens,before);
    assert.equal((await call('/admin/state',undefined,alice.cookie)).statusCode,401);
  });
});

test('member ledger survives key reassignment, crash recovery and calendar resets',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'gate-member-ledger-'));
  let db=new Store(directory);t.after(()=>{db.close();rmSync(directory,{recursive:true});});
  const user=id(),key=id(),reservation=id();db.run('INSERT INTO users VALUES (?,?,?,?,?,?,?)',user,'default','Member','ledger@example.test','unused','member',now());
  db.run('INSERT INTO virtual_keys (id,workspace_id,name,owner,token_hash,prefix,models,budget,rpm,max_request_tokens,created_at,user_id) VALUES (?,?,?,?,?,?,?,NULL,60,2048,?,?)',key,'default','Key','Member','hash','prefix','["chat"]',now(),user);
  db.run('INSERT INTO member_allowances VALUES (?,?,?, ?,NULL)',user,1000000,10000,'monthly');
  db.recordMemberUsage(user,'2000-01-01T00:00:00Z',100,200);
  db.run('INSERT INTO reservations (id,workspace_id,key_id,model,amount,created_at,token_amount) VALUES (?,?,?,?,?,?,?)',reservation,'default',key,'chat',250,now(),500);
  db.run('INSERT INTO member_holds VALUES (?,?)',reservation,user);
  db.run('UPDATE virtual_keys SET user_id=NULL WHERE id=?',key);db.close();db=new Store(directory);
  assert.equal(db.memberSummary(user).tokens_reserved,500);db.recoverReservations();assert.equal(db.memberSummary(user).tokens_used,500);assert.equal(db.memberSummary(user).tokens_reserved,0);
  db.recoverReservations();assert.equal(db.memberSummary(user).tokens_used,500);
  db.run("UPDATE member_allowances SET limit_period='lifetime' WHERE user_id=?",user);assert.equal(db.memberSummary(user).tokens_used,700);
  db.run("UPDATE member_allowances SET limit_period='daily' WHERE user_id=?",user);assert.equal(db.memberSummary(user,Date.now()+86400000).tokens_used,0);
});

test('schema 4 upgrade and backups preserve assigned usage, holds and member permissions',async t=>{
  const {backupState,restoreState,verifyBackup}=await import('../server/maintenance.ts');
  const root=mkdtempSync(join(tmpdir(),'gate-member-upgrade-')),source=join(root,'source');
  let db=new Store(source);t.after(()=>{db.close();rmSync(root,{recursive:true});});
  const user=id(),key=id(),reservation=id();
  db.run('INSERT INTO users VALUES (?,?,?,?,?,?,?)',user,'default','Existing','existing@example.test','unused','viewer',now());
  db.run('INSERT INTO virtual_keys (id,workspace_id,name,owner,token_hash,prefix,models,budget,rpm,max_request_tokens,created_at,user_id,spent) VALUES (?,?,?,?,?,?,?,NULL,60,2048,?,?,?)',key,'default','Existing key','Existing','hash','prefix','["chat"]',now(),user,100);
  db.recordUsage(key,now(),100,500);
  db.run('INSERT INTO reservations (id,workspace_id,key_id,model,amount,created_at,token_amount) VALUES (?,?,?,?,?,?,?)',reservation,'default',key,'chat',50,now(),1000);
  db.db.exec('DROP TABLE member_keys; DROP TABLE member_holds; DROP TABLE member_usage; DROP TABLE member_allowances; DROP TABLE member_access; DROP TABLE allowance_requests; DROP TABLE deployment_requests; PRAGMA user_version=4;');
  db.close();backupState(source,join(root,'backup4'));assert.equal(verifyBackup(join(root,'backup4')).schema_version,4);
  db=new Store(source);assert.equal(db.memberSummary(user).tokens_used,500);assert.equal(db.memberSummary(user).tokens_reserved,1000);assert.equal(db.get('SELECT role FROM users WHERE id=?',user)!.role,'viewer');
  db.run('INSERT INTO member_access VALUES (?,?,?,?,?)',user,'["chat"]','[]',null,0);
  db.run('INSERT INTO member_allowances VALUES (?,?,?,?,?)',user,1000000,50000,'monthly',null);db.close();
  backupState(source,join(root,'backup5'));assert.equal(verifyBackup(join(root,'backup5')).schema_version,5);
  restoreState(join(root,'backup5'),join(root,'restored'));db=new Store(join(root,'restored'));
  assert.equal(db.memberSummary(user).token_limit,50000);assert.equal(db.get('SELECT models FROM member_access WHERE user_id=?',user)!.models,'["chat"]');
  db.recoverReservations();assert.equal(db.memberSummary(user).tokens_used,1500);assert.equal(db.memberSummary(user).tokens_reserved,0);
});
