# GATE v0.3.0 plan: Bedrock first

Status: proposed implementation plan; no application changes or AWS calls made.

Prepared on 2026-10-04 against GATE v0.2.2, commit `e57d6d0`.

## Product outcome

An owner can add an AWS Bedrock connection, configure a model alias and separate input/output prices, assign that alias to a GATE virtual key, and use it from the existing playground or `/v1/chat/completions` endpoint. The same key permissions, collective input/output limits, budgets, policies and usage dashboard apply.

Bedrock is the priority for the next minor feature release, v0.3.0. Implement and validate it in the stages below. The later goal is a curated model catalog across hosted providers and local models, including services offering free API usage. This turn establishes the plan only.

## Authentication: an AWS profile is optional

Use the AWS SDK for JavaScript v3 with its standard IAM credential discovery. GATE does not require a named profile. Local development can use an AWS login/profile or environment-provided credentials; deployments on AWS can use a workload IAM role. Prefer temporary credentials. AWS documents these choices in its [Node.js credential chain](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html).

For v0.3.0, recommend one runtime AWS identity shared by the gateway's Bedrock connections. Store the region and authentication mode in GATE, while credentials remain in the runtime's AWS configuration. A profile selected with `AWS_PROFILE` is an optional deployment setting. Arbitrary per-provider role assumption, managing AWS users, and storing long-lived AWS keys in dashboard forms are deferred.

Document local Node, pip-launcher, Docker and AWS-role setup. Docker requires an explicit way to access the chosen credential source; a host's AWS login is not automatically available inside the container. Document SSO expiry/refresh and credential-file permissions. Tests must prove temporary credential refresh is retained and SDK credentials/signatures never enter logs, responses or backups.

IAM authorizes GATE to call Bedrock. GATE can run on the user's own machine and call the selected regional AWS endpoint; it does not require Bedrock to access that machine. The invocation actions are `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream`. Scope the setup examples to the chosen model/profile resources, and document any destination-region requirements when using an inference profile. See [Converse permissions](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html) and [ConverseStream permissions](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html).

## What is already available

The v0.2.2 code already provides aliases with multiple weighted deployments, per-deployment prices, key permissions, atomic reservations, input policies, conservative settlement, a streaming playground and usage by key/member. Bedrock should reuse these components.

| Current area | Change needed |
| --- | --- |
| `server/gateway.ts` combines admission/accounting with an OpenAI-compatible HTTP request and SSE parser | Extract provider-specific transport behind an adapter while retaining one shared admission/settlement path |
| `server/app.ts` validates every provider as a URL plus API key | Validate providers by type: `openai_compatible` or `bedrock` |
| The unreleased tokenizer update uses schema 4 and explicit provider inserts; deployment inserts are positional | Add the next migration, use explicit column lists, and preserve existing rows and relationships |
| `client/main.tsx` displays every provider as OpenAI compatible | Add provider type, Bedrock region/authentication guidance, and provider-aware model fields |
| `server/maintenance.ts` accepts exactly the current schema and attempts to decrypt every provider secret | Support planned schema transitions and providers with no stored secret |
| Release packaging explicitly bundles runtime dependencies | Bundle the selected AWS SDK dependencies in both npm and Python packages; test Docker too |

The maintenance assumption also affects existing OpenAI-compatible providers configured without an API key. Include that regression in the first implementation stage; never treat an empty optional secret as a corrupt encrypted value.

## Implementation stages

### 1. Establish the adapter boundary and preserve existing behavior

Introduce a small adapter interface with request validation/preparation, invocation, normalized usage and classified failures. Extract the existing OpenAI-compatible transport into the first adapter. Keep authentication, per-key policies, limits, reservation ownership, deployment selection, cancellation and settlement in the gateway.

Each adapter must distinguish failures before dispatch, explicit request rejection, potentially processed requests, and failures after streaming begins. This classification determines whether to release or retain a reservation and whether fallback is allowed. Do not equate every AWS 4xx status with a request that incurred no processing.

