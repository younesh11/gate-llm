import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresDatabase, StorageError, type SqlTransaction } from '../../server/postgres/database.ts';
import { migratePostgres } from '../../server/postgres/migrations.ts';
import { PostgresQuotas, QuotaError } from '../../server/postgres/quotas.ts';

const url=process.env.GATE_TEST_POSTGRES_URL;
if(!url || new URL(url).hostname!=='127.0.0.1' || new URL(url).pathname!=='/gate_test')throw new Error('Use npm run test:postgres with its disposable database.');
const a=new PostgresDatabase({url,localPlaintext:true}),b=new PostgresDatabase({url,localPlaintext:true});
const qa=new PostgresQuotas(a),qb=new PostgresQuotas(b);
before(async()=>{await Promise.all([migratePostgres(a),migratePostgres(b)]);});
after(async()=>{await Promise.all([a.close(),b.close()]);});
async function account(workspaceId:string,budget:bigint|null=100n,tokenLimit:bigint|null=1000n,kind:'key'|'member'='key') {
  const id=randomUUID();await qa.createAccount({id,workspaceId,principalId:randomUUID(),kind,periodStart:'2026-10-01T00:00:00Z',budget,tokenLimit});return id;
}
async function summary(id:string) {return a.transaction(async tx=>(await tx.query('SELECT * FROM gate_core.quota_accounts WHERE id=$1',[id]))[0]);}
const quotaError=(code:string)=>(error:any)=>error instanceof QuotaError && error.code===code;

