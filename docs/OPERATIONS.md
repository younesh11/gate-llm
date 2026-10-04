# Operating a single GATE instance

Version 0.2.1 is the first production-foundations increment: restart ownership, readiness and private operational logging. HTTPS deployment hardening, account recovery, automated backup/restore drills, metrics/alerts and sustained load testing remain work to complete before a production-readiness claim.

## Liveness and readiness

| Endpoint | Success | Failure / scope |
| --- | --- | --- |
| `GET /health` | HTTP 200, `status: ok`, application version | The HTTP process responds. It does not inspect storage or providers. |
| `GET /ready` | HTTP 200, `status: ready`, `checks.database: ok` | HTTP 503 when the database query fails or shutdown is underway. |

Both endpoints are unauthenticated, return `Cache-Control: no-store` and contain no configuration, paths or credentials. Docker's health check uses `/ready`. Successful probe requests do not produce completion logs. A fresh installation can be ready before an owner or provider is configured: readiness means the service can read its workspace, not that a particular model request will succeed. It does not test disk capacity, write durability or upstream availability, and makes no billable provider calls.

## Logs and request IDs

Set `LOG_LEVEL=info` (default) or `--log-level info`. Supported levels are `silent`, `fatal`, `error`, `warn`, `info`, `debug`, `trace`. CLI wins over environment. Output is structured JSON on stdout; Node runtime warnings may appear on stderr. Higher verbosity never enables prompt capture. At `warn` or above, successful request/startup records are filtered out.

Every HTTP request receives a gateway-generated UUID in `x-request-id`. Caller-supplied request IDs are ignored. For proxy requests, the same ID identifies the dashboard's stored request row, HTTP completion log and gateway settlement log.

| Event | Useful fields |
| --- | --- |
| `gateway_started` / `gateway_draining` | Startup address or shutdown transition |
| `http_request_completed` | `request_id`, method, route **template**, status, duration in milliseconds |
| `request_failed` | `request_id`, safe error classification; raw error message/stack omitted |
| `gateway_request_settled` | `request_id`, key/deployment IDs, outcome, attempts, tokens, microdollar cost and whether usage was estimated |
| `gateway_settlement_failed` | Accounting could not be persisted; investigate storage and retained reservations |
| `readiness_failed` | Database readiness check failed |

Streaming can return HTTP 200 before a later provider failure. Use the `gateway_request_settled` outcome and `http_status`, rather than just HTTP completion status, to identify these failures. An estimated charge means reported usage was unavailable; it is not an exact provider invoice. Some failures before request admission have an HTTP/error log but no gateway settlement record.

Logging intentionally excludes prompts, completions, tools/arguments, passwords, provider/virtual keys, cookies, headers, raw URL paths/query strings, user email, and raw error messages/stacks. Pino serializers and field redaction enforce this for request/response/error serialization. The gateway only emits selected operational fields. Keep logs private and configure retention/rotation in your host or container log collector; built-in export, Prometheus and OpenTelemetry are not implemented in this release.

## Ownership and crash recovery

GATE holds an exclusive transaction on a separate `process-lock.sqlite` database for its lifetime. This prevents another instance from taking the same data directory without holding a long transaction on the application database. The operating system releases the lock when the process dies, even after SIGKILL; a reused container PID does not establish ownership.

Never unlink `process-lock.sqlite` while any instance may be running. Removing an open lock file could create independent owners. Use local persistent storage with working SQLite filesystem locks; this is not a distributed lease or an HA design. The `process.lock` text marker protects against accidentally starting an older GATE version alongside the new one. Legacy upgrade instructions are in [upgrading](UPGRADING.md).

After an abrupt stop, unfinished reservations become estimated charges once, preserving conservative money/token accounting. Normal shutdown allows accepted requests to finish. The integration suite starts a real child gateway, refuses a concurrent owner, kills it, and verifies recovery and accounting. CI additionally kills/restarts a disposable container using a persisted volume. These tests do not replace backup/restore drills or sustained load tests.

## Troubleshooting

1. A 503 from `/ready`: inspect `readiness_failed` and storage permissions/availability. Do not redirect traffic to the same failing instance.
2. A failed model request: use its `x-request-id` to find the HTTP/error and settlement events, then inspect the matching dashboard request.
3. A gateway that refuses startup: stop the other owner; do not delete the SQLite lock database. Follow the explicit legacy-marker procedure only during an older-version upgrade.
4. A `gateway_settlement_failed` event: investigate storage before resuming traffic. Unresolved reservations remain for conservative recovery; do not clear them by hand.

Back up the entire stopped data directory, including `relay.sqlite`, its WAL files and `encryption.key`. Backups are sensitive and must stay out of Git and release artifacts.
