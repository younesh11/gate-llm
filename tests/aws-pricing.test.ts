import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPriceLoader,parsePriceFiles,matchModelPrices,priceUrl } from '../server/aws-pricing.ts';
import { createApp } from '../server/app.ts';
const region='eu-west-2';
function file(rows:any[]) {
  const products:any={},OnDemand:any={};
  rows.forEach((r,i)=>{const sku=String(i);products[sku]={sku,attributes:{regionCode:region,provider:'Meta',model:'Llama 3 8B',feature:'On-demand Inference',inferenceType:i%2?'Output tokens':'Input tokens',usagetype:'EUW2-Llama3-8B-tokens',...r.attributes}};OnDemand[sku]={term:{effectiveDate:r.date??'2000-01-01T00:00:00Z',priceDimensions:{rate:{beginRange:'0',endRange:'Inf',unit:'1K tokens',pricePerUnit:{USD:i%2?'0.00078':'0.00039'},appliesTo:[],description:'Standard regional tokens',...r.dimension}}}};});
  return {products,terms:{OnDemand}};
}
const parse=(data:any,service:'AmazonBedrock'|'AmazonBedrockFoundationModels'='AmazonBedrock')=>parsePriceFiles([{service,data}],region);

test('AWS token units normalize to USD per million with separate regional/global/geographic prices',()=>{
  const rates=parse(file([{}, {},{attributes:{inferenceType:'Input tokens'},dimension:{unit:'1M tokens',pricePerUnit:{USD:'3'},description:'Million Input Tokens Global'}},{attributes:{inferenceType:'Output tokens'},dimension:{unit:'tokens',pricePerUnit:{USD:'0.000015'},description:'Million Response Tokens Global'}},{attributes:{inferenceType:'Input tokens'},dimension:{unit:'1M tokens',pricePerUnit:{USD:'3.3'},description:'Million Input Tokens Regional CRIS'}},{attributes:{inferenceType:'Output tokens'},dimension:{unit:'1M tokens',pricePerUnit:{USD:'16.5'},description:'Million Response Tokens Regional CRIS'}}]));
  assert.deepEqual(rates.map(r=>[r.mode,r.input,r.output]),[['Regional',0.39,0.78],['Global cross-region',3,15],['Geographic cross-region',3.3,16.5]]);
  assert.equal(rates[0].source_urls[0],priceUrl('AmazonBedrock',region));
});
test('unsupported units, conditional prices, conflicts, missing prices and future terms never turn into zero',()=>{
  for(const dimension of [{unit:'1K TPM Hour'},{pricePerUnit:{USD:''}},{pricePerUnit:{USD:'NaN'}},{pricePerUnit:{USD:'-1'}},{pricePerUnit:{}},{beginRange:'1000'},{endRange:'200000'},{appliesTo:['conditional']},{pricePerUnit:{USD:'1e9'}}])assert.deepEqual(parse(file([{dimension}])),[]);
  assert.deepEqual(parse(file([{date:'2999-01-01T00:00:00Z'}])),[]);
  assert.deepEqual(parse(file([{}, {attributes:{inferenceType:'Input tokens'}}])),[]);
  const one=parse(file([{}]))[0];assert.equal(one.input,0.39);assert.equal(one.output,null);
  assert.equal(parse(file([{dimension:{pricePerUnit:{USD:'0'}}}]))[0].input,0);
});
test('nonstandard inference, caching, Mantle and other regions do not contaminate the standard price',()=>{
  const rows=[{attributes:{feature:'Batch Inference'}},{attributes:{feature:'Provisioned Throughput Inference'}},{attributes:{service_tier:'priority'}},{attributes:{inferenceType:'Prompt cache read input tokens'}},{attributes:{inferenceType:'Input Image Token Count'}},{attributes:{regionCode:'us-east-1'}},{dimension:{description:'model-mantle-input-tokens-standard'}},{dimension:{description:'input-tokens-long-context'}},{dimension:{description:'tokens over 200K'}},{dimension:{description:'cross-region unspecified'}}];
  assert.deepEqual(parse(file(rows)),[]);
  assert.equal(parse(file([{attributes:{model:'Nova Micro',provider:undefined}}]))[0].provider,'Amazon');
});
test('price matching requires exact provider and model names, with bounded Meta naming support and ambiguity rejection',()=>{
  const rates=parse(file([{},{}])),model={id:'meta.llama3-8b-instruct-v1:0',name:'Llama 3 8B Instruct',provider:'Meta',inference_types:['ON_DEMAND']};
  assert.equal(matchModelPrices(model,[model],rates).length,1);
  assert.deepEqual(matchModelPrices({...model,name:'Llama 3.1 8B Instruct'},[model],rates),[]);
  assert.deepEqual(matchModelPrices({...model,provider:'Another provider'},[model],rates),[]);
  assert.deepEqual(matchModelPrices({...model,inference_types:['PROVISIONED']},[model],rates),[]);
  assert.deepEqual(matchModelPrices(model,[model,{...model,id:'meta.other-generation'}],rates),[]);
});
test('public fetch pins AWS endpoints, omits credentials, caches by region and refreshes after TTL',async()=>{
  let clock=Date.now(),calls=0;
  const loader=createPriceLoader((async(url,init)=>{calls++;assert.ok(String(url).startsWith('https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/'));assert.equal(init?.credentials,'omit');assert.equal(init?.redirect,'error');assert.deepEqual(init?.headers,{Accept:'application/json'});return new Response(JSON.stringify(file([{},{}])));}) as typeof fetch,()=>clock);
  const signal=new AbortController().signal;
  const [first,second]=await Promise.all([loader(region,signal),loader(region,signal)]);assert.equal(calls,2);assert.deepEqual(first,second);assert.equal(first.status,'available');
  await loader(region,signal);assert.equal(calls,2);clock+=3600001;await loader(region,signal);assert.equal(calls,4);
  await loader('us-east-1',signal);assert.equal(calls,6);await assert.rejects(loader('evil.example',signal));assert.equal(calls,6);
});
test('failed, malformed and oversized price feeds degrade gracefully without hiding models or exposing errors',async()=>{
  const signal=new AbortController().signal;
  const partial=createPriceLoader((async url=>{if(String(url).includes('FoundationModels'))throw new Error('private raw transport detail');return new Response(JSON.stringify(file([{},{}])));}) as typeof fetch);
  const result=await partial(region,signal);assert.equal(result.status,'partial');assert.equal(result.rates.length,1);assert.ok(!JSON.stringify(result).includes('private'));
  for(const body of ['not-json',JSON.stringify({}), ' '.repeat(8_000_001)]) {const loader=createPriceLoader((async()=>new Response(body)) as typeof fetch);const value=await loader(region,signal);assert.equal(value.status,'unavailable');assert.deepEqual(value.rates,[]);}
});
test('catalog includes matched prices only when requested and gracefully handles a pricing outage',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'gate-prices-'));let outage=false,calls=0;
  const {app,db}=await createApp({directory,logLevel:'silent',catalogClientFactory:()=>({send:async(command:any)=>command.constructor.name==='GetFoundationModelAvailabilityCommand'?{modelId:command.input.modelId,regionAvailability:'AVAILABLE'}:({modelSummaries:[{modelId:'meta.llama3-8b-instruct-v1:0',modelArn:'arn:aws:bedrock:eu-west-2::foundation-model/meta.llama3-8b-instruct-v1:0',modelLifecycle:{status:'ACTIVE'},modelName:'Llama 3 8B Instruct',providerName:'Meta',inferenceTypesSupported:['ON_DEMAND']}]}),destroy(){}}) as any,priceLoader:async()=>{calls++;if(outage)throw new Error('hidden transport message');return {status:'available',checked_at:new Date().toISOString(),rates:parse(file([{},{}]))};}});
  t.after(async()=>{await app.close();rmSync(directory,{recursive:true});});
  const setup=await app.inject({method:'POST',url:'/api/setup',payload:{workspace:'Price QA',name:'Owner',email:'owner@qa.test',password:'synthetic-password'}}),cookie=String(setup.headers['set-cookie']).split(';')[0];
  const call=(include_pricing?:boolean)=>app.inject({method:'POST',url:'/api/admin/aws/catalog',headers:{cookie},payload:{region,...(include_pricing===undefined?{}:{include_pricing})}});
  await call();assert.equal(calls,0);
  const r=await call(true);assert.equal(r.statusCode,200);assert.equal(r.json().items[0].prices[0].input,0.39);assert.equal(r.json().pricing.currency,'USD');
  outage=true;const failed=await call(true);assert.equal(failed.statusCode,200);assert.equal(failed.json().items.length,1);assert.equal(failed.json().pricing.status,'unavailable');assert.deepEqual(failed.json().items[0].prices,[]);assert.ok(!failed.body.includes('hidden'));
  assert.equal(db.get('SELECT COUNT(*) AS n FROM deployments')!.n,0);assert.equal(db.get('SELECT COUNT(*) AS n FROM usage_daily')!.n,0);
});
