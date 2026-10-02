import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { version } from './meta.ts';
import { randomBytes } from 'node:crypto';
import { z, ZodError } from 'zod';
import { Store, HttpError, hash, id, now, issueToken, passwordHash, passwordMatches, type Row } from './store.ts';
import { registerGateway, validateUpstream } from './gateway.ts';
import { defaultPiiTypes, inspectPolicy, piiTypes, policyPiiTypes } from './guards.ts';

type Options = { directory: string; allowPrivate?: boolean; secureCookie?: boolean; allowRemoteSetup?: boolean; staticDir?: string; timeoutMs?: number; random?: () => number };
const name = z.string().trim().min(1).max(80);
const providerSchema = z.object({ name, base_url: z.string().max(500), api_key: z.string().max(4096).optional(), enabled: z.boolean().default(true) });
const deploymentSchema = z.object({ provider_id: z.string(), alias: z.string().regex(/^[a-zA-Z0-9._/-]{1,100}$/), upstream_model: z.string().min(1).max(200), weight: z.number().int().min(1).max(1000), input_price: z.number().finite().min(0).max(1000), output_price: z.number().finite().min(0).max(1000), enabled: z.boolean().default(true) });
const policySchema = z.object({ name, blocked_terms: z.array(z.string().trim().min(1).max(100)).max(100), redact_pii: z.boolean(), block_secrets: z.boolean(), pii_types: z.array(z.enum(piiTypes)).max(4).default(defaultPiiTypes), term_match: z.enum(['substring', 'word']).default('substring') });
const keySchema = z.object({ name, owner: name, models: z.array(z.string().min(1).max(100)).min(1).max(100), policy_id: z.string().nullable().default(null), budget: z.number().finite().min(0.01).max(100000).nullable(), rpm: z.number().int().min(1).max(10000), max_request_tokens: z.number().int().min(1).max(1000000), expires_at: z.string().datetime().nullable().default(null), token_limit: z.number().int().min(0).max(1e12).nullable().optional(), tpm: z.number().int().min(1).max(1e9).nullable().optional(), limit_period: z.enum(['lifetime', 'daily', 'monthly']).optional(), user_id: z.string().nullable().optional() });
const memberSchema = z.object({ name, email: z.string().trim().email().max(150).transform(v => v.toLowerCase()), password: z.string().min(12).max(200), role: z.enum(['owner', 'viewer']) });

