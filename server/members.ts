import type { Notifications } from './notifications.ts';
import { AppStore, mapRows } from './storage.ts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError, id, now, hash, issueToken, type Row } from './store.ts';

export async function accessFor(db: AppStore, userId: string) {
  const row = (await db.get('SELECT * FROM member_access WHERE user_id=?', userId));
  return { models: JSON.parse(row?.models ?? '[]') as string[], provider_ids: JSON.parse(row?.provider_ids ?? '[]') as string[], policy_id: row?.policy_id ?? null, suspended: !!row?.suspended };
}
export async function keyMember(db: AppStore, key: Row, model?: string) {
  if (!key.user_id) return;
  const user = (await db.get('SELECT * FROM users WHERE id=? AND workspace_id=?', key.user_id, key.workspace_id));
  if (!user) throw new HttpError(403, 'The key owner is unavailable.', 'member_unavailable');
  const access = (await accessFor(db, user.id));
  if (access.suspended) throw new HttpError(403, 'The key owner is suspended.', 'member_suspended');
  if (user.role === 'member' && model && !access.models.includes(model)) throw new HttpError(403, 'Your owner has not assigned this model to you.', 'model_not_assigned');
  return { user, access };
}
export async function checkMemberAllowance(db: AppStore, key: Row, cost: number, tokens: number, timestamp: number) {
  const member = (await keyMember(db, key));
  if (member?.user.role !== 'member') return;
  const summary = (await db.memberSummary(member.user.id, timestamp));
  if (!summary.approved || (summary.expires_at && summary.expires_at <= new Date(timestamp).toISOString())) throw new HttpError(429, 'Request an allowance from your workspace owner before using a model.', 'member_allowance_required');
  if (summary.budget !== null && summary.spent + summary.money_reserved + cost > summary.budget) throw new HttpError(429, 'Your shared budget cannot cover this request. Lower the output limit or request a higher allowance.', 'member_budget_exceeded');
  if (summary.token_limit !== null && summary.tokens_used + summary.tokens_reserved + tokens > summary.token_limit) throw new HttpError(429, 'Your shared input + output token allowance cannot cover this request. Lower the request limit or request a higher allowance.', 'member_tokens_exceeded');
}
export async function memberState(db: AppStore, user: Row) {
  const access = (await accessFor(db, user.id));
  return {
    access, allowance: (await db.memberSummary(user.id)),
    models: (await db.all('SELECT DISTINCT d.alias FROM deployments d JOIN providers p ON p.id=d.provider_id WHERE d.workspace_id=? AND d.enabled=1 AND p.enabled=1', user.workspace_id)).filter(row => access.models.includes(row.alias)),
    providers: (await db.all('SELECT id,name FROM providers WHERE workspace_id=? AND enabled=1', user.workspace_id)).filter(row => access.provider_ids.includes(row.id)),
    keys: (await mapRows((await db.all('SELECT k.id,k.name,k.prefix,k.models,k.revoked,k.created_at,k.expires_at,k.max_request_tokens FROM virtual_keys k JOIN member_keys m ON m.key_id=k.id WHERE k.workspace_id=? AND m.user_id=? ORDER BY k.created_at DESC', user.workspace_id, user.id)), async key => ({ ...key, models: JSON.parse(key.models), ...(await db.limitSummary(key)) }))),
    allowance_requests: (await db.all('SELECT * FROM allowance_requests WHERE workspace_id=? AND user_id=? ORDER BY created_at DESC LIMIT 50', user.workspace_id, user.id)),
    deployment_requests: (await db.all('SELECT id,alias,upstream_model,status,created_at FROM deployment_requests WHERE workspace_id=? AND user_id=? ORDER BY created_at DESC LIMIT 50', user.workspace_id, user.id)),
    requests: (await db.all('SELECT r.* FROM requests r JOIN member_keys m ON m.key_id=r.key_id WHERE r.workspace_id=? AND m.user_id=? ORDER BY r.created_at DESC LIMIT 50', user.workspace_id, user.id)),
  };
}
const cap = z.object({ budget: z.number().finite().min(0.01).max(100000).nullable(), token_limit: z.number().int().min(1).max(1e12).nullable(), limit_period: z.enum(['lifetime','daily','monthly']) });
const validateCap = (value: { budget: number | null; token_limit: number | null }) => { if (value.budget === null && value.token_limit === null) throw new HttpError(400, 'Choose a budget, a token allowance, or both.'); };
const keyInput = z.object({ name: z.string().trim().min(1).max(80), models: z.array(z.string().min(1).max(100)).min(1).max(100), max_request_tokens: z.number().int().min(1).max(32768).default(2048) }).strict();

