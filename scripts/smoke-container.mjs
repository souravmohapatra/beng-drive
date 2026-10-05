import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const host = 'beng-mini-pc';
const sshArgs = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ConnectionAttempts=1', host];
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, ...options }).trim();
const remote = command => run('ssh', [...sshArgs, command]);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const identity = remote('hostname; id -un').split('\n');
if (identity.join('/') !== 'beng-mini-pc/beng') throw new Error('Unexpected remote identity');
const ports = remote("ss -ltn | awk '{print $4}'");
if (ports.split('\n').some(x => /:(4310|4311|443)$/.test(x))) throw new Error('Fixture ports are occupied');

const project = `bdt02${process.pid}${Date.now()}`;
const dir = remote('mktemp -d /home/beng/bd-t02-XXXXXXXX');
if (!/^\/home\/beng\/bd-t02-[A-Za-z0-9]+$/.test(dir)) throw new Error('Unexpected fixture path');
const local = mkdtempSync(join(tmpdir(), 'bd-smoke-'));
const files = ['Dockerfile', '.dockerignore', 'compose.yaml', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.mjs', 'index.html', 'src/client', 'src/server'];
const source = `${host}:${dir}/`;
const compose = (suffix = project) => `cd ${quote(dir)} && docker compose -p ${suffix} --env-file fixture.env`;
const fixture = () => `NODE_ENV=test\nAPP_MODE=fixture\nPUBLIC_ORIGIN=https://drive.example.invalid\nADMIN_ORIGIN=https://admin.example.invalid\nADMIN_OWNER_LOGIN=fixture-owner@example.invalid\nSTATE_BIND_SOURCE=${dir}/state\nNAS_BIND_SOURCE=${dir}/nas\n`;
try {
  writeFileSync(join(local, 'fixture.env'), fixture(), { mode: 0o600 });
  const dry = run('rsync', ['-anRv', ...files, source]);
  if (/\.agent|\.git|\.env|node_modules|\.sqlite/.test(dry)) throw new Error('Unsafe dry-run transfer list');
  console.log(`ALLOWLIST_DRY_RUN\n${dry}`);
  run('rsync', ['-aRv', ...files, source]);
  run('rsync', ['-av', join(local, 'fixture.env'), source]);
  remote(`mkdir -m 700 ${quote(`${dir}/state`)} ${quote(`${dir}/nas`)}`);
  remote(`${compose()} config --quiet`);
  console.log('COMPOSE_CONFIG_OK');
  const bad = `${dir}/absent-nas`;
  remote(`sed -i 's|NAS_BIND_SOURCE=.*|NAS_BIND_SOURCE=${bad}|' ${quote(`${dir}/fixture.env`)}`);
  let missingError = '';
  try { remote(`${compose(`${project}bad`)} up -d --build`); } catch (error) { missingError = error.stderr; }
  if (!missingError.includes(`bind source path does not exist: ${bad}`) || remote(`test ! -e ${quote(bad)} && echo absent`) !== 'absent') throw new Error('Missing NAS bind did not fail closed');
  console.log('MISSING_BIND_REJECTED');
  remote(`${compose(`${project}bad`)} down --rmi local --remove-orphans >/dev/null 2>&1 || true`);
  run('rsync', ['-av', join(local, 'fixture.env'), source]);
  remote(`${compose()} up -d --build`);
  const container = remote(`${compose()} ps -q app`);
  if (!/^[0-9a-f]{12,64}$/.test(container)) throw new Error('No fixture container');
  const image = remote(`docker inspect -f '{{.Image}}' ${container}`);
  const runtime = remote(`docker exec ${container} node -e "import('node:sqlite').then(({DatabaseSync})=>{let db=new DatabaseSync(':memory:');console.log(process.version,db.prepare('SELECT sqlite_version() AS v').get().v)})"`);
  const uid = remote(`docker exec ${container} id -u; docker exec ${container} id -g`);
  const portsShown = remote(`docker port ${container}`);
  const restart = remote(`docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' ${container}`);
  const mounts = JSON.parse(remote(`docker inspect -f '{{json .Mounts}}' ${container}`));
  const inventory = remote(`docker exec ${container} find /app -maxdepth 2 -mindepth 1 -print`);
  if (/\/app\/(\.agent|\.agents|\.git|\.env|.*\.sqlite)/.test(inventory)) throw new Error('Forbidden image content');
  if (!portsShown.includes('127.0.0.1:4310') || portsShown.includes('4311')) throw new Error('Port publication mismatch');
  if (restart !== 'unless-stopped' || mounts.length !== 2 || !mounts.some(m => m.Source === `${dir}/state` && m.Destination === '/var/lib/beng-drive') || !mounts.some(m => m.Source === `${dir}/nas` && m.Destination === '/data')) throw new Error('Runtime mount or restart policy mismatch');
  if (runtime !== 'v24.21.0 3.53.4' || uid !== '1000\n1000') throw new Error('Runtime mismatch');
  const socket = `${dir}/state/admin.sock`;
  if (remote(`stat -c '%a' ${quote(socket)}`) !== '600') throw new Error('Admin socket mode mismatch');
  console.log(`IMAGE ${image}\nRUNTIME ${runtime}\nUID_GID ${uid.replace('\n', ':')}\nPORTS ${portsShown.replaceAll('\n', '; ')}\nRESTART ${restart}\nSCOPED_BINDS_OK\nADMIN_SOCKET_MODE 600`);
  const probe = remote(`curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:4310/health/live; curl -sS -o /dev/null -w ' %{http_code}' -H 'Tailscale-User-Login: fixture-owner@example.invalid' http://127.0.0.1:4310/api/admin/session; curl --unix-socket ${quote(socket)} -sS -o /dev/null -w ' %{http_code}' -H 'Tailscale-User-Login: fixture-owner@example.invalid' http://localhost/api/admin/session; curl --unix-socket ${quote(socket)} -sS -o /dev/null -w ' %{http_code}' -H 'Tailscale-User-Login: fixture-owner@example.invalid' http://localhost/health/ready`);
  if (probe !== '200 403 200 503') throw new Error(`Unexpected loopback results ${probe}`);
  const health = JSON.parse(remote(`curl --unix-socket ${quote(socket)} -fsS -H 'Tailscale-User-Login: fixture-owner@example.invalid' http://localhost/api/admin/health`));
  if (!['available','unavailable'].includes(health.storage) || health.cleanup.pending !== 0 || health.cleanup.overdue !== 0 || health.cleanup.lastSuccessAt !== null) throw new Error('Private cleanup health shape mismatch');
  console.log('PRIVATE_CLEANUP_HEALTH_PASS', JSON.stringify(health));
  const untrusted = remote(`docker exec --user 65534:65534 ${container} node -e "const h=require('node:http');h.get({socketPath:'/var/lib/beng-drive/admin.sock',path:'/api/admin/session',headers:{'Tailscale-User-Login':'fixture-owner@example.invalid'}},()=>process.exit(1)).on('error',e=>{console.log(e.code);process.exit(e.code==='EACCES'?0:1)})"`);
  if (untrusted !== 'EACCES') throw new Error('Untrusted container user reached admin socket');
  const marker = `fixture${process.pid}${Date.now()}`;
  const dbEval = source => remote(`${compose()} exec -T app node -e ${quote(source)}`);
  const dbPath = '/var/lib/beng-drive/app.sqlite';
  dbEval(`const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('${dbPath}');d.exec('CREATE TABLE fixture_sentinel (value TEXT NOT NULL)');d.prepare('INSERT INTO fixture_sentinel VALUES (?)').run('${marker}');d.close()`);
  const readMarker = () => dbEval(`const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('${dbPath}');console.log(d.prepare('SELECT value FROM fixture_sentinel').get().value);d.close()`);
  if (dbEval(`const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('${dbPath}');console.log(d.prepare('PRAGMA user_version').get().user_version);d.close()`) !== '6') throw new Error('Schema v6 missing from package');
  const hostDb = `${dir}/state/app.sqlite`;
  const inode = remote(`test -s ${quote(hostDb)} && stat -c '%i' ${quote(hostDb)}`);
  const before = readMarker();
  const beforeContainer = remote(`${compose()} ps -q app`);
  remote(`${compose()} restart app`);
  const afterRestart = readMarker();
  const restartedContainer = remote(`${compose()} ps -q app`);
  remote(`${compose()} up -d --force-recreate`);
  const afterRecreate = readMarker();
  const recreatedContainer = remote(`${compose()} ps -q app`);
  const finalInode = remote(`test -s ${quote(hostDb)} && stat -c '%i' ${quote(hostDb)}`);
  if (before !== marker || afterRestart !== marker || afterRecreate !== marker || beforeContainer !== restartedContainer || beforeContainer === recreatedContainer || inode !== finalInode) throw new Error('SQLite sentinel or host bind was not retained');
  console.log(`LOOPBACK ${probe}\nUNTRUSTED ${untrusted}\nDB_SENTINEL ${before}->${afterRestart}->${afterRecreate}\nHOST_DB_INODE_STABLE ${inode}`);

  // Stop automatic restarts only for this exact disposable container so exit and stale socket are observable.
  remote(`docker update --restart=no ${recreatedContainer}`);
  const oldPid = remote(`docker inspect -f '{{.State.Pid}}' ${recreatedContainer}`);
  remote(`docker kill --signal=KILL ${recreatedContainer}`);
  const killed = remote(`docker wait ${recreatedContainer}`);
  if (killed !== '137' || remote(`docker inspect -f '{{.State.Running}}' ${recreatedContainer}`) !== 'false') throw new Error('Exact fixture process did not exit after kill');
  const stale = remote(`stat -c '%F %a %u %i' ${quote(socket)}`);
  if (!/^socket 600 1000 \d+$/.test(stale)) throw new Error('Abrupt exit did not retain expected stale socket');
  remote(`docker start ${recreatedContainer}`);
  remote("for i in $(seq 1 40); do curl -fsS -o /dev/null http://127.0.0.1:4310/health/live && exit 0; sleep .25; done; exit 1");
  const newPid = remote(`docker inspect -f '{{.State.Pid}}' ${recreatedContainer}`);
  const afterAbrupt = readMarker();
  const socketAfterAbrupt = remote(`stat -c '%F %a %u' ${quote(socket)}`);
  const abruptProbe = remote(`curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:4310/health/live; curl -sS -o /dev/null -w ' %{http_code}' -H 'Tailscale-User-Login: fixture-owner@example.invalid' http://127.0.0.1:4310/api/admin/session; curl --unix-socket ${quote(socket)} -sS -o /dev/null -w ' %{http_code}' -H 'Tailscale-User-Login: fixture-owner@example.invalid' http://localhost/api/admin/session`);
  if (oldPid === newPid || !/^\d+$/.test(newPid) || afterAbrupt !== marker || socketAfterAbrupt !== 'socket 600 1000' || abruptProbe !== '200 403 200' || remote(`stat -c '%i' ${quote(hostDb)}`) !== inode) throw new Error('Abrupt restart failed persistent state or routing');
  console.log(`ABRUPT_EXIT_VERIFIED ${recreatedContainer} ${oldPid}->${newPid} exit=${killed} stale=${stale}`);
  console.log(`ABRUPT_RESTART_PASS sentinel=${afterAbrupt} socket=${socketAfterAbrupt} routes=${abruptProbe}`);

  // A root helper sees only this disposable state bind; a foreign-owned stale socket must fail closed.
  remote(`docker kill --signal=KILL ${recreatedContainer}`);
  if (remote(`docker wait ${recreatedContainer}`) !== '137') throw new Error('Foreign-owner fixture process did not exit');
  const ownerHelper = (name, uid) => remote(`docker run --rm --name ${project}${name} --network none --user 0:0 --mount ${quote(`type=bind,src=${dir}/state,dst=/state`)} ${image} chown ${uid}:${uid} /state/admin.sock`);
  ownerHelper('foreign',65534);
  const foreign = remote(`stat -c '%F %a %u %i' ${quote(socket)}`);
  if (!/^socket 600 65534 \d+$/.test(foreign)) throw new Error('Foreign-owner fixture setup failed');
  remote(`docker start ${recreatedContainer}`);
  const rejected = remote(`docker wait ${recreatedContainer}`);
  const foreignAfter = remote(`stat -c '%F %a %u %i' ${quote(socket)}`);
  const foreignLog = remote(`docker logs --tail 3 ${recreatedContainer} 2>&1`);
  console.log('FOREIGN_SOCKET_DIAGNOSTIC', JSON.stringify({rejected,foreign,foreignAfter,startupFailed:foreignLog.includes('startup_failed')}));
  if (rejected !== '1' || foreignAfter !== foreign || !foreignLog.includes('startup_failed')) throw new Error('Foreign-owned socket was not rejected unchanged');
  console.log(`FOREIGN_SOCKET_REJECTED ${recreatedContainer} exit=${rejected} socket=${foreign}`);
  ownerHelper('restore',1000);
  remote(`docker start ${recreatedContainer}`);
  remote("for i in $(seq 1 40); do curl -fsS -o /dev/null http://127.0.0.1:4310/health/live && exit 0; sleep .25; done; exit 1");
  if (readMarker() !== marker || remote(`stat -c '%F %a %u' ${quote(socket)}`) !== 'socket 600 1000') throw new Error('Fixture did not recover after exact owner restore');
  remote(`docker update --restart=unless-stopped ${recreatedContainer}`);
  console.log('FOREIGN_SOCKET_RESTORE_PASS');
} finally {
  try { remote(`${compose()} down --rmi local --remove-orphans >/dev/null 2>&1 || true`); } catch {}
  try { remote(`${compose(`${project}bad`)} down --rmi local --remove-orphans >/dev/null 2>&1 || true`); } catch {}
  try { remote(`rm -rf -- ${quote(dir)}`); } catch {}
  rmSync(local, { recursive: true, force: true });
}
