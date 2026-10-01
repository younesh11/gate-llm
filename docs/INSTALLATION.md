# Installation

GATE means Gateway for AI Traffic & Enforcement. The package name is `gate-llm`; the command is `gate-llm`. Version 0.1.0 is available as a public Docker image and [GitHub release downloads](https://github.com/younesh11/gate-llm/releases/tag/v0.1.0). Short-name installation from npm/PyPI is still pending.

## Docker Compose (no Node or Python installation needed)

From the project directory:

```sh
docker compose up --build -d
docker compose logs -f relay
```

Open http://127.0.0.1:4310 and create an owner. If that port is occupied, use `GATE_PORT=4313 docker compose up --build -d`. The named `relay-data` volume contains the database and encryption key. `docker compose down` preserves it; `docker compose down -v` deletes it. Never use `-v` for an upgrade.

The container listens on 0.0.0.0 internally, while Compose publishes to host loopback only. It runs as UID 1000 with dropped capabilities and a read-only root filesystem. Use a named volume, or make bind-mounted state writable by UID 1000.

To use the published image instead of building locally:

```sh
GATE_IMAGE=ghcr.io/younesh11/gate-llm:0.1.0 docker compose up -d --no-build --pull always
```

The image is public and supports Linux AMD64 and ARM64. No Docker Hub or GitHub account is needed to pull it. For reproducible deployment, pin a tested digest. The Dockerfile's NODE_IMAGE build argument can also pin the Node base image by digest.

## npm

Requires Node.js 22.13+; use Node.js 24 LTS.

```sh
# Install the public GitHub release now:
npm install -g https://github.com/younesh11/gate-llm/releases/download/v0.1.0/gate-llm-0.1.0.tgz
gate-llm serve --port 4310

# Locally built release:
npm run pack:release
npm install -g ./artifacts/npm/gate-llm-0.1.0.tgz
```

The npm archive includes compiled JavaScript, the dashboard and runtime dependencies. TypeScript and build tools are not required on the target machine. No install script starts a server or creates an account.

## pip / pipx

Requires Python 3.10+ and Node.js 22.13+ (24 LTS recommended). This is a launcher for the Node application, not a rewritten Python server or a Python SDK. Server dependencies are bundled and first startup does not download code.

```sh
# Install the public GitHub release, preferably in a virtual environment:
python -m pip install https://github.com/younesh11/gate-llm/releases/download/v0.1.0/gate_llm-0.1.0-py3-none-any.whl
gate-llm serve --port 4310

# Alternatively, isolate the launcher:
pipx install https://github.com/younesh11/gate-llm/releases/download/v0.1.0/gate_llm-0.1.0-py3-none-any.whl

# Locally built wheel:
python -m pip install ./artifacts/python/gate_llm-0.1.0-py3-none-any.whl
```

Choose either pip or npm for the command in a given environment to avoid PATH ambiguity. The Python wrapper extracts a checksum-verified runtime to `~/.cache/gate-llm`; `GATE_RUNTIME_DIR` overrides the cache. Runtime cache and application data must remain separate.

After registry publication, the short forms will be `npm install -g gate-llm@0.1.0` and `python -m pip install gate-llm==0.1.0`. Until then, use the verified release URLs above.

## Source checkout

```sh
npm ci
npm run build
npm start -- --data-dir ./data
```

With no explicit data path, the CLI uses `~/.gate-llm`. Existing Relay data is never moved automatically; point `--data-dir` at it to continue using the same users, credentials and history. Relative paths are resolved from your current directory; dashboard assets are resolved from the installed package.

## First use

1. Create your private owner account in the dashboard.
2. Add an OpenAI-compatible provider, its base URL and credential.
3. Add a deployment with a model ID, alias and accurate input/output prices.
4. Create a virtual key with allowed aliases, guardrails and limits.
5. Use the key in the playground or your client.
