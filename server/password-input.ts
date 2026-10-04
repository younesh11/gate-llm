import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { validatePassword } from './maintenance.ts';

export async function readPassword(fromStdin: boolean) {
  if (fromStdin) {
    if (process.stdin.isTTY) throw new Error('--password-stdin requires a pipe; omit it for a hidden terminal prompt.');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > 1024) throw new Error('Password input is too long.');
      chunks.push(bytes);
    }
    const password = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).replace(/\r?\n$/, '');
    validatePassword(password);
    return password;
  }
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error('Use an interactive terminal, or pipe one password line with --password-stdin.');
  let muted = false;
  const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stderr.write(chunk, encoding); callback(); } });
  const terminal = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  const ask = (prompt: string) => new Promise<string>((resolve, reject) => {
    const cancel = () => { cleanup(); reject(new Error('Password reset cancelled.')); };
    const cleanup = () => { terminal.off('SIGINT', cancel); terminal.off('close', cancel); };
    terminal.once('SIGINT', cancel); terminal.once('close', cancel);
    muted = false;
    terminal.question(prompt, answer => { cleanup(); process.stderr.write('\n'); resolve(answer); });
    muted = true;
  });
  try {
    const password = await ask('New password (12–200 characters): ');
    validatePassword(password);
    if (await ask('Confirm password: ') !== password) throw new Error('Passwords do not match. No credentials were changed.');
    return password;
  } finally { terminal.close(); output.end(); }
}
