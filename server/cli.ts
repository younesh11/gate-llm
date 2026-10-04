#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { version } from './meta.ts';

const help = `GATE ${version} — self-hosted LLM gateway

Usage: gate-llm [serve] [options]

  --host <address>            Bind address (default: 127.0.0.1)
  --port <number>             HTTP port (default: 4310)
  --data-dir <directory>      Persistent data (default: ~/.gate-llm)
  --env-file <file>           Load an explicit environment file
  --allow-private-upstreams  Allow trusted local/private model endpoints
  --allow-remote-setup       Allow first-owner setup from non-loopback clients
  --secure-cookie            Require HTTPS for session cookies
  --log-level <level>         Operational log level (default: info)
  --version                  Print the release version
  --help                     Show this help

Existing HOST, PORT, DATA_DIR, COOKIE_SECURE, ALLOW_PRIVATE_UPSTREAMS and
ALLOW_REMOTE_SETUP and LOG_LEVEL variables also work. CLI options take precedence.
The dashboard and proxy share the same port. Create an owner on first use.
`;

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { host: { type: 'string' }, port: { type: 'string' }, 'data-dir': { type: 'string' }, 'env-file': { type: 'string' }, 'allow-private-upstreams': { type: 'boolean' }, 'allow-remote-setup': { type: 'boolean' }, 'secure-cookie': { type: 'boolean' }, 'log-level': { type: 'string' }, version: { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) console.log(help);
  else if (values.version) console.log(version);
  else {
    if (positionals.length > 1 || positionals[0] && positionals[0] !== 'serve') throw new Error('Unknown command. Run gate-llm --help.');
    const { start } = await import('./runtime.ts');
    await start({ host: values.host, port: values.port, dataDir: values['data-dir'], envFile: values['env-file'], allowPrivate: values['allow-private-upstreams'], allowRemoteSetup: values['allow-remote-setup'], secureCookie: values['secure-cookie'], logLevel: values['log-level'] });
  }
} catch (error: any) { console.error(`GATE: ${error.message}`); process.exitCode = 1; }
