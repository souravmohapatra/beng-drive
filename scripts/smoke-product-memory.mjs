import { execFileSync } from 'node:child_process';

const host = 'beng-mini-pc';
const ssh = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ConnectionAttempts=1', host];
const remote = command => execFileSync('ssh', [...ssh, command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
if (remote('hostname; id -un') !== 'beng-mini-pc\nbeng') throw new Error('Unexpected remote identity');
const stage = remote('mktemp -d /home/beng/bd-t09-rss-XXXXXXXX');
if (!/^\/home\/beng\/bd-t09-rss-[A-Za-z0-9]+$/.test(stage)) throw new Error('Unexpected fixture path');
const files = ['package.json', 'package-lock.json', 'src/server', 'test/uploads.test.mjs',
  'test/fixtures/product-upload-server.mjs', 'scripts/fixtures/product-memory-runner.py'];
const target = `${host}:${stage}/`;
let safe = false;
try {
  const dry = execFileSync('rsync', ['-anRv', ...files, target], { encoding: 'utf8' });
  if (/\.agent|\.env|node_modules|\.git/.test(dry)) throw new Error('Unsafe transfer list');
  console.log(`ALLOWLIST_DRY_RUN\n${dry}`);
  execFileSync('rsync', ['-aRv', ...files, target], { encoding: 'utf8' });
  const result = remote(`python3 '${stage}/scripts/fixtures/product-memory-runner.py' '${stage}'`);
  console.log(result);
  safe = result.includes('PRODUCT_MEMORY_PASS') && result.includes('FIXTURE_CONTAINERS_CLEAN_PASS');
  if (!safe) throw new Error('Memory proof or cleanup incomplete');
} finally {
  if (safe) remote(`rm -rf -- '${stage}'`);
  else console.error(`Fixture retained for safe cleanup: ${stage}`);
}