export function registerMembers(app: FastifyInstance, db: AppStore, sessionUser: (request: FastifyRequest) => Promise<Row>, notifications: Notifications) {
  const member = async (request: FastifyRequest) => { const user = (await sessionUser(request)); if (user.role !== 'member') throw new HttpError(403, 'This action is for workspace members.'); return user; };
  const target = async (request: FastifyRequest) => { const actor = (await sessionUser(request)); const user = (await db.get('SELECT id,name,email,role FROM users WHERE id=? AND workspace_id=?', (request.params as any).id, actor.workspace_id)); if (!user) throw new HttpError(404, 'Member not found.'); return { actor, user }; };
  app.get('/api/admin/team', async request => {
    const actor = (await sessionUser(request)); if (actor.role !== 'owner') throw new HttpError(403, 'Only owners can manage the team.');
    return { users: (await mapRows((await db.all('SELECT id,name,email,role,created_at FROM users WHERE workspace_id=?', actor.workspace_id)), async user => ({ ...user, access: (await accessFor(db,user.id)), allowance: (await db.memberSummary(user.id)) }))),
      requests: (await db.all('SELECT r.*,u.name AS user_name FROM allowance_requests r LEFT JOIN users u ON u.id=r.user_id WHERE r.workspace_id=? ORDER BY r.created_at DESC LIMIT 200', actor.workspace_id)),
      deployments: (await db.all('SELECT r.*,u.name AS user_name,p.name AS provider_name FROM deployment_requests r LEFT JOIN users u ON u.id=r.user_id LEFT JOIN providers p ON p.id=r.provider_id WHERE r.workspace_id=? ORDER BY r.created_at DESC LIMIT 200', actor.workspace_id)) };
  });
  app.put('/api/admin/users/:id/access', async request => {
    const { actor,user } = (await target(request));
    if (user.role === 'owner') throw new HttpError(400, 'Owner access cannot be restricted here.');
    const input = z.object({ models: z.array(z.string()).max(100), provider_ids: z.array(z.string()).max(100), policy_id: z.string().nullable(), suspended: z.boolean() }).strict().parse(request.body);
    const aliases = (await db.all('SELECT DISTINCT alias FROM deployments WHERE workspace_id=?', actor.workspace_id)).map(row=>row.alias);
    if (input.models.some(model=>!aliases.includes(model))) throw new HttpError(400, 'Choose models in this workspace.');
    const providers = (await db.all('SELECT id FROM providers WHERE workspace_id=?',actor.workspace_id)).map(row=>row.id);
    if (input.provider_ids.some(provider=>!providers.includes(provider))) throw new HttpError(400,'Choose providers in this workspace.');
    if (input.policy_id && !(await db.get('SELECT id FROM policies WHERE id=? AND workspace_id=?', input.policy_id,actor.workspace_id))) throw new HttpError(400,'Choose a policy in this workspace.');
    (await db.transaction(async ()=>{ (await db.run('INSERT INTO member_access VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET models=excluded.models,provider_ids=excluded.provider_ids,policy_id=excluded.policy_id,suspended=excluded.suspended',user.id,JSON.stringify([...new Set(input.models)]),JSON.stringify([...new Set(input.provider_ids)]),input.policy_id,Number(input.suspended)));
      if(input.suspended) (await db.run('DELETE FROM sessions WHERE user_id=?',user.id));
      (await db.audit(actor.workspace_id,actor.email,'member.access_updated',user.email));
    })); return {ok:true};
  });
  app.post('/api/member/allowance-requests', async request => {
    const user = (await member(request)), input = cap.extend({ reason: z.string().trim().min(1).max(500) }).strict().parse(request.body); validateCap(input);
    await db.transaction(async()=>{
      if (await db.get("SELECT id FROM allowance_requests WHERE user_id=? AND status='pending'",user.id)) throw new HttpError(409,'You already have a pending request. Wait for your owner’s decision.');
      const requestId=id();
      await db.run('INSERT INTO allowance_requests (id,workspace_id,user_id,budget,token_limit,limit_period,reason,created_at) VALUES (?,?,?,?,?,?,?,?)',requestId,user.workspace_id,user.id,input.budget===null?null:Math.round(input.budget*1e6),input.token_limit,input.limit_period,input.reason,now());
      await notifications.allowance(user.workspace_id,requestId,user.id);
      await db.audit(user.workspace_id,user.email,'allowance.requested',user.id);
    });return {ok:true};
  });
  app.post('/api/admin/allowance-requests/:id/resolve', async request => {
    const actor=(await sessionUser(request));
    const input=cap.extend({ decision:z.enum(['approved','rejected']),note:z.string().trim().max(500).default(''),expires_at:z.string().datetime().nullable().default(null) }).strict().parse(request.body);
    if(input.decision==='approved') {validateCap(input); if(input.expires_at && input.expires_at<=now()) throw new HttpError(400,'Expiry must be in the future.');}
    (await db.transaction(async ()=>{
      const row=(await db.get('SELECT * FROM allowance_requests WHERE id=? AND workspace_id=?',(request.params as any).id,actor.workspace_id));
      if(!row) throw new HttpError(404,'Request not found.');if(row.status!=='pending') throw new HttpError(409,'This request has already been reviewed.');
      const user=(await db.get('SELECT * FROM users WHERE id=? AND workspace_id=?',row.user_id,actor.workspace_id));
      if(!user || user.role!=='member') throw new HttpError(400,'This member is no longer available.');
      if(input.decision==='approved') (await db.run('INSERT INTO member_allowances VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET budget=excluded.budget,token_limit=excluded.token_limit,limit_period=excluded.limit_period,expires_at=excluded.expires_at',row.user_id,input.budget===null?null:Math.round(input.budget*1e6),input.token_limit,input.limit_period,input.expires_at));
      (await db.run('UPDATE allowance_requests SET status=?,decision_note=?,resolved_at=? WHERE id=?',input.decision,input.note,now(),row.id));
      await notifications.allowance(actor.workspace_id,row.id,row.user_id,input.decision);
      (await db.audit(actor.workspace_id,actor.email,`allowance.${input.decision}`,row.user_id));
    }));return {ok:true};
  });
  app.post('/api/member/keys', async request => {
    const user=(await member(request)),input=keyInput.parse(request.body),access=(await accessFor(db,user.id));
    if(input.models.some(model=>!access.models.includes(model))) throw new HttpError(403,'Choose only models assigned to you.');
    const allowance=(await db.memberSummary(user.id));
    if(!allowance.approved || allowance.expires_at && allowance.expires_at<=now()) throw new HttpError(403,'Request an allowance before creating a key.');
    if((await db.get('SELECT COUNT(*) AS count FROM member_keys m JOIN virtual_keys k ON k.id=m.key_id WHERE m.user_id=? AND k.revoked=0',user.id))!.count>=50) throw new HttpError(400,'You can have up to 50 active personal keys.');
    const keyId=id(),token=issueToken();
    (await db.transaction(async ()=>{
      (await db.run('INSERT INTO virtual_keys (id,workspace_id,name,owner,token_hash,prefix,models,policy_id,budget,rpm,max_request_tokens,created_at,user_id) VALUES (?,?,?,?,?,?,?,NULL,NULL,60,?,?,?)',keyId,user.workspace_id,input.name,user.name,hash(token),token.slice(0,11),JSON.stringify([...new Set(input.models)]),input.max_request_tokens,now(),user.id));
      (await db.run('INSERT INTO member_keys VALUES (?,?)',keyId,user.id));(await db.audit(user.workspace_id,user.email,'key.created',input.name));
    }));return {id:keyId,token};
  });
  const personalKey=async (request:FastifyRequest)=>{ const user=(await member(request)),key=(await db.get('SELECT k.* FROM virtual_keys k JOIN member_keys m ON m.key_id=k.id WHERE k.id=? AND k.workspace_id=? AND m.user_id=? AND k.user_id=?',(request.params as any).id,user.workspace_id,user.id,user.id));if(!key)throw new HttpError(404,'Key not found.');return {user,key}; };
  app.put('/api/member/keys/:id',async request=>{
    const {user,key}=(await personalKey(request)),input=keyInput.parse(request.body);
    if(key.revoked)throw new HttpError(400,'Revoked keys cannot be edited.');
    const access = await accessFor(db,user.id);
    if(input.models.some(model=>!access.models.includes(model)))throw new HttpError(403,'Choose only models assigned to you.');
    (await db.run('UPDATE virtual_keys SET name=?,models=?,max_request_tokens=? WHERE id=?',input.name,JSON.stringify(input.models),Math.min(input.max_request_tokens,key.max_request_tokens),key.id));
    (await db.audit(user.workspace_id,user.email,'key.updated',input.name));return {ok:true};
  });
  app.post('/api/member/keys/:id/:action',async request=>{
    const {user,key}=(await personalKey(request)),{action}=z.object({action:z.enum(['rotate','revoke'])}).parse(request.params);
    if(key.revoked)throw new HttpError(400,'This key is already revoked.');
    const token=issueToken();
    if(action==='rotate')(await db.run('UPDATE virtual_keys SET token_hash=?,prefix=? WHERE id=?',hash(token),token.slice(0,11),key.id));
    else (await db.run('UPDATE virtual_keys SET revoked=1 WHERE id=?',key.id));
    (await db.audit(user.workspace_id,user.email,`key.${action}`,key.name));return action==='rotate'?{token}:{ok:true};
  });
  app.post('/api/member/deployment-requests',async request=>{
    const user=(await member(request)),input=z.object({provider_id:z.string(),alias:z.string().regex(/^[a-zA-Z0-9._/-]{1,100}$/),upstream_model:z.string().min(1).max(200)}).strict().parse(request.body);
    if(!(await accessFor(db,user.id)).provider_ids.includes(input.provider_id))throw new HttpError(403,'Your owner has not granted deployment creation for this provider.');
    if(!(await db.get('SELECT id FROM providers WHERE id=? AND workspace_id=? AND enabled=1',input.provider_id,user.workspace_id)))throw new HttpError(400,'Provider unavailable.');
    if((await db.get('SELECT id FROM deployments WHERE workspace_id=? AND alias=?',user.workspace_id,input.alias)))throw new HttpError(409,'Choose a new model alias.');
    if((await db.get("SELECT COUNT(*) AS count FROM deployment_requests WHERE user_id=? AND status='pending'",user.id))!.count>=10)throw new HttpError(429,'Wait for your pending deployments to be reviewed.');
    (await db.run('INSERT INTO deployment_requests (id,workspace_id,user_id,provider_id,alias,upstream_model,created_at) VALUES (?,?,?,?,?,?,?)',id(),user.workspace_id,user.id,input.provider_id,input.alias,input.upstream_model,now()));
    (await db.audit(user.workspace_id,user.email,'deployment.requested',input.alias));return {ok:true};
  });
  app.post('/api/admin/deployment-requests/:id/resolve',async request=>{
    const actor=(await sessionUser(request)),input=z.object({decision:z.enum(['approved','rejected']),input_price:z.number().finite().min(0).max(1000),output_price:z.number().finite().min(0).max(1000)}).strict().parse(request.body);
    (await db.transaction(async ()=>{
      const row=(await db.get('SELECT * FROM deployment_requests WHERE id=? AND workspace_id=?',(request.params as any).id,actor.workspace_id));
      if(!row)throw new HttpError(404,'Request not found.');if(row.status!=='pending')throw new HttpError(409,'Already reviewed.');
      if(input.decision==='approved') {
        const user=(await db.get('SELECT * FROM users WHERE id=? AND workspace_id=?',row.user_id,actor.workspace_id)),access=(await accessFor(db,row.user_id));
        if(!user || access.suspended || !access.provider_ids.includes(row.provider_id))throw new HttpError(403,'This member no longer has deployment access.');
        if(!(await db.get('SELECT id FROM providers WHERE id=? AND workspace_id=? AND enabled=1',row.provider_id,actor.workspace_id)))throw new HttpError(400,'Provider unavailable.');
        if((await db.get('SELECT id FROM deployments WHERE workspace_id=? AND alias=?',actor.workspace_id,row.alias)))throw new HttpError(409,'This alias is already in use.');
        (await db.run('INSERT INTO deployments VALUES (?,?,?,?,?,1,?,?,1,0,0,?)',id(),actor.workspace_id,row.provider_id,row.alias,row.upstream_model,input.input_price,input.output_price,now()));
        // Model assignment and spending authority remain explicit owner decisions.
      }
      (await db.run('UPDATE deployment_requests SET status=? WHERE id=?',input.decision,row.id));(await db.audit(actor.workspace_id,actor.email,`deployment.${input.decision}`,row.alias));
    }));return {ok:true};
  });
}
