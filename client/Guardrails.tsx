import { useEffect, useRef, useState } from 'react';
import { ChevronRight, CircleHelp, KeyRound, Pencil, Server, ShieldCheck } from 'lucide-react';

type Row = Record<string, any>;
export type PolicyDraft = { block_secrets: boolean; redact_pii: boolean; pii_types: string[]; blocked_terms: string[]; term_match: 'substring' | 'word' };
const categories = [
  ['email', 'Email addresses'], ['us_ssn', 'US SSN patterns'],
  ['phone', 'International phone numbers (+ country code)'], ['credit_card', 'Payment-card numbers (checksum checked)']
];
export function Guardrails({ data, owner, open }: { data: Row; owner: boolean; open: (kind: string, row?: Row) => void }) {
  return <>
    <div className="policy-intro"><div className="policy-flow"><span><KeyRound size={18}/> Virtual key</span><ChevronRight size={17}/><span className="selected"><ShieldCheck size={18}/> Assigned policy</span><ChevronRight size={17}/><span><Server size={18}/> Provider</span></div><p>Create a policy here, then assign it to individual keys. Saving a new policy does not apply it automatically.</p></div>
    <div className="provider-grid">{data.policies.map((policy: Row) => {
      const assigned = data.keys.filter((key: Row) => !key.revoked && key.policy_id === policy.id);
      const types: string[] = policy.pii_types ?? ['email', 'us_ssn'];
      return <section className="panel policy-card" key={policy.id} aria-label={policy.name}>
        <div className="card-heading"><span className="policy-icon"><ShieldCheck size={23}/></span><span className="badge">{assigned.length} assigned {assigned.length === 1 ? 'key' : 'keys'}</span></div>
        <h3>{policy.name}</h3>
        <div className="policy-rule"><span>Credential patterns</span><span className={`badge ${policy.block_secrets ? 'good' : ''}`}>{policy.block_secrets ? 'Block' : 'Off'}</span></div>
        <div className="policy-rule"><span>Personal data</span><span className={`badge ${policy.redact_pii && types.length ? 'good' : ''}`}>{policy.redact_pii && types.length ? 'Redact' : 'Off'}</span></div>
        {!!policy.redact_pii && types.length > 0 && <p className="policy-detail">{categories.filter(([id]) => types.includes(id)).map(([, label]) => label).join(' · ')}</p>}
        <div className="policy-rule"><span>Blocked terms</span><strong>{policy.blocked_terms.length} · {policy.term_match === 'word' ? 'Whole word' : 'Substring'}</strong></div>
        {policy.blocked_terms.length > 0 && <div className="chips">{policy.blocked_terms.map((term: string, index: number) => <span className="badge" key={index}>{term}</span>)}</div>}
        <p className="policy-assigned"><strong>Assigned to</strong>{assigned.length ? assigned.map((key: Row) => key.name).join(', ') : 'No keys yet'}</p>
        {owner && <div className="card-footer policy-actions"><button className="text-button" onClick={() => open('policy', policy)}><Pencil size={14}/> Edit &amp; test</button><button className="text-button" onClick={() => open('assignment', policy)} disabled={!data.keys.some((key: Row) => !key.revoked && (!key.expires_at || key.expires_at > new Date().toISOString()))}><KeyRound size={14}/> Assign to key</button></div>}
      </section>;
    })}</div>
    <div className="info-note"><CircleHelp size={17}/><p>Checks run on request inputs using the key’s assigned policy. These pattern checks do not detect every secret or personal identifier, inspect model output, or provide complete prompt-injection protection.</p></div>
  </>;
}
export function PolicyFields({ draft, change, assigned }: { draft: PolicyDraft; change: (draft: PolicyDraft) => void; assigned: number }) {
  const [terms, setTerms] = useState(draft.blocked_terms.join('\n'));
  return <>
    <p className="field-help">{assigned ? `Saving changes updates the policy for ${assigned} assigned ${assigned === 1 ? 'key' : 'keys'}.` : 'Save this reusable policy, then assign it to a key from Guardrails or Virtual keys.'}</p>
    <label className="check-card"><input type="checkbox" checked={draft.block_secrets} onChange={e => change({ ...draft, block_secrets: e.target.checked })}/><span><strong>Block credential patterns</strong><small>Selected API keys including Groq, GitHub, GitLab, Slack and AWS, plus private-key headers.</small></span></label>
    <label className="check-card"><input type="checkbox" checked={draft.redact_pii} onChange={e => change({ ...draft, redact_pii: e.target.checked })}/><span><strong>Redact personal data</strong><small>Replace selected patterns in messages and tool argument values before sending.</small></span></label>
    <fieldset className="pii-options" disabled={!draft.redact_pii}><legend>Personal data to redact</legend>{categories.map(([id, label]) => <label className="check-row" key={id}><input type="checkbox" checked={draft.pii_types.includes(id)} onChange={e => change({ ...draft, pii_types: e.target.checked ? [...draft.pii_types, id] : draft.pii_types.filter(type => type !== id) })}/><span>{label}</span></label>)}</fieldset>
    {draft.redact_pii && !draft.pii_types.length && <p className="field-help">Select at least one category to redact personal data.</p>}
    <label className="field"><span>Blocked terms</span><textarea rows={4} value={terms} onChange={e => { setTerms(e.target.value); change({ ...draft, blocked_terms: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) }); }} placeholder="One term or phrase per line"/><small>Up to 100 terms, 100 characters each. Case, repeated spaces, invisible separators and compatible Unicode forms are normalized.</small></label>
    <label className="field"><span>Term matching</span><select value={draft.term_match} onChange={e => change({ ...draft, term_match: e.target.value as PolicyDraft['term_match'] })}><option value="substring">Substring — matches inside other words</option><option value="word">Whole word or phrase — respects word boundaries</option></select></label>
    <PolicyTester policy={draft}/>
  </>;
}
function PolicyTester({ policy }: { policy: PolicyDraft }) {
  const [text, setText] = useState(''), [result, setResult] = useState<Row | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const fingerprint = JSON.stringify(policy);
  useEffect(() => { controller.current?.abort(); setResult(null); setError(''); setBusy(false); return () => controller.current?.abort(); }, [fingerprint, text]);
  const run = async () => {
    controller.current?.abort(); const request = new AbortController(); controller.current = request;
    setBusy(true); setResult(null); setError('');
    try {
      const response = await fetch('/api/admin/policies/test', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ policy, text }), signal: request.signal });
      const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? 'Could not test policy.');
      if (!request.signal.aborted) setResult(data);
    } catch (e: any) { if (!request.signal.aborted) setError(e.message); }
    finally { if (!request.signal.aborted) setBusy(false); }
  };
  return <section className="policy-tester" aria-label="Policy tester">
    <h3>Test this policy</h3><p>Try sample input with these settings before saving. No provider call, token usage or saved test text.</p>
    <div className="policy-samples"><span>Load an example:</span><button type="button" className="text-button" onClick={() => setText('Email sample@example.com. Phone +44 20 7946 0958. Card 4111 1111 1111 1111. ID 123-45-6789.')}>Personal data</button><button type="button" className="text-button" onClick={() => setText('Example credential: gsk_' + 'x'.repeat(40))}>Fake secret</button></div>
    <label className="field"><span>Test input</span><textarea rows={4} maxLength={20000} value={text} onChange={e => setText(e.target.value)} placeholder="Enter sample text to inspect"/></label>
    <button type="button" className="button secondary" disabled={busy || !text.trim()} onClick={run}>{busy ? 'Testing…' : 'Test policy'}</button>
    <div aria-live="polite">{error && <p className="form-error">{error}</p>}{result && <div className={`policy-result ${result.action}`}>
      <strong>{result.action === 'block' ? 'Blocked' : result.action === 'redact' ? 'Allowed with redaction' : 'Allowed'}</strong>
      <p>{result.message ?? (result.action === 'redact' ? 'The provider would receive the sanitized text below.' : 'No enabled rule matched this input.')}</p>
      {result.findings.length > 0 && <ul>{result.findings.map((finding: Row) => <li key={finding.rule + finding.action}>{finding.label} · {finding.count} {finding.count === 1 ? 'match' : 'matches'} · {finding.action === 'block' ? 'Block' : 'Redact'}</li>)}</ul>}
      {result.text !== null && <pre>{result.text}</pre>}
    </div>}</div>
  </section>;
}
