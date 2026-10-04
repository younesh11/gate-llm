# Source security review — 2026-10-04

Scope: the gateway, dashboard authorization, upstream networking, input guardrails, token admission, credential storage/logging, maintenance commands, dependency lock, npm/Python packaging and CI configuration. Reviewed the local changes after v0.2.2 (`e57d6d0`) and added regression tests. This is an internal source review with targeted tests, not an independent penetration test or a production certification. Published v0.2.2 artifacts do not contain these fixes; the changes are currently in source under Unreleased.

## Findings addressed

| Finding | Assessment | Fix and evidence |
| --- | --- | --- |
| Dashboard authorization used the raw URL while the router accepted encoded static segments | High: reproduced a viewer changing workspace settings through an encoded path; origin checks were also affected | Authorize the matched route. Test owner/viewer/unauthenticated behavior across all 15 mutation routes and three path spellings; verify rejected calls leave state unchanged and reads remain uncached. |
| Upstream resolution was checked separately from socket connection, and string-based IP checks missed alternate IPv6/metadata forms | Medium in the documented trusted-owner deployment: an owner-controlled endpoint could bypass intended egress restrictions | Share a guarded transport across generation and token counting. Validate the exact DNS results supplied to the socket; use binary IP range checks; block known metadata aliases even with private opt-in; keep redirects disabled and standard TLS verification. A deterministic rebinding test proves zero connections reach a private trap server. |
| Email PII matching used unbounded repetitions | Medium: authenticated adversarial input could stall the single event loop | Bound email components. Before the fix, 4,000/16,000/32,000-character inputs took approximately 28/403/1,616 ms locally. A maximum-size adversarial inspection now completes in a child process with a five-second kill deadline while preserving email redaction. |
| Local-only bootstrap checked the peer address without checking Host | Preventive hardening against browser DNS rebinding during first-owner setup | Require a loopback Host and peer unless remote setup is explicitly enabled. Test a nonlocal Host on a loopback request and verify no owner is created. |

Origin comparisons also include the scheme and normalized default port, reject malformed/null origins and cross-site fetch metadata, and work with HTTPS termination when `COOKIE_SECURE=true` and the external Host is preserved.

## Verification

- All 63 Node tests pass locally, including the new security cases and existing streaming, concurrent budget/token admission, key revocation, guardrails, migration, backup/restore and operational-log privacy coverage.
- Type checking, production build, npm package-content checks and installed npm CLI smoke checks pass. Package checks require the new guarded transport and bundled HTTP dependency, and reject private state/configuration files.
- Python extraction safety tests, isolated wheel/sdist builds, Twine checks, and installed-wheel startup, dashboard and recovery checks pass locally.
- `npm audit` reports zero known vulnerabilities across the locked production and development dependencies on the review date. CI and release workflows now fail on high/critical advisory findings.
- A limited credential-pattern scan covered 70 working source files and 131 historical Git blobs. Only synthetic guardrail fixtures matched; no real credential was identified. This scan does not prove the absence of secrets in arbitrary formats or outside Git.
- Docker's local daemon was unavailable during this review. The existing CI container job builds, starts and smoke-tests a disposable Compose deployment; it does not constitute a full container vulnerability scan.

After restarting with the security fixes, the live EC2 test passed normal and streaming requests with a 500-token combined cap (45 input + 7 output used). Missing-key, model-permission and credential-guardrail checks passed; the temporary test key was revoked. The tokenizer setting remains opt-in, and other prompt formats retain the conservative estimate.

## Remaining operating boundaries

- Keep the dashboard on a trusted network with HTTPS for team access. Public demo credentials are only for isolated local demos. No SSO/MFA, distributed enforcement or internet-scale denial-of-service qualification is provided.
- Private upstream mode deliberately permits private services other than known metadata destinations. Restrict provider administration and use network egress controls; a finite address list cannot describe every environment-specific sensitive service or translation mechanism.
- Providers and tokenizers are trusted to report truthful usage and apply consistent chat templates. Configured prices are estimates, and upstream usage can exceed admission estimates. Text-pattern guardrails are not comprehensive data-loss prevention or prompt-injection defenses.
- Backup checksums detect corruption, not malicious replacement. Backups contain the encryption key and must stay in trusted encrypted storage. A restored snapshot can roll back key revocations and usage.
- CI action references remain version tags rather than immutable commit pins. Runtime/container security also depends on the installed Node release and base image; the npm advisory result does not audit those components.

No unresolved blocking finding was identified within this scope after the fixes. Push approval should be assessed against these boundaries, not as a claim that the service is safe for untrusted public multi-tenant deployment.

Implementation references: [Fastify matched request routes](https://fastify.dev/docs/latest/Reference/Request/), [Node BlockList](https://nodejs.org/api/net.html#class-netblocklist), and [Undici connection handling](https://undici.nodejs.org/).
