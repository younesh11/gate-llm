import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { HttpError } from '../store.ts';

export class StorageError extends Error {
  constructor(public readonly code: 'unavailable' | 'busy' | 'conflict' | 'invalid' | 'internal') {
    super(`PostgreSQL storage ${code}.`);
  }
}
export interface SqlTransaction {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<T[]>;
}
export type PostgresOptions = {
  url: string;
  maxConnections?: number;
  maxWaiting?: number;
  // Explicit opt-in for local development only; TLS verification is otherwise required.
  localPlaintext?: boolean;
  ca?: string;
  // Explicit opt-in for a private Compose network; never inferred from a URL.
  privateNetworkPlaintext?: boolean;
  safeNumbers?: boolean;
};
function safeError(error: unknown) {
  if (error instanceof StorageError) return error;
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (['40001', '40P01', '23505'].includes(code)) return new StorageError('conflict');
  if (['57014', '55P03', '53300'].includes(code)) return new StorageError('busy');
  if (code.startsWith('23') || code.startsWith('22')) return new StorageError('invalid');
  return new StorageError('unavailable');
}
function bounded(value: number, min: number, max: number) {
  if (!Number.isInteger(value) || value < min || value > max) throw new StorageError('invalid');
  return value;
}

/** Bounded async pool shared by application storage and quota primitives. */
export class PostgresDatabase {
  private readonly pool: Pool;
  private readonly maxWaiting: number;
  private closed = false;
  private readonly safeNumbers: boolean;
  constructor(options: PostgresOptions) {
    this.safeNumbers = !!options.safeNumbers;
    let url: URL;
    try { url = new URL(options.url); } catch { throw new StorageError('invalid'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1) || url.search || url.hash) throw new StorageError('invalid');
    if (options.localPlaintext && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new StorageError('invalid');
    this.maxWaiting = bounded(options.maxWaiting ?? 100, 0, 1000);
    this.pool = new Pool({
      connectionString: options.url,
      ssl: options.localPlaintext || options.privateNetworkPlaintext ? false : { rejectUnauthorized: true, ...(options.ca ? { ca: options.ca } : {}) },
      max: bounded(options.maxConnections ?? 10, 1, 100),
      connectionTimeoutMillis: 2000, idleTimeoutMillis: 10000,
      statement_timeout: 5000, lock_timeout: 2000, idle_in_transaction_session_timeout: 5000,
      application_name: 'gate-llm',
    });
    // Idle socket failures must not crash the process or expose a credential-bearing error.
    this.pool.on('error', () => {});
  }
  stats() { return { total: this.pool.totalCount, idle: this.pool.idleCount, waiting: this.pool.waitingCount }; }
  private async acquire() {
    if (this.closed) throw new StorageError('unavailable');
    if (this.pool.idleCount === 0 && this.pool.totalCount >= this.pool.options.max! && this.pool.waitingCount >= this.maxWaiting) throw new StorageError('busy');
    try { return await this.pool.connect(); } catch (error) { throw safeError(error); }
  }
  async transaction<T>(operation: (tx: SqlTransaction) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.acquire();
    let broken = false, active = true;
    const tx: SqlTransaction = { query: async <R extends QueryResultRow>(text: string, values?: unknown[]) => {
      if (!active) throw new StorageError('invalid');
      try {
        const result = await client.query<R>(text, values);
        if (this.safeNumbers && result.rows) for (const field of result.fields) {
          if (![20, 1700].includes(field.dataTypeID)) continue;
          for (const row of result.rows) {
            const value = row[field.name];
            if (value === null) continue;
            const number = Number(value);
            if (!Number.isFinite(number) || Math.abs(number) > Number.MAX_SAFE_INTEGER || /^-?\d+(\.0+)?$/.test(String(value)) && !Number.isSafeInteger(number)) throw new StorageError('invalid');
            (row as QueryResultRow)[field.name] = number;
          }
        }
        return result.rows;
      } catch (error) { throw safeError(error); }
    } };
    try {
      await client.query('BEGIN');
      const result = await operation(tx);
      const committed = await client.query('COMMIT');
      if (committed.command !== 'COMMIT') throw new StorageError('invalid');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { broken = true; }
      // Domain errors from operation are intentionally preserved; transport errors are sanitized.
      if (error instanceof StorageError || error instanceof HttpError || (error instanceof Error && error.name === 'QuotaError')) throw error;
      throw safeError(error);
    } finally { active = false; client.release(broken); }
  }
  /** Pin a session lock for the single-instance application/recovery owner. */
  async exclusiveSession(lockId: number, onLost: () => void) {
    const client = await this.acquire();
    let released = false, backendPid = 0;
    const lost = () => { onLost(); };
    client.on('error', lost);
    try {
      const result = await client.query('SELECT pg_try_advisory_lock($1) AS acquired, pg_backend_pid() AS pid', [lockId]);
      backendPid = result.rows[0].pid;
      if (!result.rows[0].acquired) throw new StorageError('conflict');
    } catch (error) { client.removeListener('error', lost); client.release(true); throw safeError(error); }
    return {
      backendPid,
      ping: async () => { try { await client.query('SELECT 1'); } catch { onLost(); throw new StorageError('unavailable'); } },
      close: () => { if (!released) { released = true; client.removeListener('error', lost); client.release(true); } }
    };
  }
  async ready() { await this.transaction(async tx => { await tx.query('SELECT 1'); }); }
  async close() { if (!this.closed) { this.closed = true; await this.pool.end(); } }
}
