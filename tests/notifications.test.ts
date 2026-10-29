import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.ts';
import { id, now, passwordHash, hash } from '../server/store.ts';
import { publicBaseUrl } from '../server/notifications.ts';
import { awsNotificationTransport, type DeliveryMessage } from '../server/notification-transport.ts';

async function fixture(t:any) {
  const directory=mkdtempSync(join(tmpdir(),'gate-notifications-')),sent:DeliveryMessage[]=[],logs:string[]=[];
  let fail=false;
  const transport={email:true,sns:true,async send(message:DeliveryMessage){if(fail)throw new Error('secret-provider-error');sent.push(message);return 'test-message-id';}};
  const opened=await createApp({directory,notificationTransport:transport,notificationWorker:false,publicBaseUrl:'http://localhost:4310',logDestination:{write:line=>logs.push(line)}});
  const {app,db}=opened;
  t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
  const setup=await app.inject({method:'POST',url:'/api/setup',payload:{workspace:'Test',name:'Owner',email:'owner@example.test',password:'owner-test-password'}});assert.equal(setup.statusCode,200,setup.body);
  const cookie=String(setup.headers['set-cookie']).split(';')[0];
  const call=(path:string,body?:any,method:any=body===undefined?'GET':'POST',session=cookie)=>app.inject({method,url:'/api'+path,headers:{cookie:session},...(body===undefined?{}:{payload:body})});
  const ok=async(path:string,body?:any,method?:any,session?:string)=>{const r=await call(path,body,method,session);assert.equal(r.statusCode,200,r.body);return r.json();};
  const invite=async(email='new@example.test',extra:any={})=>ok('/admin/invitations',{name:'New Person',email,...extra});
  const token=(link:string)=>new URL(link).hash.slice('#token='.length);
  const accept=(link:string)=>call('/invitations/accept',{token:token(link),password:'new-user-password',confirm_password:'new-user-password'});
  return {...opened,sent,logs,call,ok,invite,token,accept,fail:(value:boolean)=>{fail=value;}};
}

test('invitation activation is one-use, atomic, private, and grants no budget or deployment rights',async t=>{
  const f=await fixture(t),result=await f.invite();
  assert.ok(result.link.startsWith('http://localhost:4310/invite#token='));
  const token=f.token(result.link);assert.equal(f.db.get('SELECT token_hash FROM invitations WHERE id=?',result.id)!.token_hash,hash(token));
  assert.ok(!(await f.ok('/admin/invitations')).items.some((r:any)=>'token_hash' in r||'link' in r));
  const peek=await f.ok('/invitations/inspect',{token});assert.equal(peek.email,'new@example.test');assert.equal(f.db.get('SELECT status FROM invitations WHERE id=?',result.id)!.status,'pending');
  const results=await Promise.all([f.accept(result.link),f.accept(result.link)]);assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,400]);
  assert.ok(results.every(r=>!r.headers['set-cookie']));
  assert.equal(f.db.get("SELECT COUNT(*) AS n FROM users WHERE email='new@example.test'")!.n,1);
  const user=f.db.get("SELECT * FROM users WHERE email='new@example.test'")!;assert.equal(user.role,'member');assert.equal(f.db.get('SELECT * FROM member_allowances WHERE user_id=?',user.id),undefined);assert.equal(f.db.get('SELECT provider_ids FROM member_access WHERE user_id=?',user.id)!.provider_ids,'[]');
  const login=await f.ok('/login',{email:'new@example.test',password:'new-user-password'});assert.equal(login.ok,true);
  assert.equal((await f.accept(result.link)).statusCode,400);
  assert.ok(!f.logs.join('').includes(token));assert.ok(!f.logs.join('').includes('new-user-password'));
});

