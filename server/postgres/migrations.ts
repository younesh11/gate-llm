import { createHash } from 'node:crypto';
import { PostgresDatabase, StorageError } from './database.ts';

// Independent, versioned accounting schema. Identity/configuration port comes next.
const initial = `
CREATE TABLE gate_core.quota_accounts (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL, principal_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('key','member')), period_start timestamptz NOT NULL,
  budget bigint CHECK (budget >= 0), token_limit bigint CHECK (token_limit >= 0),
  spent bigint NOT NULL DEFAULT 0 CHECK (spent >= 0), tokens_used bigint NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
  reserved bigint NOT NULL DEFAULT 0 CHECK (reserved >= 0), tokens_reserved bigint NOT NULL DEFAULT 0 CHECK (tokens_reserved >= 0),
  enabled boolean NOT NULL DEFAULT true,
  UNIQUE(workspace_id, kind, principal_id, period_start), UNIQUE(workspace_id,id)
);
CREATE TABLE gate_core.reservations (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL, fingerprint text NOT NULL,
  status text NOT NULL CHECK(status IN ('reserved','settled')),
  money bigint NOT NULL CHECK(money >= 0), tokens bigint NOT NULL CHECK(tokens >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(workspace_id,id)
);
CREATE TABLE gate_core.holds (
  workspace_id uuid NOT NULL, reservation_id uuid NOT NULL, account_id uuid NOT NULL,
  PRIMARY KEY(reservation_id,account_id),
  FOREIGN KEY(workspace_id,reservation_id) REFERENCES gate_core.reservations(workspace_id,id),
  FOREIGN KEY(workspace_id,account_id) REFERENCES gate_core.quota_accounts(workspace_id,id)
);
CREATE TABLE gate_core.usage_ledger (
  request_id uuid PRIMARY KEY REFERENCES gate_core.reservations(id),
  cost bigint NOT NULL CHECK(cost >= 0), tokens bigint NOT NULL CHECK(tokens >= 0),
  estimated boolean NOT NULL, settled_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX quota_holds_account ON gate_core.holds(account_id);
CREATE INDEX pending_reservations ON gate_core.reservations(created_at) WHERE status='reserved';
`;
const migrations = [{ version: 1, sql: initial }];
export async function migratePostgres(db: PostgresDatabase) {
  await db.transaction(async tx => {
    // Serializes migrations across deploys; transaction-scoped, released on crash/rollback.
    await tx.query('SELECT pg_advisory_xact_lock($1)', [719430102]);
    await tx.query('CREATE SCHEMA IF NOT EXISTS gate_core');
    await tx.query('CREATE TABLE IF NOT EXISTS gate_core.schema_migrations (version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())');
    const applied = await tx.query<{ version: number; checksum: string }>('SELECT version,checksum FROM gate_core.schema_migrations ORDER BY version');
    if (applied.some((row, index) => row.version !== index + 1 || !migrations.some(m => m.version === row.version))) throw new StorageError('invalid');
    for (const migration of migrations) {
      const checksum = createHash('sha256').update(migration.sql).digest('hex');
      const existing = applied.find(row => row.version === migration.version);
      if (existing) { if (existing.checksum !== checksum) throw new StorageError('invalid'); continue; }
      await tx.query(migration.sql);
      await tx.query('INSERT INTO gate_core.schema_migrations(version,checksum) VALUES($1,$2)', [migration.version,checksum]);
    }
  });
}
