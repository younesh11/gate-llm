# GATE

**Gateway for AI Traffic & Enforcement**

An independent, self-hosted LLM gateway. One endpoint for your models, a dashboard for your keys and usage, and limits enforced before requests reach a provider. The current beta uses TypeScript, Fastify, React and PostgreSQL or SQLite; no LiteLLM dependency.

**Version 0.3.0 · MIT license · Single instance**

## Features

- **Virtual keys:** create, rotate, revoke, expire, assign to team members and restrict allowed model aliases.
- **Allowances:** money, combined input + output tokens, both, or neither; lifetime, daily or monthly periods.
- **Request limits:** combined input + output ceiling, requests per minute, tokens per minute and concurrent request limits.
- **Proxy and routing:** OpenAI-compatible chat completions, JSON/SSE streaming, weighted load balancing, cooldowns and fallback on explicit HTTP 429 responses.
- **Input guardrails:** reusable per-key policies, a local policy tester, normalized blocked terms, selected secret detection and configurable pattern-based PII redaction.
- **Playground and analytics:** streaming chat, token and spend breakdowns by key/member/application, request history and audit records.
- **Team access:** owner/member/viewer roles, invite-only password setup, assigned models, shared allowances, hashed virtual keys and encrypted provider credentials.
- **Notifications:** private inboxes, budget/token thresholds, allowance decisions and durable optional SES email/SNS delivery.
- **Recovery:** verified offline backups, restores into new directories, and local password reset with session invalidation.

Operational JSON logs, generated request IDs, database readiness and crash-released ownership are covered in [operations](docs/OPERATIONS.md). This is an internal beta; these foundations increments do not establish full production readiness.

The intended production scale is applications serving thousands of users. The [PostgreSQL integration](docs/POSTGRESQL.md) now covers the application and a controlled SQLite import, with one gateway instance enforced. Cross-instance coordination and measured capacity/failure testing follow the [production plan](docs/PRODUCTION_PLAN.md). The current release is not qualified for that scale.

See [gateway behavior and limitations](docs/GATEWAY.md) for accounting, compatibility and security details. Native AWS Bedrock text chat and streaming use IAM with Converse. SSO, customer billing and multiple gateway replicas are not implemented.

## Start with Docker

Docker with Compose is the only host dependency. To run the current source:

```sh
git clone https://github.com/younesh11/gate-llm.git
cd gate-llm
./scripts/start.sh
```

Open **http://localhost:4310** and create your owner account. The script creates a private `.env` if missing, builds the image and waits for readiness. Existing configuration and persistent data are preserved.

**Different port?** Set `GATE_PORT=8080` in `.env`, then run `./scripts/start.sh` again. The dashboard and API use the same port. Keep `GATE_BIND=127.0.0.1` for local access or an SSH tunnel.

Prefer the standard commands? Run `cp .env.example .env`, `chmod 600 .env`, edit the settings, then `docker compose up --build -d --wait`. Stop with `docker compose down`; **do not add `-v`**, which deletes stored data.

This command preserves the existing SQLite setup. For a new PostgreSQL installation from source, use `./scripts/start.sh --postgres`; it generates `.env.postgres` and starts GATE plus PostgreSQL with separate persistent volumes. For published images, optional AWS credentials and remote access, see [installation](docs/INSTALLATION.md).

## Install a release package

**The 0.3.0 source is available through the Git tag; build it with Docker above or package it locally. A Git push does not publish npm/PyPI packages or a container image.**

The older [v0.2.2 release](https://github.com/younesh11/gate-llm/releases/tag/v0.2.2) has public npm and Python downloads with checksums. You do not need a registry account to install them. Those older downloads do not include the 0.3.0 features. Publication under the short `gate-llm` name on npm/PyPI is still pending.

```sh
# npm — Node.js 22.13+ required (24 LTS recommended)
npm install -g https://github.com/younesh11/gate-llm/releases/download/v0.2.2/gate-llm-0.2.2.tgz

# Or pip, inside a virtual environment — Python 3.10+ AND Node.js required
python -m pip install https://github.com/younesh11/gate-llm/releases/download/v0.2.2/gate_llm-0.2.2-py3-none-any.whl

# Either installation provides the same command:
gate-llm serve --port 4310
```

The pip package bundles the gateway, dashboard and Node dependencies. It is a Python launcher for the same server, so Node.js must already be installed; npm is not required. Docker includes its own runtime.

Persistent state defaults to `~/.gate-llm`. Use `--data-dir ./data` to keep a source checkout's existing state. Installation, environment variables and future registry commands are documented in [Installation](docs/INSTALLATION.md) and [Configuration](docs/CONFIGURATION.md).

## Connect a model

1. Add a provider with an OpenAI-compatible base URL and credential.
2. Add a deployment with its real model ID, your chosen alias and input/output prices.
3. Create and test a policy in **Guardrails**, then select it when creating a virtual key with allowed aliases and allowances. You can also use **Guardrails → Assign to key** for an existing key.
4. Use the playground, or point your application at the gateway's `/v1` endpoint.

```sh
curl http://127.0.0.1:4310/v1/chat/completions \
  -H "Authorization: Bearer YOUR_VIRTUAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"team-chat","messages":[{"role":"user","content":"Hello"}],"max_tokens":512,"stream":true}'
```

The API's standard `max_tokens` means output tokens. GATE's per-key maximum and optional `max_total_tokens` request field apply to estimated input + output. Configured model prices determine cost accounting; the dashboard is not a provider invoice.

## Development and demo

```sh
npm ci
npm run build
npm start -- --data-dir ./data

# Development: run these in separate terminals
npm run dev
npm run dev:ui

# Isolated simulated-provider demo (stop any server on 4310 first)
npm run demo
```

The demo uses `data/demo`, a simulated upstream on port 4311 and the public demo login `demo@relay.local` / `relay-local-demo`. It makes no paid API calls. Keep the demo local and separate from real provider credentials.

```sh
npm test
npm run test:python
npm run check:version
npm run pack:release
npm run check:package
npm run test:package
```

## Documentation

- [Installation](docs/INSTALLATION.md) and [configuration](docs/CONFIGURATION.md)
- [Gateway features, API behavior and limits](docs/GATEWAY.md)
- [Member access and approval flow](docs/MEMBER_ACCESS.md) (included in 0.3.0)
- [Native AWS Bedrock text chat and streaming](docs/BEDROCK.md) (included in 0.3.0)
- [AWS model catalog setup](docs/AWS_CATALOG.md) (included in 0.3.0)
- [Architecture](docs/ARCHITECTURE.md)
- [Upgrades, backups and migration](docs/UPGRADING.md)
- [Backup, restore and password recovery](docs/RECOVERY.md), including Docker examples
- [Versioning and publication](docs/RELEASING.md)
- [Changelog](CHANGELOG.md), [contributing](CONTRIBUTING.md) and [security](SECURITY.md)

Licensed under the [MIT license](LICENSE).

### Invitations and notifications

Invite members from **Team**, let them set their own passwords, and review their allowance requests. **Settings → Notifications** controls budget and combined-token alerts; the notification bell shows each person’s private inbox. Optional SES email and SNS administrator alerts use a durable delivery queue. See [Invitations and notifications](docs/NOTIFICATIONS.md) for configuration, security and delivery guarantees.
