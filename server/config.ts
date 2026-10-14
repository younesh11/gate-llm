import type { PostgresOptions } from './postgres/database.ts';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function loadEnvironment(envFile?: string) {
  if (envFile) process.loadEnvFile(resolve(envFile));
  else if (existsSync('.env')) process.loadEnvFile('.env');
}
export function dataDirectory(directory?: string) {
  return resolve(directory ?? process.env.DATA_DIR ?? join(homedir(), process.env.GATE_STORAGE === 'postgres' ? '.gate-llm-postgres' : '.gate-llm'));
}

export function postgresConfiguration(env: NodeJS.ProcessEnv = process.env): PostgresOptions | undefined {
  const storage = env.GATE_STORAGE ?? 'sqlite';
  if (!['sqlite', 'postgres'].includes(storage)) throw new Error('GATE_STORAGE must be sqlite or postgres.');
  if (storage === 'sqlite') {
    if (env.DATABASE_URL) throw new Error('Set GATE_STORAGE=postgres to use DATABASE_URL. SQLite fallback is not allowed.');
    return undefined;
  }
  if (!env.DATABASE_URL) throw new Error('PostgreSQL requires DATABASE_URL.');
  const ssl = env.DATABASE_SSL_MODE ?? 'verify-full';
  if (!['verify-full', 'disable'].includes(ssl)) throw new Error('DATABASE_SSL_MODE must be verify-full or disable.');
  return {
    url: env.DATABASE_URL,
    maxConnections: Number(env.DATABASE_POOL_MAX ?? 10),
    maxWaiting: Number(env.DATABASE_POOL_WAITING_MAX ?? 100),
    privateNetworkPlaintext: ssl === 'disable',
    ...(env.DATABASE_SSL_CA_FILE ? { ca: readFileSync(env.DATABASE_SSL_CA_FILE, 'utf8') } : {}),
  };
}
