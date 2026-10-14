import { Pool, type PoolClient, type QueryResultRow } from 'pg';

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

/** Async PostgreSQL foundation. Not yet wired into the SQLite application handlers. */
export class PostgresDatabase {
  private readonly pool: Pool;
  private readonly maxWaiting: number;
  private closed = false;
  constructor(options: PostgresOptions) {
    let url: URL;
    try { url = new URL(options.url); } catch { throw new StorageError('invalid'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1) || url.search || url.hash) throw new StorageError('invalid');
    if (options.localPlaintext && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new StorageError('invalid');
    this.maxWaiting = bounded(options.maxWaiting ?? 100, 0, 1000);
    this.pool = new Pool({
      connectionString: options.url,
      ssl: options.localPlaintext ? false : { rejectUnauthorized: true, ...(options.ca ? { ca: options.ca } : {}) },
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
      try { return (await client.query<R>(text, values)).rows; } catch (error) { throw safeError(error); }
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
      if (error instanceof StorageError || (error instanceof Error && error.name === 'QuotaError')) throw error;
      throw safeError(error);
    } finally { active = false; client.release(broken); }
  }
  async ready() { await this.transaction(async tx => { await tx.query('SELECT 1'); }); }
  async close() { if (!this.closed) { this.closed = true; await this.pool.end(); } }
}
