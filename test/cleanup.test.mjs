import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, chmodSync, rmSync, realpathSync, mkdirSync, existsSync, lstatSync,
  symlinkSync, unlinkSync, writeFileSync, readFileSync, linkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { configFrom } from '../src/server/config.mjs';
import { openDatabase } from '../src/server/db.mjs';
import { startServers } from '../src/server/http.mjs';
import { StoragePool } from '../src/server/storage/pool.mjs';
import { commitment, annotateUploadError } from '../src/server/collections.mjs';

const publicOrigin = 'https://drive.example.invalid';
const adminOrigin = 'https://admin.example.invalid';
const owner = 'owner@example.invalid';
const meta = name => `filename ${Buffer.from(name).toString('base64')}`;
function send(target, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const address = target.startsWith('/') ? { socketPath: target } : { hostname: '127.0.0.1', port: new URL(target).port };
    const req = request({ ...address, path, method, headers }, res => {
      const parts = [];
      res.on('data', part => parts.push(part));
      res.on('end', () => {
        const raw = Buffer.concat(parts).toString();
        let value = raw;
        try { value = raw ? JSON.parse(raw) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: value });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
async function setup({ intervalSeconds = 3600 } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bd-cleanup-')));
  chmodSync(dir, 0o700);
  const root = join(dir, 'nas'); mkdirSync(root, { mode: 0o700 });
  let ms = Date.now(), cleanup;
  const config = configFrom({ APP_MODE: 'fixture', ADMIN_OWNER_LOGIN: owner, ADMIN_SOCKET_PATH: join(dir, 'admin.sock'),
    DB_PATH: join(dir, 'app.sqlite'), PUBLIC_ORIGIN: publicOrigin, ADMIN_ORIGIN: adminOrigin,
    FREE_SPACE_FLOOR_BYTES: '1', PARTIAL_IDLE_SECONDS: '172800', CLEANUP_INTERVAL_SECONDS: String(intervalSeconds) });
  const storage = new StoragePool({ root, fixture: true, expectedSource: '' });
  let db = openDatabase(config.dbPath);
  db.exec("UPDATE intake_window SET closes_at='9999-12-31T23:59:59.999Z' WHERE id=1");
  let servers = await startServers(config, [0, 0], storage, db, { cleanupClock: () => ms, onCleanupReady: run => { cleanup = run; } });
  const guest = () => `http://127.0.0.1:${servers[0].address().port}`;
  const identity = { 'Tailscale-User-Login': owner };
  const adminSession = await send(config.adminSocketPath, '/api/admin/session', { headers: identity });
  const admin = { ...identity, Cookie: adminSession.headers['set-cookie'][0].split(';')[0], Origin: adminOrigin,
    'X-CSRF-Token': adminSession.body.csrfToken, 'Content-Type': 'application/json' };
  const create = async allowance => {
    const result = await send(config.adminSocketPath, '/api/admin/collections', { method: 'POST', headers: admin,
      body: JSON.stringify({ title: 'Cleanup fixture', allowance }) });
    assert.equal(result.status, 201); return result.body;
  };
  const unlock = async collection => {
    const result = await send(guest(), `/api/c/${collection.token}/unlock`, { method: 'POST',
      headers: { Origin: publicOrigin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: collection.key, displayName: 'Guest' }) });
    assert.equal(result.status, 200);
    return { Cookie: result.headers['set-cookie'][0].split(';')[0], Origin: publicOrigin,
      'X-CSRF-Token': result.body.csrfToken, 'Tus-Resumable': '1.0.0' };
  };
  const post = async (collection, auth, size = 5) => {
    const result = await send(guest(), `/uploads/${collection.token}`, { method: 'POST',
      headers: { ...auth, 'Upload-Length': String(size), 'Upload-Metadata': meta('file.txt') } });
    assert.equal(result.status, 201); return result.headers.location;
  };
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
    for (let attempt = 0; attempt < 200 && (storage.counts.active || storage.counts.pending); attempt++)
      await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(storage.counts, { active: 0, pending: 0 });
    db.close();
    stopped = true;
  };
  const restart = async () => {
    await stop(); db = openDatabase(config.dbPath);
    servers = await startServers(config, [0, 0], storage, db, { cleanupClock: () => ms, onCleanupReady: run => { cleanup = run; } });
    stopped = false;
  };
  return { dir, root, config, storage, guest, admin, create, unlock, post, restart,
    get db() { return db; }, get cleanup() { return cleanup; }, now: () => ms, advance: n => { ms += n; },
    age: (id, elapsedMs) => { const sidecar = JSON.parse(readFileSync(join(root, 'partials', `${id}.json`), 'utf8'));
      const persisted = db.prepare('SELECT transfer_at FROM uploads WHERE id=?').get(id).transfer_at;
      ms = Math.max(Date.parse(sidecar.activity.at), Date.parse(persisted)) + elapsedMs; },
    health: () => send(config.adminSocketPath, '/api/admin/health', { headers: identity }),
    stop, close: async () => { await stop();
      for (let attempt = 0; attempt < 5; attempt++) {
        try { rmSync(dir, { recursive: true, force: true }); break; }
        catch (error) { if (error.code !== 'ENOTEMPTY' || attempt === 4) throw error;
          await new Promise(resolve => setTimeout(resolve, 20)); }
      }
    } };
}

test('idle boundary, no read refresh, exact accounting and private health', async () => {
  const x = await setup();
  try {
    const c = await x.create(20), auth = await x.unlock(c);
    const path = await x.post(c, auth), id = path.split('/').at(-1);
    assert.equal((await send(x.guest(), '/api/admin/health')).status, 404);
    assert.equal((await send(x.config.adminSocketPath, '/api/admin/health',
      { headers: { 'Tailscale-User-Login': 'someone-else@example.invalid' } })).status, 403);
    assert.equal((await x.health()).body.cleanup.pending, 0);
    x.age(id, 172799000);
    const beforeActivity = x.db.prepare('SELECT transfer_at FROM uploads WHERE id=?').get(id).transfer_at;
    assert.equal((await send(x.guest(), path, { method: 'HEAD', headers: auth })).status, 200);
    assert.equal((await send(x.guest(), `/api/c/${c.token}/uploads`, { headers: auth })).status, 200);
    annotateUploadError(x.db, id, 'uploading', 'STORAGE_ERROR');
    assert.equal(x.db.prepare('SELECT transfer_at FROM uploads WHERE id=?').get(id).transfer_at, beforeActivity);
    assert.equal(await x.cleanup(), true);
    assert.equal(x.db.prepare('SELECT status FROM uploads WHERE id=?').get(id).status, 'uploading');
    x.advance(1000);
    assert.equal((await x.health()).body.cleanup.pending, 1);
    assert.equal(await x.cleanup(), true);
    assert.equal(x.db.prepare('SELECT status FROM uploads WHERE id=?').get(id).status, 'cancelled');
    assert.equal(existsSync(join(x.root, 'partials', `${id}.part`)), false);
    assert.equal(existsSync(join(x.root, 'partials', `${id}.json`)), false);
    assert.equal(commitment(x.db, c.id).reservedCount, 0);
    assert.equal(await x.cleanup(), true);
    assert.equal(commitment(x.db, c.id).reservedCount, 0);
    assert.equal((await x.health()).body.cleanup.pending, 0);
    assert.equal((await send(x.config.adminSocketPath, '/api/admin/health', { headers: x.admin })).headers['cache-control'], 'no-store');
  } finally { await x.close(); }
});

test('committed PATCH refreshes transfer activity; rotation alone does not revoke; DELETE repeats safely', async () => {
  const x = await setup();
  try {
    const c = await x.create(20), auth = await x.unlock(c);
    const path = await x.post(c, auth), id = path.split('/').at(-1);
    x.advance(172799000);
    const patch = await send(x.guest(), path, { method: 'PATCH', headers: { ...auth,
      'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0' }, body: Buffer.from('x') });
    assert.equal(patch.status, 204);
    x.advance(1000);
    assert.equal(await x.cleanup(), true);
    assert.equal(x.db.prepare('SELECT status FROM uploads WHERE id=?').get(id).status, 'uploading');
    assert.equal((await send(x.config.adminSocketPath, `/api/admin/collections/${c.id}/rotate-key`,
      { method: 'POST', headers: x.admin })).status, 200);
    assert.equal(await x.cleanup(), true);
    assert.equal(x.db.prepare('SELECT status FROM uploads WHERE id=?').get(id).status, 'uploading');
    assert.equal((await send(x.guest(), path, { method: 'DELETE', headers: auth })).status, 401);
    x.advance(172801000);
    assert.equal(await x.cleanup(), true);
    assert.equal(x.db.prepare('SELECT status FROM uploads WHERE id=?').get(id).status, 'cancelled');
  } finally { await x.close(); }
});

test('response timeout after durable write keeps recent bytes and reservation until new idle boundary', async () => {
  const x = await setup();
  try {
    const c = await x.create(20), auth = await x.unlock(c), path = await x.post(c, auth), id = path.split('/').at(-1);
    x.age(id, 172799000);
    const original = x.storage.submit.bind(x.storage);
    let committed;
    x.storage.submit = (op, ...args) => {
      if (op !== 'write') return original(op, ...args);
      const actual = original(op, ...args);
      committed = actual;
      const failed = actual.then(() => { throw Object.assign(new Error('STORAGE_TIMEOUT'), { code: 'STORAGE_TIMEOUT' }); });
      failed.settled = actual.settled;
      return failed;
    };
    const response = await send(x.guest(), path, { method: 'PATCH', headers: { ...auth,
      'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0' }, body: Buffer.from('x') });
    assert.equal(response.status, 503);
    await committed;
    x.storage.submit = original;
    const part = join(x.root, 'partials', `${id}.part`);
    const sidecar = JSON.parse(readFileSync(join(x.root, 'partials', `${id}.json`), 'utf8'));
    assert.equal(sidecar.offset, 1);
    assert.equal(sidecar.activity.offset, 1);
    assert.equal(readFileSync(part).toString(), 'x');
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await send(x.config.adminSocketPath, '/health/ready', { headers: { 'Tailscale-User-Login': owner } })).status === 200) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    x.advance(2000);
    assert.equal(await x.cleanup(), true);
    assert.equal(x.db.prepare('SELECT status FROM uploads WHERE id=?').get(id).status, 'uploading');
    assert.equal(commitment(x.db, c.id).reservedCount, 1);
    assert.equal(readFileSync(part).toString(), 'x');
    x.age(id, 172800000);
    assert.equal(await x.cleanup(), true);
    assert.equal(x.db.prepare('SELECT status FROM uploads WHERE id=?').get(id).status, 'cancelled');
    assert.equal(commitment(x.db, c.id).reservedCount, 0);
    assert.equal(existsSync(part), false);
    console.log('DURABLE_ACTIVITY_TIMEOUT_PASS', JSON.stringify({ response: response.status, committedOffset: 1, releasedOnce: true }));
  } finally { await x.close(); }
});

