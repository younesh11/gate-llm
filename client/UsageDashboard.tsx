import React, { useEffect, useState } from 'react';
import { Activity, ArrowUpRight, KeyRound, RefreshCw, Users, Zap } from 'lucide-react';

type Usage = { tokens: number; input_tokens: number; output_tokens: number; cost: number };
type Key = Usage & { id: string; name: string; owner: string; prefix: string; revoked: number; user_id: string | null; user_name: string | null; user_email: string | null };
type Report = { since: string | null; trend_start: string; through: string; by_key: Key[]; daily: (Usage & { key_id: string; day: string })[] };
type Group = Usage & { id: string; name: string; detail: string; keys: string[] };
const count = (value: number) => value.toLocaleString('en-US');
const compact = (value: number) => new Intl.NumberFormat('en-US', { notation: 'compact' }).format(value);
const sum = (rows: Usage[]): Usage => rows.reduce((total, row) => ({ tokens: total.tokens + row.tokens, input_tokens: total.input_tokens + row.input_tokens, output_tokens: total.output_tokens + row.output_tokens, cost: total.cost + row.cost }), { tokens: 0, input_tokens: 0, output_tokens: 0, cost: 0 });
const unknown = (row: Usage) => Math.max(0, row.tokens - row.input_tokens - row.output_tokens);
const usd = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 }).format(value / 1e6);

