# PostgreSQL foundation — development increment

Implemented locally on 2026-10-14. This is an internal storage foundation, **not a PostgreSQL-backed gateway release**. The running dashboard, authentication, model routing and existing usage continue to use SQLite. Setting `DATABASE_URL` does not switch the gateway to PostgreSQL. No user data has been migrated.

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

## Required before production use

1. Port identity/configuration, authorization and every gateway/admin/reporting handler to async repositories. Introduce explicit production configuration; never silently fall back to SQLite on PostgreSQL failure.
2. Complete the schema and controlled SQLite migration, including encryption-key handling, existing balances, attribution, backup/restore and maintenance commands. Existing workspace IDs include `default`; map them explicitly because the new internal schema uses UUIDs.
3. Wire admission/settlement into the real request path. Add owner-controlled quota mutations, calendar-period selection, expiry/revocation, route/policy/pricing snapshots and corresponding race tests.
4. Add lease ownership/fencing and idempotent crash recovery before allowing multiple live gateways. Pending reservations in this foundation are deliberately not recovered automatically.
5. Add shared rate/concurrency controls, provider pool configuration, overload rejection and operational metrics. The current gateway's eight-per-key and 16-per-origin limits remain unchanged.
6. Finish Docker production configuration, separate migration/runtime identities, TLS and secret rotation, and the measured [production qualification gates](PRODUCTION_PLAN.md).

There is deliberately no public API or end-user switch exposing this incomplete storage path yet.
