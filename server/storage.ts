import { AsyncLocalStorage } from 'node:async_hooks';
import { Store, type Row, id, now } from './store.ts';

/** Application storage is asynchronous even when the selected backend is SQLite. */
export abstract class AppStore {
  abstract readonly backend: 'sqlite' | 'postgres';
  abstract all(sql: string, ...params: any[]): Promise<Row[]>;
  async get(sql: string, ...params: any[]): Promise<Row | undefined> { return (await this.all(sql, ...params))[0]; }
  abstract run(sql: string, ...params: any[]): Promise<unknown>;
  abstract transaction<T>(fn: () => Promise<T>): Promise<T>;
  abstract seal(value: string): string;
  abstract unseal(value: string): string;
  abstract close(): Promise<void>;
  async audit(workspace: string, actor: string, action: string, target: string) {
    (await this.run('INSERT INTO audit VALUES (?, ?, ?, ?, ?, ?)', id(), workspace, actor, action, target, now()));
  }
  async log(row: Row) {
    const value = { id: id(), workspace_id: 'default', key_id: '', key_name: '', model: '', deployment_id: null, status: 'success', http_status: 200, latency_ms: 0, input_tokens: 0, output_tokens: 0, cost: 0, estimated: 0, guardrail: null, attempts: 0, created_at: now(), ...row };
    const fields = Object.keys(value);
    (await this.run(`INSERT INTO requests (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`, ...Object.values(value)));
  }
  async limitSummary(key: Row, timestamp = Date.now()) {
    const date = new Date(timestamp), period = key.limit_period ?? 'lifetime';
    let start: string | null = null, next: string | null = null;
    if (period === 'daily') {
      start = date.toISOString().slice(0, 10);
      next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)).toISOString();
    } else if (period === 'monthly') {
      start = date.toISOString().slice(0, 7) + '-01';
      next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString();
    }
    const usage = (await this.get('SELECT COALESCE(SUM(cost),0) AS cost, COALESCE(SUM(tokens),0) AS tokens FROM usage_daily WHERE key_id=? AND day>=?', key.id, start ?? ''))!;
    const reserved = (await this.get('SELECT COALESCE(SUM(amount),0) AS cost, COALESCE(SUM(token_amount),0) AS tokens FROM reservations WHERE key_id=? AND created_at>=?', key.id, start ? start + 'T00:00:00.000Z' : ''))!;
    return { period_spent: period === 'lifetime' ? key.spent : usage.cost, tokens_used: usage.tokens, money_reserved: reserved.cost, tokens_reserved: reserved.tokens, resets_at: next, period_start: start };
  }
  async recordUsage(keyId: string, timestamp: string, cost: number, tokens: number, inputTokens = 0, outputTokens = 0) {
    (await this.run('INSERT INTO usage_daily (key_id,day,cost,tokens,input_tokens,output_tokens) VALUES (?,?,?,?,?,?) ON CONFLICT(key_id,day) DO UPDATE SET cost=usage_daily.cost+excluded.cost,tokens=usage_daily.tokens+excluded.tokens,input_tokens=usage_daily.input_tokens+excluded.input_tokens,output_tokens=usage_daily.output_tokens+excluded.output_tokens', keyId, timestamp.slice(0, 10), cost, tokens, inputTokens, outputTokens));
  }
  async memberSummary(userId: string, timestamp = Date.now()) {
    const allowance = (await this.get('SELECT * FROM member_allowances WHERE user_id=?', userId));
    const date = new Date(timestamp), period = allowance?.limit_period ?? 'lifetime';
    const start = period === 'daily' ? date.toISOString().slice(0,10) : period === 'monthly' ? date.toISOString().slice(0,7) + '-01' : '';
    const usage = (await this.get('SELECT COALESCE(SUM(cost),0) AS cost,COALESCE(SUM(tokens),0) AS tokens FROM member_usage WHERE user_id=? AND day>=?', userId, start))!;
    const held = (await this.get('SELECT COALESCE(SUM(r.amount),0) AS cost,COALESCE(SUM(r.token_amount),0) AS tokens FROM reservations r JOIN member_holds h ON h.reservation_id=r.id WHERE h.user_id=? AND r.created_at>=?', userId, start ? start + 'T00:00:00.000Z' : ''))!;
    return { approved: !!allowance, budget: allowance?.budget ?? null, token_limit: allowance?.token_limit ?? null, limit_period: period, expires_at: allowance?.expires_at ?? null, spent: usage.cost, tokens_used: usage.tokens, money_reserved: held.cost, tokens_reserved: held.tokens };
  }
  async recordMemberUsage(userId: string | null | undefined, timestamp: string, cost: number, tokens: number) {
    if (userId) (await this.run('INSERT INTO member_usage VALUES (?,?,?,?) ON CONFLICT(user_id,day) DO UPDATE SET cost=member_usage.cost+excluded.cost,tokens=member_usage.tokens+excluded.tokens', userId, timestamp.slice(0,10), cost, tokens));
  }
  async recoverReservations() {
    // One gateway process per data directory. An interrupted request may have been billed.
    (await this.transaction(async () => {
      for (const row of (await this.all('SELECT r.*, k.name AS key_name FROM reservations r JOIN virtual_keys k ON k.id=r.key_id'))) {
        (await this.run('UPDATE virtual_keys SET spent=spent+?, reserved=MAX(0,reserved-?) WHERE id=?', row.amount, row.amount, row.key_id));
        (await this.recordUsage(row.key_id, row.created_at, row.amount, row.token_amount));
        (await this.recordMemberUsage((await this.get('SELECT user_id FROM member_holds WHERE reservation_id=?', row.id))?.user_id, row.created_at, row.amount, row.token_amount));
        (await this.log({ workspace_id: row.workspace_id, key_id: row.key_id, key_name: row.key_name, model: row.model, status: 'interrupted', http_status: 502, cost: row.amount, estimated: 1, created_at: row.created_at }));
      }
      (await this.run('DELETE FROM reservations'));
    }));
  }
  async checkReady() {
    if (!(await this.get('SELECT id FROM workspaces WHERE id=?', 'default'))) throw new Error('Storage is unavailable.');
  }
}

