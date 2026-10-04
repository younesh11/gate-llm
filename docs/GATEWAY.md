# Gateway behavior and limits


- **Proxy:** `GET /v1/models` and `POST /v1/chat/completions`, JSON and SSE streaming, model aliases, request cancellation, timeouts and bounded response sizes. Text content only; tool-call JSON is forwarded but tools are never executed by GATE. This is a focused compatibility subset, not a claim of complete OpenAI API compatibility.
- **Keys:** one-time display, hashed storage, create/edit/revoke/rotate, model allowlists, expiry, combined dollar/token allowances with lifetime/daily/monthly periods, per-minute request and token limits, per-request combined input + output limits, and eight concurrent requests per key. Rotation invalidates the old token immediately while retaining usage and policy settings. Revocation blocks new requests; already accepted requests can finish.
- **Providers:** create/update/disable OpenAI-compatible endpoints; provider API keys encrypted with AES-256-GCM. No credential is returned by management APIs.
- **Routing:** weighted selection among enabled deployments under an alias; fallback on explicit HTTP 429 responses, up to three total attempts; cooldowns after 429 and 5xx responses. The remaining enabled deployments take future traffic during cooldown.
- **Input guardrails:** reusable per-key policies with normalized blocked terms, selected secret patterns, configurable PII pattern redaction and a local policy tester. No client override. These checks are intentionally limited; there is no semantic moderation service, guaranteed PII detection, output inspection, or complete prompt-injection protection.
- **Playground:** streaming conversations, system prompt, model/temperature/total-token controls, stop generation, token/latency display. Virtual key and chat history remain in browser memory only.
- **Workspace:** owner/viewer dashboard accounts, member creation/removal, audit records, metadata-only request history, seven-day usage overview. Viewers can inspect workspace metadata and use their separately issued virtual keys; owners manage all settings.

## Connect an application

```sh
curl http://127.0.0.1:4310/v1/chat/completions \
  -H "Authorization: Bearer YOUR_VIRTUAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"team-chat","messages":[{"role":"user","content":"Hello"}],"max_tokens":512,"stream":true}'
```

Use your gateway's `/v1` base URL in compatible clients. This version does not implement `/v1/responses`, embeddings, images, audio, batches, or native Anthropic/Gemini protocols. Native providers must expose a compatible endpoint to work here. Unknown request parameters are rejected rather than silently ignored.

## Create, test and assign guardrail policies

1. Open **Guardrails → Create policy**. Choose credential blocking, PII categories, blocked terms and a term matching mode.
2. Use **Test this policy** to inspect sample text with the draft settings. It reports allowed, redacted or blocked, with rule names and counts. Blocked input is not echoed in the result. Tests do not contact providers, consume quotas, save prompts or create request/audit records.
3. Save the policy, then use its **Assign to key** action to select one existing key. Alternatively choose it in **Virtual keys → Create / Edit → Guardrail policy**. New keys start with no policy selected; creating a policy alone does not protect any key.
4. The policy applies to every subsequent request using that key, including playground and streaming requests. One key has at most one policy. Assigning another replaces the current policy. Choose **No policy** in the key editor to remove the assignment. Editing a shared policy changes checks for all keys assigned to it; accepted requests already in flight retain their original checks.

| Check | Behavior |
| --- | --- |
| Credential patterns | Blocks selected OpenAI-style, Groq, GATE, Stripe, Hugging Face, Google, GitHub, GitLab, Slack and AWS access-key patterns and private-key headers. These are local shape checks, not provider validation or arbitrary password detection. |
| Blocked terms | Up to 100 literal terms/phrases, 100 characters each. Substring mode matches within words; whole-word mode checks Unicode letter/number/underscore boundaries. Both normalize case, NFKC compatible characters, selected invisible characters and whitespace runs. No regular expressions or semantic classification. |
| Default PII | Email addresses and separated US SSN patterns become `[EMAIL REDACTED]` and `[ID REDACTED]`. Categories can be selected independently or redaction disabled. |
| Optional PII | Phone numbers with an explicit `+` country prefix (8–15 digits) and 13–19 digit payment-card patterns with a valid Luhn checksum become `[PHONE REDACTED]` and `[PAYMENT CARD REDACTED]`. These start disabled, and matches can be false positives. |

Secrets are inspected in request string values and property names; blocked terms apply to string values, excluding API envelope property names. Field names inside JSON-encoded content are also checked for blocked terms. JSON-encoded strings are decoded for inspection, including escaped function arguments. PII redaction applies to string values in message content and `tool_calls[].function.arguments`, preserving valid JSON when arguments are structured. PII in structured field names blocks the request instead of renaming fields. Routing identifiers, tool schemas, numeric values and other metadata are not PII-redacted. Encodings/obfuscations outside the supported normalization and non-text data are not comprehensively detected. Nested inspection is limited to 64 levels; deeper inputs are rejected.

