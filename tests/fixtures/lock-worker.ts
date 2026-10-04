import { createApp } from '../../server/app.ts';
import { hash, now } from '../../server/store.ts';

const { app, db } = await createApp({ directory: process.argv[2], logLevel: 'silent' });
if (process.argv[3] === 'seed') {
  db.transaction(() => {
    db.run('INSERT INTO virtual_keys (id,workspace_id,name,owner,token_hash,prefix,models,policy_id,budget,spent,reserved,rpm,max_request_tokens,expires_at,revoked,created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 400, ?, ?, ?, 0, ?)', 'crash-key', 'default', 'Crash test', 'Test', hash('synthetic-crash-key'), 'rk_test', '["chat"]', null, 1000000, 60, 8192, null, now());
    db.run('INSERT INTO reservations (id,workspace_id,key_id,model,amount,created_at,token_amount) VALUES (?, ?, ?, ?, ?, ?, ?)', 'crash-reservation', 'default', 'crash-key', 'chat', 400, now(), 3000);
  });
}
await app.listen({ host: '127.0.0.1', port: 0 });
const address = app.server.address() as { port: number };
process.send?.({ ready: true, origin: `http://127.0.0.1:${address.port}` });
process.on('SIGTERM', () => { void app.close().then(() => process.exit(0)); });
