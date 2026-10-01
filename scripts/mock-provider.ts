import { createServer } from 'node:http';
export function mockProvider() {
  const captured: any[] = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw || '{}'); captured.push(body);
    if (body.model === 'rate-limit') { response.writeHead(429, { 'Retry-After': '1' }); response.end('{}'); return; }
    if (body.model === 'server-error') { response.writeHead(500); response.end('{}'); return; }
    if (body.model === 'slow') await new Promise(resolve => setTimeout(resolve, 120));
    const prompt = body.messages?.at(-1)?.content ?? '';
    const answer = prompt.toLowerCase().includes('rate limit') || prompt.toLowerCase().includes('rate limiting')
      ? 'Rate limiting sets a maximum number of requests an application can send within a time window.\n\nThink of it as a door that admits 60 requests each minute. Once that allowance is used, new requests wait for the next window.\n\nIn GATE, each virtual key has its own requests-per-minute limit. This keeps one application from consuming the whole team’s capacity.\n\nThis response came from the local demo provider. Connect your own model to generate real answers.'
      : `Your request reached the local demo provider.\n\nYou said: ${prompt}\n\nGATE checked your virtual key, applied its guardrail policy, selected a deployment, and forwarded the request. This is a simulated answer; no paid model was called.\n\nTo use your own LLM, add its OpenAI-compatible endpoint in Providers, then create a deployment under Models & routing.`;
    const usage = { prompt_tokens: 32, completion_tokens: Math.min(128, body.max_tokens ?? body.max_completion_tokens ?? 128), total_tokens: 160 };
    if (!body.stream) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ id: 'chatcmpl-local', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }], usage })); return; }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (value: any) => response.write(`data: ${JSON.stringify({ id: 'chatcmpl-local', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, ...value })}\n\n`);
    for (const word of answer.match(/\S+\s*/g) ?? []) {
      if (response.destroyed) return;
      emit({ choices: [{ index: 0, delta: { content: word }, finish_reason: null }] });
      await new Promise(resolve => setTimeout(resolve, body.model === 'fast' ? 0 : 12));
    }
    if (body.model === 'broken-stream') { response.end(); return; }
    emit({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    emit({ choices: [], usage }); response.end('data: [DONE]\n\n');
  });
  return { server, captured };
}