Blocking runs before upstream calls and quota reservations, returning HTTP 422 with code `guardrail_blocked`. Request metadata records `blocked:secret`, `blocked:term` or `blocked:pii_field_name`, without matched text. Allowed redactions record `redacted:N`. These are input-only checks; provider responses are not inspected.

The owner-authenticated management API accepts the following policy fields on `POST /api/admin/policies` and `PUT /api/admin/policies/:id`:

```json
{
  "name": "Team privacy",
  "block_secrets": true,
  "redact_pii": true,
  "pii_types": ["email", "us_ssn", "phone", "credit_card"],
  "blocked_terms": ["internal only"],
  "term_match": "word"
}
```

Omitted `pii_types` defaults to `["email","us_ssn"]`; omitted `term_match` defaults to `"substring"`. `POST /api/admin/policies/test` takes `{ "policy": { ...fields except name }, "text": "sample text" }` (1–20,000 characters), and returns `{ action, result, findings, text, message? }`. The result text is sanitized for redaction and `null` for blocked input. `PATCH /api/admin/keys/:id/policy` takes `{ "policy_id": "saved-policy-id" }` or `null` to detach, without changing key limits or usage. All policy mutations, assignments and tests require an owner dashboard session and same-origin requests; virtual API keys cannot access them. A caller cannot override its assigned policy through the chat API.

## Budget and retry behavior

Currency is stored as integer microdollars. Each accepted request atomically reserves a conservative estimate based on serialized input bytes, per-message overhead, requested maximum output, and the most expensive eligible deployment. Concurrent requests cannot spend the same available budget. Reservation is reconciled with provider-reported prompt/completion usage and configured prices after completion.

If usage is missing, the stream is interrupted, the connection times out, or the gateway restarts with unresolved reservations, the full reservation is retained as an **estimated** charge. This protects the local budget at the expense of possibly overstating provider spend. An explicit 429 is treated as unbilled and may fall back. Server failures, connection errors, timeouts and partial streams are not automatically replayed because billing may already have occurred.

This is operational cost control, not an exact invoice or a guaranteed provider spending cap. Token accounting and special pricing vary across providers; cache discounts and non-token fees are not modeled. Misconfigured prices, unusual tokenization, or incorrect provider usage can produce different actual charges. Request and token rate limits use fixed UTC minute windows. Dollar budgets and total token allowances share the selected period: lifetime (no reset), daily (midnight UTC), or monthly (the first day at midnight UTC). The first limit that cannot cover a request blocks it with HTTP 429. Editing or rotating a key does not reset its usage. Changing the period evaluates usage already accrued during the newly selected period.

## Choose a budget or token allowance

In **Virtual keys → Create key / Edit → Allocation type**, choose **Budget only**, **Tokens only (input + output)**, **Budget and tokens**, or **No allowance cap**. Only the relevant amount fields appear. Switching modes removes the inactive cap when saved and preserves usage history.

For example, to apply both allowances, configure:

| Setting | Example |
| --- | --- |
| Allocation type | Budget and tokens |
| Allowance period | Monthly |
| Spend budget | $20 |
| Total token allowance | 1,000,000 input + output tokens |
| Tokens per minute | 100,000 |
| Requests per minute | 60 |
| Maximum tokens per request | 8,192 input + output |

Budget only caps spending without a total token cap. Tokens only caps the combined input + output count without a spending cap. When both are selected, both allowances are enforced. Each selected amount is required; setting the token allowance to zero blocks requests. The API represents an unlimited allowance with `null`. Free/self-hosted deployments consume tokens even when their configured dollar cost is zero. TPM is a separate optional burst limit.

Admission reserves estimated input tokens plus the requested maximum output, then reconciles against reported prompt + completion tokens. The reservation can exceed what the request eventually consumes, so a request may be rejected while some allowance remains. Reduce the prompt/output limit if needed. Unknown usage retains the reserved token amount as an estimate, including after interruption or restart. Provider usage that exceeds the estimate can exceed a quota before it is reported; subsequent requests are blocked. These are admission controls, not an exact provider-tokenizer guarantee.

Requests are charged to the UTC date and minute in which they were admitted, even if they complete after a period boundary. Completed charges remain in a separate daily usage ledger, so rotation and request-history cleanup cannot erase quota usage. New periodic windows become available without a scheduled reset worker. Upgrading an existing database keeps its keys and budgets unchanged, adds unlimited token settings by default, and initializes token history from previously reported input/output usage. Tokens for old requests with no usage information cannot be reconstructed retroactively.

## Combined request limit and model access

