import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fixtureKey } from '../../test/fixtures/tus-server.mjs';

const chunkSize = 8 * 1024 * 1024;
const streamPiece = 64 * 1024;
const streamPaceMs = 2;
const sampleIntervalMs = 25;
const url = 'http://127.0.0.1:4361';
const headers = { 'Tus-Resumable': '1.0.0', 'X-Fixture-Key': fixtureKey };
let server;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function request(path, options = {}) {
  return fetch(url + path, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(120000) });
}
async function start() {
  server = spawn(process.execPath, ['test/fixtures/tus-server-cli.mjs'], { stdio: ['ignore', 'pipe', 'inherit'], env: process.env });
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`server exited ${server.exitCode}`);
    try { if ((await request('/health/live')).status === 200) return server.pid; } catch {}
    await delay(100);
  }
  throw new Error('server did not start');
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const child = server;
  const exit = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exit;
}
async function head(location) {
  const response = await request(location, { method: 'HEAD' });
  assert.equal(response.status, 200);
  return Number(response.headers.get('upload-offset'));
}
async function rss(pid) {
  try {
    const match = (await fs.readFile(`/proc/${pid}/status`, 'utf8')).match(/^VmRSS:\s+(\d+) kB$/m);
    return match ? Number(match[1]) * 1024 : null; // Exited zombies may still have /proc/status without VmRSS.
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    throw error;
  }
}
async function children(pid) {
  try {
    const content = (await fs.readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim();
    return content ? content.split(' ').map(Number) : [];
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return [];
    throw error;
  }
}
async function observe(serverPid, baseline) {
  const data = {
    sampleIntervalMs, streamPaceMs, streamPiece, chunkBytes: chunkSize,
    baselineServerRss: baseline, serverPeakRss: baseline, maxIndividualWorkerRss: 0,
    maxSimultaneousWorkerRss: 0, aggregateServicePeakRss: baseline, clientPeakRss: process.memoryUsage().rss,
    maxLiveWorkers: 0, activeSamples: 0, liveWorkerSamples: 0, firstSampleMs: null, lastSampleMs: null,
    workerPids: new Set(),
  };
  let running = true;
  let requestActive = false;
  let observerError;
  const began = performance.now();
  const loop = (async () => {
    while (running) {
      try {
        if (requestActive) {
          const serverRss = await rss(serverPid);
          if (serverRss !== null) {
            const pids = await children(serverPid);
            let workerSum = 0;
            let liveWorkers = 0;
            for (const pid of pids) {
              const workerRss = await rss(pid);
              if (workerRss === null) continue; // Worker exited between /proc reads.
              liveWorkers++;
              workerSum += workerRss;
              data.workerPids.add(pid);
              data.maxIndividualWorkerRss = Math.max(data.maxIndividualWorkerRss, workerRss);
            }
            const now = Math.round(performance.now() - began);
            data.activeSamples++;
            data.firstSampleMs ??= now;
            data.lastSampleMs = now;
            if (liveWorkers) data.liveWorkerSamples++;
            data.serverPeakRss = Math.max(data.serverPeakRss, serverRss);
            data.maxSimultaneousWorkerRss = Math.max(data.maxSimultaneousWorkerRss, workerSum);
            data.aggregateServicePeakRss = Math.max(data.aggregateServicePeakRss, serverRss + workerSum);
            data.maxLiveWorkers = Math.max(data.maxLiveWorkers, liveWorkers);
            data.clientPeakRss = Math.max(data.clientPeakRss, process.memoryUsage().rss);
          }
        }
      } catch (error) { observerError = error; running = false; }
      if (running) await delay(sampleIntervalMs);
    }
  })();
  return {
    setActive(value) { requestActive = value; },
    async finish() {
      running = false;
      await loop;
      if (observerError) throw observerError;
      const result = { ...data, workerPids: [...data.workerPids], activeWindowMs: data.lastSampleMs - data.firstSampleMs };
      assert.ok(result.activeSamples >= 2 && result.liveWorkerSamples >= 2, 'insufficient active worker RSS samples');
      assert.equal(result.maxLiveWorkers, 1, 'single transfer spawned concurrent workers');
      return result;
    },
  };
}
function chunkFor(offset) {
  const chunk = Buffer.allocUnsafe(chunkSize);
  for (let i = 0; i < chunk.length; i += streamPiece) chunk.fill((offset / chunkSize + i / streamPiece) & 255, i, i + streamPiece);
  return chunk;
}
function pacedBody(chunk) {
  let offset = 0;
  return new ReadableStream({
    async pull(controller) {
      if (offset === chunk.length) { controller.close(); return; }
      controller.enqueue(chunk.subarray(offset, offset + streamPiece));
      offset += streamPiece;
      await delay(streamPaceMs);
    },
  });
}
async function transfer(totalMiB, { restart = false, measure = false } = {}) {
  const total = totalMiB * 1024 * 1024;
  const hash = createHash('sha256');
  let observation;
  let serverPid;
  let location;
  let restartEvidence;
  try {
    serverPid = await start();
    let response = await request('/uploads', { method: 'POST', headers: { 'Upload-Length': String(total), 'Upload-Metadata': 'filename Zml4dHVyZS5iaW4=' } });
    assert.equal(response.status, 201);
    location = response.headers.get('location');
    assert.match(location, /^\/uploads\/[0-9a-f]{32}$/);
    assert.equal(await head(location), 0);
    const baselineServerRss = await rss(serverPid);
    assert.ok(baselineServerRss);
    assert.deepEqual(await children(serverPid), [], 'baseline has live worker');
    if (measure) observation = await observe(serverPid, baselineServerRss);
    for (let offset = 0; offset < total; offset += chunkSize) {
      const chunk = chunkFor(offset);
      hash.update(chunk);
      if (observation) observation.setActive(true);
      try {
        response = await request(location, {
          method: 'PATCH',
          headers: { 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' },
          body: pacedBody(chunk), duplex: 'half',
        });
      } finally { if (observation) observation.setActive(false); }
      assert.equal(response.status, 204);
      assert.equal(Number(response.headers.get('upload-offset')), offset + chunkSize);
      if (restart && offset === 3 * chunkSize) {
        assert.equal(await head(location), 4 * chunkSize);
        const beforePid = serverPid;
        await stop();
        serverPid = await start();
        assert.notEqual(serverPid, beforePid);
        assert.equal(await head(location), 4 * chunkSize);
        restartEvidence = { beforePid, afterPid: serverPid, headOffset: 4 * chunkSize };
        console.log('SERVER_RESTART_RESUME', JSON.stringify(restartEvidence));
      }
    }
    const memory = observation ? await observation.finish() : undefined;
    assert.equal(await head(location), total);
    response = await request(`/fixture/finalize/${location.split('/').at(-1)}`, { method: 'POST', headers: { 'x-fixture-size': String(total) } });
    assert.equal(response.status, 200);
    const destination = (await response.json()).completed;
    assert.equal(destination, `/data/completed/00000000-0000-4000-8000-000000000001/${location.split('/').at(-1)}-fixture.bin`);
    const actual = createHash('sha256');
    for await (const chunk of createReadStream(destination, { highWaterMark: 65536 })) actual.update(chunk);
    const sourceSha256 = hash.digest('hex');
    const nasSha256 = actual.digest('hex');
    assert.equal(nasSha256, sourceSha256);
    assert.equal((await fs.stat(destination)).size, total);
    const result = { totalMiB, bytes: total, serverPid: restart ? undefined : serverPid, sourceSha256, nasSha256, destination, memory, restart: restartEvidence };
    console.log(measure ? 'NAS_PAIR_CASE' : 'NAS_TUS_PASS', JSON.stringify(result));
    return result;
  } finally {
    if (observation) {
      try { await observation.finish(); } catch {} // Main path reports observer failure; stop still runs.
    }
    await stop();
  }
}

const expectedSource = process.env.FIXTURE_NFS_SOURCE;
assert.match(expectedSource, /^192\.168\.68\.67:\/volume3\/workspace\/beng-drive\/bd-t03-[a-f0-9]+$/);
const mount = (await fs.readFile('/proc/self/mountinfo', 'utf8')).split('\n').find(line => line.split(' - ')[0].split(' ')[4] === '/data');
assert.ok(mount);
assert.equal(mount.split(' - ')[1].split(' ').slice(0, 2).join(' '), `nfs ${expectedSource}`);
const root = await fs.stat('/data');
assert.equal(root.uid, 1000);
assert.equal(root.mode & 0o777, 0o700);
console.log('MOUNT', expectedSource, 'root', `${root.uid}:${root.gid}`, (root.mode & 0o777).toString(8));
const small = await transfer(16, { measure: true });
const large = await transfer(128, { measure: true });
const peakDifference = large.memory.aggregateServicePeakRss - small.memory.aggregateServicePeakRss;
const normalizedDifference = (large.memory.aggregateServicePeakRss - large.memory.baselineServerRss) -
  (small.memory.aggregateServicePeakRss - small.memory.baselineServerRss);
console.log('NAS_MEMORY_COMPARISON', JSON.stringify({
  smallMiB: 16, largeMiB: 128, chunkBytes: chunkSize, concurrency: 1,
  sampleIntervalMs, streamPiece, streamPaceMs, peakDifference, normalizedDifference,
  thresholdBytes: 64 * 1024 * 1024,
}));
assert.ok(peakDifference < 64 * 1024 * 1024, 'service RSS scales with total file size');
console.log('NAS_MEMORY_COMPARISON_PASS');
await transfer(128, { restart: true });
console.log('NAS_FIXTURE_CONTENTS', JSON.stringify({ partials: await fs.readdir('/data/partials'), completed: await fs.readdir('/data/completed') }));