test('full product process crash after worker commit recovers activity across untouched socket and storage', async () => {
  const x = await setup();
  const helper = fileURLToPath(new URL('./fixtures/activity-product-process.mjs', import.meta.url));
  const children = [];
  const launch = async (mode, now) => {
    const child = spawn(process.execPath, [helper, x.root, x.config.dbPath, x.config.adminSocketPath, mode, String(now)],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    children.push(child);
    let stderr = ''; child.stderr.on('data', part => { stderr += part.toString(); }); child.stdout.resume();
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`startup timeout: ${stderr.slice(-300)}`)), 10000);
      child.once('message', message => { clearTimeout(timer); resolve(message); });
      child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`early exit ${code}/${signal}: ${stderr.slice(-300)}`)); });
    });
    assert.equal(ready.type, 'ready');
    return { child, url: ready.url };
  };
  const exited = async (child, expected) => {
    const code = child.exitCode !== null ? child.exitCode : await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('product exit timeout')), 10000);
      child.once('exit', value => { clearTimeout(timer); resolve(value); });
    });
    assert.equal(code, expected);
  };
  const trigger = child => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cleanup IPC timeout')), 10000);
    child.once('message', message => { clearTimeout(timer); resolve(message); });
    child.send({ type: 'cleanup' });
  });
  const ready = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await send(x.config.adminSocketPath, '/health/ready', { headers: { 'Tailscale-User-Login': owner } })).status === 200) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('recovered product readiness timeout');
  };
  try {
    const c = await x.create(20), auth = await x.unlock(c), path = await x.post(c, auth), id = path.split('/').at(-1);
    x.age(id, 172799000);
    const formerBoundary = x.now() + 2000;
    await x.stop();
    const crash = await launch('crash-write', x.now());
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await send(x.config.adminSocketPath, '/health/ready', { headers: { 'Tailscale-User-Login': owner } })).status === 200) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await assert.rejects(send(crash.url, path, { method: 'PATCH', headers: { ...auth,
      'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0' }, body: Buffer.from('x') }));
    await exited(crash.child, 91);
    assert.equal(lstatSync(x.config.adminSocketPath).isSocket(), true);
    const partial = join(x.root, 'partials', `${id}.part`);
    const sidecar = JSON.parse(readFileSync(join(x.root, 'partials', `${id}.json`), 'utf8'));
    assert.equal(readFileSync(partial).toString(), 'x');
    assert.equal(sidecar.offset, 1);
    assert.equal(sidecar.activity.offset, 1);
    const expectedHash = createHash('sha256').update('x').digest('hex');
    assert.equal(createHash('sha256').update(readFileSync(partial)).digest('hex'), expectedHash);
    let db = openDatabase(x.config.dbPath);
    const stale = db.prepare('SELECT transfer_at FROM uploads WHERE id=?').get(id).transfer_at;
    assert.ok(Date.parse(stale) < Date.parse(sidecar.activity.at));
    db.close();
    const first = await launch('recover', formerBoundary);
    await ready();
    assert.equal((await trigger(first.child)).result, true);
    db = openDatabase(x.config.dbPath);
    assert.equal(db.prepare('SELECT status,transfer_at FROM uploads WHERE id=?').get(id).status, 'uploading');
    assert.equal(db.prepare('SELECT transfer_at FROM uploads WHERE id=?').get(id).transfer_at, sidecar.activity.at);
    assert.equal(commitment(db, c.id).reservedCount, 1);
    db.close();
    assert.equal(readFileSync(partial).toString(), 'x');
    assert.equal(createHash('sha256').update(readFileSync(partial)).digest('hex'), expectedHash);
    first.child.send({ type: 'stop' }); await exited(first.child, 0);
    const second = await launch('recover', Date.parse(sidecar.activity.at) + 172800000);
    await ready();
    assert.equal((await trigger(second.child)).result, true);
    db = openDatabase(x.config.dbPath);
    assert.equal(db.prepare('SELECT status FROM uploads WHERE id=?').get(id).status, 'cancelled');
    assert.equal(commitment(db, c.id).reservedCount, 0);
    db.close();
    assert.equal(existsSync(partial), false);
    second.child.send({ type: 'stop' }); await exited(second.child, 0);
    console.log('DURABLE_ACTIVITY_PRODUCT_CRASH_PASS', JSON.stringify({ crashPid: crash.child.pid,
      crashExit: 91, recoveryPids: [first.child.pid, second.child.pid], offset: 1, releasedOnce: true }));
  } finally {
    for (const child of children) if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    await x.close();
  }
});

