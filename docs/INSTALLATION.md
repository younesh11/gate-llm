# Installation

GATE means Gateway for AI Traffic & Enforcement. The package name is `gate-llm`; the command is `gate-llm`. The current source version is 0.3.0; build this checkout for invitations, native Bedrock and PostgreSQL support. Previously published version 0.2.2 is available as a public Docker image and [GitHub release downloads](https://github.com/younesh11/gate-llm/releases/tag/v0.2.2). Short-name installation from npm/PyPI is still pending.

## Docker Compose (no Node or Python installation needed)

From a source checkout, Docker with Compose is the only host prerequisite:

```sh
./scripts/start.sh
```

This creates a mode-600 `.env` if absent, builds the current checkout and waits for the server health check. It never overwrites an existing `.env` or creates demo credentials. Open http://localhost:4310 and create your private owner account.

For a different port, set `GATE_PORT=8080` in `.env` and rerun the script. Leave the container's internal port alone. Both the dashboard and `/v1` API are exposed on your chosen port. A shell environment variable overrides the same name in `.env`.

The equivalent manual flow is:

```sh
cp .env.example .env  # first installation only; do not overwrite existing settings
chmod 600 .env
# Edit GATE_PORT in .env if needed.
docker compose up --build -d --wait
docker compose logs -f relay
```

The named `relay-data` volume contains the database and encryption key. `docker compose down` preserves it; `docker compose down -v` deletes it. Never use `-v` for an upgrade. Keep the same Compose project name/directory to reuse its volume. Back up before updating from published schema 3 to the current source schema 5; older binaries cannot open the upgraded database.

The container listens on 0.0.0.0 internally, while Compose defaults to host loopback (`GATE_BIND=127.0.0.1`). It runs as UID 1000 with dropped capabilities and a read-only root filesystem. Use a named volume, or make bind-mounted state writable by UID 1000. This command starts SQLite. From the source checkout, `./scripts/start.sh --postgres` starts the integrated PostgreSQL application and database, with a generated password, editable port and separate volumes. See [PostgreSQL setup and migration](POSTGRESQL.md). These features are included in 0.3.0 source; existing published 0.2.2 artifacts do not include them.

For a remote server, keep the default binding and use an SSH tunnel for initial owner setup, for example `ssh -L 4310:127.0.0.1:4310 user@server`. For team access, put a configured HTTPS reverse proxy in front, preserve the external Host header and set `COOKIE_SECURE=true`. `GATE_BIND` can select a host interface if necessary; do not expose an uninitialized gateway or send credentials over public HTTP. Compose enables remote first-owner setup internally for container NAT, so the loopback binding is part of the default protection.

Optional AWS catalog credentials can be configured with `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and, for temporary credentials, `AWS_SESSION_TOKEN` in `.env`. Prefer a runtime IAM role on AWS. The `.env` file is excluded from Git and Docker builds. Provider API keys still belong in the dashboard's encrypted store. See [AWS catalog permissions](AWS_CATALOG.md); a host AWS profile is not mounted automatically. The region is selected in the AWS models page; `AWS_REGION` does not lock the picker.

After editing `.env`, rerun `./scripts/start.sh` or `docker compose up -d --wait` to recreate the container with changed settings. `docker compose restart` alone does not reload environment settings. Avoid sharing `docker compose config` output because it can include credentials; `docker compose config --quiet` validates without printing values.

To use the published image instead of building locally:

```sh
GATE_IMAGE=ghcr.io/younesh11/gate-llm:0.2.2 docker compose up -d --no-build --pull always
```

The image is public and supports Linux AMD64 and ARM64. No Docker Hub or GitHub account is needed to pull it. For reproducible deployment, pin a tested digest. The Dockerfile's NODE_IMAGE build argument can also pin the Node base image by digest.

## npm

Requires Node.js 22.13+; use Node.js 24 LTS.

```sh
# Install the public GitHub release now:
npm install -g https://github.com/younesh11/gate-llm/releases/download/v0.2.2/gate-llm-0.2.2.tgz
gate-llm serve --port 4310

# Locally built release:
npm run pack:release
npm install -g ./artifacts/npm/gate-llm-0.3.0.tgz
```

The npm archive includes compiled JavaScript, the dashboard and runtime dependencies. TypeScript and build tools are not required on the target machine. No install script starts a server or creates an account.

## pip / pipx

Requires Python 3.10+ and Node.js 22.13+ (24 LTS recommended). This is a launcher for the Node application, not a rewritten Python server or a Python SDK. Server dependencies are bundled and first startup does not download code.

```sh
# Install the public GitHub release, preferably in a virtual environment:
python -m pip install https://github.com/younesh11/gate-llm/releases/download/v0.2.2/gate_llm-0.2.2-py3-none-any.whl
gate-llm serve --port 4310

# Alternatively, isolate the launcher:
pipx install https://github.com/younesh11/gate-llm/releases/download/v0.2.2/gate_llm-0.2.2-py3-none-any.whl

# Locally built wheel:
python -m pip install ./artifacts/python/gate_llm-0.3.0-py3-none-any.whl
```

Choose either pip or npm for the command in a given environment to avoid PATH ambiguity. The Python wrapper extracts a checksum-verified runtime to `~/.cache/gate-llm`; `GATE_RUNTIME_DIR` overrides the cache. Runtime cache and application data must remain separate.

After registry publication, the short forms will be `npm install -g gate-llm@0.2.2` and `python -m pip install gate-llm==0.2.2`. Until then, use the verified release URLs above.

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
