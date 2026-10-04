import { HttpError, type Row } from './store.ts';
import type { UpstreamFetch } from './upstream.ts';

export function estimateInputTokens(body: Row) {
  return Buffer.byteLength(JSON.stringify(body)) + 128 * body.messages.length + 1024;
}

export function canCountText(body: Row) {
  // Tool formatting and structured output can change provider-specific prompts.
  return !body.tools?.length && body.tool_choice === undefined && body.response_format === undefined &&
    body.messages.every((message: Row) => message.role !== 'tool' && !message.tool_calls?.length);
}

export async function countVllmInput(deployment: Row, body: Row, credential: string | undefined, signal: AbortSignal, fetchUpstream: UpstreamFetch) {
  if (!deployment.base_url.endsWith('/v1')) throw new HttpError(400, 'vLLM token counting requires a base URL ending in /v1.');
  // Preserve a reverse proxy path prefix, and never follow redirects with credentials.
  const url = deployment.base_url.slice(0, -3) + '/tokenize';
  let response: Awaited<ReturnType<UpstreamFetch>>;
  try {
    response = await fetchUpstream(url, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
      body: JSON.stringify({ model: deployment.upstream_model, messages: body.messages, add_generation_prompt: true, add_special_tokens: false }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Tokenization was rejected');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No tokenizer response');
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length;
      if (size > 4_000_000) { await reader.cancel(); throw new Error('Tokenizer response too large'); }
      chunks.push(next.value);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!Number.isSafeInteger(result.count) || result.count < 1 || result.count > 10_000_000 ||
      !Array.isArray(result.tokens) || result.tokens.length !== result.count ||
      !result.tokens.every((token: unknown) => Number.isSafeInteger(token) && Number(token) >= 0)) {
      throw new Error('Invalid tokenizer count');
    }
    return result.count as number;
  } catch {
    // The upstream error or response may contain prompt text or credentials.
    throw new HttpError(503, 'Could not count input tokens with the provider tokenizer. Check the provider connection and token-counting setting; no generation was started.', 'token_count_unavailable');
  }
}
