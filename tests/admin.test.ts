import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.ts';
import { Store, now, hash, passwordHash } from '../server/store.ts';
import { notificationSchema } from '../server/notification-schema.ts';
import { adminScenario } from './fixtures/admin-scenario.ts';

test('SQLite admin authorization contract',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'gate-admin-'));
  const opened=await createApp({directory,allowPrivate:true,logLevel:'silent',publicBaseUrl:'http://localhost:4310',notificationWorker:false,notificationTransport:{email:true,sns:false,async send(){return 'test';}}});
  t.after(async()=>{await opened.app.close();rmSync(directory,{recursive:true});});
  await adminScenario(t,opened);
});

test('SQLite schema 7 invitation upgrade retains existing tokens and delivery references',()=>{
  const directory=mkdtempSync(join(tmpdir(),'gate-admin-migration-'));
  let db=new Store(directory);
  try {
    db.run('INSERT INTO users VALUES (?,?,?,?,?,?,?)','owner','default','Owner','owner@migration.test',passwordHash('synthetic-password'),'owner',now());
    db.db.exec('DROP TABLE invitations;');db.db.exec(notificationSchema);
    db.run('INSERT INTO invitations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)','existing','default','owner','Member','member@migration.test','member',hash('old-token'),'[]',null,'pending',Date.now()+86400000,now());
    db.run('INSERT INTO notification_deliveries (id,workspace_id,invitation_id,channel,dedupe,title,payload,status,next_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)','delivery','default','existing','email','existing','Invite','encrypted-payload','pending',0,now());
    db.db.exec('PRAGMA user_version=7');db.close();db=new Store(directory);
    assert.equal(db.get('PRAGMA user_version')!.user_version,8);
    assert.equal(db.get('SELECT token_hash FROM invitations WHERE id=?','existing')!.token_hash,hash('old-token'));
    assert.equal(db.get('SELECT invitation_id FROM notification_deliveries')!.invitation_id,'existing');
    db.run("UPDATE invitations SET role='admin' WHERE id='existing'");
    assert.throws(()=>db.run("UPDATE invitations SET role='owner' WHERE id='existing'"));
  } finally {db.close();rmSync(directory,{recursive:true});}
});
