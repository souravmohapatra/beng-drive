import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

const mounts = await fs.readFile('/proc/self/mountinfo', 'utf8');
const line = mounts.split('\n').find(part => part.split(' - ')[0]?.split(' ')[4] === '/data');
assert.ok(line, 'fixture mount absent');
assert.equal(line.split(' - ')[1].split(' ').slice(0, 2).join(' '), 'nfs bd-t03-server:/export');
assert.ok(!line.split(' - ')[0].includes(' shared:'), 'shared mount propagation');
const stat = await fs.stat('/data');
assert.equal(stat.uid, 1000);
assert.equal(stat.mode & 0o777, 0o700);
console.log('HARD_NFS_CLIENT_PREFLIGHT', line.split(' - ')[1], 'uid', stat.uid, 'mode', (stat.mode & 0o777).toString(8));
setInterval(() => {}, 1000);
