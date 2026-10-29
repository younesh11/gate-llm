import { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand, type ConverseCommandInput } from '@aws-sdk/client-bedrock-runtime';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from './store.ts';

export const awsRegion = z.string().regex(/^(us|eu|ap|sa|ca|me|af|il|mx)-[a-z]+-[1-9]\d?$/, 'Enter a commercial AWS region, for example us-west-2.');
export type BedrockFactory = (region: string) => Pick<BedrockRuntimeClient, 'send' | 'destroy'>;
export const bedrockClient: BedrockFactory = region => new BedrockRuntimeClient({
  region: awsRegion.parse(region), endpoint: `https://bedrock-runtime.${region}.amazonaws.com`,
  ignoreConfiguredEndpointUrls: true, maxAttempts: 1,
  requestHandler: { connectionTimeout: 3000, requestTimeout: 120000 },
  // Explicit credential identity: provider secrets and AWS_BEARER_TOKEN_BEDROCK
  // are not authentication sources for this provider type.
  authSchemePreference: ['sigv4'],
});

/** Validate before admission. Never silently discard unsupported OpenAI options. */
export function converseInput(body: any): ConverseCommandInput {
  for (const key of ['tools', 'tool_choice', 'parallel_tool_calls', 'response_format', 'seed', 'frequency_penalty', 'presence_penalty']) {
    if (body[key] !== undefined) throw new HttpError(400, `AWS Bedrock text chat does not yet support ${key}.`, 'unsupported_bedrock_parameter');
  }
  if (body.temperature !== undefined && body.temperature > 1) throw new HttpError(400, 'AWS Bedrock temperature must be between 0 and 1.', 'unsupported_bedrock_parameter');
  const system: { text: string }[] = [], messages: NonNullable<ConverseCommandInput['messages']> = [];
  for (const m of body.messages) {
    if (m.role === 'tool' || m.tool_calls !== undefined || m.tool_call_id !== undefined || m.name !== undefined || typeof m.content !== 'string' || !m.content.trim()) {
      throw new HttpError(400, 'AWS Bedrock currently accepts non-empty text messages without tools or message names.', 'unsupported_bedrock_parameter');
    }
    if (m.role === 'system' || m.role === 'developer') {
      if (messages.length) throw new HttpError(400, 'Place Bedrock system instructions before the conversation.', 'unsupported_bedrock_parameter');
      system.push({ text: m.content });
    } else {
      const previous = messages.at(-1);
      if (previous && previous.role === m.role) previous.content!.push({ text: m.content });
      else messages.push({ role: m.role, content: [{ text: m.content }] });
    }
  }
  if (!messages.length || messages[0].role !== 'user') throw new HttpError(400, 'Start the Bedrock conversation with a user message.', 'unsupported_bedrock_parameter');
  const stop = body.stop === undefined ? undefined : typeof body.stop === 'string' ? [body.stop] : body.stop;
  if (stop?.some((s: string) => !s.length)) throw new HttpError(400, 'Bedrock stop sequences must not be empty.');
  return { modelId: body.model, messages, ...(system.length ? { system } : {}), inferenceConfig: {
    maxTokens: body.max_completion_tokens ?? body.max_tokens,
    temperature: body.temperature, topP: body.top_p, stopSequences: stop,
  } };
}
function usage(value: any) {
  if (!value || !Number.isSafeInteger(value.inputTokens) || !Number.isSafeInteger(value.outputTokens) || value.inputTokens < 0 || value.outputTokens < 0 || !Number.isSafeInteger(value.inputTokens + value.outputTokens)) throw new Error('Invalid Bedrock usage');
  return { prompt_tokens: value.inputTokens, completion_tokens: value.outputTokens, total_tokens: value.inputTokens + value.outputTokens };
}
function finishReason(reason: string | undefined) {
  if (reason === 'max_tokens') return 'length';
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'stop';
  if (reason === 'guardrail_intervened' || reason === 'content_filtered') return 'content_filter';
  throw new Error('Unsupported Bedrock completion');
}
export function bedrockErrorMessage(status: number) {
  if (status === 401) return 'AWS credentials are missing, expired or invalid. Refresh the server AWS profile and retry.';
  if (status === 403) return 'AWS denied model access. Check bedrock:InvokeModel and bedrock:InvokeModelWithResponseStream permissions, model access and region.';
  if (status === 400 || status === 404) return 'Bedrock rejected this model or request. Check the model ID, region, Converse support and whether an inference profile is required.';
  return `AWS Bedrock returned HTTP ${status}. Check model availability and try again later.`;
}

