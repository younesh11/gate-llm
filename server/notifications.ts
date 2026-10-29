import { requireOperator } from './roles.ts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes, scrypt } from 'node:crypto';
import { z } from 'zod';
import type { AppStore } from './storage.ts';
import { hash, HttpError, id, now, type Row } from './store.ts';
import type { NotificationTransport, DeliveryMessage } from './notification-transport.ts';

export const notificationSettings = z.object({ enabled: z.boolean().default(true), thresholds: z.array(z.number().int().min(1).max(100)).min(1).max(5).default([70,90,100]), owners: z.boolean().default(true), affected_user: z.boolean().default(false), email: z.boolean().default(false), sns: z.boolean().default(false) }).strict();
export function publicBaseUrl(value?: string) {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) throw new Error('PUBLIC_BASE_URL must be an HTTPS origin (HTTP is allowed only on localhost).');
  return url.origin;
}
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const inviteInput = z.object({ name: z.string().trim().min(1).max(80), email: z.string().trim().email().max(150).transform(v=>v.toLowerCase()), role: z.enum(['admin','member','viewer']).default('member'), models: z.array(z.string().min(1).max(100)).max(100).default([]), policy_id: z.string().nullable().default(null), send_email: z.boolean().default(false) }).strict();
const unavailable = () => new HttpError(400, 'This invitation is unavailable. Ask your owner for a new link.', 'invitation_unavailable');
export class Notifications {
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private stopping = false;
  constructor(readonly db: AppStore, readonly transport: NotificationTransport, readonly baseUrl?: string) {}
  async settings(workspace: string) { const row = await this.db.get('SELECT settings FROM notification_settings WHERE workspace_id=?',workspace); return notificationSettings.parse(row ? JSON.parse(row.settings) : {}); }
  async queue(workspace: string, dedupe: string, message: DeliveryMessage, userId: string | null = null, invitationId: string | null = null, tokenHash?: string) {
    await this.db.run(`INSERT INTO notification_deliveries (id,workspace_id,user_id,invitation_id,channel,dedupe,title,payload,status,next_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(dedupe) DO NOTHING`,id(),workspace,userId,invitationId,message.channel,dedupe,message.title,this.db.seal(JSON.stringify({...message,tokenHash})), 'pending',Date.now(),now());
  }
  async notify(workspace: string, users: Row[], dedupe: string, title: string, body: string, email: boolean) {
    for (const user of users) {
      if (await this.db.get('SELECT user_id FROM member_access WHERE user_id=? AND suspended=1',user.id)) continue;
      await this.db.run('INSERT INTO notifications VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(dedupe) DO NOTHING',id(),workspace,user.id,dedupe+':'+user.id,title,body,null,now());
      if (email && this.transport.email) await this.queue(workspace,dedupe+':email:'+user.id,{channel:'email',to:user.email,title,body},user.id);
    }
  }
  async allowance(workspace: string, requestId: string, userId: string, decision?: string) {
    const settings = await this.settings(workspace);
    const users = decision ? await this.db.all('SELECT id,email FROM users WHERE id=? AND workspace_id=?',userId,workspace) : await this.db.all("SELECT id,email FROM users WHERE workspace_id=? AND role IN ('owner','admin')",workspace);
    await this.notify(workspace,users,`allowance:${requestId}:${decision??'requested'}`,decision ? `Allowance ${decision}` : 'Allowance request to review',decision ? `Your allowance request was ${decision}. Open My access to review the decision and your current limits.` : 'A team member requested an allowance. Open Team to review the request.',settings.email);
  }
  async evaluateAlerts() {
    for (const pending of await this.db.all('SELECT * FROM alert_pending ORDER BY day,subject_id LIMIT 25')) {
      await this.db.transaction(async()=>{
        const key = pending.subject_type === 'key';
        const subject = key ? await this.db.get('SELECT * FROM virtual_keys WHERE id=?',pending.subject_id) : await this.db.get('SELECT a.*,u.workspace_id,u.name FROM member_allowances a JOIN users u ON u.id=a.user_id WHERE a.user_id=?',pending.subject_id);
        if (subject) {
          const settings = await this.settings(subject.workspace_id);
          if (settings.enabled) {
            const period = subject.limit_period ?? 'lifetime', day = pending.day;
            const start = period==='daily'?day:period==='monthly'?day.slice(0,7)+'-01':'';
            const end = period==='daily'?new Date(Date.parse(day)+86400000).toISOString().slice(0,10):period==='monthly'?new Date(Date.UTC(Number(day.slice(0,4)),Number(day.slice(5,7)),1)).toISOString().slice(0,10):'9999';
            const usage = (await this.db.get(`SELECT COALESCE(SUM(cost),0) AS cost,COALESCE(SUM(tokens),0) AS tokens FROM ${key?'usage_daily':'member_usage'} WHERE ${key?'key_id':'user_id'}=? AND day>=? AND day<?`,pending.subject_id,start,end))!;
            const affected = key ? subject.user_id : pending.subject_id;
            const recipients = await this.db.all("SELECT id,email FROM users WHERE workspace_id=? AND ((?=1 AND role IN ('owner','admin')) OR (?=1 AND id=?))",subject.workspace_id,Number(settings.owners),Number(settings.affected_user),affected??'');
            for (const metric of ['budget','token_limit'] as const) {
              const limit=subject[metric],used=metric==='budget'?usage.cost:usage.tokens;
              if (limit === null || limit === undefined || limit <= 0) continue;
              for (const threshold of [...new Set(settings.thresholds)].sort((a,b)=>a-b)) {
                if (used / limit * 100 < threshold) continue;
                const dedupe=`budget:${pending.subject_type}:${pending.subject_id}:${period}:${start}:${metric}:${limit}:${threshold}`;
                const title=`${metric==='budget'?'Budget':'Token allowance'} reached ${threshold}%`;
                const amount = metric==='budget'?`$${(used/1e6).toFixed(6)} of $${(limit/1e6).toFixed(2)}`:`${used} of ${limit} combined input/output tokens`;
                const body=`${key?'Key':'Member'} "${subject.name}": ${amount} used (${period}${start?' starting '+start:''}). Limits remain enforced by GATE; requests must fit the remaining allowance.`;
                await this.notify(subject.workspace_id,recipients,dedupe,title,body,settings.email);
                if (settings.sns && this.transport.sns) await this.queue(subject.workspace_id,dedupe+':sns',{channel:'sns',title,body});
              }
            }
          }
        }
        await this.db.run('DELETE FROM alert_pending WHERE subject_type=? AND subject_id=? AND day=?',pending.subject_type,pending.subject_id,pending.day);
      });
    }
  }
  private async validInvite(row: Row, tokenHash?: string) {
    return row.status==='pending' && row.expires_at>Date.now() && (!tokenHash || row.token_hash===tokenHash) && !!await this.db.get("SELECT u.id FROM users u LEFT JOIN member_access a ON a.user_id=u.id WHERE u.id=? AND u.workspace_id=? AND (u.role='owner' OR (u.role='admin' AND ? IN ('member','viewer'))) AND COALESCE(a.suspended,0)=0",row.issuer_id,row.workspace_id,row.role);
  }
  async deliverOne() {
    const claim=id();
    const row:Row|undefined=await this.db.transaction(async()=>{
      const row=await this.db.get("SELECT * FROM notification_deliveries WHERE (status='pending' AND next_at<=?) OR (status='sending' AND lease_until<=?) ORDER BY created_at LIMIT 1",Date.now(),Date.now());
      if (!row) return;
      await this.db.run("UPDATE notification_deliveries SET status='sending',claim=?,lease_until=?,attempts=attempts+1 WHERE id=?",claim,Date.now()+60000,row.id);
      return {...row,attempts:row.attempts+1};
    });
    if (!row) return false;
    try {
      const message=JSON.parse(this.db.unseal(row.payload));
      let valid=true;
      if (row.invitation_id) {
        const invite=await this.db.get('SELECT * FROM invitations WHERE id=?',row.invitation_id);
        valid=!!invite && await this.validInvite(invite,message.tokenHash);
      } else if (row.user_id) {
        valid=!!await this.db.get('SELECT u.id FROM users u LEFT JOIN member_access a ON a.user_id=u.id WHERE u.id=? AND u.workspace_id=? AND COALESCE(a.suspended,0)=0',row.user_id,row.workspace_id);
      }
      if (!valid || row.attempts>5) {
        await this.db.run("UPDATE notification_deliveries SET status=?,payload='',claim=NULL,lease_until=0 WHERE id=? AND claim=?",valid?'failed':'cancelled',row.id,claim);
        return true;
      }
      const controller=new AbortController();
      let timer: ReturnType<typeof setTimeout>;
      const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Delivery timed out'));},15000);});
      let providerId:string;
      try { providerId=await Promise.race([this.transport.send(message,controller.signal),timeout]); } finally { clearTimeout(timer!); }
      await this.db.run("UPDATE notification_deliveries SET status='accepted',payload='',provider_id=?,claim=NULL,lease_until=0,error_code=NULL WHERE id=? AND claim=?",providerId.slice(0,200),row.id,claim);
    } catch {
      // No provider error text: it may contain credentials, message bodies or invite links.
      await this.db.run("UPDATE notification_deliveries SET status=?,next_at=?,claim=NULL,lease_until=0,error_code='delivery_failed',payload=CASE WHEN ?=1 THEN '' ELSE payload END WHERE id=? AND claim=?",row.attempts>=5?'failed':'pending',Date.now()+Math.min(3600000,30000*2**(row.attempts-1)),Number(row.attempts>=5),row.id,claim);
    }
    return true;
  }
  tick(): Promise<void> {
    if (this.active) return this.active;
    this.active=(async()=>{ await this.evaluateAlerts(); for(let i=0;i<10&&!this.stopping;i++) if (!await this.deliverOne()) break; })().finally(()=>{this.active=undefined;});
    return this.active;
  }
  start(onError:()=>void) { this.timer=setInterval(()=>{void this.tick().catch(onError);},5000);this.timer.unref(); }
  async stop() { this.stopping=true;clearInterval(this.timer);try{await this.active;}finally{this.transport.close?.();} }
  async inspect(token:string) {
    const row=await this.db.get('SELECT * FROM invitations WHERE token_hash=?',hash(token));
    if (!row || !await this.validInvite(row) || await this.db.get('SELECT id FROM users WHERE email=?',row.email)) throw unavailable();
    return row;
  }
}