test('migration is repeatable and concurrent deploys apply one checksummed version',async()=>{
  await migratePostgres(a);
  const rows=await a.transaction(tx=>tx.query('SELECT version,checksum FROM gate_core.schema_migrations'));
  assert.equal(rows.length,1);assert.equal(rows[0].version,1);assert.match(rows[0].checksum,/^[a-f0-9]{64}$/);
  await a.ready();
});
test('async transactions roll back and transaction handles cannot escape their lifetime',async()=>{
  const workspace=randomUUID(),id=await account(workspace);let escaped:SqlTransaction|undefined;
  await assert.rejects(a.transaction(async tx=>{escaped=tx;await tx.query('UPDATE gate_core.quota_accounts SET spent=7 WHERE id=$1',[id]);throw new QuotaError('invalid');}),quotaError('invalid'));
  assert.equal((await summary(id)).spent,'0');
  await assert.rejects(escaped!.query('SELECT 1'),StorageError);
  await a.ready();
});
test('100 competing requests through one application key and shared member budget cannot over-reserve',async()=>{
  const workspaceId=randomUUID(),key=await account(workspaceId,1000n),member=await account(workspaceId,100n,1000n,'member');
  const inputs=Array.from({length:100},()=>({requestId:randomUUID(),workspaceId,accountIds:[key,member],money:5n,tokens:10n}));
  const results=await Promise.allSettled(inputs.map((input,i)=>(i%2?qa:qb).reserve(input)));
  const accepted=inputs.filter((_,i)=>results[i].status==='fulfilled');
  assert.equal(accepted.length,20);
  for(const result of results)if(result.status==='rejected')assert.ok(quotaError('exceeded')(result.reason));
  for(const id of [key,member]){const row=await summary(id);assert.equal(row.reserved,'100');assert.equal(row.tokens_reserved,'200');}
  await Promise.all(accepted.flatMap(input=>[qa,qb].map(q=>q.settle({requestId:input.requestId,workspaceId,cost:3n,tokens:6n,estimated:false}))));
  for(const id of [key,member]){const row=await summary(id);assert.equal(row.reserved,'0');assert.equal(row.tokens_reserved,'0');assert.equal(row.spent,'60');assert.equal(row.tokens_used,'120');}
  const [ledger]=await a.transaction(tx=>tx.query('SELECT COUNT(*)::text AS count,SUM(l.cost)::text AS cost FROM gate_core.usage_ledger l JOIN gate_core.reservations r ON r.id=l.request_id WHERE r.workspace_id=$1',[workspaceId]));
  assert.equal(ledger.count,'20');assert.equal(ledger.cost,'60');
});
test('request retries reserve and settle once; changed retry payloads are rejected',async()=>{
  const workspaceId=randomUUID(),id=await account(workspaceId),requestId=randomUUID();
  const input={requestId,workspaceId,accountIds:[id],money:10n,tokens:20n};
  const results=await Promise.all(Array.from({length:20},(_,i)=>(i%2?qa:qb).reserve(input)));
  assert.equal(results.filter(r=>r.created).length,1);assert.equal((await summary(id)).reserved,'10');
  await assert.rejects(qb.reserve({...input,money:11n}),quotaError('conflict'));
  const settlement={requestId,workspaceId,cost:4n,tokens:5n,estimated:false};
  await qa.settle(settlement);assert.equal((await qb.settle(settlement)).created,false);
  await assert.rejects(qb.settle({...settlement,cost:9n}),quotaError('conflict'));
  assert.deepEqual(await qa.reserve(input),{created:false,status:'settled'});
  assert.equal((await summary(id)).spent,'4');
});
test('workspace boundaries and disabled accounts fail closed without partial holds',async()=>{
  const workspaceId=randomUUID(),foreign=await account(randomUUID()),local=await account(workspaceId);
  const input={requestId:randomUUID(),workspaceId,accountIds:[local,foreign],money:1n,tokens:1n};
  await assert.rejects(qa.reserve(input),quotaError('not_allowed'));assert.equal((await summary(local)).reserved,'0');
  const rows=await a.transaction(tx=>tx.query('SELECT id FROM gate_core.reservations WHERE id=$1',[input.requestId]));assert.equal(rows.length,0);
  await a.transaction(tx=>tx.query('UPDATE gate_core.quota_accounts SET enabled=false WHERE id=$1',[local]));
  await assert.rejects(qa.reserve({...input,accountIds:[local]}),quotaError('not_allowed'));
  await assert.rejects(qa.settle({requestId:randomUUID(),workspaceId,cost:0n,tokens:0n,estimated:false}),quotaError('not_allowed'));
});
test('token limits independently constrain free models and bigint accounting remains exact',async()=>{
  const workspaceId=randomUUID(),id=await account(workspaceId,null,10n);
  await qa.reserve({requestId:randomUUID(),workspaceId,accountIds:[id],money:0n,tokens:10n});
  await assert.rejects(qa.reserve({requestId:randomUUID(),workspaceId,accountIds:[id],money:0n,tokens:1n}),quotaError('exceeded'));
  const large=9007199254740993n,key=await account(workspaceId,large,null),requestId=randomUUID();
  await qa.reserve({requestId,workspaceId,accountIds:[key],money:large,tokens:0n});
  assert.equal((await summary(key)).reserved,large.toString());
  await qa.settle({requestId,workspaceId,cost:large,tokens:0n,estimated:false});assert.equal((await summary(key)).spent,large.toString());
  await assert.rejects(qa.reserve({requestId:randomUUID(),workspaceId,accountIds:[key],money:-1n,tokens:0n}),quotaError('invalid'));
});
test('actual usage exceeding the estimate is recorded and blocks later admissions',async()=>{
  const workspaceId=randomUUID(),id=await account(workspaceId,5n,10n),requestId=randomUUID();
  await qa.reserve({requestId,workspaceId,accountIds:[id],money:5n,tokens:10n});
  await qa.settle({requestId,workspaceId,cost:7n,tokens:15n,estimated:false});
  assert.equal((await summary(id)).spent,'7');assert.equal((await summary(id)).tokens_used,'15');
  await assert.rejects(qa.reserve({requestId:randomUUID(),workspaceId,accountIds:[id],money:0n,tokens:1n}),quotaError('exceeded'));
});
test('pool backpressure is bounded and database errors omit raw query values',async()=>{
  const db=new PostgresDatabase({url:url!,localPlaintext:true,maxConnections:1,maxWaiting:0});
  let release!:()=>void,entered!:()=>void;const enteredPromise=new Promise<void>(r=>entered=r);
  const holding=db.transaction(async()=>{entered();await new Promise<void>(r=>release=r);});await enteredPromise;
  await assert.rejects(db.ready(),(error:any)=>error instanceof StorageError && error.code==='busy');release();await holding;
  try {await db.transaction(tx=>tx.query('SELECT $1::uuid',['private-invalid-input']));assert.fail('expected failure');}catch(error){assert.ok(error instanceof StorageError);assert.ok(!String(error).includes('private-invalid-input'));}
  await db.close();await assert.rejects(db.ready(),StorageError);
  assert.throws(()=>new PostgresDatabase({url:'postgresql://user:private-password@example.test/gate?sslmode=disable'}),StorageError);
  assert.throws(()=>new PostgresDatabase({url:'postgresql://user:private-password@example.test/gate',localPlaintext:true}),StorageError);
});
test('migration detects edited or future schema history rather than silently accepting it',async()=>{
  const [original]=await a.transaction(tx=>tx.query('SELECT checksum FROM gate_core.schema_migrations WHERE version=1'));
  try {
    await a.transaction(tx=>tx.query("UPDATE gate_core.schema_migrations SET checksum='modified' WHERE version=1"));
    await assert.rejects(migratePostgres(b),StorageError);
  }finally{await a.transaction(tx=>tx.query('UPDATE gate_core.schema_migrations SET checksum=$1 WHERE version=1',[original.checksum]));}
  try {
    await a.transaction(tx=>tx.query("INSERT INTO gate_core.schema_migrations(version,checksum) VALUES(99,'future')"));
    await assert.rejects(migratePostgres(b),StorageError);
  }finally{await a.transaction(tx=>tx.query('DELETE FROM gate_core.schema_migrations WHERE version=99'));}
});