test('invitation rotation, expiry, revocation and issuer suspension invalidate links and queued mail',async t=>{
  const f=await fixture(t),first=await f.invite('rotate@example.test',{send_email:true});
  const row=f.db.get('SELECT * FROM notification_deliveries WHERE invitation_id=?',first.id)!;assert.ok(!row.payload.includes(f.token(first.link)));assert.ok(f.db.unseal(row.payload).includes(first.link));
  const second=await f.ok(`/admin/invitations/${first.id}/regenerate`,{send_email:true});
  assert.equal((await f.accept(first.link)).statusCode,400);
  assert.equal(f.db.get('SELECT payload FROM notification_deliveries WHERE id=?',row.id)!.payload,'');
  await f.ok(`/admin/invitations/${second.id}/revoke`,{});await f.notifications.tick();assert.equal(f.sent.length,0);assert.equal((await f.accept(second.link)).statusCode,400);
  const expired=await f.invite('expired@example.test');f.db.run('UPDATE invitations SET expires_at=? WHERE id=?',Date.now()-1,expired.id);assert.equal((await f.accept(expired.link)).statusCode,400);
  const suspended=await f.invite('suspended@example.test',{send_email:true});const issuer=f.db.get('SELECT issuer_id FROM invitations WHERE id=?',suspended.id)!.issuer_id;
  f.db.run('INSERT INTO member_access VALUES (?,?,?,?,?)',issuer,'[]','[]',null,1);
  assert.equal((await f.accept(suspended.link)).statusCode,400);await f.notifications.tick();assert.equal(f.sent.length,0);
});

test('invitation API rejects privilege escalation, existing accounts, removed grants and cross-origin requests',async t=>{
  const f=await fixture(t);
  assert.equal((await f.call('/admin/users',{name:'Old',password:'owner-chosen-password'})).statusCode,410);
  assert.equal((await f.call('/admin/invitations',{name:'Bad',email:'bad@example.test',role:'owner'})).statusCode,400);
  assert.equal((await f.call('/admin/invitations',{name:'Bad',email:'owner@example.test'})).statusCode,409);
  assert.equal((await f.call('/admin/invitations',{name:'Bad',email:'bad@example.test',models:['missing']})).statusCode,400);
  const invite=await f.invite();assert.equal((await f.call('/admin/invitations',{name:'Again',email:'new@example.test'})).statusCode,409);
  const mismatch=await f.call('/invitations/accept',{token:f.token(invite.link),password:'abcdefghijkl',confirm_password:'different-password'});assert.equal(mismatch.statusCode,400);
  const csrf=await f.app.inject({method:'POST',url:'/api/invitations/accept',headers:{host:'attacker.test',origin:'http://attacker.test'},payload:{token:f.token(invite.link),password:'new-user-password',confirm_password:'new-user-password'}});assert.equal(csrf.statusCode,403);
  assert.equal((await f.accept(invite.link)).statusCode,200);
  const login=await f.call('/login',{email:'new@example.test',password:'new-user-password'});const member=String(login.headers['set-cookie']).split(';')[0];
  for(const path of ['/admin/invitations','/admin/notifications','/admin/%69nvitations'])assert.equal((await f.call(path,undefined,'GET',member)).statusCode,403);
  assert.equal((await f.call('/admin/invitations',{},'POST',member)).statusCode,403);
});

