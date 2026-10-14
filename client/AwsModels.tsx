import { useEffect, useRef, useState } from 'react';
import { Copy, RefreshCw, Search } from 'lucide-react';

type Price = { mode: string; input: number | null; output: number | null; source_urls: string[]; effective_dates: string[] };
const usd = (value: number | null) => value === null ? 'Unavailable' : new Intl.NumberFormat('en-US', {style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:9}).format(value);
type Item = { id: string; name?: string; provider?: string; input?: string[]; output?: string[]; streaming?: boolean | null; status: string; inference_types?: string[]; type?: string; models?: string[]; prices?: Price[] };
type Catalog = { region: string; kind: string; fetched_at: string; truncated: boolean; availability?: { verified: boolean; unavailable: number; unverified: number; excluded: number; permission_required: boolean }; items: Item[]; pricing?: { status: string; checked_at: string; currency: string; unit: string } };

export function AwsModels({ owner, copy }: { owner: boolean; copy: (text: string) => Promise<void> }) {
  const [region, setRegion] = useState('eu-west-2'), [kind, setKind] = useState('models');
  const [catalog, setCatalog] = useState<Catalog | null>(null), [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const change = (value: string, field: 'region' | 'kind') => {
    pending.current?.abort(); setBusy(false); setCatalog(null); setError(''); setSearch('');
    if (field === 'region') setRegion(value); else setKind(value);
  };
  const load = async (event: React.FormEvent) => {
    event.preventDefault(); pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setCatalog(null); setError('');
    try {
      const response = await fetch('/api/admin/aws/catalog', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ region: region.trim(), kind, include_pricing: true }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message ?? 'Could not load AWS models.');
      if (!controller.signal.aborted) setCatalog(result);
    } catch (error: any) { if (!controller.signal.aborted) setError(error.message); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  const items = catalog?.items.filter(item => `${item.id} ${item.name} ${item.provider ?? ''} ${item.type ?? ''}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  return <div className="stack aws-catalog">
    <section className="panel aws-catalog-controls">
      <h3>Discover models from AWS</h3>
      <p>Fetch the regional Bedrock catalog using the AWS identity configured on your GATE server. No model inference is performed.</p>
      <form onSubmit={load}>
        <div className="two-fields">
          <label className="field"><span>AWS region</span><input value={region} onChange={event => change(event.target.value, 'region')} placeholder="eu-west-2" required maxLength={40} list="aws-regions"/><small>Choose the region where you intend to use Bedrock.</small></label>
          <datalist id="aws-regions">{['eu-west-2', 'eu-west-1', 'eu-central-1', 'us-east-1', 'us-west-2', 'ap-south-1', 'ap-southeast-1'].map(value => <option key={value} value={value}/>)}</datalist>
          <label className="field"><span>Catalog</span><select value={kind} onChange={event => change(event.target.value, 'kind')}><option value="models">Models in this region</option><option value="profiles">Cross-region / inference profiles</option></select><small>Profiles may route requests across AWS regions.</small></label>
        </div>
        <button type="submit" className="button primary" disabled={!owner || busy || !region.trim()}><RefreshCw size={16}/>{busy ? 'Loading from AWS…' : 'Load from AWS'}</button>
      </form>
      {!owner && <p className="field-help">Ask a workspace owner to load the AWS catalog.</p>}
      <details className="aws-setup"><summary>AWS connection and permissions</summary>
        <p>Use an IAM role on AWS, environment credentials, or an optional AWS profile configured for the server. A provider API key entered elsewhere in GATE is not used for catalog discovery.</p>
        <p>The server needs <code>bedrock:ListFoundationModels</code> and <code>bedrock:GetFoundationModelAvailability</code> for models and <code>bedrock:ListInferenceProfiles</code> for profiles. Refresh an expired AWS login before retrying.</p>
        <p><a href="https://docs.aws.amazon.com/bedrock/latest/userguide/using-iam.html" target="_blank" rel="noreferrer">AWS permissions guide</a></p>
      </details>
      <div aria-live="polite">{error && <p className="form-error" role="alert">{error}</p>}</div>
    </section>
    <div className="info-note"><p><strong>Discovery is separate from model access.</strong> A catalog entry does not verify your account’s invocation permissions, token quota, or Chat Completions compatibility. Native Bedrock Converse support is still pending in GATE. Check compatibility before adding a copied ID in Models &amp; routing.</p></div>
    {catalog && <section className="panel">
      <div className="panel-head"><div><h3>{catalog.kind === 'models' ? 'Models available in this region' : 'Inference profiles (may route across regions)'} · {catalog.region}</h3><p>{catalog.items.length} returned · Loaded {new Date(catalog.fetched_at).toLocaleTimeString()}</p></div></div>
      <div className="filter-bar aws-catalog-filter"><div className="search"><Search size={17}/><input aria-label="Search AWS catalog" placeholder="Search name, provider or model ID…" value={search} onChange={event => setSearch(event.target.value)}/></div><span className="muted">{items.length} shown</span></div>
      {catalog.kind === 'models' && <div className="aws-pricing-note"><p><strong>Regional on-demand text prices · USD per 1 million tokens.</strong> Excludes batch, caching, extended-context tiers, provisioned throughput, Mantle and account discounts. Deployment prices are not changed.</p><p>{catalog.pricing?.status === 'unavailable' ? 'AWS prices could not be loaded. Model discovery still works.' : `${catalog.pricing?.status === 'partial' ? 'Some AWS price feeds could not be loaded. ' : ''}Prices checked ${catalog.pricing ? new Date(catalog.pricing.checked_at).toLocaleString() : '—'} · cached up to 1 hour.`} <a href="https://aws.amazon.com/bedrock/pricing/" target="_blank" rel="noreferrer">AWS pricing</a></p></div>}
      {catalog.kind === 'profiles' && <p className="aws-pricing-note">These active profiles were returned by the selected region’s AWS endpoint, but may run inference in other regions. Their prices and destination availability are not inferred; verify the profile in AWS before deployment.</p>}
      {catalog.availability && <p className="aws-pricing-note">Only active on-demand models with AWS-confirmed region availability are shown. Provisioned-only and profile-only models are excluded. {catalog.availability.unverified > 0 && `${catalog.availability.unverified} models hidden because availability could not be verified. `}{catalog.availability.permission_required && 'Grant bedrock:GetFoundationModelAvailability to the server’s AWS identity and reload.'}</p>}
      {catalog.truncated && <p className="form-error">The lookup reached its safety limit. Results are incomplete; use the AWS console for the full list.</p>}
      {items.length ? <div className="table-wrap"><table><thead><tr><th>Model / profile</th>{catalog.kind === 'models' && <th>Input / output cost<small>USD / 1M tokens</small></th>}<th>{catalog.kind === 'models' ? 'Capabilities' : 'Routing'}</th><th>AWS status</th><th>Action</th></tr></thead><tbody>{items.map(item => <tr key={item.id}>
        <td><strong>{item.name || item.id}</strong><small className="mono aws-model-id">{item.id}</small><small>{item.provider || item.type}</small></td>
        {catalog.kind === 'models' && <td className="aws-prices">{item.prices?.length ? item.prices.map(price => <div className="aws-price-pair" key={price.mode}><strong>In {usd(price.input)} · Out {usd(price.output)}</strong><small>{price.mode}</small><small><a href={price.source_urls[0]} target="_blank" rel="noreferrer" title={`Effective dates: ${price.effective_dates.join(', ')}`}>AWS price source</a></small></div>) : <><span className="muted">Price unavailable</span><small>No unambiguous standard rate matched.</small></>}</td>}
        <td>{catalog.kind === 'models' ? <><span>{item.input?.join(', ') || 'Unknown'} → {item.output?.join(', ') || 'Unknown'}</span><small>Streaming: {item.streaming === null ? 'Unknown' : item.streaming ? 'Yes' : 'No'}</small><small>{item.inference_types?.join(', ')}</small></> : <><span>{item.models?.length ?? 0} model destinations</span><small>May include other regions</small></>}</td>
        <td><span className="badge neutral">{item.status}</span><small>Access unverified</small></td>
        <td><button type="button" className="text-button" aria-label={`Copy ID for ${item.name || item.id}`} onClick={() => void copy(item.id)}><Copy size={15}/> Copy ID</button></td>
      </tr>)}</tbody></table></div> : <div className="empty"><h3>{catalog.items.length ? 'No matching entries' : 'No verified entries to show'}</h3><p>{catalog.items.length ? 'Try another name or clear your search.' : 'No matching available models were verified. Check the region and AWS permissions, or use the separate inference profiles catalog.'}</p></div>}
    </section>}
  </div>;
}
