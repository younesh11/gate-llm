import { resolve } from 'node:path';
import { createApp } from '../server/app.ts';
import { mockProvider } from './mock-provider.ts';

const { server } = mockProvider();
await new Promise<void>(resolve => server.listen(4311, '127.0.0.1', resolve));
const { app, db } = await createApp({ directory: resolve(process.env.DATA_DIR ?? 'data/demo'), allowPrivate: true });
if (!db.get('SELECT id FROM users LIMIT 1')) {
  const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { workspace: 'Studio workspace', name: 'Demo owner', email: 'demo@relay.local', password: 'relay-local-demo' } });
  if (setup.statusCode !== 200) throw new Error(setup.body);
  const cookie = String(setup.headers['set-cookie']).split(';')[0];
  async function admin(url: string, payload: any) {
    const response = await app.inject({ method: 'POST', url: '/api/admin/' + url, headers: { cookie }, payload });
    if (response.statusCode !== 200) throw new Error(response.body); return response.json();
  }
  const provider = await admin('providers', { name: 'Local demo · simulated', base_url: 'http://127.0.0.1:4311/v1', enabled: true });
  await admin('deployments', { provider_id: provider.id, alias: 'team-chat', upstream_model: 'demo-chat', weight: 3, input_price: 0, output_price: 0, enabled: true });
  await admin('deployments', { provider_id: provider.id, alias: 'team-chat', upstream_model: 'demo-backup', weight: 1, input_price: 0, output_price: 0, enabled: true });
  await admin('deployments', { provider_id: provider.id, alias: 'team-fast', upstream_model: 'fast', weight: 1, input_price: 0, output_price: 0, enabled: true });
  const baseline = db.get('SELECT id FROM policies LIMIT 1')!;
  const restricted = await admin('policies', { name: 'Internal applications', blocked_terms: ['do-not-send'], redact_pii: true, block_secrets: true });
  const a = await admin('keys', { name: 'Engineering sandbox', owner: 'Engineering', models: ['team-chat', 'team-fast'], policy_id: baseline.id, budget: 10, rpm: 60, max_request_tokens: 8192 });
  const b = await admin('keys', { name: 'Internal assistant', owner: 'Operations', models: ['team-chat'], policy_id: restricted.id, budget: 25, rpm: 30, max_request_tokens: 8192 });
  for (let i = 0; i < 5; i++) await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${i % 2 ? a.token : b.token}` }, payload: { model: 'team-chat', messages: [{ role: 'user', content: i === 3 ? 'My email is sample@example.com' : 'Hello from the demo' }] } });
  await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${b.token}` }, payload: { model: 'team-chat', messages: [{ role: 'user', content: 'do-not-send' }] } });
}
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 4310) });
console.log('GATE demo: http://127.0.0.1:' + (process.env.PORT ?? 4310));
console.log('Demo only: demo@relay.local / relay-local-demo');
const close = async () => { await app.close(); server.close(); process.exit(0); };
process.on('SIGINT', close); process.on('SIGTERM', close);
