# PostgreSQL setup and migration

Tested with PostgreSQL 16 and 18. The application can use PostgreSQL for users, sessions, providers, deployments, policies, virtual keys, team permissions, allowances, reservations and usage. This is an **single-gateway implementation included in 0.3.0**. It has not been qualified for thousands of concurrent requests. SQLite remains available for existing installations and demos.

## Start a new Docker installation

From a source checkout:

```sh
./scripts/start.sh --postgres
```

The script creates `.env.postgres` with permissions `0600` and a generated database password, builds GATE, starts PostgreSQL 18, waits for readiness and prints the dashboard URL. Create your owner account in the browser. No default login is installed.

Change `GATE_PORT=4310` in `.env.postgres` to choose the host port, then run the command again. The dashboard and API share that port. `GATE_BIND=127.0.0.1` keeps access local by default; use an HTTPS reverse proxy for remote access and set `COOKIE_SECURE=true`.

```sh
# Logs and graceful shutdown (data is retained)
docker compose --env-file .env.postgres -f compose.postgres.yaml logs -f relay
docker compose --env-file .env.postgres -f compose.postgres.yaml down
```

PostgreSQL has no published host port. Traffic to it uses the private Compose network with explicitly disabled TLS. Two named volumes persist the database and GATE's `encryption.key`. Both are required for recovery. These volumes and the Compose project are separate from the SQLite setup. Do not delete volumes with `down -v`. Do not change `POSTGRES_PASSWORD` after initialization without also changing the database role password.

## Existing or managed PostgreSQL

Use a database dedicated to GATE. The role currently needs permission to create and migrate the `gate_app` schema; separate migration/runtime roles are still planned. Use a direct connection or a session-pooling proxy: transaction pooling is incompatible with the process ownership lock.

```dotenv
GATE_STORAGE=postgres
DATABASE_URL=postgresql://gate:URL_ENCODED_PASSWORD@database.example:5432/gate
DATA_DIR=/private/path/gate-postgres-secrets
DATABASE_SSL_MODE=verify-full
DATABASE_POOL_MAX=10
DATABASE_POOL_WAITING_MAX=100
# If your database uses a private CA:
# DATABASE_SSL_CA_FILE=/private/path/server-ca.pem
```

Start with `gate-llm --env-file /private/path/postgres.env` or `npm start -- --env-file /private/path/postgres.env` from a built checkout. URL-encode special password characters. The URL must not contain query parameters; configure TLS with the variables above. Verified TLS is the default. `DATABASE_SSL_MODE=disable` is an explicit option only for trusted local/private networks.

A URL without `GATE_STORAGE=postgres`, invalid configuration, failed migration, wrong encryption key or unavailable database stops startup. There is no silent SQLite fallback. PostgreSQL uses a separate data directory; selecting a directory containing `relay.sqlite` is refused.

## Import an existing SQLite installation

Schedule downtime and drain/stop the SQLite gateway first. Keep it stopped during cutover. Use the current source build; these commands are not yet part of the published 0.2.2 package.

1. Build with `npm ci && npm run build`.
2. Make a verified SQLite backup (the output directory must be new):

   ```sh
   node build/cli.js backup --data-dir /path/to/sqlite-data --output /private/backups/gate-before-postgres
   node build/cli.js verify-backup --input /private/backups/gate-before-postgres
   ```

3. Configure a new, empty PostgreSQL database in a private env file using the variables above. The target secrets directory must not already exist; its parent must exist.
4. Import explicitly:

   ```sh
   node build/cli.js migrate-sqlite --input /private/backups/gate-before-postgres --data-dir /private/gate-postgres-secrets --env-file /private/postgres.env
   ```

5. Set `DATA_DIR` to that new directory, start GATE with the same PostgreSQL configuration, sign in, and verify providers, models, permissions, keys and usage before admitting application traffic.

