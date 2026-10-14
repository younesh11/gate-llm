import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { once } from 'node:events';
import { z } from 'zod';
import { accessFor, keyMember, checkMemberAllowance } from './members.ts';
import { Store, HttpError, hash, now, type Row } from './store.ts';
import { applyPolicy, GuardrailError, orderDeployments } from './guards.ts';
import { safeError } from './operations.ts';
import { canCountText, countVllmInput, estimateInputTokens } from './token-counting.ts';
import { createUpstreamClient, type UpstreamFetch } from './upstream.ts';
export { isPrivateAddress, validateUpstream } from './upstream.ts';

const message = z.object({ role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']), content: z.string().max(100_000).nullable(), name: z.string().optional(), tool_call_id: z.string().optional(), tool_calls: z.array(z.any()).max(64).optional() }).strict();
const chatBody = z.object({
  model: z.string().min(1).max(100), messages: z.array(message).min(1).max(100), stream: z.boolean().default(false),
  temperature: z.number().min(0).max(2).optional(), top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().min(1).max(32768).optional(), max_completion_tokens: z.number().int().min(1).max(32768).optional(),
  max_total_tokens: z.number().int().min(1).max(1_000_000).optional(),
  tools: z.array(z.any()).max(64).optional(), tool_choice: z.any().optional(), parallel_tool_calls: z.boolean().optional(),
  response_format: z.any().optional(), stop: z.union([z.string(), z.array(z.string()).max(4)]).optional(), seed: z.number().int().optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(), presence_penalty: z.number().min(-2).max(2).optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).optional(), n: z.literal(1).optional()
}).strict();

export function registerGateway(app: FastifyInstance, db: Store, options: { allowPrivate: boolean; timeoutMs?: number; random?: () => number }) {
  const upstream = createUpstreamClient(options.allowPrivate);
  app.addHook('onClose', async () => { await upstream.close(); });
  const counting = new Map<string, { window: number; calls: number; active: number }>();
  const authenticate = (request: FastifyRequest): Row => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) throw new HttpError(401, 'A virtual API key is required.', 'invalid_api_key');
    const key = db.get('SELECT * FROM virtual_keys WHERE token_hash=?', hash(authorization.slice(7)));
    if (!key || key.revoked || (key.expires_at && key.expires_at <= now())) throw new HttpError(401, 'This API key is invalid, expired or revoked.', 'invalid_api_key');
    keyMember(db, key);
    return key;
  };
  app.get('/v1/models', async request => {
    const key = authenticate(request), allowed: string[] = JSON.parse(key.models);
    const rows = db.all('SELECT DISTINCT d.alias FROM deployments d JOIN providers p ON p.id=d.provider_id WHERE d.workspace_id=? AND d.enabled=1 AND p.enabled=1', key.workspace_id);
    return { object: 'list', data: rows.filter(row => allowed.includes(row.alias) && (keyMember(db,key)?.user.role !== 'member' || accessFor(db,key.user_id).models.includes(row.alias))).map(row => ({ id: row.alias, object: 'model', created: 0, owned_by: 'relay' })) };
  });

  app.post('/v1/chat/completions', async (request, reply) => {
    const started = Date.now(), requestId = request.id, key = authenticate(request);
    let body = chatBody.parse(request.body);
    if (body.max_tokens && body.max_completion_tokens) throw new HttpError(400, 'Use only one output-token limit.');
    if (!(JSON.parse(key.models) as string[]).includes(body.model)) throw new HttpError(403, 'This key cannot access the requested model.', 'model_not_allowed');
    const member = keyMember(db,key,body.model);
    checkMemberAllowance(db,key,0,0,Date.now());
    const memberPolicy = member?.user.role === 'member' && member.access.policy_id ? db.get('SELECT * FROM policies WHERE id=? AND workspace_id=?',member.access.policy_id,key.workspace_id) : undefined;
    const policy = key.policy_id ? db.get('SELECT * FROM policies WHERE id=? AND workspace_id=?', key.policy_id, key.workspace_id) : undefined;
    let guardrail: string | null = null;
    try { for (const rule of [memberPolicy, policy]) { const guarded = applyPolicy(body, rule); body = guarded.body; guardrail = guarded.result ?? guardrail; } }
    catch (error) {
      if (error instanceof GuardrailError) db.log({ id: requestId, workspace_id: key.workspace_id, key_id: key.id, key_name: key.name, model: body.model, status: 'blocked', http_status: 422, latency_ms: Date.now() - started, guardrail: error.result });
      throw error;
    }
    const candidates = orderDeployments(db.all('SELECT d.*, p.base_url, p.secret, p.token_counting FROM deployments d JOIN providers p ON p.id=d.provider_id WHERE d.workspace_id=? AND d.alias=? AND d.enabled=1 AND p.enabled=1 AND d.cooldown_until<=?', key.workspace_id, body.model, Date.now()), options.random).slice(0, 3);
    if (!candidates.length) throw new HttpError(503, 'No available deployment for this model.', 'no_deployments');
    const totalLimit = body.max_total_tokens ?? key.max_request_tokens;
    if (totalLimit > key.max_request_tokens) throw new HttpError(400, `This key allows up to ${key.max_request_tokens} combined input + output tokens per request.`, 'request_token_limit_exceeded');
    const canCount = canCountText(body), estimate = estimateInputTokens(body);
    const exact = canCount && candidates.every(row => row.token_counting === 'vllm');
    let inputEstimate = estimate;
    if (canCount && candidates.some(row => row.token_counting === 'vllm')) {
      // Counting happens after guardrails, before generation reservations. Bound this
      // unbilled work separately so rejected requests cannot hammer the tokenizer.
      const window = Math.floor(Date.now() / 60000);
      for (const [id, entry] of counting) if (entry.window !== window && !entry.active) counting.delete(id);
      const entry = counting.get(key.id) ?? { window, calls: 0, active: 0 };
      if (entry.window !== window) { entry.window = window; entry.calls = 0; }
      if (entry.active >= 8 || entry.calls >= key.rpm) throw new HttpError(429, 'Token-counting request limit reached. Wait before trying again.', 'token_count_rate_limit');
      entry.calls++; entry.active++; counting.set(key.id, entry);
      const controller = new AbortController(), onClose = () => controller.abort();
      const timer = setTimeout(() => controller.abort(), Math.min(options.timeoutMs ?? 5000, 5000));
      reply.raw.on('close', onClose);
      try {
        const inputs = await Promise.all(candidates.map(async row => {
          if (row.token_counting !== 'vllm') return estimate;
          return countVllmInput(row, body, row.secret ? db.unseal(row.secret) : undefined, controller.signal, upstream.fetch);
        }));
        inputEstimate = Math.max(...inputs);
      } finally {
        controller.abort(); clearTimeout(timer); reply.raw.off('close', onClose); entry.active--;
      }
    }
    const remainingOutput = totalLimit - inputEstimate;
    const inputLabel = exact ? 'Counted input' : 'Estimated input';
    if (remainingOutput < 1) throw new HttpError(400, `${inputLabel} (${inputEstimate}) leaves no room for output within the ${totalLimit} combined-token limit. Shorten the conversation or increase the request limit.${exact ? '' : ' This is a conservative estimate; a supported provider tokenizer can give a more accurate count.'}`, 'request_token_limit_exceeded');
    const maxOutput = body.max_completion_tokens ?? body.max_tokens ?? Math.min(remainingOutput, body.max_total_tokens ? 32768 : 1024);
    if (maxOutput > remainingOutput) throw new HttpError(400, `${inputLabel} (${inputEstimate}) plus requested output (${maxOutput}) exceeds the ${totalLimit} combined-token limit. Reduce the output limit to ${remainingOutput} or shorten the conversation.`, 'request_token_limit_exceeded');
    const reservation = Math.ceil(Math.max(...candidates.map(row => inputEstimate * row.input_price + maxOutput * row.output_price)));
    const tokenReservation = inputEstimate + maxOutput;
    const admittedAt = now(), minuteWindow = Math.floor(Date.parse(admittedAt) / 60000);
    db.transaction(() => {
      const current = authenticate(request);
      keyMember(db,current,body.model);
      if (current.user_id !== key.user_id) throw new HttpError(409,'Key assignment changed. Retry the request.');
      const freshMemberPolicyId = member?.user.role === 'member' ? accessFor(db,current.user_id).policy_id : null;
      const freshMemberPolicy = freshMemberPolicyId ? db.get('SELECT * FROM policies WHERE id=? AND workspace_id=?',freshMemberPolicyId,current.workspace_id) : undefined;
      if (JSON.stringify(freshMemberPolicy) !== JSON.stringify(memberPolicy)) throw new HttpError(409,'Your guardrail policy changed. Retry the request.');
      checkMemberAllowance(db,current,reservation,tokenReservation,Date.parse(admittedAt));
      if (!(JSON.parse(current.models) as string[]).includes(body.model)) throw new HttpError(403, 'This key cannot access the requested model.', 'model_not_allowed');
      if (totalLimit > current.max_request_tokens) throw new HttpError(400, 'The key request limit changed. Retry with a lower combined-token limit.', 'request_token_limit_exceeded');
      const allocation = db.limitSummary(current, Date.parse(admittedAt));
      if (current.budget !== null && allocation.period_spent + allocation.money_reserved + reservation > current.budget) throw new HttpError(429, 'Key budget cannot cover this request. Reduce the output limit or increase the budget.', 'budget_exceeded');
      if (current.token_limit !== null && allocation.tokens_used + allocation.tokens_reserved + tokenReservation > current.token_limit) throw new HttpError(429, 'Token allowance cannot cover this request. Reduce the prompt/output limit, increase the allowance, or wait for its reset.', 'token_quota_exceeded');
      if (db.get('SELECT COUNT(*) AS count FROM reservations WHERE key_id=?', key.id)!.count >= 8) throw new HttpError(429, 'Too many concurrent requests for this key.', 'concurrency_limit');
      const rate = db.get('SELECT requests,tokens FROM rate_windows WHERE key_id=? AND window=?', key.id, minuteWindow);
      if ((rate?.requests ?? 0) >= current.rpm) throw new HttpError(429, 'Requests-per-minute limit exceeded.', 'rate_limit_exceeded');
      if (current.tpm !== null && (rate?.tokens ?? 0) + tokenReservation > current.tpm) throw new HttpError(429, 'Tokens-per-minute limit cannot cover this request. Reduce the prompt/output limit or wait for the next minute.', 'token_rate_limit_exceeded');
      db.run('INSERT INTO rate_windows (key_id,window,requests,tokens) VALUES (?, ?, 1, ?) ON CONFLICT(key_id,window) DO UPDATE SET requests=requests+1,tokens=tokens+excluded.tokens', key.id, minuteWindow, tokenReservation);
      db.run('DELETE FROM rate_windows WHERE window<?', minuteWindow - 3);
      db.run('UPDATE virtual_keys SET reserved=reserved+? WHERE id=?', reservation, key.id);
      db.run('INSERT INTO reservations (id,workspace_id,key_id,model,amount,created_at,token_amount,minute_window) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', requestId, key.workspace_id, key.id, body.model, reservation, admittedAt, tokenReservation, minuteWindow);
      if (current.user_id) db.run('INSERT INTO member_holds VALUES (?,?)', requestId,current.user_id);
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000);
    const onClose = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on('close', onClose);
    let selected: Row | undefined, attempts = 0, sentUpstream = false, usage: any, status = 'success', statusCode = 200, estimated = 0, cost = 0, chargedTokens = 0;
    const finish = () => {
      clearTimeout(timer); reply.raw.off('close', onClose);
      if (usage && Number.isSafeInteger(usage.prompt_tokens) && Number.isSafeInteger(usage.completion_tokens) && usage.prompt_tokens >= 0 && usage.completion_tokens >= 0 && Number.isSafeInteger(usage.prompt_tokens + usage.completion_tokens) && selected) {
        cost = Math.ceil(usage.prompt_tokens * selected.input_price + usage.completion_tokens * selected.output_price);
        chargedTokens = usage.prompt_tokens + usage.completion_tokens;
      } else { usage = undefined; if (sentUpstream) { cost = reservation; chargedTokens = tokenReservation; estimated = 1; } }
      try { db.transaction(() => {
        db.run('UPDATE virtual_keys SET reserved=MAX(0,reserved-?), spent=spent+? WHERE id=?', reservation, cost, key.id);
        db.run('UPDATE rate_windows SET tokens=MAX(0,tokens-?)+? WHERE key_id=? AND window=?', tokenReservation, chargedTokens, key.id, minuteWindow);
        db.recordUsage(key.id, admittedAt, cost, chargedTokens, usage?.prompt_tokens ?? 0, usage?.completion_tokens ?? 0);
        db.recordMemberUsage(db.get('SELECT user_id FROM member_holds WHERE reservation_id=?',requestId)?.user_id,admittedAt,cost,chargedTokens);
        db.run('DELETE FROM reservations WHERE id=?', requestId);
        db.log({ id: requestId, workspace_id: key.workspace_id, key_id: key.id, key_name: key.name, model: body.model, deployment_id: selected?.id ?? null, status, http_status: statusCode, latency_ms: Date.now() - started, input_tokens: usage?.prompt_tokens ?? 0, output_tokens: usage?.completion_tokens ?? 0, cost, estimated, guardrail, attempts, created_at: admittedAt });
      }); } catch (error) {
        request.log.error({ event: 'gateway_settlement_failed', error: safeError(error) });
        throw error;
      }
      request.log[status === 'success' ? 'info' : 'warn']({ event: 'gateway_request_settled', key_id: key.id, deployment_id: selected?.id ?? null, status, http_status: statusCode, attempts, duration_ms: Date.now() - started, tokens: chargedTokens, cost_microdollars: cost, estimated: !!estimated });
    };
    try {
      let response: Awaited<ReturnType<UpstreamFetch>> | undefined;
      for (const deployment of candidates) {
        selected = deployment;
        attempts++;
        const { max_total_tokens: _totalLimit, ...upstreamBody } = body;
        const payload: any = { ...upstreamBody, model: deployment.upstream_model, ...(body.max_completion_tokens ? { max_completion_tokens: maxOutput } : { max_tokens: maxOutput }) };
        if (body.stream) payload.stream_options = { include_usage: true };
        sentUpstream = true;
        response = await upstream.fetch(`${deployment.base_url}/chat/completions`, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', ...(deployment.secret ? { Authorization: `Bearer ${db.unseal(deployment.secret)}` } : {}) },
          body: JSON.stringify(payload)
        });
        if (response.status === 429) {
          const seconds = Number(response.headers.get('retry-after'));
          db.run('UPDATE deployments SET failures=failures+1, cooldown_until=? WHERE id=?', Date.now() + (Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 300) : 30) * 1000, deployment.id);
          await response.body?.cancel(); sentUpstream = false;
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status < 500) sentUpstream = false;
          if (response.status >= 500) db.run('UPDATE deployments SET failures=failures+1, cooldown_until=? WHERE id=?', Date.now() + 30_000, deployment.id);
          throw new HttpError(502, `Provider returned HTTP ${response.status}. Check its credentials, model and request parameters.`, 'upstream_error');
        }
        db.run('UPDATE deployments SET failures=0, cooldown_until=0 WHERE id=?', deployment.id);
        break;
      }
      if (!response?.ok) throw new HttpError(503, 'Available providers are rate limited. Try again shortly.', 'upstream_rate_limit');
      reply.header('x-request-id', requestId);
      if (!body.stream) {
        const reader = response.body?.getReader();
        if (!reader) throw new HttpError(502, 'Provider returned an empty response.', 'invalid_upstream_response');
        const chunks: Uint8Array[] = []; let bytes = 0;
        while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > 4_000_000) { controller.abort(); throw new HttpError(502, 'Provider response exceeded the size limit.'); } chunks.push(next.value); }
        const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!Array.isArray(json.choices)) throw new HttpError(502, 'Provider returned an invalid chat response.');
        usage = json.usage;
        return reply.send({ ...json, model: body.model });
      }
      if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw new HttpError(502, 'Provider did not return an event stream.');
      reply.hijack();
      reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', 'x-request-id': requestId });
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = '', doneMarker = false, bytes = 0;
      while (true) {
        const next = await reader.read(); if (next.done) break;
        bytes += next.value.length;
        if (bytes > 8_000_000) throw new HttpError(502, 'Stream exceeded the size limit.');
        buffer += decoder.decode(next.value, { stream: true });
        if (buffer.length > 1_000_000) throw new HttpError(502, 'Provider event exceeded the size limit.');
        const lines = buffer.split('\n'); buffer = lines.pop()!;
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') { doneMarker = true; continue; }
          try { const event = JSON.parse(data); if (event.error) throw new HttpError(502, 'The provider reported a stream error.'); if (event.usage) usage = event.usage; }
          catch (error) { if (error instanceof HttpError) throw error; }
        }
        if (!reply.raw.write(next.value)) await once(reply.raw, 'drain', { signal: controller.signal });
      }
      if (!doneMarker) throw new HttpError(502, 'Provider stream ended before completion.', 'stream_interrupted');
      reply.raw.end();
      return reply;
    } catch (error) {
      controller.abort();
      status = controller.signal.aborted && reply.raw.destroyed ? 'cancelled' : 'error';
      statusCode = error instanceof HttpError ? error.status : 502;
      if (reply.raw.headersSent) {
        if (!reply.raw.destroyed) { reply.raw.write(`data: ${JSON.stringify({ error: { message: 'The upstream stream was interrupted.', code: 'stream_interrupted' } })}\n\n`); reply.raw.end(); }
        return reply;
      }
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, 'Provider connection failed, timed out or returned an invalid response. This request was not retried.', 'upstream_error');
    } finally { finish(); }
  });
}
