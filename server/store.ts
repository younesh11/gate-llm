import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHash, createCipheriv, createDecipheriv, scryptSync, timingSafeEqual } from 'node:crypto';

export type Row = Record<string, any>;
export class Store {
  db: DatabaseSync;
  encryptionKey: Buffer;
  lockPath: string;
  constructor(public directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.lockPath = join(directory, 'process.lock');
    if (existsSync(this.lockPath)) {
      const pid = Number(readFileSync(this.lockPath, 'utf8'));
      let alive = true;
      try { process.kill(pid, 0); } catch (error: any) { if (error.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('This data directory is already in use. Run one gateway instance per directory.');
      unlinkSync(this.lockPath);
    }
    writeFileSync(this.lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
    const path = join(directory, 'encryption.key');
    if (!existsSync(path) && existsSync(join(directory, 'relay.sqlite'))) {
      unlinkSync(this.lockPath);
      throw new Error('The database exists but its encryption key is missing. Restore the key from your backup.');
    }
    if (!existsSync(path)) writeFileSync(path, randomBytes(32), { mode: 0o600, flag: 'wx' });
    this.encryptionKey = readFileSync(path);
    if (this.encryptionKey.length !== 32) throw new Error('Invalid encryption key. Restore it from your backup.');
    this.db = new DatabaseSync(join(directory, 'relay.sqlite'));
    chmodSync(join(directory, 'relay.sqlite'), 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      INSERT OR IGNORE INTO workspaces VALUES ('default', 'My workspace');
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, base_url TEXT NOT NULL, secret TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deployments (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, provider_id TEXT NOT NULL REFERENCES providers(id), alias TEXT NOT NULL, upstream_model TEXT NOT NULL, weight INTEGER NOT NULL, input_price REAL NOT NULL, output_price REAL NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, failures INTEGER NOT NULL DEFAULT 0, cooldown_until INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS policies (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, blocked_terms TEXT NOT NULL, redact_pii INTEGER NOT NULL, block_secrets INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS virtual_keys (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, owner TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, models TEXT NOT NULL, policy_id TEXT REFERENCES policies(id), budget INTEGER, spent INTEGER NOT NULL DEFAULT 0, reserved INTEGER NOT NULL DEFAULT 0, rpm INTEGER NOT NULL, max_output INTEGER NOT NULL, expires_at TEXT, revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rate_windows (key_id TEXT NOT NULL, window INTEGER NOT NULL, requests INTEGER NOT NULL, PRIMARY KEY(key_id, window));
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, key_id TEXT NOT NULL, key_name TEXT NOT NULL, model TEXT NOT NULL, deployment_id TEXT, status TEXT NOT NULL, http_status INTEGER NOT NULL, latency_ms INTEGER NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cost INTEGER NOT NULL DEFAULT 0, estimated INTEGER NOT NULL DEFAULT 0, guardrail TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS request_workspace_time ON requests(workspace_id, created_at);
      CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, key_id TEXT NOT NULL REFERENCES virtual_keys(id), model TEXT NOT NULL, amount INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, created_at TEXT NOT NULL);
    `);
    if (Number(this.get('PRAGMA user_version')!.user_version) < 1) {
      this.transaction(() => {
        this.db.exec(`
          ALTER TABLE virtual_keys ADD COLUMN token_limit INTEGER;
          ALTER TABLE virtual_keys ADD COLUMN tpm INTEGER;
          ALTER TABLE virtual_keys ADD COLUMN limit_period TEXT NOT NULL DEFAULT 'lifetime';
          ALTER TABLE reservations ADD COLUMN token_amount INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE reservations ADD COLUMN minute_window INTEGER;
          ALTER TABLE rate_windows ADD COLUMN tokens INTEGER NOT NULL DEFAULT 0;
          CREATE TABLE usage_daily (key_id TEXT NOT NULL REFERENCES virtual_keys(id), day TEXT NOT NULL, cost INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(key_id,day));
          INSERT INTO usage_daily (key_id,day,cost,tokens)
            SELECT r.key_id, substr(r.created_at,1,10), SUM(r.cost), SUM(r.input_tokens+r.output_tokens)
            FROM requests r JOIN virtual_keys k ON k.id=r.key_id GROUP BY r.key_id,substr(r.created_at,1,10);
          CREATE INDEX reservation_key_time ON reservations(key_id,created_at);
          PRAGMA user_version=1;
        `);
      });
    }
    if (Number(this.get('PRAGMA user_version')!.user_version) < 2) {
      this.transaction(() => {
        this.db.exec(`
          ALTER TABLE virtual_keys RENAME COLUMN max_output TO max_request_tokens;
          ALTER TABLE virtual_keys ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
          ALTER TABLE usage_daily ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE usage_daily ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
          UPDATE usage_daily SET
            input_tokens=COALESCE((SELECT SUM(r.input_tokens) FROM requests r WHERE r.key_id=usage_daily.key_id AND substr(r.created_at,1,10)=usage_daily.day),0),
            output_tokens=COALESCE((SELECT SUM(r.output_tokens) FROM requests r WHERE r.key_id=usage_daily.key_id AND substr(r.created_at,1,10)=usage_daily.day),0);
          PRAGMA user_version=2;
        `);
      });
    }
  }
  all(sql: string, ...params: any[]): Row[] { return this.db.prepare(sql).all(...params) as Row[]; }
  get(sql: string, ...params: any[]): Row | undefined { return this.db.prepare(sql).get(...params) as Row | undefined; }
  run(sql: string, ...params: any[]) { return this.db.prepare(sql).run(...params); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  seal(value: string) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
  }
  unseal(value: string) {
    const data = Buffer.from(value, 'base64'), decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(-16));
    return Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]).toString('utf8');
  }
  audit(workspace: string, actor: string, action: string, target: string) {
    this.run('INSERT INTO audit VALUES (?, ?, ?, ?, ?, ?)', id(), workspace, actor, action, target, now());
  }
  log(row: Row) {
    const value = { id: id(), workspace_id: 'default', key_id: '', key_name: '', model: '', deployment_id: null, status: 'success', http_status: 200, latency_ms: 0, input_tokens: 0, output_tokens: 0, cost: 0, estimated: 0, guardrail: null, attempts: 0, created_at: now(), ...row };
    const fields = Object.keys(value);
    this.run(`INSERT INTO requests (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`, ...Object.values(value));
  }
  limitSummary(key: Row, timestamp = Date.now()) {
    const date = new Date(timestamp), period = key.limit_period ?? 'lifetime';
    let start: string | null = null, next: string | null = null;
    if (period === 'daily') {
      start = date.toISOString().slice(0, 10);
      next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)).toISOString();
    } else if (period === 'monthly') {
      start = date.toISOString().slice(0, 7) + '-01';
      next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString();
    }
    const usage = this.get('SELECT COALESCE(SUM(cost),0) AS cost, COALESCE(SUM(tokens),0) AS tokens FROM usage_daily WHERE key_id=? AND day>=?', key.id, start ?? '')!;
    const reserved = this.get('SELECT COALESCE(SUM(amount),0) AS cost, COALESCE(SUM(token_amount),0) AS tokens FROM reservations WHERE key_id=? AND created_at>=?', key.id, start ? start + 'T00:00:00.000Z' : '')!;
    return { period_spent: period === 'lifetime' ? key.spent : usage.cost, tokens_used: usage.tokens, money_reserved: reserved.cost, tokens_reserved: reserved.tokens, resets_at: next, period_start: start };
  }
  recordUsage(keyId: string, timestamp: string, cost: number, tokens: number, inputTokens = 0, outputTokens = 0) {
    this.run('INSERT INTO usage_daily (key_id,day,cost,tokens,input_tokens,output_tokens) VALUES (?,?,?,?,?,?) ON CONFLICT(key_id,day) DO UPDATE SET cost=cost+excluded.cost,tokens=tokens+excluded.tokens,input_tokens=input_tokens+excluded.input_tokens,output_tokens=output_tokens+excluded.output_tokens', keyId, timestamp.slice(0, 10), cost, tokens, inputTokens, outputTokens);
  }
  recoverReservations() {
    // One gateway process per data directory. An interrupted request may have been billed.
    this.transaction(() => {
      for (const row of this.all('SELECT r.*, k.name AS key_name FROM reservations r JOIN virtual_keys k ON k.id=r.key_id')) {
        this.run('UPDATE virtual_keys SET spent=spent+?, reserved=MAX(0,reserved-?) WHERE id=?', row.amount, row.amount, row.key_id);
        this.recordUsage(row.key_id, row.created_at, row.amount, row.token_amount);
        this.log({ workspace_id: row.workspace_id, key_id: row.key_id, key_name: row.key_name, model: row.model, status: 'interrupted', http_status: 502, cost: row.amount, estimated: 1, created_at: row.created_at });
      }
      this.run('DELETE FROM reservations');
    });
  }
  close() { this.db.close(); if (existsSync(this.lockPath)) unlinkSync(this.lockPath); }
}
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const issueToken = () => `rk_${randomBytes(32).toString('base64url')}`;
export function passwordHash(value: string) { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(value, salt, 64).toString('hex')}`; }
export function passwordMatches(value: string, stored: string) {
  const [salt, expected] = stored.split(':');
  return timingSafeEqual(scryptSync(value, salt, 64), Buffer.from(expected, 'hex'));
}

export class HttpError extends Error { constructor(public status: number, message: string, public code = 'invalid_request') { super(message); } }