The importer requires SQLite schema 8. For an older schema, start and stop this GATE version in SQLite mode before making the backup. It verifies the backup, preserves IDs/password hashes/API-key hashes/provider ciphertext/the matching encryption key and usage, verifies row counts and decryptability, and commits all imported rows in one transaction. Browser sessions are invalidated. Pending reservations are conservatively charged once at the next startup, because an interrupted provider request may already have been billed. The source database and backup are never changed.

A nonempty target is refused. Failure leaves `postgres-import.incomplete` in the new secrets directory, preventing startup. Preserve the error evidence, use a fresh empty target database and a new directory, and repeat from the verified backup; do not remove the marker to bypass a failed import. An interrupted process may have committed before writing its completion marker, so inspect before retrying.

Before accepting PostgreSQL traffic, rollback means restarting the untouched SQLite installation. After accepting traffic, returning to the old snapshot requires reconciling new usage and configuration; it is not a lossless rollback.

## Backup and restore PostgreSQL

The SQLite `backup`/`restore` commands do not back up PostgreSQL. Use PostgreSQL backup tools or your managed database's backup/PITR service, plus a private copy of GATE's matching encryption key. Test restoration before relying on a backup.

For Compose, stop GATE, keep PostgreSQL running, and save both artifacts privately:

```sh
umask 077
mkdir gate-backup
docker compose --env-file .env.postgres -f compose.postgres.yaml stop relay
docker compose --env-file .env.postgres -f compose.postgres.yaml exec -T postgres pg_dump -U gate -d gate -Fc > gate-backup/gate.dump
docker compose --env-file .env.postgres -f compose.postgres.yaml cp relay:/app/data/encryption.key gate-backup/encryption.key
docker compose --env-file .env.postgres -f compose.postgres.yaml start relay
```

Restore the dump with `pg_restore --exit-on-error --no-owner --no-privileges` into a **new, empty** database while GATE is stopped. Restore `encryption.key` to its new `DATA_DIR` with mode `0600` and ownership writable by the gateway (UID 1000 in Docker). Start the same GATE version against the restored database and verify readiness, login, credential decryption and usage. Startup validates the key fingerprint and migration checksum. Restored pending requests are charged conservatively, and restored sessions retain their original expiry unless you invalidate them.

For a lost password, stop the gateway and run `gate-llm reset-password --env-file /private/postgres.env --data-dir /private/gate-postgres-secrets --email owner@example.com`. It prompts privately, changes only that user's password, revokes their sessions and writes an audit event in one transaction. It refuses to run while another GATE process owns the database.

## Current guarantees and limits

- The async pool has bounded waiting and connection/statement/lock/idle-transaction timeouts. No checked-out connection or transaction remains open during provider inference or streaming.
- Short writes serialize through a database advisory transaction lock. Quota checks, reservations and permission changes cannot interleave inside admission; settlement is atomic. This conservative serialization is a throughput limit to replace with per-account locking in the next stage.
- A pinned PostgreSQL session lock allows one gateway process per database. Each application transaction also validates an ownership token and the live advisory lock. Losing ownership fences further database operations until restart; readiness returns 503. Startup recovery occurs only after acquiring ownership. Do not scale replicas yet.
- One pool slot is reserved for ownership; `DATABASE_POOL_MAX` must be 2–100. The application keeps numeric balances within JavaScript's exact integer range using database constraints and checked decoding. Money is integer microdollars; model prices retain the existing floating-point configuration representation.
- Existing per-key concurrency (8) and per-origin connection (16) limits remain. Redis coordination, durable distributed leases, per-period quota buckets, exact decimal pricing, separate migration roles and measured load/failure qualification are outstanding.
- The older `gate_core` bigint quota primitives remain isolated experiments. Runtime data lives in `gate_app`; there is no dual ledger or background synchronization between schemas.

Run `npm test`, `npm run test:postgres` and `node scripts/smoke-compose.mjs --postgres` for regression, real database and deployment checks. Test runners use disposable synthetic state, not `DATABASE_URL` or existing local data. These checks establish functionality and selected failure behavior, not production capacity.