test('budget alerts deduplicate by key/member, metric, threshold and UTC budget period',async t=>{
  const f=await fixture(t),db=f.notifications.db;
  await f.ok('/admin/notifications',{enabled:true,thresholds:[70,90,100],owners:true,affected_user:true,email:true,sns:true},'PUT');
  const member=id();f.db.run('INSERT INTO users VALUES (?,?,?,?,?,?,?)',member,'default','Member','member@example.test',passwordHash('member-password'),'member',now());
  const provider=await f.ok('/admin/providers',{name:'Mock',base_url:'https://1.1.1.1/v1'});
  await f.ok('/admin/deployments',{provider_id:provider.id,alias:'chat',upstream_model:'chat',weight:1,input_price:1,output_price:1});
  const key=await f.ok('/admin/keys',{name:'Application',owner:'Member',models:['chat'],budget:1,token_limit:1000,rpm:60,max_request_tokens:2048,user_id:member,limit_period:'daily'});
  const record=async(day:string,cost:number,tokens:number)=>db.transaction(async()=>{await db.recordUsage(key.id,day+'T10:00:00.000Z',cost,tokens);});
  await record('2026-10-28',700000,700);await f.notifications.tick();
  assert.equal(f.db.get('SELECT COUNT(*) AS n FROM notifications')!.n,4);assert.equal(f.sent.length,6);
  await record('2026-10-28',10000,10);await f.notifications.tick();assert.equal(f.sent.length,6);
  await record('2026-10-29',700000,700);await f.notifications.tick();assert.equal(f.sent.length,12);
  await record('2026-10-29',300000,300);await f.notifications.tick();assert.equal(f.db.get('SELECT COUNT(*) AS n FROM notifications')!.n,16);
  assert.equal(f.db.get('SELECT COUNT(*) AS n FROM alert_pending')!.n,0);
  f.db.run('INSERT INTO member_allowances VALUES (?,?,?,?,?)',member,null,1000,'monthly',null);
  await db.transaction(async()=>{await db.recordMemberUsage(member,'2026-10-29T10:00:00.000Z',0,900);});await f.notifications.tick();
  assert.equal(f.db.get("SELECT COUNT(*) AS n FROM notifications WHERE dedupe LIKE 'budget:member:%'")!.n,4);
  const inbox=await f.ok('/member/notifications');const first=inbox.items[0];await f.ok(`/member/notifications/${first.id}/read`,{});assert.equal((await f.ok('/member/notifications')).unread,inbox.unread-1);
  const login=await f.call('/login',{email:'member@example.test',password:'member-password'});const memberCookie=String(login.headers['set-cookie']).split(';')[0];
  const own=await f.ok('/member/notifications',undefined,'GET',memberCookie);assert.ok(own.items.every((item:any)=>item.id!==first.id));
  const unread=f.db.get('SELECT id FROM notifications WHERE user_id<>? AND read_at IS NULL LIMIT 1',member)!;
  await f.ok(`/member/notifications/${unread.id}/read`,{},'POST',memberCookie);assert.equal(f.db.get('SELECT read_at FROM notifications WHERE id=?',unread.id)!.read_at,null);
});

test('outbox retries safely, removes invite payload after acceptance, and reports terminal failure without secrets',async t=>{
  const f=await fixture(t),invite=await f.invite('mail@example.test',{send_email:true});f.fail(true);
  await f.notifications.tick();let delivery=f.db.get('SELECT * FROM notification_deliveries WHERE invitation_id=?',invite.id)!;assert.equal(delivery.attempts,1);assert.equal(delivery.status,'pending');
  await f.notifications.tick();assert.equal(f.db.get('SELECT attempts FROM notification_deliveries WHERE id=?',delivery.id)!.attempts,1);
  f.fail(false);f.db.run('UPDATE notification_deliveries SET next_at=0 WHERE id=?',delivery.id);await Promise.all([f.notifications.tick(),f.notifications.tick()]);
  delivery=f.db.get('SELECT * FROM notification_deliveries WHERE id=?',delivery.id)!;assert.equal(delivery.status,'accepted');assert.equal(delivery.payload,'');assert.equal(f.sent.length,1);
  assert.equal(f.sent[0].channel,'email');assert.ok(f.sent[0].body.includes(invite.link));assert.equal(f.sent[0].to,'mail@example.test');
  const failing=await f.invite('failed@example.test',{send_email:true});f.fail(true);
  for(let i=0;i<5;i++){f.db.run('UPDATE notification_deliveries SET next_at=0 WHERE invitation_id=?',failing.id);await f.notifications.tick();}
  const failed=f.db.get('SELECT * FROM notification_deliveries WHERE invitation_id=?',failing.id)!;assert.equal(failed.status,'failed');assert.equal(failed.attempts,5);assert.equal(failed.payload,'');
  const history=await f.ok('/admin/notifications');assert.ok(!JSON.stringify(history).includes('secret-provider-error'));assert.ok(!JSON.stringify(history).includes(f.token(invite.link)));assert.ok(!f.logs.join('').includes('secret-provider-error'));
});

