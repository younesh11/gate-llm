import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, copyFileSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { verifyBackup } from '../maintenance.ts';
import { id, now, schemaVersion } from '../store.ts';
import { PostgresAppStore } from './app-store.ts';
import type { PostgresOptions } from './database.ts';

const tables = ['workspaces','users','providers','deployments','policies','virtual_keys','rate_windows','requests','reservations','audit','usage_daily','member_access','member_allowances','member_usage','member_keys','member_holds','allowance_requests','deployment_requests','notification_settings','invitations','notifications','notification_deliveries','alert_pending'] as const;

/** Offline, all-or-nothing import of a verified backup. Never modifies the source. */
export async function importSqlite(input: string, directory: string, options: PostgresOptions) {
  const source = resolve(input), destination = resolve(directory);
  const manifest = verifyBackup(source);
  if (manifest.schema_version !== schemaVersion) throw new Error('Upgrade SQLite with this GATE version and create a new backup before importing.');
  // Refuse even an empty existing directory: the source and target must be unmistakable.
  mkdirSync(destination, { mode: 0o700 });
  writeFileSync(join(destination,'postgres-import.incomplete'), 'Import has not completed. Do not start this installation.\n', { flag:'wx',mode:0o600 });
  copyFileSync(join(source,'encryption.key'),join(destination,'encryption.key'));
  chmodSync(join(destination,'encryption.key'),0o600);
  const sqlite = new DatabaseSync(join(source,'relay.sqlite'),{readOnly:true});
  let target: PostgresAppStore | undefined;
  const counts: Record<string,number> = {};
  try {
    target = await PostgresAppStore.open(destination, options, true);
    const db = target;
    await db.transaction(async () => {
      for (const table of [...tables.filter(t=>t!=='workspaces'),'sessions']) {
        if ((await db.get(`SELECT COUNT(*) AS count FROM ${table}`))!.count !== 0) throw new Error('Import requires an empty PostgreSQL application database.');
      }
      const workspaces = await db.all('SELECT * FROM workspaces');
      if (workspaces.length !== 1 || workspaces[0].id !== 'default') throw new Error('Import requires an empty PostgreSQL application database.');
      await db.run('DELETE FROM workspaces');
      for (const table of tables) {
        const columns = (sqlite.prepare(`PRAGMA table_info(${table})`).all()).map(c=>String(c.name));
        const statement = `INSERT INTO ${table} (${columns.map(c=>`"${c.replaceAll('"', '""')}"`).join(',')}) VALUES (${columns.map(()=>'?').join(',')})`;
        counts[table] = 0;
        for (const row of sqlite.prepare(`SELECT * FROM ${table}`).iterate()) {
          await db.run(statement, ...columns.map(c=>row[c])); counts[table]++;
        }
        if ((await db.get(`SELECT COUNT(*) AS count FROM ${table}`))!.count !== counts[table]) throw new Error('Import verification failed.');
      }
      // Browser sessions are intentionally invalidated. API key hashes and usage remain intact.
      await db.run('INSERT INTO audit VALUES (?,?,?,?,?,?)',id(),'default','system','storage.imported','SQLite backup → PostgreSQL',now());
      // Old-origin invitation links must be regenerated after migration.
      await db.run("UPDATE invitations SET status='revoked' WHERE status='pending'");
      await db.run("UPDATE notification_deliveries SET status='cancelled',payload='',claim=NULL WHERE invitation_id IS NOT NULL AND status IN ('pending','sending')");
      for (const provider of await db.all("SELECT secret FROM providers WHERE secret<>''")) db.unseal(provider.secret);
    });
    unlinkSync(join(destination,'postgres-import.incomplete'));
    return { status:'postgres_imported',directory:destination,counts,sessions_invalidated:true };
  } finally { sqlite.close(); await target?.close(); }
}
