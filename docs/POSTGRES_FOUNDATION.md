# PostgreSQL foundation — development increment

The initial internal bigint quota prototype is described below. The application is now connected to PostgreSQL through the separate `gate_app` schema; see [PostgreSQL setup, migration and current limits](POSTGRESQL.md). The prototype's `gate_core` schema is not the runtime ledger. No existing installation is switched or migrated automatically.

## Implemented

- `server/postgres/database.ts`: asynchronous pooled connections; checked-out connection for each transaction; bounded waiting, connection/statement/lock/idle-transaction timeouts; verified TLS by default; explicit loopback-only plaintext for development; sanitized database errors and pool shutdown.
- `server/postgres/migrations.ts`: transactional, checksummed migrations serialized with a transaction-scoped advisory lock. Unknown future or edited migration versions are rejected. An independent `gate_core` schema currently contains quota accounts, reservations, attributed holds and a usage ledger.
- `server/postgres/quotas.ts`: internal quota-account creation, atomic reservation across key/member accounts, workspace checks, fixed lock order and idempotent settlement. All money and token arithmetic uses bigint; money is in microdollars. Actual usage above an estimate is recorded rather than silently capped.
- Replays return `created: false`; they must never authorize a second provider call. Reusing a request ID with different input or a different settlement is rejected. These primitives do not authenticate users or select their account/period: the future application repository must enforce those responsibilities.

No transaction or database connection is retained for the duration of inference. PostgreSQL remains the authoritative reservation/usage store; a future Redis layer must not become the money ledger.

## Reproduce the checks

```sh
npm ci
docker pull postgres:18-alpine
npm run test:postgres
```

The test runner creates a uniquely named disposable PostgreSQL container with a generated password, an ephemeral loopback port and temporary data. It stops the container afterward. It never reads `DATABASE_URL` or touches existing SQLite state. CI runs the same tests. No paid model requests are made.

The tests exercise concurrent migrations, transaction rollback/lifetime, 100 competing reservations through two independent pools against one application key plus one member budget, duplicate admission and settlement, workspace boundaries, disabled accounts, independent token limits, exact bigint values, excess actual usage, bounded pool waiting and migration-history validation. This is database correctness evidence, not a gateway throughput or multi-replica certification.

## Next production stages

The application now has async storage, PostgreSQL configuration, single-instance ownership/recovery, Docker setup and a verified SQLite-backup importer. Application IDs remain text, preserving existing workspaces without UUID remapping. The earlier primitives above are not wired to the HTTP request path; current runtime admission and settlement operate atomically on the application schema.

Next: replace serialized writes and history sums with per-account/period repositories, integrate exact bigint/decimal accounting throughout the API, add distributed leases and shared rate/concurrency controls, test backup restore and failure modes operationally, separate migration/runtime identities, and pass the measured [production qualification gates](PRODUCTION_PLAN.md). Multiple live gateways remain explicitly prohibited until their recovery and coordination model is implemented.