test('notification settings reject unconfigured transports and public invite APIs are rate limited',async t=>{
  const f=await fixture(t);assert.throws(()=>publicBaseUrl('http://16.60.247.3:8443'));assert.throws(()=>publicBaseUrl('https://example.com/other'));assert.equal(publicBaseUrl('https://gate.example.com:8443'),'https://gate.example.com:8443');
  assert.equal(awsNotificationTransport({}).email,false);assert.throws(()=>awsNotificationTransport({NOTIFICATION_EMAIL_FROM:'test@example.com'}));
  const invalid=await f.call('/admin/notifications',{enabled:true,thresholds:[0,110],owners:true,affected_user:false,email:false,sns:false},'PUT');assert.equal(invalid.statusCode,400);
  for(let i=0;i<30;i++)await f.call('/invitations/inspect',{token:'a'.repeat(43)});
  assert.equal((await f.call('/invitations/inspect',{token:'a'.repeat(43)})).statusCode,429);
});

test('revoking while accepting has one atomic outcome; removed grants cannot activate an account',async t=>{
  const f=await fixture(t),provider=await f.ok('/admin/providers',{name:'Fixture',base_url:'https://1.1.1.1/v1'});
  const deployment=await f.ok('/admin/deployments',{provider_id:provider.id,alias:'assigned',upstream_model:'chat',weight:1,input_price:0,output_price:0});
  const invalid=await f.invite('grants@example.test',{models:['assigned']});f.db.run('DELETE FROM deployments WHERE id=?',deployment.id);
  assert.equal((await f.accept(invalid.link)).statusCode,400);assert.equal(f.db.get("SELECT id FROM users WHERE email='grants@example.test'"),undefined);
  const invite=await f.invite('race@example.test');
  const [accepted,revoked]=await Promise.all([f.accept(invite.link),f.call(`/admin/invitations/${invite.id}/revoke`,{})]);
  assert.deepEqual([accepted.statusCode,revoked.statusCode].sort(),[200,400]);
  const state=f.db.get('SELECT status FROM invitations WHERE id=?',invite.id)!.status;
  assert.equal(!!f.db.get("SELECT id FROM users WHERE email='race@example.test'"),state==='accepted');
});

test('allowance requests and decisions notify only their intended audience even with threshold alerts disabled',async t=>{
  const f=await fixture(t),invite=await f.invite();assert.equal((await f.accept(invite.link)).statusCode,200);
  const login=await f.call('/login',{email:'new@example.test',password:'new-user-password'}),cookie=String(login.headers['set-cookie']).split(';')[0];
  await f.ok('/admin/notifications',{enabled:false,thresholds:[70],owners:true,affected_user:false,email:true,sns:false},'PUT');
  await f.ok('/member/allowance-requests',{budget:1,token_limit:null,limit_period:'monthly',reason:'Test application'},'POST',cookie);
  assert.equal((await f.ok('/member/notifications')).items[0].title,'Allowance request to review');
  assert.equal((await f.ok('/member/notifications',undefined,'GET',cookie)).items.length,0);
  const row=f.db.get('SELECT id FROM allowance_requests')!;
  await f.ok(`/admin/allowance-requests/${row.id}/resolve`,{decision:'approved',budget:1,token_limit:null,limit_period:'monthly'});
  const inbox=await f.ok('/member/notifications',undefined,'GET',cookie);assert.equal(inbox.items[0].title,'Allowance approved');
  await f.ok('/member/notifications/read-all',{},'POST',cookie);assert.equal((await f.ok('/member/notifications',undefined,'GET',cookie)).unread,0);assert.equal((await f.ok('/member/notifications')).unread,1);
  await f.notifications.tick();assert.equal(f.sent.length,2);assert.equal(f.sent[1].channel,'email');
});

