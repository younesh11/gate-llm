import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function loadEnvironment(envFile?: string) {
  if (envFile) process.loadEnvFile(resolve(envFile));
  else if (existsSync('.env')) process.loadEnvFile('.env');
}
export function dataDirectory(directory?: string) {
  return resolve(directory ?? process.env.DATA_DIR ?? join(homedir(), '.gate-llm'));
}