test('legacy sidecar keeps idle reservation but revocation can remove it', async () => {
  const x = await setup();
  try {
    const c = await x.create(20), auth = await x.unlock(c), path = await x.post(c, auth), id = path.split('/').at(-1);
    const filename = join(x.root, 'partials', `${id}.json`);
    const sidecar = JSON.parse(readFileSync(filename, 'utf8'));
    delete sidecar.activity; delete sidecar.owner;
    writeFileSync(filename, JSON.stringify(sidecar), { mode: 0o600 });
    x.advance(172801000);
    assert.equal(await x.cleanup(), false);
    assert.equal(x.db.prepare('SELECT status,error_code FROM uploads WHERE id=?').get(id).status, 'uploading');
    assert.equal(x.db.prepare('SELECT error_code FROM uploads WHERE id=?').get(id).error_code, 'ACTIVITY_UNKNOWN');
    assert.equal(commitment(x.db, c.id).reservedCount, 1);
    assert.equal(existsSync(join(x.root, 'partials', `${id}.part`)), true);
    x.db.prepare('UPDATE collections SET revoked_at=? WHERE id=?').run(new Date().toISOString(), c.id);
    assert.equal(await x.cleanup(), true);
    assert.equal(x.db.prepare('SELECT status FROM uploads WHERE id=?').get(id).status, 'cancelled');
    assert.equal(commitment(x.db, c.id).reservedCount, 0);
  } finally { await x.close(); }
});

