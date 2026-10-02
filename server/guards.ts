import type { Row } from './store.ts';
import { HttpError } from './store.ts';

export const piiTypes = ['email', 'us_ssn', 'phone', 'credit_card'] as const;
export type PiiType = typeof piiTypes[number];
export const defaultPiiTypes: PiiType[] = ['email', 'us_ssn'];
export type Finding = { rule: string; label: string; action: 'block' | 'redact'; count: number };
export type Inspection = { action: 'allow' | 'block' | 'redact'; result: string; findings: Finding[]; body: any; message?: string };
export class GuardrailError extends HttpError {
  constructor(message: string, public result: string) { super(422, message, 'guardrail_blocked'); }
}

const secrets = [
  { rule: 'secret.api_key', label: 'API key pattern', pattern: /\b(?:sk-[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9_-]{20,}|rk_[A-Za-z0-9_-]{30,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|hf_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{30,})/g },
  { rule: 'secret.github', label: 'GitHub token pattern', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { rule: 'secret.gitlab', label: 'GitLab token pattern', pattern: /\bglpat-[A-Za-z0-9_-]{16,}/g },
  { rule: 'secret.slack', label: 'Slack token pattern', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { rule: 'secret.aws', label: 'AWS access-key pattern', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { rule: 'secret.private_key', label: 'Private-key header', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g }
];
const pii: Record<PiiType, { label: string; pattern: RegExp; replacement: string; accepts?: (value: string) => boolean }> = {
  email: { label: 'Email address', pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b/gi, replacement: '[EMAIL REDACTED]' },
  us_ssn: { label: 'US SSN pattern', pattern: /\b\d{3}[- ]\d{2}[- ]\d{4}\b/g, replacement: '[ID REDACTED]' },
  phone: { label: 'International phone number', pattern: /(?<![\w+])\+\d[\d ().-]{6,38}\d(?![ ().-]*\d)/g, replacement: '[PHONE REDACTED]', accepts: value => { const digits = value.replace(/\D/g, ''); return digits.length >= 8 && digits.length <= 15; } },
  credit_card: { label: 'Payment-card number', pattern: /(?<!\d)(?:\d[ -]?){12,18}\d(?![ -]?\d)/g, replacement: '[PAYMENT CARD REDACTED]', accepts: validCard }
};
function validCard(value: string) {
  const digits = value.replace(/\D/g, '');
  if (/^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  for (let i = digits.length - 1, offset = 0; i >= 0; i--, offset++) { let n = Number(digits[i]); if (offset % 2) { n *= 2; if (n > 9) n -= 9; } sum += n; }
  return sum % 10 === 0;
}
function normalize(value: string) {
  return value.normalize('NFKC').replace(/[\u00ad\u034f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '').replace(/\s+/gu, ' ').toLowerCase();
}
function containsTerm(text: string, term: string, wholeWord: boolean) {
  let position = text.indexOf(term);
  while (position !== -1) {
    if (!wholeWord || (!/[\p{L}\p{N}_]$/u.test(text.slice(Math.max(0, position - 2), position)) && !/^[\p{L}\p{N}_]/u.test(text.slice(position + term.length, position + term.length + 2)))) return true;
    position = text.indexOf(term, position + 1);
  }
  return false;
}
function embeddedJson(value: string): unknown | undefined {
  if (!/^[\s]*[\[{"]/.test(value)) return undefined;
  try { const parsed = JSON.parse(value); if (typeof parsed === 'string' || parsed && typeof parsed === 'object') return parsed; } catch { /* Ordinary text can contain JSON punctuation. */ }
  return undefined;
}
function depthLimit(depth: number) { if (depth > 64) throw new HttpError(400, 'Request nesting exceeds the guardrail inspection limit.', 'guardrail_input_too_deep'); }
export function policyPiiTypes(policy: Row): PiiType[] {
  const selected = policy.pii_types === undefined ? defaultPiiTypes : typeof policy.pii_types === 'string' ? JSON.parse(policy.pii_types) : policy.pii_types;
  return piiTypes.filter(type => selected.includes(type));
}

export function inspectPolicy(body: any, policy: Row): Inspection {
  const findings = new Map<string, Finding>();
  const add = (rule: string, label: string, action: 'block' | 'redact', count = 1) => {
    const key = rule + ':' + action, existing = findings.get(key);
    findings.set(key, { rule, label, action, count: (existing?.count ?? 0) + count });
  };
  const terms = [...new Set<string>((typeof policy.blocked_terms === 'string' ? JSON.parse(policy.blocked_terms) : policy.blocked_terms ?? []).map((value: string) => normalize(value)).filter(Boolean))];
  const scanSecrets = (text: string) => {
    if (!policy.block_secrets) return;
    // Normalize invisible/compatibility characters for detection without rewriting the prompt.
    const normalized = text.normalize('NFKC').replace(/[\u00ad\u034f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '');
    for (const detector of secrets) { const count = [...normalized.matchAll(detector.pattern)].length; if (count) add(detector.rule, detector.label, 'block', count); }
  };
  const scanTerms = (value: string) => {
    const normalized = normalize(value);
    for (const term of terms) if (containsTerm(normalized, term, policy.term_match === 'word')) add('blocked_term', 'Blocked term', 'block');
  };
  const inspect = (value: any, depth = 0, embedded = false): void => {
    depthLimit(depth);
    if (typeof value === 'string') {
      const parsed = embeddedJson(value);
      if (parsed !== undefined && parsed !== value) { inspect(parsed, depth + 1, true); return; }
      scanTerms(value);
      scanSecrets(value);
    } else if (Array.isArray(value)) value.forEach(item => inspect(item, depth + 1, embedded));
    else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { scanSecrets(key); if (embedded) scanTerms(key); inspect(child, depth + 1, embedded); }
  };
  // Exclude API envelope property names; embedded JSON in user content is fully inspected.
  inspect(body);
  const selectedPii = policy.redact_pii ? policyPiiTypes(policy) : [];
  let piiFieldName = false;
  const redactText = (text: string, fieldName = false) => {
    let result = text;
    for (const type of selectedPii) {
      const detector = pii[type];
      result = result.replace(detector.pattern, value => {
        if (detector.accepts && !detector.accepts(value)) return value;
        add('pii.' + type, detector.label, fieldName ? 'block' : 'redact');
        if (fieldName) piiFieldName = true;
        return detector.replacement;
      });
    }
    return result;
  };
  const redact = (value: any, depth = 0): any => {
    depthLimit(depth);
    if (typeof value === 'string') {
      const parsed = embeddedJson(value);
      if (parsed !== undefined && parsed !== value) {
        const before = JSON.stringify(parsed), after = JSON.stringify(redact(parsed, depth + 1));
        return before === after ? value : after;
      }
      return redactText(value);
    }
    if (Array.isArray(value)) return value.map(item => redact(item, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => {
      // Changing tool argument names can break the call; block sensitive names instead.
      redactText(key, true);
      return [key, redact(child, depth + 1)];
    }));
    return value;
  };
  // Rewrite only message content and function argument values. Routing/schema identifiers stay intact.
  const output = selectedPii.length ? { ...body, messages: body.messages.map((message: any) => ({ ...message, content: redact(message.content), ...(message.tool_calls ? { tool_calls: message.tool_calls.map((tool: any) => tool && typeof tool === 'object' && tool.function && typeof tool.function === 'object' ? { ...tool, function: { ...tool.function, ...(typeof tool.function.arguments === 'string' ? { arguments: redact(tool.function.arguments) } : {}) } } : tool) } : {}) })) } : body;
  const matches = [...findings.values()], blocked = matches.some(finding => finding.action === 'block');
  if (blocked) {
    const reason = matches.some(f => f.rule.startsWith('secret.')) ? 'secret' : piiFieldName ? 'pii_field_name' : 'term';
    const message = reason === 'secret' ? 'A possible credential was detected. Remove it before sending.' : reason === 'pii_field_name' ? 'Personal data was detected in a structured field name. Remove it before sending.' : 'Request blocked by the assigned content policy.';
    return { action: 'block', result: 'blocked:' + reason, body: null, findings: matches, message };
  }
  const count = matches.reduce((sum, finding) => sum + finding.count, 0);
  return { action: count ? 'redact' : 'allow', result: count ? `redacted:${count}` : 'passed', body: output, findings: matches };
}
export function applyPolicy(body: any, policy?: Row): { body: any; result: string | null } {
  if (!policy) return { body, result: null };
  const inspection = inspectPolicy(body, policy);
  if (inspection.action === 'block') throw new GuardrailError(inspection.message!, inspection.result);
  return { body: inspection.body, result: inspection.result };
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