/** Convert the native response to the existing gateway's bounded JSON/SSE pipeline. */
export async function fetchBedrock(region: string, body: any, signal: AbortSignal, factory: BedrockFactory = bedrockClient, responseModel = body.model): Promise<Response> {
  const input = converseInput(body), client = factory(awsRegion.parse(region));
  let closed = false;
  const close = () => { if (!closed) { closed = true; client.destroy(); signal.removeEventListener('abort', close); } };
  signal.addEventListener('abort', close, { once: true });
  const base = { id: `chatcmpl-${randomUUID()}`, created: Math.floor(Date.now() / 1000), model: responseModel };
  try {
    if (signal.aborted) throw new Error('Request aborted');
    if (!body.stream) {
      const result = await client.send(new ConverseCommand(input), { abortSignal: signal });
      const content = result.output?.message?.content;
      if (!content || content.some(block => typeof block.text !== 'string')) throw new Error('Unsupported Bedrock output');
      return Response.json({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: content.map(b => b.text).join('') }, finish_reason: finishReason(result.stopReason) }], usage: usage(result.usage) });
    }
    const result = await client.send(new ConverseStreamCommand(input), { abortSignal: signal });
    if (!result.stream) throw new Error('Missing Bedrock stream');
    const encoder = new TextEncoder();
    const event = (value: any) => encoder.encode(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', ...value })}\n\n`);
    async function* chunks() {
      let stopped = false, measured = false, started = false;
      try {
        for await (const part of result.stream!) {
          if (signal.aborted) throw new Error('Request aborted');
          if (Object.keys(part).some(key => key.endsWith('Exception') || key === '$unknown')) throw new Error('Bedrock stream failed');
          if (part.messageStart) {
            if (started || part.messageStart.role !== 'assistant') throw new Error('Invalid Bedrock stream start');
            started = true;
            yield event({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
          }
          if (part.contentBlockStart?.start && Object.keys(part.contentBlockStart.start).length) throw new Error('Unsupported Bedrock content');
          if (part.contentBlockDelta) {
            const delta = part.contentBlockDelta.delta;
            if (!started || stopped || typeof delta?.text !== 'string') throw new Error('Unsupported Bedrock delta');
            yield event({ choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }] });
          }
          if (part.messageStop) {
            if (!started || stopped) throw new Error('Invalid Bedrock stream stop');
            stopped = true;
            yield event({ choices: [{ index: 0, delta: {}, finish_reason: finishReason(part.messageStop.stopReason) }] });
          }
          if (part.metadata) {
            if (!stopped || measured) throw new Error('Invalid Bedrock stream metadata');
            measured = true;
            yield event({ choices: [], usage: usage(part.metadata.usage) });
          }
        }
        if (!stopped || !measured) throw new Error('Incomplete Bedrock stream');
        yield encoder.encode('data: [DONE]\n\n');
      } finally { close(); }
    }
    const iterator = chunks();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try { const next = await iterator.next(); if (next.done) controller.close(); else controller.enqueue(next.value); }
        catch (error) { close(); controller.error(error); }
      },
      async cancel() { close(); await iterator.return(undefined); },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  } catch (error: any) {
    close();
    // Only definite pre-inference rejections release the reserved allowance.
    const name = error?.name;
    const status = ['CredentialsProviderError', 'TokenProviderError', 'ExpiredTokenException', 'UnrecognizedClientException', 'InvalidSignatureException'].includes(name) ? 401 : error?.$metadata?.httpStatusCode;
    if ([400, 401, 403, 404, 429, 500, 503].includes(status)) return new Response(null, { status });
    throw new Error('Bedrock connection failed');
  } finally { if (!body.stream) close(); }
}