test('failed uncommitted PATCH and read/error annotations never refresh idle activity', async () => {
  const x = await setup();
  try {
    const c = await x.create(20), auth = await x.unlock(c), path = await x.post(c, auth), id = path.split('/').at(-1);
    const before = x.db.prepare('SELECT transfer_at FROM uploads WHERE id=?').get(id).transfer_at;
    const original = x.storage.submit.bind(x.storage);
    x.storage.submit = (op, ...args) => {
      if (op !== 'write') return original(op, ...args);
      const failed = Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
      failed.settled = failed.catch(() => {});
      return failed;
    };
    const patch = await send(x.guest(), path, { method: 'PATCH', headers: { ...auth,
      'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0' }, body: Buffer.from('x') });
    assert.equal(patch.status, 503);
    x.storage.submit = original;
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await send(x.config.adminSocketPath, '/health/ready', { headers: { 'Tailscale-User-Login': owner } })).status === 200) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal((await send(x.guest(), path, { method: 'HEAD', headers: auth })).status, 200);
    annotateUploadError(x.db, id, 'uploading', 'STORAGE_ERROR');
    assert.equal(x.db.prepare('SELECT transfer_at FROM uploads WHERE id=?').get(id).transfer_at, before);
    x.age(id, 172800000);
    assert.equal(await x.cleanup(), true);
    assert.equal(x.db.prepare('SELECT status FROM uploads WHERE id=?').get(id).status, 'cancelled');
    assert.equal(commitment(x.db, c.id).reservedCount, 0);
  } finally { await x.close(); }
});