**Maximum tokens per request** caps estimated input plus output for a single call. The key stores `max_request_tokens`; the playground sends `max_total_tokens`. Input includes the conversation and tool/schema payload. The gateway estimates input before admission, rejects requests that cannot fit, and restricts upstream output to the remaining capacity (with a 32,768 output ceiling). This conservative byte-based estimate is not an exact model tokenizer; provider usage can differ.

OpenAI-compatible `max_tokens` and `max_completion_tokens` retain their standard output-only meaning at the API boundary. When explicitly supplied, estimated input plus that output amount must fit the combined cap. With no output or total parameter, the output default is up to 1,024 tokens, reduced to fit the key's remaining request capacity. With `max_total_tokens`, all remaining capacity can be used for output. The gateway-only total parameter is removed before forwarding.

Existing per-request numeric limits migrate unchanged into the combined limit. A previous limit of 2,048 output tokens becomes 2,048 total tokens; review small limits if existing prompts no longer fit. The admin API now uses `max_request_tokens` instead of `max_output`.

**Allowed models** are the configured aliases this key is permitted to call. A key allowing only `team-chat` cannot call `team-fast`. Add aliases in **Models & routing**, then check the ones this application needs. This selection does not allocate tokens separately to each model.

## Token usage dashboard

Open **Token usage** for input/output charts, a usage ranking, and an exact-count breakdown. Choose today, the last seven or thirty days, or all time; select a key, team member, or owner/application to filter. All-time totals include the complete ledger; its trend shows the last thirty days. Dates use UTC and the view refreshes every fifteen seconds.

Use **Assigned team member** in the key editor to attribute usage to a dashboard user. Unassigned keys appear together in the member view; owner/application groups use the existing owner label. These groups reflect current key assignments, including historical usage. Reassigning a key moves its history into its new group; deleting a member leaves the key and usage unassigned.

Totals come from the persistent daily ledger, including revoked keys, and survive request-log cleanup. Reported input and output are tracked separately. **Estimated / unsplit** includes retained reservations without provider usage and historical tokens whose input/output split is unavailable. This amount is already included in total tokens; in-flight reservations are not counted as spent until settled. Costs use configured deployment prices. The dashboard is scoped to the signed-in workspace and readable by owners and viewers.

## Storage, backup, and team access

- Run **one gateway process per data directory**. An exclusive transaction on `process-lock.sqlite` guards accidental double-starts; the operating system releases it when the owner exits, including an abrupt kill. Never remove the lock database while an instance is running. SQLite transactions persist budgets, reservations, rate counters, users, sessions and configuration; there is no in-memory-only budget store.
- The storage directory contains `relay.sqlite`, its WAL files, and `encryption.key`. Keep the whole directory private. The encryption key is stored locally, separate from ciphertext, and is not a managed KMS. Anyone who can read both can decrypt provider credentials.
- Stop the service for a consistent filesystem backup of the entire data directory. Restore the database and its original encryption key together. Missing keys are not silently regenerated for an existing database.
- Dashboard passwords are salted with scrypt. Sessions are hashed, expire after 12 hours, and use HttpOnly/SameSite=Strict cookies. Mutation requests with a foreign Origin are rejected. Login attempts are limited per client IP. This is not a substitute for perimeter protections on a public deployment.
- Before inviting your team, configure the first owner locally, put the service behind HTTPS, set `COOKIE_SECURE=true`, and keep the admin interface on a trusted network. Preserve the external Host header in your reverse proxy and support SSE without buffering. To bind a direct LAN interface, set `HOST` intentionally; do not publish the demo.
- Each person should receive their own dashboard account. Virtual keys never grant administrative access. Removing a member ends dashboard sessions; separately revoke keys issued to that member.
- Request logs do not store prompt/response bodies or authorization headers. Audit records are append-only through the application API, but are not cryptographically tamper-proof against a host administrator. Retention/export automation is not implemented yet.
- Structured operational logs use generated request IDs and selected metadata only. `/health` is liveness; `/ready` additionally queries the database and returns 503 if it cannot serve that check. It does not call providers or prove storage capacity. See [operations](OPERATIONS.md).
- Provider URLs are an owner-controlled configuration surface. Public upstreams require HTTPS and are checked for private-address resolution; redirects are rejected. Private access is an explicit opt-in for trusted local models. Use network egress rules before exposing this to untrusted tenants; this is not a hardened multi-tenant SSRF boundary.


## Path to a hosted product

The schema scopes users, providers, policies, deployments, keys, usage and audit records to a workspace. Only one workspace can be provisioned through the current UI. That creates a migration path; it does not make this release a multi-tenant SaaS.

Before offering it to customers: move storage to PostgreSQL; add Redis or another shared coordination mechanism for multiple workers; add organization onboarding, membership/invitation flows and authorization tests; move encryption to KMS/secret storage; provide stronger egress controls, SSO, retention/export, operational monitoring and load testing. Add provider adapters only when a real use case requires them.
