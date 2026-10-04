# GATE

**Gateway for AI Traffic & Enforcement**

A small, independent, self-hosted LLM gateway for you and your team. One endpoint for your models, a dashboard for your keys and usage, and limits enforced before requests reach a provider. Built with TypeScript, Fastify, React and SQLite; no LiteLLM dependency.

**Version 0.2.1 · MIT license · Single instance**

## Features

- **Virtual keys:** create, rotate, revoke, expire, assign to team members and restrict allowed model aliases.
- **Allowances:** money, combined input + output tokens, both, or neither; lifetime, daily or monthly periods.
- **Request limits:** combined input + output ceiling, requests per minute, tokens per minute and concurrent request limits.
- **Proxy and routing:** OpenAI-compatible chat completions, JSON/SSE streaming, weighted load balancing, cooldowns and fallback on explicit HTTP 429 responses.
- **Input guardrails:** reusable per-key policies, a local policy tester, normalized blocked terms, selected secret detection and configurable pattern-based PII redaction.
- **Playground and analytics:** streaming chat, token and spend breakdowns by key/member/application, request history and audit records.
- **Team access:** owner/viewer accounts, hashed virtual keys and encrypted provider credentials.

Operational JSON logs, generated request IDs, database readiness and crash-released ownership are covered in [operations](docs/OPERATIONS.md). This is an internal beta; the first foundations increment does not establish full production readiness.

See [gateway behavior and limitations](docs/GATEWAY.md) for accounting, compatibility and security details. Native AWS Bedrock IAM/Converse, SSO, customer billing and multiple gateway replicas are not implemented in 0.2.1.

## Start with Docker

The public image supports Linux AMD64 and ARM64. From this source directory:

```sh
GATE_IMAGE=ghcr.io/younesh11/gate-llm:0.2.1 docker compose up -d --no-build --pull always
```

To build the image yourself instead, run `docker compose up --build -d`.

Open **http://127.0.0.1:4310** and create your owner account. Data persists in a named volume. If port 4310 is occupied, prefix the command with `GATE_PORT=4313`. The container runs as a non-root user and publishes to host loopback by default.

## Install a release package

The [v0.2.1 release](https://github.com/younesh11/gate-llm/releases/tag/v0.2.1) has public npm and Python downloads with checksums. You do not need a registry account to install them. Publication under the short `gate-llm` name on npm/PyPI is still pending.

```sh
# npm — Node.js 22.13+ required (24 LTS recommended)
npm install -g https://github.com/younesh11/gate-llm/releases/download/v0.2.1/gate-llm-0.2.1.tgz

# Or pip, inside a virtual environment — Python 3.10+ AND Node.js required
python -m pip install https://github.com/younesh11/gate-llm/releases/download/v0.2.1/gate_llm-0.2.1-py3-none-any.whl

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
- [Architecture](docs/ARCHITECTURE.md)
- [Upgrades, backups and migration](docs/UPGRADING.md)
- [Versioning and publication](docs/RELEASING.md)
- [Changelog](CHANGELOG.md), [contributing](CONTRIBUTING.md) and [security](SECURITY.md)

Licensed under the [MIT license](LICENSE).