test('SQLite migration from schema 6 preserves accounts and encrypted providers',async t=>{
  const {Store}=await import('../server/store.ts');
  const directory=mkdtempSync(join(tmpdir(),'gate-notification-upgrade-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  let db=new Store(directory);db.run('INSERT INTO users VALUES (?,?,?,?,?,?,?)','owner','default','Owner','owner@example.test',passwordHash('owner-password'),'owner',now());
  db.run('INSERT INTO providers (id,workspace_id,name,base_url,secret,created_at) VALUES (?,?,?,?,?,?)','p','default','Provider','https://1.1.1.1/v1',db.seal('encrypted-test-key'),now());
  db.db.exec('DROP TABLE notification_deliveries; DROP TABLE notifications; DROP TABLE invitations; DROP TABLE notification_settings; DROP TABLE alert_pending; PRAGMA user_version=6;');db.close();
  db=new Store(directory);try{assert.equal(db.get('SELECT COUNT(*) AS n FROM users')!.n,1);assert.equal(db.unseal(db.get('SELECT secret FROM providers')!.secret),'encrypted-test-key');assert.equal(db.get('SELECT COUNT(*) AS n FROM invitations')!.n,0);}finally{db.close();}
});

test('a real gateway settlement creates durable alerts without sending email on the request path',async t=>{
  const {mockProvider}=await import('../scripts/mock-provider.ts'),mock=mockProvider();await new Promise<void>(r=>mock.server.listen(0,'127.0.0.1',r));
  const directory=mkdtempSync(join(tmpdir(),'gate-notify-proxy-'));let sends=0;
  const {app,notifications,db}=await createApp({directory,allowPrivate:true,notificationWorker:false,logLevel:'silent',notificationTransport:{email:true,sns:false,async send(){sends++;throw new Error('fake outage');}}});
  t.after(async()=>{await app.close();await new Promise<void>(r=>mock.server.close(()=>r()));rmSync(directory,{recursive:true,force:true});});
  const setup=await app.inject({method:'POST',url:'/api/setup',payload:{workspace:'Test',name:'Owner',email:'owner@example.test',password:'owner-test-password'}}),cookie=String(setup.headers['set-cookie']).split(';')[0];
  const post=async(path:string,payload:any,method:any='POST')=>{const r=await app.inject({method,url:'/api/admin/'+path,headers:{cookie},payload});assert.equal(r.statusCode,200,r.body);return r.json();};
  const provider=await post('providers',{name:'Fake provider',base_url:`http://127.0.0.1:${(mock.server.address() as any).port}/v1`});await post('deployments',{provider_id:provider.id,alias:'chat',upstream_model:'fast',weight:1,input_price:0,output_price:0});
  await post('notifications',{enabled:true,thresholds:[1],owners:true,affected_user:false,email:true,sns:false},'PUT');const key=await post('keys',{name:'Free model',owner:'Owner',models:['chat'],budget:null,token_limit:10000,rpm:60,max_request_tokens:2048});
  const result=await app.inject({method:'POST',url:'/v1/chat/completions',headers:{authorization:'Bearer '+key.token},payload:{model:'chat',messages:[{role:'user',content:'hello'}],max_tokens:128}});
  assert.equal(result.statusCode,200,result.body);assert.equal(sends,0);assert.equal(db.get('SELECT COUNT(*) AS n FROM alert_pending')!.n,1);
  await notifications.tick();assert.equal(sends,1);assert.equal(db.get('SELECT COUNT(*) AS n FROM notifications')!.n,1);assert.equal(db.get('SELECT cost FROM requests')!.cost,0);assert.equal(db.get('SELECT tokens FROM usage_daily')!.tokens,160);
});