export async function createApp(options: Options) {
  const db = new Store(options.directory);
  db.recoverReservations();
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024, requestTimeout: 150000 });
  await app.register(cookie);
  const attempts = new Map<string, { count: number; until: number }>();
  const sessionUser = (request: any) => {
    if (!request.cookies.relay_session) throw new HttpError(401, 'Sign in to continue.', 'authentication_required');
    const user = db.get('SELECT u.id, u.workspace_id, u.name, u.email, u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?', hash(request.cookies.relay_session), Date.now());
    if (!user) throw new HttpError(401, 'Your session has expired. Sign in again.', 'authentication_required');
    return user;
  };
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'same-origin').header('X-Frame-Options', 'DENY');
    if (request.url.startsWith('/api')) {
      reply.header('Cache-Control', 'no-store');
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
        const origin = request.headers.origin;
        if (origin && new URL(origin).host !== request.headers.host) throw new HttpError(403, 'Cross-origin administration is not allowed.');
      }
      if (request.url.startsWith('/api/admin')) {
        const user = sessionUser(request);
        if (request.method !== 'GET' && user.role !== 'owner') throw new HttpError(403, 'Only workspace owners can make this change.');
      }
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: { message: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '), code: 'validation_error' } });
    if (error instanceof HttpError) return reply.code(error.status).send({ error: { message: error.message, code: error.code } });
    if ((error as any).statusCode === 413) return reply.code(413).send({ error: { message: 'Request exceeds the 256 KB limit.', code: 'request_too_large' } });
    if ((error as any).statusCode === 400) return reply.code(400).send({ error: { message: 'Invalid JSON request.', code: 'invalid_request' } });
    return reply.code(500).send({ error: { message: 'The request could not be completed.', code: 'internal_error' } });
  });
  app.get('/health', async () => ({ status: 'ok', version }));
  app.get('/api/session', async request => {
    const setup = !db.get('SELECT id FROM users LIMIT 1');
    let user = null; try { user = sessionUser(request); } catch {}
    return { setup, user, workspace: db.get('SELECT * FROM workspaces WHERE id=?', user?.workspace_id ?? 'default') };
  });
  const establishSession = (reply: any, user: Row) => {
    const token = randomBytes(32).toString('base64url');
    db.run('DELETE FROM sessions WHERE expires_at<?', Date.now());
    db.run('INSERT INTO sessions VALUES (?, ?, ?)', hash(token), user.id, Date.now() + 12 * 60 * 60 * 1000);
    reply.setCookie('relay_session', token, { httpOnly: true, secure: options.secureCookie ?? false, sameSite: 'strict', path: '/', maxAge: 43200 });
    return { ok: true };
  };
  app.post('/api/setup', async (request, reply) => {
    if (db.get('SELECT id FROM users LIMIT 1')) throw new HttpError(409, 'This workspace is already configured.');
    if (!options.allowRemoteSetup && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip)) throw new HttpError(403, 'Create the first owner from this machine, or explicitly enable remote setup.');
    const input = memberSchema.omit({ role: true }).extend({ workspace: name }).parse(request.body);
    const user = { id: id(), workspace_id: 'default', ...input };
    db.transaction(() => {
      db.run('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?)', user.id, 'default', input.name, input.email, passwordHash(input.password), 'owner', now());
      db.run('UPDATE workspaces SET name=? WHERE id=?', input.workspace, 'default');
      db.run('INSERT INTO policies (id,workspace_id,name,blocked_terms,redact_pii,block_secrets,created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id(), 'default', 'Team baseline', '[]', 1, 1, now());
      db.audit('default', input.email, 'workspace.created', input.workspace);
    });
    return establishSession(reply, user);
  });
  app.post('/api/login', async (request, reply) => {
    const input = z.object({ email: z.string().email().max(150).transform(v => v.toLowerCase()), password: z.string().min(1).max(200) }).parse(request.body);
    const time = Date.now();
    for (const [key, value] of attempts) if (value.until < time) attempts.delete(key);
    const limitKey = request.ip;
    const entry = attempts.get(limitKey) ?? { count: 0, until: time + 15 * 60 * 1000 };
    if (entry.count >= 10) throw new HttpError(429, 'Too many sign-in attempts. Try again in 15 minutes.');
    entry.count++; attempts.set(limitKey, entry);
    const user = db.get('SELECT * FROM users WHERE email=?', input.email);
    if (!user || !passwordMatches(input.password, user.password_hash)) throw new HttpError(401, 'Email or password is incorrect.');
    attempts.delete(limitKey); db.audit(user.workspace_id, user.email, 'session.created', user.name);
    return establishSession(reply, user);
  });
  app.post('/api/logout', async (request, reply) => {
    if (request.cookies.relay_session) db.run('DELETE FROM sessions WHERE token_hash=?', hash(request.cookies.relay_session));
    reply.clearCookie('relay_session', { path: '/' }); return { ok: true };
  });
  app.get('/api/admin/state', async request => {
    const user = sessionUser(request), w = user.workspace_id;
    const providers = db.all('SELECT id, name, base_url, enabled, created_at, (length(secret)>0) AS has_key FROM providers WHERE workspace_id=? ORDER BY created_at DESC', w);
    const deployments = db.all('SELECT d.*, p.name AS provider_name FROM deployments d JOIN providers p ON p.id=d.provider_id WHERE d.workspace_id=? ORDER BY d.alias, d.created_at', w);
    const keys = db.all('SELECT id,name,owner,prefix,models,policy_id,budget,spent,reserved,rpm,max_request_tokens,expires_at,revoked,created_at,token_limit,tpm,limit_period,user_id FROM virtual_keys WHERE workspace_id=? ORDER BY created_at DESC', w).map(key => ({ ...key, models: JSON.parse(key.models), ...db.limitSummary(key) }));
    const policies = db.all('SELECT * FROM policies WHERE workspace_id=? ORDER BY created_at', w).map(policy => ({ ...policy, blocked_terms: JSON.parse(policy.blocked_terms), pii_types: policyPiiTypes(policy) }));
    const since = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10) + 'T00:00:00.000Z';
    const stats = db.get(`SELECT COUNT(*) AS requests, COALESCE(SUM(cost),0) AS cost, COALESCE(AVG(CASE WHEN status='success' THEN latency_ms END),0) AS latency, COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END),0) AS success, COALESCE(SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END),0) AS blocked, COALESCE(SUM(input_tokens+output_tokens),0) AS tokens FROM requests WHERE workspace_id=? AND created_at>=?`, w, since);
    return { providers, deployments, keys, policies, stats,
      requests: db.all('SELECT * FROM requests WHERE workspace_id=? ORDER BY created_at DESC LIMIT 200', w),
      daily: db.all('SELECT substr(created_at,1,10) AS day, COUNT(*) AS requests, SUM(cost) AS cost FROM requests WHERE workspace_id=? AND created_at>=? GROUP BY day', w, since),
      audit: db.all('SELECT * FROM audit WHERE workspace_id=? ORDER BY created_at DESC LIMIT 100', w),
      users: db.all('SELECT id,name,email,role,created_at FROM users WHERE workspace_id=?', w),
      settings: { allow_private_upstreams: !!options.allowPrivate, secure_cookie: !!options.secureCookie, storage: 'SQLite · single instance', version }
    };
  });
  app.get('/api/admin/usage', async request => {
    const user = sessionUser(request);
    const { period } = z.object({ period: z.enum(['today', '7d', '30d', 'all']).default('7d') }).parse(request.query);
    const today = new Date().toISOString().slice(0, 10);
    const days = period === 'today' ? 1 : period === '7d' ? 7 : 30;
    const trendStart = new Date(Date.parse(today + 'T00:00:00Z') - (days - 1) * 86400000).toISOString().slice(0, 10);
    const since = period === 'all' ? '' : trendStart;
    const byKey = db.all(`SELECT k.id,k.name,k.owner,k.prefix,k.revoked,k.user_id,u.name AS user_name,u.email AS user_email,
      COALESCE(SUM(d.tokens),0) AS tokens,COALESCE(SUM(d.input_tokens),0) AS input_tokens,
      COALESCE(SUM(d.output_tokens),0) AS output_tokens,COALESCE(SUM(d.cost),0) AS cost
      FROM virtual_keys k LEFT JOIN users u ON u.id=k.user_id AND u.workspace_id=k.workspace_id
      LEFT JOIN usage_daily d ON d.key_id=k.id AND d.day>=? AND d.day<=?
      WHERE k.workspace_id=? GROUP BY k.id ORDER BY tokens DESC,k.name`, since, today, user.workspace_id);
    const daily = db.all(`SELECT d.* FROM usage_daily d JOIN virtual_keys k ON k.id=d.key_id
      WHERE k.workspace_id=? AND d.day>=? AND d.day<=? ORDER BY d.day`, user.workspace_id, trendStart, today);
    return { period, since: since || null, trend_start: trendStart, through: today, by_key: byKey, daily };
  });
  const record = (table: string, request: any) => {
    const user = sessionUser(request), row = db.get(`SELECT * FROM ${table} WHERE id=? AND workspace_id=?`, request.params.id, user.workspace_id);
    if (!row) throw new HttpError(404, 'Item not found.'); return { user, row };
  };
  app.post('/api/admin/providers', async request => {
    const user = sessionUser(request), input = providerSchema.parse(request.body), providerId = id();
    const url = await validateUpstream(input.base_url, !!options.allowPrivate);
    db.run('INSERT INTO providers VALUES (?, ?, ?, ?, ?, ?, ?)', providerId, user.workspace_id, input.name, url, input.api_key ? db.seal(input.api_key) : '', Number(input.enabled), now());
    db.audit(user.workspace_id, user.email, 'provider.created', input.name); return { id: providerId };
  });
  app.put('/api/admin/providers/:id', async request => {
    const { user, row } = record('providers', request), input = providerSchema.parse(request.body);
    const url = await validateUpstream(input.base_url, !!options.allowPrivate);
    db.run('UPDATE providers SET name=?, base_url=?, secret=?, enabled=? WHERE id=?', input.name, url, input.api_key === undefined ? row.secret : (input.api_key ? db.seal(input.api_key) : ''), Number(input.enabled), row.id);
    db.audit(user.workspace_id, user.email, 'provider.updated', input.name); return { ok: true };
  });
  app.post('/api/admin/deployments', async request => {
    const user = sessionUser(request), input = deploymentSchema.parse(request.body), deploymentId = id();
    if (!db.get('SELECT id FROM providers WHERE id=? AND workspace_id=?', input.provider_id, user.workspace_id)) throw new HttpError(400, 'Choose a provider in this workspace.');
    db.run('INSERT INTO deployments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)', deploymentId, user.workspace_id, input.provider_id, input.alias, input.upstream_model, input.weight, input.input_price, input.output_price, Number(input.enabled), now());
    db.audit(user.workspace_id, user.email, 'deployment.created', input.alias); return { id: deploymentId };
  });
  app.put('/api/admin/deployments/:id', async request => {
    const { user, row } = record('deployments', request), input = deploymentSchema.parse(request.body);
    if (!db.get('SELECT id FROM providers WHERE id=? AND workspace_id=?', input.provider_id, user.workspace_id)) throw new HttpError(400, 'Choose a provider in this workspace.');
    db.run('UPDATE deployments SET provider_id=?,alias=?,upstream_model=?,weight=?,input_price=?,output_price=?,enabled=? WHERE id=?', input.provider_id, input.alias, input.upstream_model, input.weight, input.input_price, input.output_price, Number(input.enabled), row.id);
    db.audit(user.workspace_id, user.email, 'deployment.updated', input.alias); return { ok: true };
  });
  app.post('/api/admin/policies', async request => {
    const user = sessionUser(request), input = policySchema.parse(request.body), policyId = id();
    db.run('INSERT INTO policies (id,workspace_id,name,blocked_terms,redact_pii,block_secrets,created_at,pii_types,term_match) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', policyId, user.workspace_id, input.name, JSON.stringify(input.blocked_terms), Number(input.redact_pii), Number(input.block_secrets), now(), JSON.stringify(input.pii_types), input.term_match);
    db.audit(user.workspace_id, user.email, 'policy.created', input.name); return { id: policyId };
  });
  app.put('/api/admin/policies/:id', async request => {
    const { user, row } = record('policies', request), input = policySchema.parse(request.body);
    db.run('UPDATE policies SET name=?,blocked_terms=?,redact_pii=?,block_secrets=?,pii_types=?,term_match=? WHERE id=?', input.name, JSON.stringify(input.blocked_terms), Number(input.redact_pii), Number(input.block_secrets), JSON.stringify(input.pii_types), input.term_match, row.id);
    db.audit(user.workspace_id, user.email, 'policy.updated', input.name); return { ok: true };
  });
  app.post('/api/admin/policies/test', async request => {
    const input = z.object({ policy: policySchema.omit({ name: true }), text: z.string().min(1).max(20000) }).strict().parse(request.body);
    const inspection = inspectPolicy({ messages: [{ role: 'user', content: input.text }] }, input.policy);
    // A dry run never stores text, changes usage, or contacts a model provider.
    return { action: inspection.action, result: inspection.result, findings: inspection.findings, message: inspection.message, text: inspection.body?.messages[0].content ?? null };
  });
  app.patch('/api/admin/keys/:id/policy', async request => {
    const { user, row } = record('virtual_keys', request);
    const { policy_id } = z.object({ policy_id: z.string().min(1).nullable() }).strict().parse(request.body);
    if (row.revoked) throw new HttpError(400, 'This key has been revoked.');
    if (policy_id && !db.get('SELECT id FROM policies WHERE id=? AND workspace_id=?', policy_id, user.workspace_id)) throw new HttpError(400, 'Choose a policy in this workspace.');
    db.run('UPDATE virtual_keys SET policy_id=? WHERE id=?', policy_id, row.id);
    db.audit(user.workspace_id, user.email, 'key.policy_updated', row.name);
    return { ok: true };
  });
  function validateKey(input: z.infer<typeof keySchema>, workspace: string) {
    if (input.user_id && !db.get('SELECT id FROM users WHERE id=? AND workspace_id=?', input.user_id, workspace)) throw new HttpError(400, 'Choose a team member in this workspace.');
    if (input.expires_at && input.expires_at <= now()) throw new HttpError(400, 'Expiration must be in the future.');
    if (input.policy_id && !db.get('SELECT id FROM policies WHERE id=? AND workspace_id=?', input.policy_id, workspace)) throw new HttpError(400, 'Choose a policy in this workspace.');
    const aliases = db.all('SELECT DISTINCT alias FROM deployments WHERE workspace_id=?', workspace).map(row => row.alias);
    if (input.models.some(model => !aliases.includes(model))) throw new HttpError(400, 'Choose configured model aliases.');
  }
  app.post('/api/admin/keys', async request => {
    const user = sessionUser(request), input = keySchema.parse(request.body), keyId = id(), token = issueToken();
    validateKey(input, user.workspace_id);
    db.run('INSERT INTO virtual_keys (id,workspace_id,name,owner,token_hash,prefix,models,policy_id,budget,spent,reserved,rpm,max_request_tokens,expires_at,revoked,created_at,token_limit,tpm,limit_period,user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, 0, ?, ?, ?, ?, ?)', keyId, user.workspace_id, input.name, input.owner, hash(token), token.slice(0, 11), JSON.stringify(input.models), input.policy_id, input.budget === null ? null : Math.round(input.budget * 1e6), input.rpm, input.max_request_tokens, input.expires_at, now(), input.token_limit ?? null, input.tpm ?? null, input.limit_period ?? 'lifetime', input.user_id ?? null);
    db.audit(user.workspace_id, user.email, 'key.created', input.name); return { id: keyId, token };
  });
  app.put('/api/admin/keys/:id', async request => {
    const { user, row } = record('virtual_keys', request), input = keySchema.parse(request.body);
    validateKey(input, user.workspace_id);
    db.run('UPDATE virtual_keys SET name=?,owner=?,models=?,policy_id=?,budget=?,rpm=?,max_request_tokens=?,expires_at=?,token_limit=?,tpm=?,limit_period=?,user_id=? WHERE id=?', input.name, input.owner, JSON.stringify(input.models), input.policy_id, input.budget === null ? null : Math.round(input.budget * 1e6), input.rpm, input.max_request_tokens, input.expires_at, input.token_limit === undefined ? row.token_limit : input.token_limit, input.tpm === undefined ? row.tpm : input.tpm, input.limit_period ?? row.limit_period, input.user_id === undefined ? row.user_id : input.user_id, row.id);
    db.audit(user.workspace_id, user.email, 'key.updated', input.name); return { ok: true };
  });
  app.post('/api/admin/keys/:id/rotate', async request => {
    const { user, row } = record('virtual_keys', request);
    if (row.revoked) throw new HttpError(400, 'Revoked keys cannot be rotated. Create a new key.');
    const token = issueToken(); db.run('UPDATE virtual_keys SET token_hash=?,prefix=? WHERE id=?', hash(token), token.slice(0, 11), row.id);
    db.audit(user.workspace_id, user.email, 'key.rotated', row.name); return { token };
  });
  app.post('/api/admin/keys/:id/revoke', async request => {
    const { user, row } = record('virtual_keys', request); db.run('UPDATE virtual_keys SET revoked=1 WHERE id=?', row.id);
    db.audit(user.workspace_id, user.email, 'key.revoked', row.name); return { ok: true };
  });
  app.post('/api/admin/users', async request => {
    const user = sessionUser(request), input = memberSchema.parse(request.body);
    if (db.get('SELECT id FROM users WHERE email=?', input.email)) throw new HttpError(409, 'This email is already a member.');
    db.run('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?)', id(), user.workspace_id, input.name, input.email, passwordHash(input.password), input.role, now());
    db.audit(user.workspace_id, user.email, 'member.created', input.email); return { ok: true };
  });
  app.delete('/api/admin/users/:id', async request => {
    const { user, row } = record('users', request);
    if (row.id === user.id) throw new HttpError(400, 'You cannot remove your own account.');
    db.transaction(() => { db.run('DELETE FROM sessions WHERE user_id=?', row.id); db.run('DELETE FROM users WHERE id=?', row.id); db.audit(user.workspace_id, user.email, 'member.removed', row.email); });
    return { ok: true };
  });
  app.put('/api/admin/workspace', async request => {
    const user = sessionUser(request), input = z.object({ name }).parse(request.body);
    db.run('UPDATE workspaces SET name=? WHERE id=?', input.name, user.workspace_id);
    db.audit(user.workspace_id, user.email, 'workspace.updated', input.name); return { ok: true };
  });
  registerGateway(app, db, { allowPrivate: !!options.allowPrivate, timeoutMs: options.timeoutMs, random: options.random });
  const staticDir = options.staticDir ?? fileURLToPath(new URL('../dist/', import.meta.url));
  if (existsSync(staticDir)) {
    await app.register(staticFiles, { root: staticDir });
    app.setNotFoundHandler((request, reply) => request.method === 'GET' && !request.url.startsWith('/api') && !request.url.startsWith('/v1') ? reply.sendFile('index.html') : reply.code(404).send({ error: { message: 'Route not found.', code: 'not_found' } }));
  }
  app.addHook('onClose', async () => db.close());
  return { app, db };
}
