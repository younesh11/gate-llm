import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { createApp } from './app.ts';
import { parseLogLevel } from './operations.ts';

export type RuntimeOptions = { host?: string; port?: string; dataDir?: string; envFile?: string; allowPrivate?: boolean; allowRemoteSetup?: boolean; secureCookie?: boolean; logLevel?: string };
export async function start(options: RuntimeOptions = {}) {
  if (options.envFile) process.loadEnvFile(resolve(options.envFile));
  else if (existsSync('.env')) process.loadEnvFile('.env');
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  const port = Number(options.port ?? process.env.PORT ?? 4310);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer between 0 and 65535.');
  const directory = resolve(options.dataDir ?? process.env.DATA_DIR ?? join(homedir(), '.gate-llm'));
  const { app } = await createApp({ directory, allowPrivate: options.allowPrivate ?? process.env.ALLOW_PRIVATE_UPSTREAMS === 'true', secureCookie: options.secureCookie ?? process.env.COOKIE_SECURE === 'true', allowRemoteSetup: options.allowRemoteSetup ?? process.env.ALLOW_REMOTE_SETUP === 'true', logLevel: parseLogLevel(options.logLevel ?? process.env.LOG_LEVEL) });
  try { await app.listen({ port, host }); } catch (error) { await app.close(); throw error; }
  const address = app.server.address();
  app.log.info({ event: 'gateway_started', address: `http://${host}:${typeof address === 'object' && address ? address.port : port}` }, 'GATE is ready');
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await app.close(); process.exit(0); };
  process.on('SIGTERM', close); process.on('SIGINT', close);
  return app;
}
