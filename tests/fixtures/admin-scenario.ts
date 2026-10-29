import assert from 'node:assert/strict';
import { id, now, passwordHash } from '../../server/store.ts';

// Run the same authorization contract against both storage implementations.
export async function adminScenario(t: any, {app,db,notifications}: any) {
  const password='synthetic-role-test-password';
  const setup=await app.inject({method:'POST',url:'/api/setup',payload:{workspace:'Role test',name:'Owner',email:'owner@roles.test',password}});
  assert.equal(setup.statusCode,200,setup.body);
  const owner=String(setup.headers['set-cookie']).split(';')[0];
  const call=(path:string,body?:any,cookie=owner,method:any=body===undefined?'GET':'POST')=>app.inject({url:'/api'+path,method,headers:{cookie},...(body===undefined?{}:{payload:body})});
  const ok=async(path:string,body?:any,cookie=owner,method?:any)=>{const r=await call(path,body,cookie,method);assert.equal(r.statusCode,200,r.body);return r.json();};
  const login=async(email:string)=>{const r=await call('/login',{email,password});assert.equal(r.statusCode,200,r.body);return String(r.headers['set-cookie']).split(';')[0];};
  const account=async(email:string,role:string)=>{const userId=id();await db.run('INSERT INTO users VALUES (?,?,?,?,?,?,?)',userId,'default',role,email,passwordHash(password),role,now());return {id:userId,cookie:await login(email)};};
  const invite=await ok('/admin/invitations',{name:'Manager',email:'admin@roles.test',role:'admin'});
  const token=new URL(invite.link).hash.slice(7);
  await ok('/invitations/accept',{token,password,confirm_password:password});
  const admin=await login('admin@roles.test'),adminId=(await db.get("SELECT id FROM users WHERE email='admin@roles.test'"))!.id;
  const ownerId=(await db.get("SELECT id FROM users WHERE role='owner'"))!.id;
  const member=await account('member@roles.test','member'),viewer=await account('viewer@roles.test','viewer'),peer=await account('peer@roles.test','admin');
  const access={models:[],provider_ids:[],policy_id:null,suspended:false};
  let key:any,personal:any,issued:any;

  await t.test('admin has operational dashboard, provider, deployment, guardrail, key and team authority',async()=>{
    const provider=await ok('/admin/providers',{name:'Managed provider',base_url:'http://127.0.0.1:9999/v1',api_key:'synthetic-provider-secret'},admin);
    const deployment=await ok('/admin/deployments',{provider_id:provider.id,alias:'chat',upstream_model:'test',weight:1,input_price:0.2,output_price:0.4},admin);
    await ok(`/admin/deployments/${deployment.id}`,{provider_id:provider.id,alias:'chat',upstream_model:'test',weight:2,input_price:0.2,output_price:0.4},admin,'PUT');
    const policy=await ok('/admin/policies',{name:'Managed policy',blocked_terms:[],redact_pii:true,block_secrets:true},admin);
    key=await ok('/admin/keys',{name:'Workspace app',owner:'Application',models:['chat'],budget:2,rpm:60,max_request_tokens:2048,policy_id:policy.id},admin);
    personal=await ok('/admin/keys',{name:'Assigned to manager',owner:'Manager',user_id:adminId,models:['chat'],budget:1,rpm:60,max_request_tokens:2048},admin);
    await ok(`/admin/keys/${key.id}/rotate`,{},admin);
    await ok(`/admin/keys/${key.id}/policy`,{policy_id:null},admin,'PATCH');
    const state=await ok('/admin/state',undefined,admin);
    assert.ok(state.deployments.some((r:any)=>r.id===deployment.id));assert.ok(state.keys.some((r:any)=>r.id===key.id));
    assert.ok(!JSON.stringify(state).includes('synthetic-provider-secret'));
    assert.ok((await ok('/admin/usage',undefined,admin)).by_key.some((r:any)=>r.id===key.id));
    await ok('/admin/team',undefined,admin);
    await ok(`/admin/users/${member.id}/access`,{...access,models:['chat'],provider_ids:[provider.id]},admin,'PUT');
    await ok('/member/allowance-requests',{budget:1,token_limit:2000,limit_period:'monthly',reason:'App testing'},member.cookie);
    const request=(await db.get('SELECT * FROM allowance_requests WHERE user_id=?',member.id))!;
    assert.ok(await db.get('SELECT id FROM notifications WHERE user_id=? AND title=?',adminId,'Allowance request to review'));
    await ok(`/admin/allowance-requests/${request.id}/resolve`,{decision:'approved',budget:1,token_limit:2000,limit_period:'monthly'},admin);
    await ok('/member/deployment-requests',{provider_id:provider.id,alias:'requested',upstream_model:'test'},member.cookie);
    const dr=(await db.get('SELECT id FROM deployment_requests WHERE user_id=?',member.id))!;
    await ok(`/admin/deployment-requests/${dr.id}/resolve`,{decision:'approved',input_price:0.2,output_price:0.4},admin);
    const mk=await ok('/member/keys',{name:'Personal',models:['chat']},member.cookie);
    assert.equal((await ok('/admin/state',undefined,member.cookie)).keys[0].id,mk.id);
    issued=await ok('/admin/invitations',{name:'Invited member',email:'invited@roles.test',send_email:true},admin);
    await ok('/invitations/inspect',{token:new URL(issued.link).hash.slice(7)});
    const v=await ok('/admin/invitations',{name:'Invited viewer',email:'view-invite@roles.test',role:'viewer'},admin);
    const rotated=await ok(`/admin/invitations/${v.id}/regenerate`,{},admin);
    await ok(`/admin/invitations/${rotated.id}/revoke`,{},admin);
  });
  await t.test('admin cannot alter owner, admins, workspace settings or privileged invitations',async()=>{
    for(const target of [ownerId,peer.id,adminId]) {
      assert.equal((await call(`/admin/users/${target}/access`,{...access,suspended:true},admin,'PUT')).statusCode,403);
      assert.equal((await call(`/admin/users/${target}`,undefined,admin,'DELETE')).statusCode,403);
      assert.equal((await call(`/admin/users/${target}/role`,{role:'member'},admin,'PUT')).statusCode,403);
    }
    assert.equal((await call(`/admin/users/${member.id}/role`,{role:'admin'},admin,'PUT')).statusCode,403);
    assert.equal((await call('/admin/workspace',{name:'Hijack'},admin,'PUT')).statusCode,403);
    assert.equal((await call('/admin/%77orkspace',{name:'Hijack'},admin,'PUT')).statusCode,403);
    assert.equal((await call('/admin/notifications',{},admin,'PUT')).statusCode,403);
    assert.equal((await call('/admin/notifications',undefined,admin)).statusCode,403);
    assert.equal((await call('/admin/invitations',{name:'Escalated',email:'no@roles.test',role:'admin'},admin)).statusCode,403);
    assert.equal((await call('/admin/invitations',{name:'Escalated',email:'no@roles.test',role:'owner'},admin)).statusCode,400);
    const privileged=await ok('/admin/invitations',{name:'Another admin',email:'pending-admin@roles.test',role:'admin'});
    assert.ok(!(await ok('/admin/invitations',undefined,admin)).items.some((r:any)=>r.id===privileged.id));
    for(const action of ['revoke','regenerate'])assert.equal((await call(`/admin/invitations/${privileged.id}/${action}`,{},admin)).statusCode,403);
    assert.equal((await call(`/admin/users/${ownerId}/role`,{role:'admin'},owner,'PUT')).statusCode,403);
    assert.equal((await call(`/admin/users/${peer.id}/role`,{role:'owner'},owner,'PUT')).statusCode,400);
    await db.run('INSERT INTO workspaces VALUES (?,?)','other','Other');
    await db.run('INSERT INTO users VALUES (?,?,?,?,?,?,?)','foreign','other','Foreign','foreign@roles.test',passwordHash(password),'member',now());
    assert.equal((await call('/admin/users/foreign/role',{role:'admin'},owner,'PUT')).statusCode,404);
    assert.equal((await call('/admin/users/foreign/access',access,admin,'PUT')).statusCode,404);
  });
  await t.test('members and viewers retain private data and cannot reach operational mutation routes',async()=>{
    for(const user of [member,viewer]) {
      for(const path of ['/admin/providers','/admin/%70roviders','/admin/invitations','/admin/users'])assert.equal((await call(path,{},user.cookie)).statusCode,403);
      for(const path of ['/admin/team','/admin/invitations'])assert.equal((await call(path,undefined,user.cookie)).statusCode,403);
      const state=await ok('/admin/state',undefined,user.cookie);assert.equal(state.deployments,undefined);assert.ok(!state.keys.some((r:any)=>r.id===key.id));
      assert.equal((await call(`/admin/users/${user.id}/role`,{role:'admin'},user.cookie,'PUT')).statusCode,403);
    }
    await ok(`/admin/users/${viewer.id}/access`,{...access,suspended:true},admin,'PUT');
    assert.equal((await call('/admin/state',undefined,viewer.cookie)).statusCode,401);
  });
  await t.test('role changes revoke sessions and personal keys, invalidate pending invites, retain workspace apps',async()=>{
    await notifications.queue('default','queued-admin-alert',{channel:'email',to:'admin@roles.test',title:'Admin alert',body:'Private workspace event'},adminId);
    await ok(`/admin/users/${adminId}/role`,{role:'member'},owner,'PUT');
    assert.equal((await db.get("SELECT status FROM notification_deliveries WHERE dedupe='queued-admin-alert'"))!.status,'cancelled');
    assert.equal((await call('/admin/state',undefined,admin)).statusCode,401);
    assert.equal((await db.get('SELECT revoked FROM virtual_keys WHERE id=?',personal.id))!.revoked,1);
    assert.equal((await db.get('SELECT revoked FROM virtual_keys WHERE id=?',key.id))!.revoked,0);
    assert.equal((await call('/invitations/inspect',{token:new URL(issued.link).hash.slice(7)})).statusCode,400);
    assert.equal((await db.get('SELECT status FROM notification_deliveries WHERE invitation_id=?',issued.id))!.status,'cancelled');
    const demoted=await login('admin@roles.test');
    assert.equal((await call('/admin/providers',{},demoted)).statusCode,403);
    assert.equal((await ok('/admin/state',undefined,demoted)).deployments,undefined);
    const personalMemberKey=(await db.get('SELECT id FROM virtual_keys WHERE user_id=?',member.id))!.id;
    await ok(`/admin/users/${member.id}/role`,{role:'admin'},owner,'PUT');
    assert.equal((await call('/admin/state',undefined,member.cookie)).statusCode,401);
    assert.equal((await db.get('SELECT revoked FROM virtual_keys WHERE id=?',personalMemberKey))!.revoked,1);
    assert.ok((await ok('/admin/state',undefined,await login('member@roles.test'))).deployments);
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM audit WHERE action='member.role_updated'"))!.n,2);
    await ok(`/admin/users/${peer.id}/access`,{...access,suspended:true},owner,'PUT');
    assert.equal((await call('/admin/team',undefined,peer.cookie)).statusCode,401);
    // Even an assigned key created by an operator cannot give a Viewer model authority.
    const vk=await ok('/admin/keys',{name:'Viewer assignment',owner:'Viewer',user_id:viewer.id,models:['chat'],budget:1,rpm:60,max_request_tokens:2048});
    const result=await app.inject({url:'/v1/models',headers:{authorization:'Bearer '+vk.token}});
    assert.equal(result.statusCode,403);assert.equal(result.json().error.code,'member_role_forbidden');
  });
}
