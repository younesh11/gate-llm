# Native AWS Bedrock

Included in GATE 0.3.0. GATE supports text chat through **Converse** and **ConverseStream**, including the existing Playground and OpenAI-compatible `/v1/chat/completions` gateway route. The published v0.2.2 packages do not contain this feature.

## Connect a model

1. Configure an AWS identity for the GATE server: a local AWS profile, environment credentials or a workload IAM role. The SDK resolves and refreshes credentials; GATE does not store IAM access keys in provider records.
2. In **Providers → Add provider**, choose **AWS Bedrock**, enter a name and the region where you will invoke the model, then save. The endpoint is derived from the region. No base URL or API key is required.
3. Use **AWS models** to discover regional model IDs. Discovery is free metadata access and does not establish invocation permission or Converse compatibility. Inference profiles are separate and can route outside the source region.
4. In **Models & routing**, choose the Bedrock provider, set an alias, the model/profile ID, and separate input/output USD prices per million tokens. For example, Llama 3.1 8B uses `meta.llama3-1-8b-instruct-v1:0` where available. Some models require an inference profile ID instead.
5. Allow the alias on a virtual key and grant sufficient combined input/output allowance and budget. Select the alias in Playground, enter the key, and send a short message. **Inference is billable.**

An existing OpenAI-compatible provider can be changed to AWS Bedrock through **Configure**. Saving removes its stored bearer API key and clears deployment cooldowns. Existing deployments, aliases and prices are preserved. This change is explicit; upgrading GATE never automatically converts providers.

## Local Docker profile

Docker cannot automatically read your host's AWS profile. For the PostgreSQL source installation, build and start with:

```sh
docker compose --env-file .env.postgres -f compose.postgres.yaml -f compose.aws-profile.yaml up --build -d --wait
```

This opts into a read-only mount of `~/.aws`. Set `AWS_PROFILE=your-profile` in `.env.postgres` if using a non-default profile. `GATE_AWS_CONFIG_DIR` can select another host directory. The mounted directory must be readable by the container's `node` user. Keep both Compose files when recreating the container. SSO login/renewal occurs on the host; expired credentials require signing in again. Host-only credential-process executables are not supplied by the container.

For a Node or pip installation, the normal runtime environment/profile is used without a mount. On AWS infrastructure prefer a workload role. Each Bedrock provider uses the **same server identity** and its own configured region. Per-provider identities, custom endpoints and storing IAM credentials in the dashboard are unsupported. The native provider explicitly uses SigV4; saved bearer API keys and `AWS_BEARER_TOKEN_BEDROCK` are not its authentication source.

## Permissions

Converse needs `bedrock:InvokeModel`; streaming needs `bedrock:InvokeModelWithResponseStream`. Scope IAM permissions to the intended model resources. For inference profiles, authorize the profile and required destination models according to AWS cross-region rules. Catalog discovery requires separate read permissions listed in [AWS catalog setup](AWS_CATALOG.md).

## Behavior and limitations

- Supports non-empty user/assistant text, leading system/developer instructions, temperature (0–1), top-p, output-token limits and stop sequences. Model-specific limits/features still apply and may be rejected by AWS.
- Tools, tool messages, structured output, multimodal inputs, seed and frequency/presence penalties are not supported in this first increment. Explicit unsupported parameters fail before quota admission, rather than being silently ignored. Mixed routing pools containing Bedrock must satisfy this restriction too.
- Input admission uses the existing conservative estimate. GATE's combined-token limit remains input plus output; only the remaining allowed output is sent as Bedrock `maxTokens`. Successful accounting uses AWS's reported input and output token counts and the deployment's separate prices.
- Existing virtual-key permissions, shared member allowances, input guardrail policies, quota reservations and rate limits run before inference. Native AWS managed guardrails and output filtering are not added by this integration.
- JSON responses and text streaming are translated to OpenAI-compatible responses. Terminal usage is collected after the message stop; incomplete streams do not emit a successful completion marker. Backpressure, cancellation, size bounds and the gateway deadline apply.
- SDK retries are disabled. Only explicit throttling (HTTP 429) can select another configured deployment. Authentication/validation/access rejections release the reservation; ambiguous failures and interrupted requests without usage retain conservative estimated charges. No raw AWS errors, signatures or credentials are returned to clients.
- Provider creation saves configuration; it does not prove model access or make a billable test call. There is no regional fallback unless the owner has configured another candidate or selected a cross-region inference profile.
- This is still a single-instance gateway. Native Bedrock support does not establish production capacity or horizontal scaling.

References: [Converse](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html), [ConverseStream](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html), [model API compatibility](https://docs.aws.amazon.com/bedrock/latest/userguide/models-api-compatibility.html).
