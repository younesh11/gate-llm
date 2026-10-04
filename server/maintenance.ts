import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { createDecipheriv, createHash } from 'node:crypto';
import { z } from 'zod';
import { DirectoryLock } from './directory-lock.ts';
import { id, now, passwordHash, schemaVersion } from './store.ts';
import { version } from './meta.ts';

const databaseFile = 'relay.sqlite', keyFile = 'encryption.key';
export const backupManifestFile = 'backup-manifest.json';
export const restoreMarkerFile = 'restore.incomplete';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const manifestSchema = z.object({
  format: z.literal('gate-backup'), format_version: z.literal(1),
  gate_version: z.string().max(50), schema_version: z.literal(schemaVersion), created_at: z.string().datetime(),
  files: z.object({ 'relay.sqlite': digest, 'encryption.key': digest }).strict(),
}).strict();

function regularFile(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('Maintenance requires ordinary files, without symbolic or hard links.');
  return stat;
}
function directoryPath(path: string) {
  if (!lstatSync(path).isDirectory()) throw new Error('Maintenance requires an existing directory, not a symbolic link.');
  return realpathSync(path);
}
function checksum(path: string) {
  regularFile(path);
  const fd = openSync(path, 'r'), hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
  try { let size; while ((size = readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, size)); }
  finally { closeSync(fd); }
  return hash.digest('hex');
}
function syncFile(path: string) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function syncDirectory(path: string) {
  if (process.platform !== 'win32') syncFile(path);
}
function privateWrite(path: string, value: string | Buffer) {
  writeFileSync(path, value, { flag: 'wx', mode: 0o600 });
  syncFile(path);
}
function newDestination(path: string, source: string) {
  const destination = join(realpathSync(dirname(resolve(path))), basename(resolve(path)));
  const within = relative(source, destination);
  if (!within || (!within.startsWith(`..${sep}`) && within !== '..' && !within.startsWith(sep))) {
    throw new Error('Choose a destination outside the source directory.');
  }
  // Exclusive mkdir never overwrites an existing destination, even an empty one.
  mkdirSync(destination, { mode: 0o700 });
  return destination;
}
function keyAt(directory: string) {
  if (regularFile(join(directory, keyFile)).size !== 32) throw new Error('Invalid encryption key. Restore the matching key from a backup.');
  return readFileSync(join(directory, keyFile));
}
function inspectDatabase(db: DatabaseSync, key: Buffer) {
  if (db.prepare('PRAGMA user_version').get()!.user_version !== schemaVersion) throw new Error('Unsupported database schema. Use the matching GATE release.');
  const integrity = db.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) {
    throw new Error('Database integrity check failed.');
  }
  if (!db.prepare('SELECT id FROM workspaces WHERE id=?').get('default')) throw new Error('Invalid GATE database.');
  // Exercise every table used by recovery before declaring a snapshot usable.
  for (const table of ['users', 'sessions', 'deployments', 'policies', 'virtual_keys', 'rate_windows', 'requests', 'reservations', 'usage_daily', 'audit']) {
    db.prepare(`SELECT COUNT(*) FROM ${table}`).get();
  }
  try {
    for (const row of db.prepare('SELECT secret FROM providers').all()) {
      const data = Buffer.from(String(row.secret), 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(-16));
      decipher.update(data.subarray(12, -16)); decipher.final();
    }
  } catch { throw new Error('The encryption key cannot decrypt the stored provider credentials.'); }
}
function withState<T>(path: string, writable: boolean, operation: (db: DatabaseSync, key: Buffer, directory: string) => T): T {
  const directory = directoryPath(path);
  if (existsSync(join(directory, restoreMarkerFile))) throw new Error('Restore is incomplete. Restore again into a new directory.');
  if (existsSync(join(directory, backupManifestFile))) throw new Error('This is a backup. Restore it into a new data directory first.');
  regularFile(join(directory, databaseFile));
  const key = keyAt(directory);
  for (const name of ['process-lock.sqlite', 'process.lock', 'relay.sqlite-wal', 'relay.sqlite-shm', 'relay.sqlite-journal']) {
    try { regularFile(join(directory, name)); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
  const lock = new DirectoryLock(directory);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(join(directory, databaseFile), { readOnly: !writable });
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
    inspectDatabase(db, key);
    return operation(db, key, directory);
  } finally { try { db?.close(); } finally { lock.close(); } }
}

export function verifyBackup(path: string) {
  const directory = directoryPath(path);
  const expected = [backupManifestFile, databaseFile, keyFile].sort();
  if (JSON.stringify(readdirSync(directory).sort()) !== JSON.stringify(expected)) throw new Error('Incomplete backup or unexpected files in backup directory.');
  if (regularFile(join(directory, backupManifestFile)).size > 8192) throw new Error('Invalid backup manifest.');
  let manifest: z.infer<typeof manifestSchema>;
  try { manifest = manifestSchema.parse(JSON.parse(readFileSync(join(directory, backupManifestFile), 'utf8'))); }
  catch { throw new Error('Invalid or unsupported backup manifest.'); }
  for (const name of [databaseFile, keyFile] as const) {
    if (checksum(join(directory, name)) !== manifest.files[name]) throw new Error('Backup checksum mismatch. Restore an intact backup.');
  }
  const key = keyAt(directory), db = new DatabaseSync(join(directory, databaseFile), { readOnly: true });
  try {
    if (db.prepare('PRAGMA journal_mode').get()!.journal_mode !== 'delete') throw new Error('Backup is not a standalone snapshot.');
    inspectDatabase(db, key);
  } finally { db.close(); }
  return manifest;
}

export function backupState(path: string, output: string) {
  return withState(path, false, (db, key, source) => {
    const destination = newDestination(output, source);
    // Write the manifest last. Interrupted snapshots must never pass verification.
    db.prepare('VACUUM INTO ?').run(join(destination, databaseFile));
    chmodSync(join(destination, databaseFile), 0o600);
    const snapshot = new DatabaseSync(join(destination, databaseFile));
    try { snapshot.exec('PRAGMA journal_mode=DELETE;'); inspectDatabase(snapshot, key); }
    finally { snapshot.close(); }
    syncFile(join(destination, databaseFile));
    privateWrite(join(destination, keyFile), key);
    const manifest = { format: 'gate-backup', format_version: 1, gate_version: version, schema_version: schemaVersion, created_at: now(), files: {
      [databaseFile]: checksum(join(destination, databaseFile)), [keyFile]: checksum(join(destination, keyFile)),
    } };
    privateWrite(join(destination, backupManifestFile), JSON.stringify(manifest, null, 2) + '\n');
    syncDirectory(destination); syncDirectory(dirname(destination));
    verifyBackup(destination);
    return { status: 'backup_created', directory: destination, schema_version: schemaVersion };
  });
}

export function restoreState(input: string, output: string) {
  const source = directoryPath(input), manifest = verifyBackup(source);
  const destination = newDestination(output, source);
  // Keep the lock database inode in place even on failure; never remove a live lock.
  const lock = new DirectoryLock(destination);
  let db: DatabaseSync | undefined;
  try {
    privateWrite(join(destination, restoreMarkerFile), 'Restore did not finish. Use a new destination.\n');
    for (const name of [databaseFile, keyFile] as const) {
      copyFileSync(join(source, name), join(destination, name), constants.COPYFILE_EXCL);
      chmodSync(join(destination, name), 0o600);
      if (checksum(join(destination, name)) !== manifest.files[name]) throw new Error('Backup changed during restore. Use an intact backup and a new destination.');
      syncFile(join(destination, name));
    }
    db = new DatabaseSync(join(destination, databaseFile));
    db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
    try {
      inspectDatabase(db, keyAt(destination));
      // A restored backup must not resurrect old browser sessions.
      db.exec('DELETE FROM sessions;');
      db.prepare('INSERT INTO audit VALUES (?, ?, ?, ?, ?, ?)').run(id(), 'default', 'local-cli', 'backup.restore', manifest.created_at, now());
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    db.close(); db = undefined;
    syncFile(join(destination, databaseFile));
    syncDirectory(destination);
    unlinkSync(join(destination, restoreMarkerFile));
    syncDirectory(destination); syncDirectory(dirname(destination));
    return { status: 'backup_restored', directory: destination, sessions_invalidated: true };
  } finally { try { db?.close(); } finally { lock.close(); } }
}

export function validatePassword(password: string) {
  if (password.length < 12 || password.length > 200 || /[\r\n\0]/.test(password)) throw new Error('Password must contain 12–200 characters on one line, without NUL characters.');
}
export function resetPassword(path: string, email: string, password: string) {
  validatePassword(password);
  const parsed = z.string().trim().email().max(150).safeParse(email);
  if (!parsed.success) throw new Error('Provide a valid account email with --email.');
  return withState(path, true, db => {
    const user = db.prepare('SELECT id, workspace_id FROM users WHERE email=?').get(parsed.data.toLowerCase());
    if (!user) throw new Error('Account not found. No credentials were changed.');
    const stored = passwordHash(password);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(stored, user.id);
      const sessions = db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id).changes;
      db.prepare('INSERT INTO audit VALUES (?, ?, ?, ?, ?, ?)').run(id(), user.workspace_id, 'local-cli', 'account.password_reset', user.id, now());
      db.exec('COMMIT');
      return { status: 'password_reset', sessions_invalidated: Number(sessions) };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  });
}
