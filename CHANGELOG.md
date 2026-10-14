# Changelog

This project uses Semantic Versioning. Dates use YYYY-MM-DD.

## [Unreleased]

- Simplify source deployment to `./scripts/start.sh`: create private environment defaults without overwriting existing settings, build with Docker Compose, wait for readiness, and print the mapped address. Document one host-port setting, persistent storage, optional AWS credentials and the incomplete PostgreSQL integration.
- Start the PostgreSQL foundation with async bounded pools, checksummed migrations and bigint quota reservations/settlement tested against a disposable PostgreSQL container. This is an internal increment; live gateway handlers and user data still use SQLite, and multi-instance recovery remains pending.
- Restrict regional AWS model discovery to active on-demand models whose region availability AWS explicitly confirms. Hide unavailable/unverified, provisioned-only and profile-only models, separate cross-region profiles, and never infer regional availability or local prices from cross-region price records.
- Show separate input/output AWS list prices in model search, in USD per million tokens. Fetch regional public price files with bounded requests and caching; label cross-region rates, refuse ambiguous matches, and preserve discovery when pricing is unavailable. Deployment accounting prices remain explicitly configured.
- Add a member portal for assigned models, allowance requests, personal keys and private usage. Owners assign model access and required guardrails, suspend members, approve shared money/token allowances, and review delegated deployments with owner-controlled prices.
- Migrate to schema 5 with durable per-member usage and reservation ownership. Enforce shared allowances across keys, retain charges through rotation/recovery, and revoke assigned keys when removing a member. Existing viewers now receive a private view rather than workspace-wide metadata.

- Add owner-only AWS model discovery by commercial region, including searchable foundation models and paginated inference profiles. Use runtime IAM credentials, bound requests, and keep discovery separate from invocation access, pricing and quotas.

- Enforce dashboard permissions and origin checks using the matched route, including percent-encoded paths. Require a localhost Host header as well as a loopback peer for local-only first-owner setup.
- Validate upstream DNS answers at socket connection time for both generation and token counting. Reject alternate private IPv4/IPv6 forms, known cloud metadata addresses and metadata DNS aliases; retain trusted private-model opt-in and reject redirects.
- Bound email PII matching to prevent adversarial long text from stalling the gateway. Add authorization, DNS-rebinding, metadata, redirect and inspection-work regression tests.
- Gate CI and release packaging on npm's high/critical vulnerability check; bundle the guarded HTTP client in npm/Python distributions.
- Add opt-in vLLM input token counting for text chat, so small combined input/output limits use the configured model's chat tokenizer. Bound counting requests, apply guardrails before counting, fail closed on tokenizer errors, and preserve atomic budget/token reservations across streaming and fallback.
- Migrate providers to schema 4 with conservative estimates retained by default. Maintenance supports schema 3 and 4 snapshots, preserving older backups until a restored copy starts and migrates.
- Explain input-only limit failures without reporting a misleading requested output of zero.
- Fix backup verification, restore and password recovery for installations containing providers without API keys. Continue verifying all nonempty encrypted credentials, including when keyed and keyless providers coexist.
- Keep virtual-key editing controls visible beside each key as the table scrolls. Add an explicit Edit settings label and explain why revoked keys are locked.

## [0.2.2] - 2026-10-04

- Add offline `backup`, `verify-backup` and `restore` commands. Standalone SQLite snapshots include WAL data, the matching encryption key, and a versioned SHA-256 manifest; verification checks database integrity and provider credential decryption. POSIX files are private, but the archive is not encrypted.
- Restore into a new directory without overwriting existing state. Preserve configuration, budgets, token usage and pending reservations; invalidate saved browser sessions and record an audit event. Incomplete restore markers prevent startup of partial state. Application schema stays at version 3; future schemas are refused.
- Add local `reset-password` with a hidden confirmation prompt or explicit bounded stdin input. Password changes, session revocation and audit records commit atomically for the selected existing account. No recovery HTTP endpoint or default account is added.
- Add recovery tests for crashed WAL snapshots, corruption, key mismatch, ownership, session invalidation and failed transaction rollback. Exercise maintenance commands through packaged npm/Python installs and disposable Docker volumes; document private storage, restore drills and point-in-time limitations.
- Built-in backup scheduling, encrypted archive export, HTTPS deployment, metrics/alerts and sustained load qualification remain future work.

## [0.2.1] - 2026-10-04

- Replace PID-only directory ownership with an exclusive SQLite lock that the operating system releases after abrupt termination, including reused container PIDs. Retain a compatibility marker for older versions and release ownership after failed initialization. Application schema remains version 3.
- Add `/ready` to check local database access separately from `/health` liveness; Docker health checks now use readiness. This does not probe providers or prove disk write capacity.
- Add structured operational metadata logs, configurable LOG_LEVEL/--log-level, and generated request IDs shared by HTTP responses, usage records and gateway settlement events. Exclude prompts, credentials, raw URLs and raw error details.
- Add process-kill/restart, concurrent-owner, initialization-failure, readiness and log-privacy tests, plus a disposable container restart check in CI.
- Document operations and legacy-lock upgrade handling. This release is the first foundations increment; backup automation, account recovery, metrics/alerts and sustained load qualification remain future work.

## [0.2.0] - 2026-10-02

- Reusable guardrail policies created and tested in Guardrails, then explicitly assigned to individual virtual keys. New keys default to no policy; existing assignments are retained.
- Expanded local credential detection (including Groq), normalized blocked terms with substring/whole-word modes, and optional international phone/payment-card redaction.
- Structured tool-argument inspection, private policy previews without provider calls or stored test input, and safe block-reason metadata.
- SQLite schema version 3 adds PII categories and term matching; existing policies retain email/US SSN categories and substring matching. Stronger detection can newly block credential patterns and normalized terms missed by earlier versions.

## [0.1.0] - 2026-10-01

First packaged release, named GATE (Gateway for AI Traffic & Enforcement).

- OpenAI-compatible text chat proxy with JSON and SSE responses.
- Encrypted provider credentials, hashed virtual keys, model permissions, expiry, rotation and revocation.
- Dollar budgets, combined input/output allowances, daily/monthly/lifetime windows, RPM/TPM and combined per-request limits.
- Weighted routing, 429 fallback, cooldowns and conservative reservation accounting.
- Input guardrails, streaming playground, owner/viewer accounts and audit records.
- Persistent usage charts by key, team member and owner/application.
- Versioned Node CLI and npm archive, Python launcher/wheel, and non-root Docker/Compose deployment.
- MIT license, installation, configuration, API, upgrade and release documentation, CI and opt-in publishing workflows.

### Compatibility

This release is a single-instance application with SQLite schema version 2. Native AWS Bedrock Converse/IAM, SSO, billing, shared user budgets and multi-instance coordination are not implemented. Earlier Relay development data remains usable with an explicit `--data-dir` pointing to its existing directory; do not copy only the database without its encryption key.