export function registerNotifications(app:FastifyInstance, service:Notifications, sessionUser:(r:FastifyRequest)=>Promise<Row>, worker=true) {
  const db=service.db;
  const owner=async(request:FastifyRequest)=>{const user=await sessionUser(request);if(user.role!=='owner')throw new HttpError(403,'Only owners can manage notification settings.');return user;};
  const operator=async(request:FastifyRequest)=>{const user=await sessionUser(request);requireOperator(user);return user;};
  const canInvite=(user:Row,role:string)=>{if(role==='admin'&&user.role!=='owner')throw new HttpError(403,'Only owners can invite or manage admins.');};
  const buckets=new Map<string,{n:number;until:number}>();
  function limit(key:string,max:number) {const time=Date.now();for(const [k,v] of buckets)if(v.until<=time)buckets.delete(k);const v=buckets.get(key)??{n:0,until:time+60000};if(v.n>=max||buckets.size>10000)throw new HttpError(429,'Too many attempts. Try again shortly.');v.n++;buckets.set(key,v);}
  const throttle=(r:FastifyRequest)=>{limit('global',120);limit('ip:'+r.ip,30);};
  let hashing=0;
  const grants=async(workspace:string,models:string[],policy:string|null)=>{
    for(const model of models)if(!await db.get('SELECT id FROM deployments WHERE workspace_id=? AND alias=?',workspace,model))throw new HttpError(400,'An assigned model is no longer available. Ask the owner to create a new invitation.');
    if(policy&&!await db.get('SELECT id FROM policies WHERE workspace_id=? AND id=?',workspace,policy))throw new HttpError(400,'The assigned policy is no longer available. Ask the owner to create a new invitation.');
  };
  app.get('/api/member/notifications',async request=>{const user=await sessionUser(request);return {items:await db.all('SELECT id,title,body,read_at,created_at FROM notifications WHERE user_id=? AND workspace_id=? ORDER BY created_at DESC LIMIT 100',user.id,user.workspace_id),unread:(await db.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND read_at IS NULL',user.id))!.n};});
  app.post('/api/member/notifications/read-all',async request=>{const user=await sessionUser(request);await db.run('UPDATE notifications SET read_at=? WHERE user_id=? AND workspace_id=? AND read_at IS NULL',now(),user.id,user.workspace_id);return {ok:true};});
  app.post('/api/member/notifications/:id/read',async request=>{const user=await sessionUser(request);await db.run('UPDATE notifications SET read_at=? WHERE id=? AND user_id=? AND workspace_id=?',now(),(request.params as any).id,user.id,user.workspace_id);return {ok:true};});
  app.get('/api/admin/notifications',async request=>{const user=await owner(request);return {settings:await service.settings(user.workspace_id),email_available:service.transport.email,sns_available:service.transport.sns,public_base_url:service.baseUrl??null,deliveries:await db.all('SELECT id,channel,title,status,attempts,error_code,created_at FROM notification_deliveries WHERE workspace_id=? ORDER BY created_at DESC LIMIT 100',user.workspace_id)};});
  app.put('/api/admin/notifications',async request=>{const user=await owner(request),input=notificationSettings.parse(request.body);if(input.email&&!service.transport.email||input.sns&&!service.transport.sns)throw new HttpError(400,'Configure the selected delivery channel on the server first.');if(input.enabled&&!input.owners&&!input.affected_user&&!input.sns)throw new HttpError(400,'Choose at least one alert recipient.');await db.transaction(async()=>{await db.run('INSERT INTO notification_settings VALUES (?,?) ON CONFLICT(workspace_id) DO UPDATE SET settings=excluded.settings',user.workspace_id,JSON.stringify({...input,thresholds:[...new Set(input.thresholds)].sort((a,b)=>a-b)}));await db.audit(user.workspace_id,user.email,'notifications.updated',user.workspace_id);});return {ok:true};});
  app.get('/api/admin/invitations',async request=>{const user=await operator(request);return {email_available:service.transport.email,public_base_url:service.baseUrl??null,items:(await db.all("SELECT id,name,email,role,status,expires_at,created_at FROM invitations WHERE workspace_id=? AND (?='owner' OR role<>'admin') ORDER BY created_at DESC LIMIT 100",user.workspace_id,user.role)).map(row=>({...row,status:row.status==='pending'&&row.expires_at<=Date.now()?'expired':row.status}))};});
  async function issue(request:FastifyRequest, rotate=false) {
    const user=await operator(request);limit('operator:'+user.id,20);
    if(!service.baseUrl)throw new HttpError(400,'Set PUBLIC_BASE_URL on the server before creating invitations.');
    // Validate before the transaction so both databases return validation errors consistently.
    const parsedInput=rotate?undefined:inviteInput.parse(request.body);
    const delivery=rotate?z.object({send_email:z.boolean().default(false)}).strict().parse(request.body):undefined;
    return db.transaction(async()=>{
      let input:z.infer<typeof inviteInput>,previous:Row|undefined;
      if(rotate){const {send_email}=delivery!;previous=await db.get('SELECT * FROM invitations WHERE id=? AND workspace_id=?',(request.params as any).id,user.workspace_id);if(!previous||previous.status==='accepted')throw new HttpError(400,'This invitation cannot be regenerated.');input={name:previous.name,email:previous.email,role:previous.role,models:JSON.parse(previous.models),policy_id:previous.policy_id,send_email};}
      else input=parsedInput!;
      canInvite(await operator(request),input.role);
      if(input.role==='admin'){input.models=[];input.policy_id=null;}
      if(input.send_email&&!service.transport.email)throw new HttpError(400,'Configure email delivery first, or copy the invitation link.');
      if(await db.get('SELECT id FROM users WHERE email=?',input.email))throw new HttpError(409,'This email already has an account. Manage its existing access.');
      await grants(user.workspace_id,input.models,input.policy_id);
      if(previous){await db.run("UPDATE invitations SET status='revoked' WHERE id=?",previous.id);await db.run("UPDATE notification_deliveries SET status='cancelled',payload='',claim=NULL WHERE invitation_id=? AND status IN ('pending','sending')",previous.id);}
      await db.run("UPDATE invitations SET status='revoked' WHERE workspace_id=? AND email=? AND status='pending' AND expires_at<=?",user.workspace_id,input.email,Date.now());
      if(await db.get("SELECT id FROM invitations WHERE workspace_id=? AND email=? AND status='pending'",user.workspace_id,input.email))throw new HttpError(409,'An invitation is already pending. Regenerate its link instead.');
      const token=randomBytes(32).toString('base64url'),inviteId=id(),expires=Date.now()+86400000;
      await db.run('INSERT INTO invitations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',inviteId,user.workspace_id,user.id,input.name,input.email,input.role,hash(token),JSON.stringify([...new Set(input.models)]),input.policy_id,'pending',expires,now());
      const link=service.baseUrl+'/invite#token='+token;
      if(input.send_email)await service.queue(user.workspace_id,'invite:'+inviteId,{channel:'email',to:input.email,title:'Your GATE invitation',body:`You have been invited to GATE. Set your password using this one-time link within 24 hours:\n\n${link}\n\nKeep this link private. If you did not expect this invitation, ignore it.`},null,inviteId,hash(token));
      await db.audit(user.workspace_id,user.email,rotate?'invitation.regenerated':'invitation.created',input.email);
      return {id:inviteId,link,expires_at:expires,email_queued:input.send_email};
    });
  }
  app.post('/api/admin/invitations',request=>issue(request));
  app.post('/api/admin/invitations/:id/regenerate',request=>issue(request,true));
  app.post('/api/admin/invitations/:id/revoke',async request=>{const user=await operator(request);await db.transaction(async()=>{const row=await db.get('SELECT * FROM invitations WHERE id=? AND workspace_id=?',(request.params as any).id,user.workspace_id);if(!row||row.status==='accepted')throw new HttpError(400,'This invitation cannot be revoked.');canInvite(await operator(request),row.role);await db.run("UPDATE invitations SET status='revoked' WHERE id=?",row.id);await db.run("UPDATE notification_deliveries SET status='cancelled',payload='',claim=NULL WHERE invitation_id=? AND status IN ('pending','sending')",row.id);await db.audit(user.workspace_id,user.email,'invitation.revoked',row.email);});return {ok:true};});
  app.post('/api/invitations/inspect',async request=>{throttle(request);const {token}=z.object({token:tokenSchema}).strict().parse(request.body);const row=await service.inspect(token);const workspace=await db.get('SELECT name FROM workspaces WHERE id=?',row.workspace_id);return {name:row.name,email:row.email,workspace:workspace!.name,expires_at:row.expires_at};});
  app.post('/api/invitations/accept',async request=>{
    throttle(request);
    const input=z.object({token:tokenSchema,password:z.string().min(12).max(200),confirm_password:z.string().min(12).max(200)}).strict().parse(request.body);
    if(input.password!==input.confirm_password)throw new HttpError(400,'Passwords do not match.');
    await service.inspect(input.token);
    if(hashing>=2)throw new HttpError(429,'Password setup is busy. Try again shortly.');
    hashing++;let password:string;
    try{const salt=randomBytes(16).toString('hex');const key=await new Promise<Buffer>((resolve,reject)=>scrypt(input.password,salt,64,(error,key)=>error?reject(error):resolve(key)));password=salt+':'+key.toString('hex');}finally{hashing--;}
    await db.transaction(async()=>{
      const row=await service.inspect(input.token);await grants(row.workspace_id,JSON.parse(row.models),row.policy_id);
      const userId=id();await db.run('INSERT INTO users VALUES (?,?,?,?,?,?,?)',userId,row.workspace_id,row.name,row.email,password,row.role,now());
      await db.run('INSERT INTO member_access VALUES (?,?,?,?,?)',userId,row.models,'[]',row.policy_id,0);
      await db.run("UPDATE invitations SET status='accepted' WHERE id=?",row.id);
      await db.run("UPDATE notification_deliveries SET status='cancelled',payload='',claim=NULL WHERE invitation_id=? AND status IN ('pending','sending')",row.id);
      await db.audit(row.workspace_id,row.email,'invitation.accepted',userId);
    });return {ok:true};
  });
  if(worker) app.addHook('onReady',async()=>{service.start(()=>app.log.error({event:'notification_worker_failed',error:{code:'notification_processing_failed'}}));});
  app.addHook('preClose',async()=>{await service.stop();});
}
