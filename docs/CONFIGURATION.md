# Configuration

CLI flags override environment variables. Existing environment variables take precedence over values loaded from .env. An explicit --env-file is supported; otherwise an existing .env in the working directory is loaded. Provider credentials belong in the dashboard's encrypted store.

| Environment | CLI | Default | Meaning |
|---|---|---|---|
| HOST | --host | 127.0.0.1 | Listener address; Docker sets 0.0.0.0 internally |
| PORT | --port | 4310 | Dashboard and API port |
| DATA_DIR | --data-dir | ~/.gate-llm | Persistent database, encryption key and process lock |
| COOKIE_SECURE | --secure-cookie | false | HTTPS-only session cookie |
| ALLOW_PRIVATE_UPSTREAMS | --allow-private-upstreams | false | Permit local/private provider endpoints |
| ALLOW_REMOTE_SETUP | --allow-remote-setup | false | Permit first-owner setup beyond loopback |
| GATE_RUNTIME_DIR | — | ~/.cache/gate-llm | Python launcher's unpacked runtime cache only |
| GATE_PORT | — | 4310 | Compose host port; distinct from container PORT |
| GATE_IMAGE | — | gate-llm:0.1.0 | Compose image reference |

Boolean environment values must be exactly `true` to enable an option. CLI flags enable the corresponding option. `gate-llm --help` and `--version` do not start the server.

A virtual key's daily/monthly/lifetime allowance is separate from its combined input + output maximum per request. Prices are USD per million tokens. Zero prices mean zero local spend, even when a provider charges you. The dashboard labels unreported usage as estimated/unsplit.

Model access uses aliases configured in Models & routing. Every deployment under the same alias is eligible for its weighted share while enabled and outside cooldown. A key must explicitly allow the alias. Bedrock models that require Converse/IAM cannot be configured as ordinary compatible endpoints in this release.