test('ambiguous create response recovers committed sidecar activity before idle cleanup', async () => {
  const x = await setup();
  try {
    const c = await x.create(20), auth = await x.unlock(c);
    const original = x.storage.submit.bind(x.storage);
    let committed;
    x.storage.submit = (op, ...args) => {
      if (op !== 'create') return original(op, ...args);
      const actual = original(op, ...args);
      committed = actual;
      const failed = actual.then(() => { throw Object.assign(new Error('STORAGE_TIMEOUT'), { code: 'STORAGE_TIMEOUT' }); });
      failed.settled = actual.settled;
      return failed;
    };
    const result = await send(x.guest(), `/uploads/${c.token}`, { method: 'POST',
      headers: { ...auth, 'Upload-Length': '5', 'Upload-Metadata': meta('file.txt') } });
    assert.equal(result.status, 503);
    await committed; x.storage.submit = original;
    const id = x.db.prepare('SELECT id FROM uploads WHERE collection_id=?').get(c.id).id;
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await send(x.config.adminSocketPath, '/health/ready', { headers: { 'Tailscale-User-Login': owner } })).status === 200) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const sidecar = JSON.parse(readFileSync(join(x.root, 'partials', `${id}.json`), 'utf8'));
    assert.equal(sidecar.activity.offset, 0);
    x.age(id, 172799000);
    assert.equal(await x.cleanup(), true);
    assert.notEqual(x.db.prepare('SELECT status FROM uploads WHERE id=?').get(id).status, 'cancelled');
    x.advance(1000);
    assert.equal(await x.cleanup(), true);
    assert.equal(x.db.prepare('SELECT status FROM uploads WHERE id=?').get(id).status, 'cancelled');
    assert.equal(commitment(x.db, c.id).reservedCount, 0);
  } finally { await x.close(); }
});

test('deletion debt survives outage and restart; prepared final payload is retained', async () => {
  const x = await setup();
  try {
    const c = await x.create(20), auth = await x.unlock(c), path = await x.post(c, auth), id = path.split('/').at(-1);
    x.advance(172801000);
    const original = x.storage.submit.bind(x.storage);
    x.storage.submit = (op, ...args) => op === 'removePartial' ? (() => {
      const failed = Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
      failed.settled = failed.catch(() => {}); return failed;
    })() : original(op, ...args);
    assert.equal(await x.cleanup(), false);
    assert.equal(x.db.prepare('SELECT status FROM uploads WHERE id=?').get(id).status, 'deleting');
    assert.equal(commitment(x.db, c.id).reservedCount, 1);
    assert.equal((await x.health()).body.cleanup.pending, 1);
    x.advance(86400000);
    assert.equal((await x.health()).body.cleanup.overdue, 1);
    x.storage.submit = original;
    await x.restart();
    for (let i = 0; i < 80 && x.db.prepare('SELECT status FROM uploads WHERE id=?').get(id).status !== 'cancelled'; i++)
      await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(x.db.prepare('SELECT status FROM uploads WHERE id=?').get(id).status, 'cancelled');
    assert.equal(commitment(x.db, c.id).reservedCount, 0);
    assert.equal(await x.cleanup(), true);
    assert.equal((await x.health()).body.cleanup.pending, 0);
  } finally { await x.close(); }
});

test('held cleanup owns global claim, runs only one pass and keeps liveness', async () => {
  const x = await setup();
  try {
    const c = await x.create(20), auth = await x.unlock(c), path = await x.post(c, auth);
    x.advance(172801000);
    const original = x.storage.submit.bind(x.storage);
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let calls = 0;
    x.storage.submit = (op, ...args) => {
      if (op !== 'removePartial' || !args[0].prepare) return original(op, ...args);
      calls++;
      entered();
      const task = gate.then(() => original(op, ...args));
      task.settled = task.catch(() => {});
      return task;
    };
    const pass = x.cleanup();
    await started;
    assert.equal(await x.cleanup(), false);
    assert.equal(calls, 1);
    assert.equal((await send(x.guest(), '/health/live')).status, 200);
    assert.equal((await send(x.config.adminSocketPath, '/health/ready', { headers: x.admin })).status, 503);
    assert.equal((await send(x.guest(), `/uploads/${c.token}`, { method: 'POST', headers: {
      ...auth, 'Upload-Length': '1', 'Upload-Metadata': meta('other.txt') } })).status, 503);
    assert.equal((await send(x.guest(), path, { method: 'DELETE', headers: auth })).status, 503);
    release();
    assert.equal(await pass, true);
    assert.equal(x.db.prepare('SELECT status FROM uploads WHERE id=?').get(path.split('/').at(-1)).status, 'cancelled');
    x.storage.submit = original;
    assert.equal((await send(x.config.adminSocketPath, '/health/ready', { headers: x.admin })).status, 200);
  } finally { await x.close(); }
});

