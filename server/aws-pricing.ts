// AWS public list prices are informational. Never modify deployment prices here.
export const pricingServices = ['AmazonBedrock', 'AmazonBedrockFoundationModels'] as const;
export type PriceRate = { provider: string; model: string; mode: 'Regional' | 'Geographic cross-region' | 'Global cross-region'; input: number | null; output: number | null; source_urls: string[]; effective_dates: string[] };
export type PriceCatalog = { status: 'available' | 'partial' | 'unavailable'; checked_at: string; rates: PriceRate[] };
export type PriceLoader = (region: string, signal: AbortSignal) => Promise<PriceCatalog>;
const commercialRegion = /^(us|eu|ap|sa|ca|me|af|il|mx)-[a-z]+-[1-9]\d?$/;
const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');
export function priceUrl(service: typeof pricingServices[number], region: string) {
  if (!pricingServices.includes(service) || !commercialRegion.test(region)) throw new Error('Invalid pricing scope');
  return `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/${service}/current/${region}/index.json`;
}
function tokenPrice(dimension: any): number | null {
  if (dimension.beginRange !== '0' || dimension.endRange !== 'Inf' || !Array.isArray(dimension.appliesTo) || dimension.appliesTo.length) return null;
  const multiplier = ({ 'tokens': 1e6, 'token': 1e6, '1k tokens': 1000, '1m tokens': 1 } as Record<string, number>)[normalize(String(dimension.unit ?? ''))];
  const usd = dimension.pricePerUnit?.USD;
  if (!multiplier || typeof usd !== 'string' || !/^\d+(?:\.\d+)?$/.test(usd)) return null;
  const value = Number(usd) * multiplier;
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 1e9) / 1e9 : null;
}
export function parsePriceFiles(files: { service: typeof pricingServices[number]; data: any }[], region: string, timestamp = Date.now()): PriceRate[] {
  const groups = new Map<string, { row: PriceRate; input: Set<number>; output: Set<number>; invalid: boolean }>();
  for (const {service, data} of files) {
    if (!data?.products || !data?.terms?.OnDemand || typeof data.products !== 'object' || Array.isArray(data.products) || Object.keys(data.products).length > 20000) throw new Error('Invalid price file');
    for (const product of Object.values<any>(data.products)) {
      const a = product?.attributes;
      if (!a || a.regionCode !== region || a.feature !== 'On-demand Inference' || (a.service_tier && a.service_tier !== 'standard')) continue;
      if (typeof a.model !== 'string' || a.model.length > 200) continue;
      const direction = ({'Input tokens':'input','Output tokens':'output','Text Input Tokens':'input','Text Output Tokens':'output'} as Record<string, 'input' | 'output'>)[a.inferenceType];
      if (!direction) continue;
      // Missing provider is documented in the Nova/Titan public price records.
      const provider = a.provider || (service === 'AmazonBedrock' && /^(Nova |Titan )/.test(a.model) ? 'Amazon' : '');
      if (typeof provider !== 'string' || !provider || provider.length > 100) continue;
      for (const term of Object.values<any>(data.terms.OnDemand[product.sku] ?? {})) {
        if (!Number.isFinite(Date.parse(term.effectiveDate)) || Date.parse(term.effectiveDate) > timestamp) continue;
        for (const dimension of Object.values<any>(term.priceDimensions ?? {})) {
          const detail = `${a.usagetype ?? ''} ${dimension.description ?? ''}`;
          // Different endpoint, service tier, modality or context tiers are not interchangeable.
          if (/mantle|batch|reserved|provisioned|priority|flex|cache|long[ -]?context|200k|million image|million audio|million video/i.test(detail)) continue;
          let mode: PriceRate['mode'] = 'Regional';
          if (/\bglobal\b|_Global[-_]/i.test(detail)) mode = 'Global cross-region';
          else if (/Regional CRIS|cross[ -]?region[ -]?geo|geographic|_Geo[-_]/i.test(detail)) mode = 'Geographic cross-region';
          else if (/cross[ -]?region/i.test(detail)) continue;
          const key = JSON.stringify([normalize(provider), normalize(a.model), mode]);
          const group: { row: PriceRate; input: Set<number>; output: Set<number>; invalid: boolean } = groups.get(key) ?? { row: {provider,model:a.model,mode,input:null,output:null,source_urls:[],effective_dates:[]},input:new Set<number>(),output:new Set<number>(),invalid:false };
          const value = tokenPrice(dimension);
          // Refuse conditional, tiered, non-token and conflicting rates rather than picking a cheap rate.
          if (value === null) group.invalid = true; else group[direction].add(value);
          group.row.source_urls.push(priceUrl(service,region)); group.row.effective_dates.push(term.effectiveDate);
          groups.set(key,group);
        }
      }
    }
  }
  return [...groups.values()].filter(g=>!g.invalid && g.input.size<=1 && g.output.size<=1 && (g.input.size || g.output.size)).map(g=>({...g.row,input:[...g.input][0]??null,output:[...g.output][0]??null,source_urls:[...new Set(g.row.source_urls)],effective_dates:[...new Set(g.row.effective_dates)].sort()}));
}
export function matchModelPrices(model: { id?: string; name?: string; provider?: string; inference_types?: string[] }, models: { id?: string; name?: string; provider?: string; inference_types?: string[] }[], rates: PriceRate[]) {
  if (!model.id || !model.name || !model.provider || !model.inference_types?.some(type=>['ON_DEMAND','INFERENCE_PROFILE'].includes(type))) return [];
  const name = normalize(model.name);
  // Do not choose between two generations/versions sharing the same display name.
  if (models.filter(other=>other.id!==model.id && other.provider===model.provider && normalize(other.name??'')===name && other.inference_types?.some(type=>['ON_DEMAND','INFERENCE_PROFILE'].includes(type))).length) return [];
  const names = new Set([name]);
  if (model.provider === 'Meta' && /^meta\.llama/.test(model.id) && /^llama \d+(?:\.\d+)? \d+b instruct$/.test(name)) names.add(name.replace(/ instruct$/,''));
  return rates.filter(rate=>normalize(rate.provider)===normalize(model.provider!) && names.has(normalize(rate.model))).sort((a,b)=>a.mode.localeCompare(b.mode));
}
async function readPriceFile(url: string, signal: AbortSignal, fetcher: typeof fetch) {
  const response = await fetcher(url,{signal,redirect:'error',credentials:'omit',headers:{Accept:'application/json'}});
  if (!response.ok) { await response.body?.cancel(); throw new Error('Price feed unavailable'); }
  const reader=response.body?.getReader(); if(!reader) throw new Error('Empty price feed');
  const chunks:Uint8Array[]=[];let bytes=0;
  try { while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.length;if(bytes>8_000_000)throw new Error('Price feed too large');chunks.push(next.value);}return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export function createPriceLoader(fetcher: typeof fetch = fetch, clock = Date.now): PriceLoader {
  const cache = new Map<string,{until:number;value:PriceCatalog}>();
  const pending = new Map<string,Promise<PriceCatalog>>();
  return async (region, parent) => {
    if(!commercialRegion.test(region)) throw new Error('Invalid region');
    const time=clock(),cached=cache.get(region);
    if(cached && cached.until>time)return cached.value;
    if(pending.has(region))return pending.get(region)!;
    if(pending.size>=4)return {status:'unavailable',checked_at:new Date(time).toISOString(),rates:[]};
    const load=async():Promise<PriceCatalog>=>{
      const controller=new AbortController(),abort=()=>controller.abort();
      parent.addEventListener('abort',abort,{once:true});if(parent.aborted)abort();
      const timer=setTimeout(abort,8000);
      try {
        const results=await Promise.allSettled(pricingServices.map(async service=>{
          const data=await readPriceFile(priceUrl(service,region),controller.signal,fetcher);
          // Validate each feed separately so one failure does not hide other prices.
          parsePriceFiles([{service,data}],region,time);return {service,data};
        }));
        const files=results.flatMap(result=>result.status==='fulfilled'?[result.value]:[]);
        const value:PriceCatalog={status:files.length===pricingServices.length?'available':files.length?'partial':'unavailable',checked_at:new Date(clock()).toISOString(),rates:parsePriceFiles(files,region,time)};
        if(cache.size>=16)cache.delete(cache.keys().next().value!);
        cache.set(region,{until:clock()+(value.status==='available'?3600000:60000),value});return value;
      } finally {clearTimeout(timer);controller.abort();parent.removeEventListener('abort',abort);}
    };
    const promise=load();pending.set(region,promise);
    try{return await promise;}finally{pending.delete(region);}
  };
}
