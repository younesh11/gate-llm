import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { once } from 'node:events';
import { lookup } from 'node:dns/promises';
import { z } from 'zod';
import { Store, HttpError, hash, now, type Row } from './store.ts';
import { applyPolicy, GuardrailError, orderDeployments } from './guards.ts';
import { safeError } from './operations.ts';

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

export function isPrivateAddress(address: string) {
  const value = address.toLowerCase().replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
  if (value.includes(':')) return value === '::1' || value === '::' || /^(fc|fd|fe[89ab])/.test(value) || value.startsWith('2001:db8');
  const p = value.split('.').map(Number);
  return p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || (p[0] === 198 && [18, 19].includes(p[1]));
}
export async function validateUpstream(url: string, allowPrivate: boolean) {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new HttpError(400, 'Enter an absolute provider URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new HttpError(400, 'Use an HTTP(S) URL without credentials, query strings or fragments.');
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (hostname === 'metadata.google.internal' || hostname === '169.254.169.254') throw new HttpError(400, 'Cloud metadata endpoints cannot be used as providers.');
  if (!allowPrivate) {
    if (parsed.protocol !== 'https:') throw new HttpError(400, 'Public upstreams must use HTTPS. Set ALLOW_PRIVATE_UPSTREAMS for a trusted local model.');
    let addresses;
    try { addresses = await lookup(hostname, { all: true }); } catch { throw new HttpError(400, 'Provider hostname could not be resolved.'); }
    if (!addresses.length || addresses.some(row => isPrivateAddress(row.address))) throw new HttpError(400, 'Private upstreams require ALLOW_PRIVATE_UPSTREAMS=true.');
  }
  return parsed.toString().replace(/\/$/, '');
}

export function registerGateway(app: FastifyInstance, db: Store, options: { allowPrivate: boolean; timeoutMs?: number; random?: () => number }) {
  const authenticate = (request: FastifyRequest): Row => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) throw new HttpError(401, 'A virtual API key is required.', 'invalid_api_key');
    const key = db.get('SELECT * FROM virtual_keys WHERE token_hash=?', hash(authorization.slice(7)));
    if (!key || key.revoked || (key.expires_at && key.expires_at <= now())) throw new HttpError(401, 'This API key is invalid, expired or revoked.', 'invalid_api_key');
    return key;
  };
  app.get('/v1/models', async request => {
    const key = authenticate(request), allowed: string[] = JSON.parse(key.models);
    const rows = db.all('SELECT DISTINCT d.alias FROM deployments d JOIN providers p ON p.id=d.provider_id WHERE d.workspace_id=? AND d.enabled=1 AND p.enabled=1', key.workspace_id);
    return { object: 'list', data: rows.filter(row => allowed.includes(row.alias)).map(row => ({ id: row.alias, object: 'model', created: 0, owned_by: 'relay' })) };
  });

  app.post('/v1/chat/completions', async (request, reply) => {
    const started = Date.now(), requestId = request.id, key = authenticate(request);
    let body = chatBody.parse(request.body);
    if (body.max_tokens && body.max_completion_tokens) throw new HttpError(400, 'Use only one output-token limit.');
    if (!(JSON.parse(key.models) as string[]).includes(body.model)) throw new HttpError(403, 'This key cannot access the requested model.', 'model_not_allowed');
    const policy = key.policy_id ? db.get('SELECT * FROM policies WHERE id=? AND workspace_id=?', key.policy_id, key.workspace_id) : undefined;
    let guardrail: string | null = null;
    try { const guarded = applyPolicy(body, policy); body = guarded.body; guardrail = guarded.result; }
    catch (error) {
      if (error instanceof GuardrailError) db.log({ id: requestId, workspace_id: key.workspace_id, key_id: key.id, key_name: key.name, model: body.model, status: 'blocked', http_status: 422, latency_ms: Date.now() - started, guardrail: error.result });
      throw error;
    }
    const candidates = db.all('SELECT d.*, p.base_url, p.secret FROM deployments d JOIN providers p ON p.id=d.provider_id WHERE d.workspace_id=? AND d.alias=? AND d.enabled=1 AND p.enabled=1 AND d.cooldown_until<=?', key.workspace_id, body.model, Date.now());
    if (!candidates.length) throw new HttpError(503, 'No available deployment for this model.', 'no_deployments');
    const totalLimit = body.max_total_tokens ?? key.max_request_tokens;
    if (totalLimit > key.max_request_tokens) throw new HttpError(400, `This key allows up to ${key.max_request_tokens} combined input + output tokens per request.`, 'request_token_limit_exceeded');
    // Text-only endpoint: reserve a deliberately conservative byte-based input estimate.
    // This is a budget control, not a provider billing guarantee. Missing usage retains the reservation.
    const inputEstimate = Buffer.byteLength(JSON.stringify(body)) + 128 * body.messages.length + 1024;
    const remainingOutput = totalLimit - inputEstimate;
    const maxOutput = body.max_completion_tokens ?? body.max_tokens ?? Math.min(remainingOutput, body.max_total_tokens ? 32768 : 1024);
    if (remainingOutput < 1 || maxOutput > remainingOutput) throw new HttpError(400, `Estimated input (${inputEstimate}) plus requested output (${Math.max(0, maxOutput)}) exceeds the ${totalLimit} total tokens per request. Shorten the input or lower the requested output.`, 'request_token_limit_exceeded');
    const reservation = Math.ceil(Math.max(...candidates.map(row => inputEstimate * row.input_price + maxOutput * row.output_price)));
    const tokenReservation = inputEstimate + maxOutput;
    const admittedAt = now(), minuteWindow = Math.floor(Date.parse(admittedAt) / 60000);
    db.transaction(() => {
      const current = db.get('SELECT * FROM virtual_keys WHERE id=?', key.id)!;
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
        db.run('DELETE FROM reservations WHERE id=?', requestId);
        db.log({ id: requestId, workspace_id: key.workspace_id, key_id: key.id, key_name: key.name, model: body.model, deployment_id: selected?.id ?? null, status, http_status: statusCode, latency_ms: Date.now() - started, input_tokens: usage?.prompt_tokens ?? 0, output_tokens: usage?.completion_tokens ?? 0, cost, estimated, guardrail, attempts, created_at: admittedAt });
      }); } catch (error) {
        request.log.error({ event: 'gateway_settlement_failed', error: safeError(error) });
        throw error;
      }
      request.log[status === 'success' ? 'info' : 'warn']({ event: 'gateway_request_settled', key_id: key.id, deployment_id: selected?.id ?? null, status, http_status: statusCode, attempts, duration_ms: Date.now() - started, tokens: chargedTokens, cost_microdollars: cost, estimated: !!estimated });
    };
    try {
      let response: Response | undefined;
      for (const deployment of orderDeployments(candidates, options.random).slice(0, 3)) {
        selected = deployment;
        await validateUpstream(deployment.base_url, options.allowPrivate);
        attempts++;
        const { max_total_tokens: _totalLimit, ...upstreamBody } = body;
        const payload: any = { ...upstreamBody, model: deployment.upstream_model, ...(body.max_completion_tokens ? { max_completion_tokens: maxOutput } : { max_tokens: maxOutput }) };
        if (body.stream) payload.stream_options = { include_usage: true };
        sentUpstream = true;
        response = await fetch(`${deployment.base_url}/chat/completions`, {
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