test('timed-out cleanup retains claim until worker settlement and then retries', async () => {
  const x = await setup();
  try {
    const c = await x.create(20), auth = await x.unlock(c), path = await x.post(c, auth), id = path.split('/').at(-1);
    x.advance(172801000);
    const original = x.storage.submit.bind(x.storage);
    let settle;
    const settled = new Promise(resolve => { settle = resolve; });
    let count = 0;
    x.storage.submit = (op, ...args) => {
      if (op !== 'removePartial') return original(op, ...args);
      count++;
      const task = Promise.reject(Object.assign(new Error('STORAGE_TIMEOUT'), { code: 'STORAGE_TIMEOUT' }));
      task.settled = settled; return task;
    };
    const pass = x.cleanup();
    for (let attempt = 0; attempt < 50 && !count; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(count, 1);
    assert.equal((await send(x.guest(), '/health/live')).status, 200);
    assert.equal((await send(x.config.adminSocketPath, '/health/ready', { headers: x.admin })).status, 503);
    assert.equal((await send(x.guest(), path, { method: 'DELETE', headers: auth })).status, 503);
    assert.equal(await x.cleanup(), false);
    assert.equal(count, 1);
    assert.equal(commitment(x.db, c.id).reservedCount, 1);
    settle();
    assert.equal(await pass, false);
    x.storage.submit = original;
    assert.equal(await x.cleanup(), true);
    assert.equal(x.db.prepare('SELECT status FROM uploads WHERE id=?').get(id).status, 'cancelled');
    assert.equal(commitment(x.db, c.id).reservedCount, 0);
  } finally { await x.close(); }
});

test('fresh product process recovers deletion-to-DB crash without socket repair', async () => {
  const x = await setup();
  const helper = fileURLToPath(new URL('./fixtures/cleanup-product-process.mjs', import.meta.url));
  const children = [];
  const launch = async mode => {
    const child = spawn(process.execPath, [helper, x.root, x.config.dbPath, x.config.adminSocketPath, mode],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    children.push(child);
    let stderr = ''; child.stderr.on('data', part => { stderr += part.toString(); }); child.stdout.resume();
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`startup timeout: ${stderr.slice(-300)}`)), 10000);
      child.once('message', message => { clearTimeout(timer); resolve(message); });
      child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`early exit ${code}/${signal}: ${stderr.slice(-300)}`)); });
    });
    assert.equal(ready.type, 'ready');
    return { child, url: ready.url };
  };
  const exited = async (child, expected) => {
    const result = child.exitCode !== null ? child.exitCode : await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('process exit timeout')); }, 10000);
      child.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(result, expected);
  };
  try {
    const c = await x.create(20), auth = await x.unlock(c), path = await x.post(c, auth), id = path.split('/').at(-1);
    x.db.prepare('UPDATE collections SET revoked_at=? WHERE id=?').run(new Date().toISOString(), c.id);
    await x.stop();
    const crash = await launch('crash');
    crash.child.send({ type: 'cleanup' });
    await exited(crash.child, 91);
    console.log('CLEANUP_PRODUCT_PROCESS_EXIT', JSON.stringify({ pid: crash.child.pid, exitCode: 91, boundary: 'after_worker_unlink_before_db_commit' }));
    assert.equal(lstatSync(x.config.adminSocketPath).isSocket(), true);
    let db = openDatabase(x.config.dbPath);
    const pending = db.prepare('SELECT status,deletion_intent FROM uploads WHERE id=?').get(id);
    assert.equal(pending.status, 'deleting'); assert.equal(pending.deletion_intent, 1);
    assert.equal(commitment(db, c.id).reservedCount, 1);
    db.close();
    for (let i = 0; i < 2; i++) {
      const child = await launch('recover');
      for (let attempt = 0; attempt < 100; attempt++) {
        db = openDatabase(x.config.dbPath);
        const status = db.prepare('SELECT status FROM uploads WHERE id=?').get(id).status;
        db.close();
        if (status === 'cancelled') break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      db = openDatabase(x.config.dbPath);
      assert.equal(db.prepare('SELECT status FROM uploads WHERE id=?').get(id).status, 'cancelled');
      assert.equal(commitment(db, c.id).reservedCount, 0);
      db.close();
      assert.equal(existsSync(join(x.root, 'partials', `${id}.part`)), false);
      assert.equal(existsSync(join(x.root, 'partials', `${id}.json`)), false);
      child.child.send({ type: 'stop' });
      await exited(child.child, 0);
      console.log('CLEANUP_PRODUCT_RECOVERY_PASS', JSON.stringify({ iteration: i + 1, pid: child.child.pid, exitCode: 0, reservedCount: 0 }));
    }
  } finally {
    for (const child of children) if (child.exitCode === null) {
      child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve));
    }
    await x.close();
  }
});

