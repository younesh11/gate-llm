#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { version } from './meta.ts';
import { dataDirectory, loadEnvironment } from './config.ts';

const help = `GATE ${version} — self-hosted LLM gateway

Usage: gate-llm [serve] [options]
       gate-llm backup --data-dir <directory> --output <new-directory>
       gate-llm verify-backup --input <backup-directory>
       gate-llm restore --input <backup-directory> --data-dir <new-directory>
       gate-llm reset-password --data-dir <directory> --email <account-email>

Stop the gateway before backup or password reset. Restore never overwrites a directory.
Password reset prompts privately; use --password-stdin to read one line from a pipe.
Backups contain the encryption key: store them privately, outside your data directory.

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
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { host: { type: 'string' }, port: { type: 'string' }, 'data-dir': { type: 'string' }, 'env-file': { type: 'string' }, 'allow-private-upstreams': { type: 'boolean' }, 'allow-remote-setup': { type: 'boolean' }, 'secure-cookie': { type: 'boolean' }, 'log-level': { type: 'string' }, input: { type: 'string' }, output: { type: 'string' }, email: { type: 'string' }, 'password-stdin': { type: 'boolean' }, version: { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) console.log(help);
  else if (values.version) console.log(version);
  else {
    const command = positionals[0] ?? 'serve';
    const allowed: Record<string, string[]> = {
      serve: ['host', 'port', 'data-dir', 'env-file', 'allow-private-upstreams', 'allow-remote-setup', 'secure-cookie', 'log-level'],
      backup: ['data-dir', 'env-file', 'output'], 'verify-backup': ['input'],
      restore: ['input', 'data-dir'], 'reset-password': ['data-dir', 'env-file', 'email', 'password-stdin'],
    };
    if (positionals.length > 1 || !Object.hasOwn(allowed, command)) throw new Error('Unknown command. Run gate-llm --help.');
    if (Object.keys(values).some(key => !allowed[command].includes(key))) throw new Error('Option not supported for this command. Run gate-llm --help.');
    if (command === 'serve') {
      const { start } = await import('./runtime.ts');
      await start({ host: values.host, port: values.port, dataDir: values['data-dir'], envFile: values['env-file'], allowPrivate: values['allow-private-upstreams'], allowRemoteSetup: values['allow-remote-setup'], secureCookie: values['secure-cookie'], logLevel: values['log-level'] });
    } else {
      if (command === 'backup' && !values.output) throw new Error('Backup requires --output pointing to a new directory.');
      if (command === 'verify-backup' && !values.input) throw new Error('Verification requires --input.');
      if (command === 'restore' && (!values.input || !values['data-dir'])) throw new Error('Restore requires --input and an explicit new --data-dir.');
      if (command === 'reset-password' && !values.email) throw new Error('Password reset requires --email.');
      const { backupState, verifyBackup, restoreState, resetPassword } = await import('./maintenance.ts');
      if (['backup', 'reset-password'].includes(command)) loadEnvironment(values['env-file']);
      const directory = dataDirectory(values['data-dir']);
      if (command === 'backup') console.log(JSON.stringify(backupState(directory, values.output!)));
      else if (command === 'verify-backup') { const manifest = verifyBackup(values.input!); console.log(JSON.stringify({ status: 'backup_verified', ...manifest })); }
      else if (command === 'restore') console.log(JSON.stringify(restoreState(values.input!, directory)));
      else {
        const { readPassword } = await import('./password-input.ts');
        console.log(JSON.stringify(resetPassword(directory, values.email!, await readPassword(values['password-stdin'] ?? false))));
      }
    }
  }
} catch (error: any) { console.error(`GATE: ${error.message}`); process.exitCode = 1; }
