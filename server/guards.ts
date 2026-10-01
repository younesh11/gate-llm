import type { Row } from './store.ts';
import { HttpError } from './store.ts';

export function applyPolicy(body: any, policy?: Row): { body: any; result: string | null } {
  if (!policy) return { body, result: null };
  const serialized = JSON.stringify(body);
  const terms: string[] = JSON.parse(policy.blocked_terms);
  if (terms.some(term => serialized.toLocaleLowerCase().includes(term.toLocaleLowerCase()))) throw new HttpError(422, 'Request blocked by the assigned content policy.', 'guardrail_blocked');
  if (policy.block_secrets && /(?:sk-[A-Za-z0-9_-]{20,}|rk_[A-Za-z0-9_-]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(serialized)) throw new HttpError(422, 'A possible credential was detected. Remove it before sending.', 'guardrail_blocked');
  let count = 0;
  function redact(value: any): any {
    if (typeof value === 'string') return value.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, () => { count++; return '[EMAIL REDACTED]'; }).replace(/\b\d{3}-\d{2}-\d{4}\b/g, () => { count++; return '[ID REDACTED]'; });
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, redact(val)]));
    return value;
  }
  // Only content and tool arguments are rewritten; routing, schema keys and model identifiers remain intact.
  const output = policy.redact_pii ? { ...body, messages: body.messages.map((message: any) => ({ ...message, content: redact(message.content), ...(message.tool_calls ? { tool_calls: message.tool_calls.map((tool: any) => ({ ...tool, function: { ...tool.function, arguments: redact(tool.function.arguments) } })) } : {}) })) } : body;
  return { body: output, result: count ? `redacted:${count}` : 'passed' };
}

export function orderDeployments(rows: Row[], random = Math.random): Row[] {
  const pool = [...rows], ordered: Row[] = [];
  while (pool.length) {
    let selected = random() * pool.reduce((sum, row) => sum + row.weight, 0);
    let index = pool.findIndex(row => (selected -= row.weight) < 0);
    if (index < 0) index = pool.length - 1;
    ordered.push(pool.splice(index, 1)[0]);
  }
  return ordered;
}
