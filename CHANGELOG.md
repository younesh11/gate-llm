# Changelog

This project uses Semantic Versioning. Dates use YYYY-MM-DD.

## [Unreleased]

No unreleased changes.

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
