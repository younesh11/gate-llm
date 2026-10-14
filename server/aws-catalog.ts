import { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand, GetFoundationModelAvailabilityCommand } from '@aws-sdk/client-bedrock';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createPriceLoader, matchModelPrices, type PriceLoader } from './aws-pricing.ts';
import { HttpError } from './store.ts';

export type CatalogClientFactory = (region: string) => Pick<BedrockClient, 'send' | 'destroy'>;
export const catalogInput = z.object({
  // Commercial AWS regions only; never accept an endpoint, profile or credentials from the browser.
  region: z.string().regex(/^(us|eu|ap|sa|ca|me|af|il|mx)-[a-z]+-[1-9]\d?$/, 'Enter a commercial AWS region, for example eu-west-2.'),
  kind: z.enum(['models', 'profiles']).default('models'),
  include_pricing: z.boolean().default(false),
}).strict();

export const awsCatalogClient: CatalogClientFactory = region => new BedrockClient({
  region, endpoint: `https://bedrock.${region}.amazonaws.com`, ignoreConfiguredEndpointUrls: true,
  maxAttempts: 1, requestHandler: { connectionTimeout: 3000, requestTimeout: 10000 },
});

function catalogError(error: unknown): HttpError {
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
  if (['CredentialsProviderError', 'TokenProviderError'].includes(name)) return new HttpError(503, 'AWS credentials are unavailable. Configure an AWS profile, environment credentials or an IAM role for the GATE server, then try again.', 'aws_credentials_unavailable');
  if (['ExpiredTokenException', 'ExpiredToken', 'UnrecognizedClientException', 'InvalidSignatureException', 'InvalidClientTokenId'].includes(name)) return new HttpError(503, 'AWS credentials are expired or invalid. Refresh the GATE server’s AWS login and try again.', 'aws_credentials_invalid');
  if (name === 'AccessDeniedException') return new HttpError(403, 'AWS denied catalog access. Allow bedrock:ListFoundationModels, bedrock:GetFoundationModelAvailability and/or bedrock:ListInferenceProfiles for the GATE server’s AWS identity.', 'aws_catalog_access_denied');
  if (name === 'ThrottlingException') return new HttpError(429, 'AWS is throttling catalog requests. Wait before refreshing.', 'aws_catalog_throttled');
  if (['AbortError', 'TimeoutError'].includes(name)) return new HttpError(504, 'AWS model discovery timed out. Check the region and server connection, then retry.', 'aws_catalog_timeout');
  return new HttpError(502, 'Could not load the AWS catalog. Check the region, credentials and server connection.', 'aws_catalog_unavailable');
}

