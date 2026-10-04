# Changelog

This project uses Semantic Versioning. Dates use YYYY-MM-DD.

## [Unreleased]

No unreleased changes.

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
