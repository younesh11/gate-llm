import { createHash } from 'node:crypto';
import { PostgresDatabase } from './database.ts';

export class QuotaError extends Error {
  override name = 'QuotaError';
  constructor(public readonly code: 'invalid' | 'not_allowed' | 'exceeded' | 'conflict') { super(`Quota ${code}.`); }
}
const uuid = (value: string) => { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new QuotaError('invalid'); return value; };
const amount = (value: bigint) => { if (typeof value !== 'bigint' || value < 0n || value > 9223372036854775807n) throw new QuotaError('invalid'); return value.toString(); };
type Account = { id: string; enabled: boolean; budget: string | null; token_limit: string | null; spent: string; tokens_used: string; reserved: string; tokens_reserved: string };
type Reservation = { workspace_id: string; fingerprint: string; status: 'reserved' | 'settled'; money: string; tokens: string };

/** Money is integer microdollars. These internal primitives do not authenticate callers. */
export class PostgresQuotas {
  constructor(private readonly db: PostgresDatabase) {}
  async createAccount(input: {id:string; workspaceId:string; principalId:string; kind:'key'|'member'; periodStart:string; budget:bigint|null; tokenLimit:bigint|null}) {
    const { id,workspaceId,principalId,kind,periodStart,budget,tokenLimit } = input;
    uuid(id);uuid(workspaceId);uuid(principalId);
    if (!['key','member'].includes(kind) || !Number.isFinite(Date.parse(periodStart))) throw new QuotaError('invalid');
    await this.db.transaction(async tx => {
      await tx.query('INSERT INTO gate_core.quota_accounts(id,workspace_id,principal_id,kind,period_start,budget,token_limit) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,workspaceId,principalId,kind,periodStart,budget===null?null:amount(budget),tokenLimit===null?null:amount(tokenLimit)]);
    });
  }
  async reserve(input: { requestId:string; workspaceId:string; accountIds:string[]; money:bigint; tokens:bigint }) {
    const { requestId,workspaceId,money,tokens }=input;
    uuid(requestId);uuid(workspaceId);amount(money);amount(tokens);
    const accountIds=[...new Set(input.accountIds.map(uuid))].sort();
    if (!accountIds.length || accountIds.length>4 || accountIds.length!==input.accountIds.length) throw new QuotaError('invalid');
    const fingerprint=createHash('sha256').update(JSON.stringify([workspaceId,accountIds,money.toString(),tokens.toString()])).digest('hex');
    return this.db.transaction(async tx=>{
      const inserted=await tx.query('INSERT INTO gate_core.reservations(id,workspace_id,fingerprint,status,money,tokens) VALUES($1,$2,$3,\'reserved\',$4,$5) ON CONFLICT(id) DO NOTHING RETURNING id',[requestId,workspaceId,fingerprint,amount(money),amount(tokens)]);
      const [reservation]=await tx.query<Reservation>('SELECT * FROM gate_core.reservations WHERE id=$1 FOR UPDATE',[requestId]);
      if(reservation.workspace_id!==workspaceId || reservation.fingerprint!==fingerprint)throw new QuotaError('conflict');
      // A replay never authorizes another upstream generation. Callers must check created.
      if(!inserted.length)return {created:false,status:reservation.status};
      const accounts=await tx.query<Account>('SELECT * FROM gate_core.quota_accounts WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',[workspaceId,accountIds]);
      if(accounts.length!==accountIds.length || accounts.some(row=>!row.enabled))throw new QuotaError('not_allowed');
      for(const row of accounts) {
        if(row.budget!==null && BigInt(row.spent)+BigInt(row.reserved)+money>BigInt(row.budget))throw new QuotaError('exceeded');
        if(row.token_limit!==null && BigInt(row.tokens_used)+BigInt(row.tokens_reserved)+tokens>BigInt(row.token_limit))throw new QuotaError('exceeded');
      }
      await tx.query('UPDATE gate_core.quota_accounts SET reserved=reserved+$3::bigint,tokens_reserved=tokens_reserved+$4::bigint WHERE workspace_id=$1 AND id=ANY($2::uuid[])',[workspaceId,accountIds,amount(money),amount(tokens)]);
      for(const accountId of accountIds)await tx.query('INSERT INTO gate_core.holds(workspace_id,reservation_id,account_id) VALUES($1,$2,$3)',[workspaceId,requestId,accountId]);
      return {created:true,status:'reserved' as const};
    });
  }
  async settle(input:{requestId:string;workspaceId:string;cost:bigint;tokens:bigint;estimated:boolean}) {
    const {requestId,workspaceId,cost,tokens,estimated}=input;
    uuid(requestId);uuid(workspaceId);amount(cost);amount(tokens);
    if(typeof estimated!=='boolean')throw new QuotaError('invalid');
    return this.db.transaction(async tx=>{
      const [reservation]=await tx.query<Reservation>('SELECT * FROM gate_core.reservations WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[requestId,workspaceId]);
      if(!reservation)throw new QuotaError('not_allowed');
      if(reservation.status==='settled') {
        const [ledger]=await tx.query<{cost:string;tokens:string;estimated:boolean}>('SELECT cost,tokens,estimated FROM gate_core.usage_ledger WHERE request_id=$1',[requestId]);
        if(!ledger || BigInt(ledger.cost)!==cost || BigInt(ledger.tokens)!==tokens || ledger.estimated!==estimated)throw new QuotaError('conflict');
        return {created:false};
      }
      const accounts=await tx.query<{id:string}>('SELECT a.id FROM gate_core.quota_accounts a JOIN gate_core.holds h ON h.account_id=a.id AND h.workspace_id=a.workspace_id WHERE h.reservation_id=$1 AND h.workspace_id=$2 ORDER BY a.id FOR UPDATE OF a',[requestId,workspaceId]);
      if(!accounts.length)throw new QuotaError('conflict');
      // Actual usage may exceed an estimate; retain the real charge and block future admission.
      await tx.query('UPDATE gate_core.quota_accounts SET reserved=reserved-$3::bigint,tokens_reserved=tokens_reserved-$4::bigint,spent=spent+$5::bigint,tokens_used=tokens_used+$6::bigint WHERE workspace_id=$1 AND id=ANY($2::uuid[])',[workspaceId,accounts.map(row=>row.id),reservation.money,reservation.tokens,amount(cost),amount(tokens)]);
      await tx.query('INSERT INTO gate_core.usage_ledger(request_id,cost,tokens,estimated) VALUES($1,$2,$3,$4)',[requestId,amount(cost),amount(tokens),estimated]);
      await tx.query("UPDATE gate_core.reservations SET status='settled' WHERE id=$1",[requestId]);
      return {created:true};
    });
  }
}