export function registerAwsCatalog(app: FastifyInstance, workspaceFor: (request: FastifyRequest) => string | Promise<string>, factory: CatalogClientFactory = awsCatalogClient, prices: PriceLoader = createPriceLoader()) {
  const limits = new Map<string, { until: number; requests: number; active: boolean }>();
  const controllers = new Set<AbortController>();
  app.addHook('onClose', async () => { for (const controller of controllers) controller.abort(); });
  app.post('/api/admin/aws/catalog', async (request, reply) => {
    const input = catalogInput.parse(request.body), workspace = await workspaceFor(request), now = Date.now();
    for (const [key, value] of limits) if (!value.active && value.until <= now) limits.delete(key);
    const limit = limits.get(workspace) ?? { until: now + 60000, requests: 0, active: false };
    if (limit.active || limit.requests >= 10) throw new HttpError(429, 'A catalog lookup is running or the refresh limit has been reached. Wait before retrying.', 'aws_catalog_rate_limit');
    limit.active = true; limit.requests++; limits.set(workspace, limit);
    const controller = new AbortController(); controllers.add(controller);
    const close = () => controller.abort(); reply.raw.on('close', close);
    const timer = setTimeout(() => controller.abort(), 12000);
    let client: ReturnType<CatalogClientFactory> | undefined;
    let rejectOnAbort: () => void = () => {};
    try {
      client = factory(input.region);
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectOnAbort = () => reject(Object.assign(new Error('Catalog cancelled'), { name: 'AbortError' }));
        controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
      });
      const load = async () => {
        if (input.kind === 'models') {
          const priceRequest = input.include_pricing ? prices(input.region,controller.signal).catch(()=>({status:'unavailable' as const,checked_at:new Date().toISOString(),rates:[]})) : undefined;
          const data = await client!.send(new ListFoundationModelsCommand({ byInferenceType: 'ON_DEMAND' }), { abortSignal: controller.signal });
          const rows = data.modelSummaries ?? [];
          // Never turn price-feed entries or cross-region/provisioned-only models into local deployments.
          const candidates = rows.filter(model => model.modelId && model.modelArn === `arn:aws:bedrock:${input.region}::foundation-model/${model.modelId}` && model.modelLifecycle?.status === 'ACTIVE' && model.inferenceTypesSupported?.includes('ON_DEMAND'));
          const unique = [...new Map(candidates.map(model => [model.modelId, model])).values()];
          const checked = unique.slice(0, 200);
          const available = new Set<string>();
          let next = 0, unavailable = 0, unverified = 0, denied = false;
          // Availability calls are read-only, bounded, and fail closed for individual models.
          await Promise.all(Array.from({length: Math.min(4, checked.length)}, async () => {
            while (next < checked.length) {
              controller.signal.throwIfAborted();
              const model = checked[next++];
              try {
                const result = await client!.send(new GetFoundationModelAvailabilityCommand({modelId:model.modelId}), {abortSignal:controller.signal});
                // AWS availability responses can omit the default ':0' revision, e.g. Llama 3.1.
                // Accept only that exact canonicalization, never another version/context variant.
                const sameModel = result.modelId === model.modelId || (model.modelId!.endsWith(':0') && result.modelId === model.modelId!.slice(0,-2));
                if (sameModel && result.regionAvailability === 'AVAILABLE') available.add(model.modelId!);
                else if (result.regionAvailability === 'NOT_AVAILABLE') unavailable++;
                else unverified++;
              } catch (error) {
                unverified++;
                if (error && typeof error === 'object' && 'name' in error && error.name === 'AccessDeniedException') denied = true;
              }
            }
          }));
          const items = checked.filter(model=>available.has(model.modelId!)).map(model => ({
            id: model.modelId, name: model.modelName, provider: model.providerName,
            input: model.inputModalities ?? [], output: model.outputModalities ?? [],
            streaming: model.responseStreamingSupported ?? null,
            status: model.modelLifecycle?.status ?? 'UNKNOWN', inference_types: model.inferenceTypesSupported ?? [],
          }));
          const pricing = await priceRequest;
          return {truncated:unique.length>200,availability:{verified:true,unavailable,unverified,excluded:rows.length-candidates.length,permission_required:denied},items:pricing?items.map(item=>({...item,prices:matchModelPrices(item,items,pricing.rates).filter(price=>price.mode==='Regional')})):items,...(pricing?{pricing:{status:pricing.status,checked_at:pricing.checked_at,currency:'USD',unit:'1M tokens'}}:{})};
        }
        const items = [], seen = new Set<string>(); let nextToken: string | undefined;
        for (let page = 0; page < 20; page++) {
          controller.signal.throwIfAborted();
          const data = await client!.send(new ListInferenceProfilesCommand({ maxResults: 100, nextToken }), { abortSignal: controller.signal });
          for (const profile of (data.inferenceProfileSummaries ?? []).slice(0, 100).filter(profile=>profile.status==='ACTIVE')) items.push({
            id: profile.inferenceProfileId, name: profile.inferenceProfileName, status: profile.status ?? 'UNKNOWN',
            type: profile.type, models: (profile.models ?? []).map(model => model.modelArn),
          });
          nextToken = data.nextToken;
          if (!nextToken) break;
          if (seen.has(nextToken)) throw new Error('Repeated pagination token');
          seen.add(nextToken);
        }
        return { items, truncated: !!nextToken };
      };
      const result = await Promise.race([load(), aborted]);
      return { region: input.region, kind: input.kind, fetched_at: new Date().toISOString(), ...result };
    } catch (error) { throw catalogError(error); }
    finally {
      clearTimeout(timer); reply.raw.off('close', close);
      controller.signal.removeEventListener('abort', rejectOnAbort);
      controller.abort(); controllers.delete(controller); client?.destroy(); limit.active = false;
    }
  });
}
