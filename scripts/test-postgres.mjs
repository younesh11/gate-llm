// Owns a disposable database. Never runs destructive tests against DATABASE_URL.
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

const major = process.env.GATE_TEST_POSTGRES_MAJOR ?? '18';
if (!['16','18'].includes(major)) throw new Error('GATE_TEST_POSTGRES_MAJOR must be 16 or 18.');
const name = `gate-pg-test-${randomUUID()}`;
const password = randomBytes(24).toString('hex');
const docker = args => execFileSync('docker', args, {encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:60000});
let started=false;
try {
  docker(['run','--rm','-d','--name',name,'--label','gate.purpose=disposable-postgres-test','--tmpfs',major === '16' ? '/var/lib/postgresql/data:rw' : '/var/lib/postgresql:rw','-e',`POSTGRES_PASSWORD=${password}`,'-e','POSTGRES_DB=gate_test','-p','127.0.0.1::5432',`postgres:${major}-alpine`]);
  started=true;
  let ready=false;
  for(let attempt=0;attempt<40;attempt++) {
    try {docker(['exec',name,'pg_isready','-h','127.0.0.1','-U','postgres','-d','gate_test']);ready=true;break;} catch {await setTimeout(500);}
  }
  if(!ready)throw new Error('Test PostgreSQL did not become ready.');
  const binding=docker(['port',name,'5432/tcp']).trim();
  if(!/^127\.0\.0\.1:\d+$/.test(binding))throw new Error('Unexpected test database binding.');
  const url=`postgresql://postgres:${password}@${binding}/gate_test`;
  execFileSync(process.execPath,['--import','tsx','--test','tests/postgres/storage.test.ts','tests/postgres/application.test.ts'],{stdio:'inherit',env:{...process.env,GATE_TEST_POSTGRES_URL:url,GATE_TEST_POSTGRES_CONTAINER:name},timeout:120000});
} catch {
  console.error('PostgreSQL integration tests failed. Check Docker availability and the test output.');
  process.exitCode=1;
} finally {
  if(started)try {docker(['stop','-t','2',name]);}catch {console.error(`Could not stop disposable test container ${name}.`);process.exitCode=1;}
}