Exit check: the current gateway suite passes unchanged in behavior, including JSON/SSE passthrough, 429-only fallback, cancellation, guardrails and crash accounting. Add coverage for keyless-provider backup verification.

### 2. Add provider configuration and migration

Propose schema 5 after the unreleased schema-4 tokenizer update, with a provider type defaulting existing rows to `openai_compatible`, a Bedrock region and a runtime-IAM authentication mode. Keep current endpoint/key and token-counting fields for compatible providers. Make provider type immutable after creation so changing an existing connection cannot silently reinterpret its deployments.

Keep aliases independent of upstream model identifiers. Accept foundation-model IDs and configured inference-profile IDs/ARNs for Bedrock. Do not expose arbitrary endpoint overrides in the first Bedrock form. Use AWS regional endpoints through the SDK and validate configuration server-side.

Add model capability/limit metadata sufficient for the initial text-chat contract, including supported streaming and optional context/output limits. Preserve the current behavior of existing compatible deployments. Limit metadata must be explicit or come from a verified preset; do not assume all Bedrock models have identical features.

Maintain schema-3 and schema-4 backup verification/restore in the new release. Verify the original snapshot against its own schema, restore into a new directory, then migrate that copy through the normal startup path. Test backups of schema 5 too. Rollback from a migrated database requires the pre-upgrade backup and old version; do not promise that v0.2.2 can open a newer schema.

Exit check: upgrading real-shaped v0.2.2 fixtures preserves users, provider credentials, aliases, policies, keys, prices, budgets and usage; old snapshots remain recoverable.

### 3. Implement Bedrock text chat and streaming

Use `@aws-sdk/client-bedrock-runtime` with `Converse` and `ConverseStream`. Translate messages and supported inference parameters, then return the gateway's existing chat-completion response format. AWS provides a common conversational interface and [JavaScript examples](https://docs.aws.amazon.com/code-library/latest/ug/javascript_3_bedrock-runtime_code_examples.html).

Initial contract: text messages, initial system/developer instructions where the configured model supports them, temperature/top-p within that model's constraints, stop sequences and output limits. Reject unsupported fields or message arrangements before reserving funds or invoking AWS. Tool calls, JSON-schema output, images/audio/video, embeddings and arbitrary model-specific parameters are deferred for the Bedrock adapter; existing compatible-provider behavior remains available.

For aliases with different provider types, validate each candidate's capabilities before admission and select only compatible deployments. Return a clear unsupported-request error if none can serve the request. Never silently drop requested features to permit fallback.

Convert Bedrock stream events into valid SSE deltas, finish reasons, optional client usage events and the final completion marker. Wait for terminal usage/stream completion rather than treating the first stop event as the end of accounting. Preserve backpressure, response-size limits, timeouts and client-disconnect cancellation. The stream protocol is documented in [ConverseStream](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html).

Exit check: deterministic mock tests cover normal responses, event ordering, UTF-8 text, usage after message stop, empty output, truncated streams, cancellation and stream exceptions. The existing playground consumes the response without provider-specific client logic.

### 4. Preserve limits, pricing and failure accounting

Map provider input/output usage into the existing ledger. The key's maximum continues to cover estimated input plus allowed output, while Bedrock receives an output-only limit. Respect both the key limit and configured model limits: cap implicit defaults appropriately and reject explicit impossible requests.

