// Test the documented setup in a fresh copy and a disposable Compose project.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';

const root = new URL('../',import.meta.url);
const directory=mkdtempSync(join(tmpdir(),'gate-compose-'));
const project=`gate-setup-${randomUUID()}`;
const env={...process.env,COMPOSE_PROJECT_NAME:project,GATE_PORT:'0',GATE_BIND:'127.0.0.1',GATE_IMAGE:process.argv[2]??'gate-llm:setup-test',AWS_ACCESS_KEY_ID:'',AWS_SECRET_ACCESS_KEY:'',AWS_SESSION_TOKEN:'',AWS_PROFILE:'',AWS_REGION:'eu-west-2',COOKIE_SECURE:'false',ALLOW_PRIVATE_UPSTREAMS:'false',LOG_LEVEL:'warn'};
// Prevent ambient Compose selectors from connecting the test to another project's state.
for(const key of ['COMPOSE_FILE','COMPOSE_ENV_FILES','COMPOSE_PROFILES','COMPOSE_PROJECT_DIRECTORY'])delete env[key];
const run=(command,args,inherit=false)=>execFileSync(command,args,{cwd:directory,env,encoding:'utf8',timeout:600000,stdio:inherit?'inherit':['ignore','pipe','pipe']});
const compose=(...args)=>run('docker',['compose',...args]);
let started=false;
try {
  for(const path of ['Dockerfile','compose.yaml','.dockerignore','.env.example','package.json','package-lock.json','tsconfig.json','tsconfig.build.json','vite.config.ts','index.html','LICENSE','server','client','scripts','tests'])cpSync(new URL(path,root),join(directory,path),{recursive:true});
  started=true;
  run('bash',['scripts/start.sh'],true);
  const configuration=JSON.parse(compose('config','--format','json'));
  assert.equal(configuration.services.relay.ports[0].host_ip,'127.0.0.1');
  assert.equal(configuration.services.relay.ports[0].target,4310);
  assert.equal(configuration.services.relay.read_only,true);
  assert.equal(statSync(join(directory,'.env')).mode & 0o777,0o600);
  const origin=()=>`http://${compose('port','relay','4310').trim()}`;
  const initial=origin();assert.notEqual(new URL(initial).port,'4310');
  assert.equal((await fetch(`${initial}/ready`)).status,200);
  assert.equal((await (await fetch(`${initial}/api/session`)).json()).setup,true);
  const setup=await fetch(`${initial}/api/setup`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({workspace:'Compose QA',name:'QA Owner',email:'compose@example.test',password:'synthetic-compose-password'})});
  assert.equal(setup.status,200);
  const cookie=setup.headers.get('set-cookie').split(';')[0];
  // Recreate with a different host port, preserving both configuration and data.
  const oldPort=new URL(initial).port;
  compose('down');
  const probe=createServer();
  await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve);});
  const newPort=probe.address().port;
  await new Promise((resolve,reject)=>probe.close(error=>error?reject(error):resolve()));
  const saved=readFileSync(join(directory,'.env'),'utf8').replace(/^GATE_PORT=.*$/m,`GATE_PORT=${newPort}`)+'\n# Preserve this local comment.\n';
  writeFileSync(join(directory,'.env'),saved);
  delete env.GATE_PORT;
  run('bash',['scripts/start.sh'],true);
  const restarted=origin();
  assert.equal(new URL(restarted).port,String(newPort),'port setting from .env is applied');
  assert.equal(readFileSync(join(directory,'.env'),'utf8'),saved);
  assert.equal((await (await fetch(`${restarted}/api/session`)).json()).setup,false);
  assert.equal((await fetch(`${restarted}/api/admin/state`,{headers:{cookie}})).status,200);
  assert.equal((await fetch(`${restarted}/v1/models`)).status,401);
  console.log(`Fresh Compose setup passed: private .env, owner setup, host port ${oldPort} -> ${new URL(restarted).port}, persistent data/session, API authentication.`);
} finally {
  let cleaned=!started;
  if(started)try {compose('down','--volumes','--remove-orphans');cleaned=true;}catch {console.error(`Cleanup failed for disposable Compose project ${project} in ${directory}.`);process.exitCode=1;}
  if(cleaned)rmSync(directory,{recursive:true,force:true});
}