export function UsageDashboard() {
  const [period, setPeriod] = useState('7d'), [groupBy, setGroupBy] = useState('keys'), [selected, setSelected] = useState('all');
  const [report, setReport] = useState<Report | null>(null), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setReport(null); setError('');
    const refresh = async () => {
      try {
        const response = await fetch(`/api/admin/usage?period=${period}`, { credentials: 'same-origin', signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message ?? 'Could not load usage.');
        if (active) { setReport(data); setError(''); }
      } catch (e: any) { if (active && e.name !== 'AbortError') setError(e.message); }
    };
    void refresh(); const timer = setInterval(refresh, 15000);
    return () => { active = false; controller.abort(); clearInterval(timer); };
  }, [period, revision]);
  const grouped = new Map<string, Group>();
  for (const key of report?.by_key ?? []) {
    const id = groupBy === 'keys' ? key.id : groupBy === 'users' ? key.user_id ?? 'unassigned' : key.owner;
    const name = groupBy === 'keys' ? key.name : groupBy === 'users' ? key.user_name ?? 'Unassigned keys' : key.owner;
    const detail = groupBy === 'keys' ? `${key.owner}${key.revoked ? ' · Revoked' : ''}` : groupBy === 'users' ? key.user_email ?? 'No team member assigned' : 'Owner / application';
    const group = grouped.get(id) ?? { id, name, detail, keys: [], ...sum([]) };
    grouped.set(id, { ...group, ...sum([group, key]), keys: [...group.keys, key.id] });
  }
  const groups = [...grouped.values()].sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
  const chosen = selected === 'all' ? groups : groups.filter(row => row.id === selected);
  const keyIds = new Set(chosen.flatMap(row => row.keys));
  const total = sum(chosen), maxGroup = Math.max(1, ...groups.map(row => row.tokens));
  const days: (Usage & { day: string })[] = [];
  if (report) for (let time = Date.parse(report.trend_start + 'T00:00:00Z'); time <= Date.parse(report.through + 'T00:00:00Z'); time += 86400000) {
    const day = new Date(time).toISOString().slice(0, 10);
    days.push({ day, ...sum(report.daily.filter(row => row.day === day && keyIds.has(row.key_id))) });
  }
  const maxDay = Math.max(1, ...days.map(row => row.tokens));
  const changeGroup = (value: string) => { setGroupBy(value); setSelected('all'); };
  return <div className="usage-dashboard">
    <div className="usage-controls">
      <div className="tabs" aria-label="Group token usage">{[['keys', 'By key'], ['users', 'By team member'], ['owners', 'By owner / app']].map(([value, label]) => <button key={value} aria-pressed={groupBy === value} className={groupBy === value ? 'active' : ''} onClick={() => changeGroup(value)}>{label}</button>)}</div>
      <div className="usage-filters"><select aria-label="Usage period" value={period} onChange={e => setPeriod(e.target.value)}><option value="today">Today</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option><option value="all">All time</option></select><button className="icon-button" aria-label="Refresh usage" onClick={() => setRevision(value => value + 1)}><RefreshCw size={17}/></button></div>
    </div>
    <div className="usage-scope"><select aria-label="Usage for" value={selected} onChange={e => setSelected(e.target.value)}><option value="all">All {groupBy === 'keys' ? 'keys' : groupBy === 'users' ? 'team members' : 'owners / applications'}</option>{groups.map(row => <option key={row.id} value={row.id}>{row.name}{groupBy === 'keys' ? ` · ${row.detail}` : ''}</option>)}</select><span>UTC · refreshes every 15 seconds</span></div>
    {error && <div className="form-error" role="alert">{error} <button className="text-button" onClick={() => setRevision(value => value + 1)}>Retry</button></div>}
    {!report ? <section className="panel usage-loading">{error ? 'Usage unavailable' : 'Loading token usage…'}</section> : <>
      <div className="metrics usage-metrics">{[
        { label: 'Total tokens', value: total.tokens, note: `${keyIds.size} keys in view`, icon: Zap },
        { label: 'Input tokens', value: total.input_tokens, note: 'Provider-reported prompt usage', icon: ArrowUpRight },
        { label: 'Output tokens', value: total.output_tokens, note: 'Provider-reported completion usage', icon: Activity },
        { label: 'Estimated / unsplit', value: unknown(total), note: 'Included in the total', icon: KeyRound }
      ].map(item => <section className="metric" key={item.label}><div><span>{item.label}</span><item.icon size={17}/></div><strong title={count(item.value)}>{compact(item.value)}</strong><small>{item.note}</small></section>)}</div>
      <div className="usage-visuals">
        <section className="panel usage-trend"><div className="panel-head"><div><h3>Tokens over time</h3><p>{period === 'all' ? 'Last 30 days · all-time totals above' : 'Daily consumption · input + output'}</p></div><span className="badge">{selected === 'all' ? 'Workspace' : 'Filtered'}</span></div>
          <div className="usage-legend"><span><i className="input"/>Input</span><span><i className="output"/>Output</span><span><i className="unknown"/>Estimated / unsplit</span></div>
          <svg className="token-chart" viewBox="0 0 640 240" role="img" aria-label={`Daily token usage: ${days.map(row => `${row.day}: ${row.tokens}`).join(', ')}`}>
            {[0, .5, 1].map(fraction => <g key={fraction}><line x1="50" x2="620" y1={196 - fraction * 156} y2={196 - fraction * 156} stroke="#e3e8e5" strokeDasharray="4 5"/><text x="42" y={200 - fraction * 156} textAnchor="end" fill="#7b8781" fontSize="11">{compact(Math.round(maxDay * fraction))}</text></g>)}
            {days.map((row, index) => { const width = Math.min(44, 480 / days.length), x = 50 + (index + .5) * 570 / days.length - width / 2, scale = 156 / maxDay;
              return <g key={row.day}><title>{row.day}: {count(row.input_tokens)} input, {count(row.output_tokens)} output, {count(unknown(row))} estimated / unsplit</title><rect x={x} y={196 - row.input_tokens * scale} width={width} height={row.input_tokens * scale} fill="#226e53"/><rect x={x} y={196 - (row.input_tokens + row.output_tokens) * scale} width={width} height={row.output_tokens * scale} fill="#73b5cc"/><rect x={x} y={196 - row.tokens * scale} width={width} height={unknown(row) * scale} fill="#d9b273"/>{(index === 0 || index === days.length - 1 || index % Math.max(1, Math.ceil(days.length / 7)) === 0) && <text x={x + width / 2} y="222" textAnchor="middle" fill="#7b8781" fontSize="11">{new Date(row.day + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}</text>}</g>;
            })}
          </svg>{total.tokens === 0 && <p className="usage-empty-note">No token usage for this selection yet.</p>}
        </section>
        <section className="panel usage-ranking"><div className="panel-head"><div><h3>{groupBy === 'keys' ? 'Usage by key' : groupBy === 'users' ? 'Usage by team member' : 'Usage by owner / app'}</h3><p>Select a row to explore its usage</p></div><Users size={18}/></div><div className="usage-ranking-list">{groups.length ? groups.map(row => <button key={row.id} className={`usage-rank ${selected === row.id ? 'selected' : ''}`} aria-pressed={selected === row.id} onClick={() => setSelected(selected === row.id ? 'all' : row.id)}><span><strong>{row.name}</strong><b>{count(row.tokens)}</b></span><small>{groupBy === 'keys' ? row.detail : `${row.keys.length} ${row.keys.length === 1 ? 'key' : 'keys'}`}</small><span className="usage-bar"><i className="input" style={{ width: `${row.input_tokens / maxGroup * 100}%` }}/><i className="output" style={{ width: `${row.output_tokens / maxGroup * 100}%` }}/><i className="unknown" style={{ width: `${unknown(row) / maxGroup * 100}%` }}/></span></button>) : <p className="usage-empty-note">Create a key to start tracking usage.</p>}</div></section>
      </div>
      <section className="panel"><div className="panel-head"><div><h3>Usage breakdown</h3><p>{selected === 'all' ? 'All entities in the selected period' : chosen[0]?.name}</p></div><span className="muted">Configured cost: {usd(total.cost)}</span></div><div className="table-wrap"><table><thead><tr><th>{groupBy === 'keys' ? 'Key' : groupBy === 'users' ? 'Team member' : 'Owner / application'}</th><th>Input</th><th>Output</th><th>Estimated / unsplit</th><th>Total tokens</th><th>Cost</th></tr></thead><tbody>{chosen.map(row => <tr key={row.id}><td><strong>{row.name}</strong><small>{row.detail}</small></td><td>{count(row.input_tokens)}</td><td>{count(row.output_tokens)}</td><td>{count(unknown(row))}</td><td><strong>{count(row.tokens)}</strong></td><td>{usd(row.cost)}</td></tr>)}</tbody></table></div></section>
      <p className="table-caption muted">Usage comes from the persistent ledger, including revoked keys. Team-member and owner groups use current key assignments; assigning a key moves its existing usage into that group. Estimated / unsplit includes reserved charges without provider usage and older records without a split.</p>
    </>}
  </div>;
}