Retain separate input/output USD-per-million prices on each deployment. Prices depend on the actual model, region and serving option; do not reuse an assumed Llama rate for every provider. Use manually confirmed prices for v0.3.0, checked against [AWS pricing](https://aws.amazon.com/bedrock/pricing/). Automatic price synchronization, prompt caching and alternate service tiers are deferred. Dashboard spend remains gateway accounting, not an AWS invoice.

Configure a single SDK attempt per gateway dispatch and verify that behavior with a failing transport test. GATE should remain responsible for fallback; hidden SDK retries could duplicate work and defeat its accounting rules. AWS documents its automatic retry behavior and configuration in the [retry reference](https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html).

Retain conservative charges when processing may have happened but usage is absent. Release reservations for local validation/credential-resolution failures and explicit known rejections. Permit bounded fallback only for classified pre-stream throttling/capacity rejection; never replay a partially delivered stream. Preserve cancellation/error audit metadata without recording prompts, responses, credentials or raw SDK errors.

Exit check: concurrent budget/token admission, accurate reported usage, missing-usage settlement, expiry/revocation, RPM/TPM, cooldowns, mixed-provider aliases and unsupported features all have integration coverage. Guardrail blocks make zero SDK invocations.

### 5. Finish the owner workflow and live validation

The intended flow is **Providers → Add provider → AWS Bedrock → Region → Runtime IAM**, then **Models & routing → Model/profile ID → Alias → Input/output prices**, followed by a virtual key and playground request.

Show clear errors for absent/expired credentials, denied model access, incorrect model/region and throttling. A saved configuration is not labelled as a verified working connection. Use an explicitly initiated, small playground request with a virtual key for live inference so its usage, prices and policy are accounted for normally. Readiness checks must not make model calls.

The initial desired model is Llama 3.1 8B Instruct. AWS currently lists `meta.llama3-1-8b-instruct-v1:0` for in-region use in `us-west-2`, and a US inference profile `us.meta.llama3-1-8b-instruct-v1:0`. London is not listed on this model's current regional table. Confirm account access and acceptable processing region before choosing the live target; if UK/EU processing is required, choose an available model there. Recheck availability at implementation time. [AWS model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-meta-llama-3-1-8b-instruct.html)

Exit check: after credentials and the target are configured by the operator, one small JSON request and one streaming request succeed through GATE, and reported tokens appear correctly in the dashboard. Document the tested region/model and setup. No credentials or billable tests are needed to finish this plan or the mock-based implementation.

### 6. Package and release v0.3.0

Run the supported Node-version matrix, all existing regression tests, new Bedrock transport/accounting tests, schema upgrade/backup/restore tests, and installed npm/Python/Docker smoke tests. Include AWS dependency extraction in the Python package tests without requiring network access to download runtime code.

Publish after the checks and live validation succeed: reviewed changelog, upgrade guide, least-privilege IAM examples, model-compatibility scope, matching package versions, checksums, GitHub downloads and AMD64/ARM64 container images. Continue using the established release channels; short-name npm/PyPI publication is a separate account/setup dependency. v0.3.0 remains an internal beta, with HTTPS deployment, monitoring and load qualification still on the roadmap.

## Later: a curated catalog of hosted and local models

The adapter boundary supports the OpenRouter-style direction without adding a marketplace to the Bedrock release. Many hosted services can use the existing OpenAI-compatible adapter; others can add dedicated adapters behind the same key controls.

Plan a later catalog with model ID, provider, supported features, context/output limits, separate input/output prices, free-tier conditions, region and last verification time. Let the owner enable selected models and assign aliases. Import metadata only from intended provider APIs or owner-maintained entries. OpenRouter's [model catalog API](https://openrouter.ai/docs/api/api-reference/models/get-models) is a useful reference for this metadata design.

Open-weight/source availability and free hosted inference are separate properties. A provider can offer a free API allowance, and a self-hosted model can still have infrastructure costs. Free hosted options can change availability and have tighter limits, as OpenRouter describes for its [free router](https://openrouter.ai/docs/guides/routing/routers/free-router).

Add an explicit **free-only** routing choice in that later stage: zero-cost candidates only, token limits still enforced, and no fallback to a paid deployment unless the owner/key policy allows it. Availability, quotas and pricing freshness need to be visible. A public marketplace with customer billing, revenue sharing, onboarding and shared infrastructure would be a separate product phase.

## Decisions before live AWS testing

- Choose where GATE runs first: current local machine/Docker is the planning assumption; an AWS workload role is also supported by the proposed design.
- Choose the available credential source. A named profile is optional, not a prerequisite.
- Confirm model access and region. Preserve Llama 3.1 8B as the requested starting target unless region/access constraints require another model.
- Confirm current input/output prices and a small test allowance before making inference calls.

Implementation begins with stage 1 after the planning discussion. No version bump, dependency install, application edit, AWS resource change or release is part of this planning step.
