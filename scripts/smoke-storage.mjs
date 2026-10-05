import { execFileSync } from 'node:child_process';

const mode = process.argv[2];
if (!['--nas-write', '--hard-nfs', '--nas-transfer', '--cleanup-negative'].includes(mode)) throw new Error('Use --nas-write, --hard-nfs, --nas-transfer or --cleanup-negative');
const ssh = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ConnectionAttempts=1', 'beng-mini-pc'];
const remote = (command, input) => execFileSync('ssh', [...ssh, command], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
if (remote('hostname; id -un') !== 'beng-mini-pc\nbeng') throw new Error('Unexpected remote identity');

if (mode === '--cleanup-negative') {
  const dir = remote('mktemp -d /home/beng/bd-t03-negative-XXXXXXXX');
  if (!/^\/home\/beng\/bd-t03-negative-[A-Za-z0-9]+$/.test(dir)) throw new Error('Unexpected fixture path');
  const files = ['scripts/fixtures/nas_tus_cleanup.py', 'scripts/fixtures/nas-cleanup-negative.py'];
  const destination = `beng-mini-pc:${dir}/`;
  const dry = execFileSync('rsync', ['-anRv', ...files, destination], { encoding: 'utf8' });
  if (/\.agent|\.env|node_modules|\.git/.test(dry)) throw new Error('Unsafe transfer list');
  let clean = false;
  try {
    execFileSync('rsync', ['-aRv', ...files, destination], { encoding: 'utf8' });
    const result = remote(`python3 '${dir}/scripts/fixtures/nas-cleanup-negative.py' '${dir}'`);
    console.log(result);
    clean = result.includes('NEGATIVE_CLEAN_PASS');
    if (!result.includes('BLOCKED_RETAIN_PASS') || !clean) throw new Error('Cleanup negative proof incomplete');
  } catch (error) {
    const output = String(error.stdout || '');
    if (output) console.error(output);
    clean ||= output.includes('NEGATIVE_CLEAN_PASS');
    throw error;
  } finally {
    if (clean) remote(`rm -rf -- '${dir}'`);
    else console.error(`Fixture retained for safe cleanup: ${dir}`);
  }
} else if (mode === '--nas-transfer') {
  const dir = remote('mktemp -d /home/beng/bd-t03-nas-XXXXXXXX');
  if (!/^\/home\/beng\/bd-t03-nas-[A-Za-z0-9]+$/.test(dir)) throw new Error('Unexpected fixture path');
  const files = [
    'package.json', 'package-lock.json', 'src/server/storage/pool.mjs', 'src/server/storage/worker.mjs',
    'test/fixtures/tus-server.mjs', 'test/fixtures/tus-server-cli.mjs',
    'scripts/fixtures/Dockerfile.nas-tus', 'scripts/fixtures/nas-tus-transfer.mjs',
    'scripts/fixtures/nas-tus-runner.py', 'scripts/fixtures/nas_tus_cleanup.py',
  ];
  const destination = `beng-mini-pc:${dir}/`;
  const dry = execFileSync('rsync', ['-anRv', ...files, destination], { encoding: 'utf8' });
  if (/\.agent|\.env|node_modules|\.git/.test(dry)) throw new Error('Unsafe transfer list');
  let clean = false;
  try {
    execFileSync('rsync', ['-aRv', ...files, destination], { encoding: 'utf8' });
    const result = remote(`python3 '${dir}/scripts/fixtures/nas-tus-runner.py' '${dir}'`);
    console.log(result);
    clean = result.includes('NAS_FIXTURE_CLEAN_PASS');
    if (!result.includes('NAS_TUS_PASS') || !clean) throw new Error('NAS tus transfer incomplete');
  } catch (error) {
    const output = String(error.stdout || '');
    if (output) console.error(output);
    clean ||= output.includes('NAS_FIXTURE_CLEAN_PASS');
    throw error;
  } finally {
    if (clean) remote(`rm -rf -- '${dir}'`);
    else console.error(`Fixture retained for safe cleanup: ${dir}`);
  }
} else if (mode === '--hard-nfs') {
  const dir = remote('mktemp -d /home/beng/bd-t03-hard-XXXXXXXX');
  if (!/^\/home\/beng\/bd-t03-hard-[A-Za-z0-9]+$/.test(dir)) throw new Error('Unexpected fixture path');
  const files = [
    'package.json', 'package-lock.json', 'src/server/storage/pool.mjs', 'src/server/storage/worker.mjs',
    'test/fixtures/tus-server.mjs', 'test/fixtures/tus-server-cli.mjs',
    'scripts/fixtures/Dockerfile.hard-nfs-server', 'scripts/fixtures/Dockerfile.hard-nfs-client',
    'scripts/fixtures/ganesha.conf', 'scripts/fixtures/hard-nfs-client.mjs',
    'scripts/fixtures/hard-nfs-probe.mjs', 'scripts/fixtures/hard-nfs-fault.mjs',
    'scripts/fixtures/hard-nfs-runner.py', 'scripts/fixtures/watchdog.sh',
  ];
  const destination = `beng-mini-pc:${dir}/`;
  const dry = execFileSync('rsync', ['-anRv', ...files, destination], { encoding: 'utf8' });
  if (/\.agent|\.env|node_modules|\.git/.test(dry)) throw new Error('Unsafe transfer list');
  let clean = false;
  try {
    execFileSync('rsync', ['-aRv', ...files, destination], { encoding: 'utf8' });
    const result = remote(`python3 '${dir}/scripts/fixtures/hard-nfs-runner.py' '${dir}'`);
    console.log(result);
    clean = result.includes('FIXTURE_CLEAN_PASS');
    if (!result.includes('HARD_NFS_PASS') || !clean) throw new Error('Hard-NFS proof incomplete');
  } catch (error) {
    const output = String(error.stdout || '');
    if (output) console.error(output);
    clean ||= output.includes('FIXTURE_CLEAN_PASS');
    throw error;
  } finally {
    if (clean) remote(`rm -rf -- '${dir}'`);
    else console.error(`Fixture retained for safe cleanup: ${dir}`);
  }
} else {
  const program = `import hashlib, os, pathlib, secrets, stat, subprocess
root = pathlib.Path('/mnt/nas/workspace/beng-drive')
source = subprocess.check_output(['findmnt','-rn','-T','/mnt/nas/workspace','-o','SOURCE,FSTYPE'], text=True).strip()
if source != '192.168.68.67:/volume3/workspace nfs': raise RuntimeError('wrong mount identity')
st = root.lstat()
if not stat.S_ISDIR(st.st_mode) or (st.st_uid,st.st_gid) != (1000,10) or stat.S_IMODE(st.st_mode) != 0o700: raise RuntimeError('root changed')
acl = subprocess.check_output(['getfacl','-cp',str(root)], text=True).strip().splitlines()
if acl != ['user::rwx','group::---','other::---']: raise RuntimeError('unexpected ACL')
if any(root.iterdir()): raise RuntimeError('root not empty')
fixture = root / ('bd-t03-' + secrets.token_hex(8))
os.mkdir(fixture, 0o700)
partial = fixture / 'payload.part'
finished = fixture / 'payload.final'
chunk = bytes(range(256))*256
digest = hashlib.sha256()
try:
    fd = os.open(partial, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
    try:
        for _ in range(16):
            os.write(fd,chunk); digest.update(chunk)
        os.fsync(fd)
    finally: os.close(fd)
    os.rename(partial,finished)
    dirfd = os.open(fixture, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try: os.fsync(dirfd)
    finally: os.close(dirfd)
    actual = hashlib.sha256(finished.read_bytes()).hexdigest()
    if actual != digest.hexdigest(): raise RuntimeError('hash mismatch')
    fs = os.statvfs(fixture)
    print('NAS_WRITE_PASS', 'fixture='+str(fixture), 'bytes='+str(finished.stat().st_size), 'mode='+oct(stat.S_IMODE(finished.lstat().st_mode)), 'sha256='+actual, 'free_bytes='+str(fs.f_bavail*fs.f_frsize))
finally:
    partial.unlink(missing_ok=True); finished.unlink(missing_ok=True); fixture.rmdir()
    print('FIXTURE_REMOVED',fixture.name)
`;
  console.log(remote('python3 -', program));
  const inspect = remote(`docker run --rm --network none --user 1000:1000 --mount type=bind,src=/mnt/nas/workspace/beng-drive,dst=/data,readonly node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 node -e 'const fs=require("node:fs");const line=fs.readFileSync("/proc/self/mountinfo","utf8").split("\\n").find(x=>x.split(" - ")[0].split(" ")[4]==="/data");const [type,source]=line.split(" - ")[1].split(" ");if(type!=="nfs"||source!=="192.168.68.67:/volume3/workspace/beng-drive"||fs.statfsSync("/data").type!==0x6969)process.exit(1);console.log("CONTAINER_MOUNT_PASS",type,source)'`);
  console.log(inspect);
  const dir = remote('mktemp -d /home/beng/bd-t03-XXXXXXXX');
  if (!/^\/home\/beng\/bd-t03-[A-Za-z0-9]+$/.test(dir)) throw new Error('Unexpected fixture path');
  try {
    const files = ['src/server/storage/pool.mjs', 'src/server/storage/worker.mjs'];
    const destination = `beng-mini-pc:${dir}/`;
    const dry = execFileSync('rsync', ['-anRv', ...files, destination], { encoding: 'utf8' });
    if (/\.agent|\.env|node_modules|\.git/.test(dry)) throw new Error('Unsafe transfer list');
    execFileSync('rsync', ['-aRv', ...files, destination], { encoding: 'utf8' });
    const result = remote(`docker run --rm --network none --user 1000:1000 --mount type=bind,src=${dir}/src/server/storage,dst=/code,readonly --mount type=bind,src=/mnt/nas/workspace/beng-drive,dst=/data,readonly node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 node -e 'import("/code/pool.mjs").then(async ({StoragePool})=>{const p=new StoragePool({root:"/data",expectedSource:"192.168.68.67:/volume3/workspace/beng-drive"});if(!await p.readiness())process.exit(1);console.log("ADAPTER_READINESS_PASS",p.counts.active,p.counts.pending)})'`);
    console.log(result);
  } finally { remote(`rm -rf -- '${dir}'`); }
}