test('symlink and same-inode publication conflict retain evidence and reservation', async () => {
  const x = await setup();
  try {
    const c = await x.create(20), auth = await x.unlock(c);
    const first = await x.post(c, auth), firstId = first.split('/').at(-1);
    const second = await x.post(c, auth), secondId = second.split('/').at(-1);
    const third = await x.post(c, auth), thirdId = third.split('/').at(-1);
    const target = join(x.dir, 'foreign'); writeFileSync(target, 'untouched');
    const partial = join(x.root, 'partials', `${firstId}.part`);
    unlinkSync(partial); symlinkSync(target, partial);
    const completed = join(x.root, 'completed'); mkdirSync(completed, { mode: 0o700 });
    const collectionDir = join(completed, c.id); mkdirSync(collectionDir, { mode: 0o700 });
    const final = join(collectionDir, `${secondId}-file.txt`);
    linkSync(join(x.root, 'partials', `${secondId}.part`), final);
    const before = lstatSync(final);
    const thirdSidecar = join(x.root, 'partials', `${thirdId}.json`);
    writeFileSync(thirdSidecar, JSON.stringify({ ...JSON.parse(readFileSync(thirdSidecar, 'utf8')),
      prepared: { version: 1, id: thirdId } }));
    x.advance(172801000);
    assert.equal(await x.cleanup(), false);
    assert.equal(readFileSync(target, 'utf8'), 'untouched');
    assert.ok(['uploading', 'deleting'].includes(x.db.prepare('SELECT status FROM uploads WHERE id=?').get(firstId).status));
    assert.equal(lstatSync(final).ino, before.ino);
    assert.ok(['uploading', 'deleting'].includes(x.db.prepare('SELECT status FROM uploads WHERE id=?').get(secondId).status));
    assert.ok(['uploading', 'deleting'].includes(x.db.prepare('SELECT status FROM uploads WHERE id=?').get(thirdId).status));
    assert.equal(existsSync(join(x.root, 'partials', `${thirdId}.part`)), true);
    assert.equal(commitment(x.db, c.id).reservedCount, 3);
    assert.ok((await x.health()).body.cleanup.errors >= 1);
  } finally { await x.close(); }
});

test('payload unlink EACCES and ENOSPC keep durable deletion markers and retry once', async () => {
  for (const code of ['EACCES', 'ENOSPC']) {
    const x = await setup();
    try {
      const c = await x.create(20), auth = await x.unlock(c), path = await x.post(c, auth), id = path.split('/').at(-1);
      x.advance(172801000);
      const original = x.storage.submit.bind(x.storage);
      x.storage.submit = (op, args, stream, deadline) => original(op,
        op === 'removePartial' && !args.prepare ? { ...args, failure: { point: 'after_remove_payload', code } } : args,
        stream, deadline);
      assert.equal(await x.cleanup(), false, code);
      assert.equal(x.db.prepare('SELECT status,deletion_intent FROM uploads WHERE id=?').get(id).deletion_intent, 1);
      assert.equal(existsSync(join(x.root, 'partials', `${id}.part`)), false);
      assert.equal(JSON.parse(readFileSync(join(x.root, 'partials', `${id}.json`), 'utf8')).deleting.id, id);
      assert.equal(commitment(x.db, c.id).reservedCount, 1);
      x.storage.submit = original;
      assert.equal(await x.cleanup(), true);
      assert.equal(x.db.prepare('SELECT status FROM uploads WHERE id=?').get(id).status, 'cancelled');
      assert.equal(commitment(x.db, c.id).reservedCount, 0);
      assert.equal(existsSync(join(x.root, 'partials', `${id}.json`)), false);
    } finally { await x.close(); }
  }
});

