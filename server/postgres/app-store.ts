import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { DirectoryLock } from '../directory-lock.ts';
import { AppStore } from '../storage.ts';
import type { Row } from '../store.ts';
import { PostgresDatabase, StorageError, type PostgresOptions, type SqlTransaction } from './database.ts';
import { applicationMigrations } from './app-schema.ts';

const ownershipLock = 719430103;
const writeLock = 719430104;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

// Only trusted application SQL enters this adapter. Values always use parameters.
export function postgresSql(sql: string) {
  let index = 0;
  return sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\?|\bMAX\s*\(|\bwindow\b/gi, token => {
    if (token === '?') return `$${++index}`;
    if (/^MAX\s*\(/i.test(token)) return 'GREATEST(';
    if (token.toLowerCase() === 'window') return '"window"';
    return token;
  });
}

export class PostgresAppStore extends AppStore {
  readonly backend = 'postgres' as const;
  private readonly scope = new AsyncLocalStorage<SqlTransaction>();
  private readonly database: PostgresDatabase;
  private lock?: DirectoryLock;
  private owner?: Awaited<ReturnType<PostgresDatabase['exclusiveSession']>>;
  private encryptionKey!: Buffer;
  private fenced = false;
  private readonly ownerToken = randomUUID();
  private closed = false;
  private active = new Set<Promise<unknown>>();
  private constructor(readonly directory: string, options: PostgresOptions) {
    super();
    if ((options.maxConnections ?? 10) < 2) throw new StorageError('invalid');
    this.database = new PostgresDatabase({ ...options, safeNumbers: true });
  }
  static async open(directory: string, options: PostgresOptions, importing = false) {
    const store = new PostgresAppStore(directory, options);
    try { await store.initialize(importing); return store; }
    catch (error) { await store.close(); throw error; }
  }
  private async initialize(importing: boolean) {
    if (!importing && existsSync(join(this.directory, 'postgres-import.incomplete'))) throw new Error('PostgreSQL import did not complete. Follow docs/POSTGRESQL.md before starting.');
    if (['relay.sqlite', 'backup-manifest.json', 'restore.incomplete'].some(file => existsSync(join(this.directory, file)))) {
      throw new Error('PostgreSQL requires a separate DATA_DIR. Existing SQLite data must be migrated explicitly.');
    }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    this.lock = new DirectoryLock(this.directory);
    this.owner = await this.database.exclusiveSession(ownershipLock, () => { this.fenced = true; });
    await this.database.transaction(async tx => {
      await tx.query('CREATE SCHEMA IF NOT EXISTS gate_app');
      await tx.query('SET LOCAL search_path = gate_app, pg_catalog');
      await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, key_fingerprint TEXT NOT NULL)');
      const versions = await tx.query('SELECT * FROM schema_migrations ORDER BY version');
      if (versions.length > applicationMigrations.length || versions.some((v, i) => v.version !== i + 1 || v.checksum !== digest(applicationMigrations[i]))) throw new StorageError('invalid');
      const keyPath = join(this.directory, 'encryption.key');
      if (!existsSync(keyPath)) {
        if (versions.length) throw new StorageError('invalid');
        writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
      }
      this.encryptionKey = readFileSync(keyPath);
      if (this.encryptionKey.length !== 32 || versions.some(v => v.key_fingerprint !== digest(this.encryptionKey))) throw new StorageError('invalid');
      chmodSync(keyPath, 0o600);
      for (let i = versions.length; i < applicationMigrations.length; i++) {
        await tx.query(applicationMigrations[i]);
        if (i === 0) await tx.query("INSERT INTO workspaces VALUES ('default','My workspace')");
        await tx.query('INSERT INTO schema_migrations VALUES ($1,$2,$3)', [i + 1, digest(applicationMigrations[i]), digest(this.encryptionKey)]);
      }
      await tx.query('INSERT INTO runtime_owner VALUES (1,$1) ON CONFLICT(id) DO UPDATE SET token=excluded.token', [this.ownerToken]);
    });
  }
  private assertAvailable() { if (this.closed || this.fenced) throw new StorageError('unavailable'); }
  private async query(sql: string, params: any[]): Promise<Row[]> {
    this.assertAvailable();
    const tx = this.scope.getStore();
    const execute = async (connection: SqlTransaction) => {
      const rows = await connection.query(postgresSql(sql), params);
      return rows;
    };
    return tx ? execute(tx) : this.read(execute);
  }
  private async read<T>(fn: (tx: SqlTransaction) => Promise<T>): Promise<T> {
    const operation = this.database.transaction(async tx => {
      this.assertAvailable();
      await tx.query('SET LOCAL search_path = gate_app, pg_catalog');
      // Validate through the application connection too: a dead/partitioned ownership
      // socket must not authorize new work on a reconnected pool.
      const [owner] = await tx.query(`SELECT token FROM runtime_owner WHERE id=1 AND EXISTS
        (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=$1 AND objid=$2 AND classid=0 AND objsubid=1 AND granted)`, [this.owner!.backendPid, ownershipLock]);
      if (owner?.token !== this.ownerToken) { this.fenced = true; throw new StorageError('unavailable'); }
      return fn(tx);
    });
    this.active.add(operation);
    try { return await operation; } finally { this.active.delete(operation); }
  }
  all(sql: string, ...params: any[]) { return this.query(sql, params); }
  async run(sql: string, ...params: any[]) {
    if (this.scope.getStore()) return this.query(sql, params);
    return this.transaction(() => this.query(sql, params));
  }
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.assertAvailable();
    if (this.scope.getStore()) throw new StorageError('invalid');
    return this.read(async tx => {
      // Short application writes serialize admission with key/permission changes.
      // Provider calls and streaming run outside this transaction and release the pool slot.
      await tx.query('SELECT pg_advisory_xact_lock($1)', [writeLock]);
      const result = await this.scope.run(tx, fn);
      this.assertAvailable();
      return result;
    });
  }
  seal(value: string) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
  }
  unseal(value: string) {
    const data = Buffer.from(value, 'base64'), decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, data.subarray(0,12));
    decipher.setAuthTag(data.subarray(-16));
    return Buffer.concat([decipher.update(data.subarray(12,-16)), decipher.final()]).toString('utf8');
  }
  async checkReady() { this.assertAvailable(); await this.owner!.ping(); await super.checkReady(); }
  async close() {
    if (this.closed) return;
    this.closed = true;
    // Keep ownership until all application connections have closed.
    await Promise.allSettled(this.active);
    this.owner?.close();
    try { await this.database.close(); } finally { this.lock?.close(); }
  }
}