/** Serialize SQLite operations across await boundaries; never interleave a transaction. */
export class SqliteAppStore extends AppStore {
  readonly backend = 'sqlite' as const;
  private readonly scope = new AsyncLocalStorage<{ active: boolean }>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly raw: Store) { super(); }
  private async exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const scope = this.scope.getStore();
    if (scope) { if (!scope.active) throw new Error('Transaction is closed.'); return fn(); }
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  }
  all(sql: string, ...params: any[]) { return this.exclusive(() => this.raw.all(sql, ...params)); }
  run(sql: string, ...params: any[]) { return this.exclusive(() => this.raw.run(sql, ...params)); }
  transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.scope.getStore()) throw new Error('Nested transactions are not supported.');
    return this.exclusive(async () => {
      this.raw.db.exec('BEGIN IMMEDIATE');
      const scope = { active: true };
      try { const result = await this.scope.run(scope, fn); this.raw.db.exec('COMMIT'); return result; }
      catch (error) { this.raw.db.exec('ROLLBACK'); throw error; }
      finally { scope.active = false; }
    });
  }
  seal(value: string) { return this.raw.seal(value); }
  unseal(value: string) { return this.raw.unseal(value); }
  async close() { await this.exclusive(() => this.raw.close()); }
}

/** Keep dashboard/report reads from overflowing the bounded PostgreSQL queue. */
export async function mapRows<T, R>(rows: T[], fn: (row: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(rows.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
    while (next < rows.length) { const index = next++; result[index] = await fn(rows[index]); }
  }));
  return result;
}
