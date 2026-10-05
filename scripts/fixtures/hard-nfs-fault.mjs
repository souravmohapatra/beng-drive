import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import { StoragePool } from '../../src/server/storage/pool.mjs';

const pool = new StoragePool({ root: '/data', expectedSource: 'bd-t03-server:/export' });
const ids = Array.from({ length: 10 }, () => randomBytes(16).toString('hex'));
const collectionId = '11111111-1111-1111-1111-111111111111';
const grantId = '22222222-2222-2222-2222-222222222222';
const payload = Buffer.alloc(65536, 0x7a);
const expectedHash = createHash('sha256').update(payload).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = createServer(async (req, res) => {
  if (req.url === '/health/live') { res.writeHead(200); res.end('ok'); return; }
  if (req.url === '/health/ready') {
    const ready = await pool.readiness(); res.writeHead(ready ? 200 : 503); res.end(); return;
  }
  if (req.url === '/admit' || req.url === '/offset') {
    try {
      const value = req.url === '/offset' ? await pool.submit('stat', { id: ids[0] }, undefined, 2000) : await pool.submit('probe', {}, undefined, 2000);
      res.writeHead(200); res.end(JSON.stringify(value));
    } catch {
      res.writeHead(503, { 'Retry-After': '5' }); res.end();
    }
    return;
  }
  res.writeHead(404); res.end();
});
async function request(path) {
  const start = performance.now();
  const response = await fetch(`http://127.0.0.1:4362${path}`, { signal: AbortSignal.timeout(5000) });
  return { status: response.status, retryAfter: response.headers.get('retry-after'), elapsedMs: Math.round(performance.now() - start) };
}
async function sample(label, settled) {
  const children = (await fs.readFile(`/proc/${process.pid}/task/${process.pid}/children`, 'utf8')).trim();
  const result = { label, t: Math.round(performance.now()), ...pool.counts, settled, timedOut: timeoutResult, idLocked: pool.activeIds.has(ids[0]), pids: children ? children.split(' ').map(Number) : [], rss: process.memoryUsage().rss };
  console.log('FAULT_SAMPLE', JSON.stringify(result));
  return result;
}

let timeoutResult;

try {
  assert.equal(await pool.readiness(), true);
  for (const id of ids) await pool.submit('create', { id, size: payload.length, collectionId, grantId });
  await new Promise(resolve => server.listen(4362, '127.0.0.1', resolve));
  console.log('FAULT_READY', process.pid, ids[0]);
  await new Promise(resolve => process.stdin.once('data', resolve));
  process.stdin.pause();
  let settled = 0;
  const started = performance.now();
  const jobs = ids.map((id, index) => pool.submit('write', { id, offset: 0, collectionId, grantId }, Readable.from([payload]), index === 0 ? 2000 : 120000)
    .then(value => { settled++; return { value }; }, error => {
      settled++;
      const result = { code: error.code, elapsedMs: Math.round(performance.now() - started) };
      if (index === 0) timeoutResult = result;
      return { error: result };
    }));
  const pending = Array.from({ length: 10 }, (_, index) => {
    const queuedAt = performance.now();
    return pool.submit('probe', {}, undefined, 120000).then(
      value => ({ operation: 'probe', index, value, elapsedMs: Math.round(performance.now() - queuedAt) }),
      error => ({ operation: 'probe', index, error: error.code || 'UNKNOWN', elapsedMs: Math.round(performance.now() - queuedAt) }),
    );
  });
  assert.deepEqual(pool.counts, { active: 10, pending: 10 });
  await sample('immediate', settled);
  await delay(5500);
  const s1 = await sample('5.5s', settled);
  assert.equal(s1.settled, 1);
  assert.equal(s1.timedOut.code, 'STORAGE_TIMEOUT');
  assert.ok(s1.timedOut.elapsedMs >= 1900 && s1.timedOut.elapsedMs < 5000);
  assert.equal(s1.idLocked, true);
  assert.equal(s1.active, 10);
  assert.equal(s1.pending, 10);
  assert.equal(s1.pids.length, 10);
  const responses = { live: await request('/health/live'), ready: await request('/health/ready'), admit: await request('/admit'), offset: await request('/offset') };
  console.log('FAULT_HTTP', JSON.stringify(responses));
  assert.equal(responses.live.status, 200);
  assert.equal(responses.ready.status, 503);
  assert.ok(responses.ready.elapsedMs < 2000);
  assert.equal(responses.admit.status, 503);
  assert.equal(responses.admit.retryAfter, '5');
  assert.equal(responses.offset.status, 503);
  assert.equal((await request('/admit')).status, 503);
  await delay(6500);
  const s2 = await sample('12s', settled);
  assert.equal(s2.settled, 1);
  assert.equal(s2.active, 10);
  assert.equal(s2.pending, 10);
  assert.equal(s2.idLocked, true);
  assert.deepEqual(s2.pids, s1.pids);
  console.log('FAULT_TIMEOUT_RETAINED', JSON.stringify(timeoutResult));
  const values = await Promise.all(jobs);
  console.log('FAULT_WRITE_RESULTS', JSON.stringify(values.map((result, index) => ({ operation: 'write', index, error: result.error?.code, offset: result.value?.offset }))));
  assert.equal(values[0].error.code, 'STORAGE_TIMEOUT');
  assert.ok(values.slice(1).every(result => result.value.offset === payload.length));
  const probes = await Promise.all(pending);
  console.log('FAULT_QUEUED_RESULTS', JSON.stringify(probes.map(({ operation, index, error, elapsedMs, value }) => ({ operation, index, error, elapsedMs, freeBytesPositive: value?.freeBytes > 0 }))));
  assert.ok(probes.every(result => !result.error && result.value?.freeBytes > 0), 'queued probes must all succeed after recovery');
  assert.deepEqual(pool.counts, { active: 0, pending: 0 });
  assert.equal(pool.activeIds.size, 0);
  assert.ok((await pool.submit('probe', {}, undefined, 2000)).freeBytes > 0);
  assert.equal(await pool.readiness(), true);
  console.log('FAULT_FRESH_PROBE_READY_PASS');
  assert.equal((await pool.submit('stat', { id: ids[0] })).offset, payload.length);
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(`/data/partials/${ids[0]}.part`)) digest.update(chunk);
  assert.equal(digest.digest('hex'), expectedHash);
  await sample('recovered', settled);
  console.log('FAULT_RECOVERY_PASS', expectedHash);
  for (const id of ids) {
    await fs.unlink(`/data/partials/${id}.part`);
    await fs.unlink(`/data/partials/${id}.json`);
  }
} finally {
  await new Promise(resolve => server.close(resolve));
}