test('revocation and expiry clear partials before the available-storage 24-hour deadline', async () => {
  const x = await setup();
  try {
    const revoked = await x.create(20), expired = await x.create(20), recent = await x.create(20);
    const a = await x.unlock(revoked), b = await x.unlock(expired), c = await x.unlock(recent);
    const revokedPath = await x.post(revoked, a), expiredPath = await x.post(expired, b), recentPath = await x.post(recent, c);
    const revoke = await send(x.config.adminSocketPath, `/api/admin/collections/${revoked.id}/revoke`,
      { method: 'POST', headers: x.admin });
    assert.equal(revoke.status, 200);
    x.db.prepare('UPDATE collections SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), expired.id);
    assert.equal((await x.health()).body.cleanup.pending, 2);
    assert.equal(await x.cleanup(), true);
    for (const [collection, path] of [[revoked, revokedPath], [expired, expiredPath]]) {
      assert.equal(x.db.prepare('SELECT status FROM uploads WHERE id=?').get(path.split('/').at(-1)).status, 'cancelled');
      assert.equal(commitment(x.db, collection.id).reservedCount, 0);
    }
    assert.equal(x.db.prepare('SELECT status FROM uploads WHERE id=?').get(recentPath.split('/').at(-1)).status, 'uploading');
    assert.equal((await x.health()).body.cleanup.pending, 0);
  } finally { await x.close(); }
});

test('configured scheduled tick deletes an idle partial without a second pass', async () => {
  const x = await setup({ intervalSeconds: 1 });
  try {
    const c = await x.create(20), auth = await x.unlock(c), path = await x.post(c, auth), id = path.split('/').at(-1);
    x.advance(172801000);
    for (let attempt = 0; attempt < 40; attempt++) {
      if (x.db.prepare('SELECT status FROM uploads WHERE id=?').get(id).status === 'cancelled') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(x.db.prepare('SELECT status FROM uploads WHERE id=?').get(id).status, 'cancelled');
    assert.ok((await x.health()).body.cleanup.lastAttemptAt);
  } finally { await x.close(); }
});

test('zero-byte completed payload keeps its count and bytes through cleanup', async () => {
  const x = await setup();
  try {
    const c = await x.create(20), auth = await x.unlock(c), path = await x.post(c, auth, 0), id = path.split('/').at(-1);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (x.db.prepare('SELECT status FROM uploads WHERE id=?').get(id).status === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const row = x.db.prepare('SELECT status,storage_locator,completed_at FROM uploads WHERE id=?').get(id);
    assert.equal(row.status, 'completed');
    const file = join(x.root, row.storage_locator);
    assert.equal(lstatSync(file).size, 0);
    x.advance(172800000 + 86400000);
    assert.equal(await x.cleanup(), true);
    assert.equal(lstatSync(file).size, 0);
    assert.equal(x.db.prepare('SELECT completed_at FROM uploads WHERE id=?').get(id).completed_at, row.completed_at);
    assert.equal(commitment(x.db, c.id).completedCount, 1);
    assert.equal(commitment(x.db, c.id).reservedCount, 0);
    assert.equal((await send(x.guest(), path, { method: 'DELETE', headers: auth })).status, 409);
  } finally { await x.close(); }
});

test('v4 migration keeps completed receipt identity and rejects future schema', async () => {
  const x = await setup();
  try {
    const c = await x.create(20), auth = await x.unlock(c), path = await x.post(c, auth, 0), id = path.split('/').at(-1);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (x.db.prepare('SELECT status FROM uploads WHERE id=?').get(id).status === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const original = x.db.prepare('SELECT completed_at,content_hash,storage_locator FROM uploads WHERE id=?').get(id);
    assert.ok(original.completed_at);
    await x.stop();
    let db = new DatabaseSync(x.config.dbPath);
    db.exec(`DROP TABLE intake_window; DROP TABLE cleanup_state; DROP INDEX uploads_cleanup_idx;
      ALTER TABLE uploads DROP COLUMN transfer_at; ALTER TABLE uploads DROP COLUMN deletion_intent;
      ALTER TABLE uploads DROP COLUMN deleting_at; DELETE FROM schema_migrations WHERE version IN (5,6); PRAGMA user_version=4`);
    db.close();
    db = openDatabase(x.config.dbPath);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 6);
    const migrated = db.prepare('SELECT completed_at,content_hash,storage_locator FROM uploads WHERE id=?').get(id);
    assert.equal(migrated.completed_at, original.completed_at);
    assert.equal(migrated.content_hash, original.content_hash);
    assert.equal(migrated.storage_locator, original.storage_locator);
    assert.equal(commitment(db, c.id).completedCount, 1);
    db.exec('PRAGMA user_version=7'); db.close();
    assert.throws(() => openDatabase(x.config.dbPath), /Unsupported database schema/);
  } finally { await x.close(); }
});

test('missing unmarked artifacts retain debt; restored root retries bounded cleanup', async () => {
  const x = await setup();
  try {
    const c = await x.create(20), auth = await x.unlock(c);
    const sidecarOnly = await x.post(c, auth), sidecarId = sidecarOnly.split('/').at(-1);
    const payloadOnly = await x.post(c, auth), payloadId = payloadOnly.split('/').at(-1);
    const patch = await send(x.guest(), payloadOnly, { method: 'PATCH', headers: { ...auth,
      'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0' }, body: Buffer.from('x') });
    assert.equal(patch.status, 204);
    unlinkSync(join(x.root, 'partials', `${sidecarId}.part`));
    unlinkSync(join(x.root, 'partials', `${payloadId}.json`));
    x.advance(172801000);
    assert.equal(await x.cleanup(), false);
    assert.equal(commitment(x.db, c.id).reservedCount, 2);
    assert.equal(existsSync(join(x.root, 'partials', `${sidecarId}.json`)), true);
    assert.equal(readFileSync(join(x.root, 'partials', `${payloadId}.part`), 'utf8'), 'x');
    const off = `${x.root}-offline`;
    renameSync(x.root, off);
    assert.equal(await x.cleanup(), false);
    await new Promise(resolve => setTimeout(resolve, 5200)); // Expire the five-second readiness probe cache.
    assert.equal((await x.health()).body.storage, 'unavailable');
    assert.equal(commitment(x.db, c.id).reservedCount, 2);
    renameSync(off, x.root);
    assert.equal(await x.cleanup(), false);
    assert.equal(commitment(x.db, c.id).reservedCount, 2);
  } finally { await x.close(); }
});
