import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, chmodSync, mkdirSync, realpathSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { configFrom } from '../src/server/config.mjs';
import { openDatabase } from '../src/server/db.mjs';
import { startServers } from '../src/server/http.mjs';
import { StoragePool } from '../src/server/storage/pool.mjs';
import { commitment } from '../src/server/collections.mjs';

const owner = 'owner@example.invalid';
const origin = 'https://drive.example.invalid';
const adminOrigin = 'https://admin.example.invalid';
function send(target, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const options = target.startsWith('/') ? { socketPath: target, path, method, headers } : { hostname: '127.0.0.1', port: new URL(target).port, path, method, headers };
    const req = request(options, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let body = text; try { body = JSON.parse(text); } catch { /* HTML or HEAD. */ }
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('Request did not settle')));
    req.on('error', reject); req.end(body);
  });
}
async function until(run, accept) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await run(); if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Lifecycle did not settle');
}
async function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bd-intake-'))); chmodSync(dir, 0o700);
  const root = join(dir, 'nas'); mkdirSync(root, { mode: 0o700 });
  const config = configFrom({ APP_MODE: 'fixture', ADMIN_OWNER_LOGIN: owner, ADMIN_SOCKET_PATH: join(dir, 'admin.sock'),
    DB_PATH: join(dir, 'app.sqlite'), PUBLIC_ORIGIN: origin, ADMIN_ORIGIN: adminOrigin, FREE_SPACE_FLOOR_BYTES: '1' });
  let now = Date.now(), db = openDatabase(config.dbPath);
  const storage = new StoragePool({ root, fixture: true, expectedSource: '' });
  let servers = await startServers(config, [0, 0], storage, db, { clock: () => now });
  let running = true;
  const guest = () => `http://127.0.0.1:${servers[0].address().port}`;
  const identity = { 'Tailscale-User-Login': owner };
  const session = await send(config.adminSocketPath, '/api/admin/session', { headers: identity });
  const admin = { ...identity, Cookie: session.headers['set-cookie'][0].split(';')[0], Origin: adminOrigin,
    'X-CSRF-Token': session.body.csrfToken, 'Content-Type': 'application/json' };
  const window = closesAt => send(config.adminSocketPath, '/api/admin/intake', { method: 'PUT', headers: admin, body: JSON.stringify({ closesAt }) });
  const create = async () => {
    const result = await send(config.adminSocketPath, '/api/admin/collections', { method: 'POST', headers: admin, body: JSON.stringify({ title: 'Private fixture collection' }) });
    assert.equal(result.status, 201); return result.body;
  };
  const unlock = async collection => {
    const result = await send(guest(), `/api/c/${collection.token}/unlock`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: collection.key, displayName: 'Fixture guest' }) });
    assert.equal(result.status, 200);
    return { Cookie: result.headers['set-cookie'][0].split(';')[0], Origin: origin, 'X-CSRF-Token': result.body.csrfToken, 'Tus-Resumable': '1.0.0' };
  };
  const post = async (collection, auth, size) => {
    const result = await send(guest(), `/uploads/${collection.token}`, { method: 'POST', headers: { ...auth, 'Upload-Length': String(size),
      'Upload-Metadata': `filename ${Buffer.from('saved.bin').toString('base64')}` } });
    assert.equal(result.status, 201); return result.headers.location;
  };
  const stop = async () => {
    if (!running) return;
    await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
    await until(() => storage.counts, counts => !counts.active && !counts.pending);
    db.close(); running = false;
  };
  const restart = async () => {
    await stop(); db = openDatabase(config.dbPath);
    servers = await startServers(config, [0, 0], storage, db, { clock: () => now }); running = true;
    await until(() => send(config.adminSocketPath, '/health/ready', { headers: identity }), result => result.status === 200);
  };
  return { dir, root, config, guest, admin, identity, window, create, unlock, post, stop, restart,
    get db() { return db; }, get now() { return now; }, set now(value) { now = value; },
    async close() { await stop(); rmSync(dir, { recursive: true, force: true }); } };
}

test('closed intake rejects guest routes before authentication or body/storage work; only owner can open it', async () => {
  const x = await setup();
  try {
    const collection = await x.create(); // An active collection alone must not open intake.
    const page = await send(x.guest(), '/');
    assert.equal(page.status, 200); assert.match(page.headers['content-type'], /text\/html/);
    assert.equal(page.headers['cache-control'], 'no-store'); assert.equal(page.headers['set-cookie'], undefined);
    assert.equal((await send(x.guest(), `/c/${collection.token}`)).body, page.body);
    for (const [path, method] of [[`/api/c/${collection.token}/unlock`, 'POST'], [`/api/c/${collection.token}/session`, 'GET'],
      [`/api/c/${collection.token}/uploads`, 'GET'], [`/uploads/${collection.token}`, 'OPTIONS'],
      [`/uploads/${collection.token}`, 'POST'], [`/uploads/${collection.token}/id`, 'HEAD'],
      [`/uploads/${collection.token}/id`, 'PATCH'], [`/uploads/${collection.token}/id`, 'DELETE'], ['/api/admin/intake', 'PUT'], ['/assets/missing.js', 'GET']]) {
      const result = await send(x.guest(), path, { method, headers: { ...x.admin, 'Content-Length': '10485760' } });
      assert.equal(result.status, 403, `${method} ${path}`);
      if (method !== 'HEAD') assert.equal(result.body.error.code, 'INTAKE_CLOSED');
      assert.equal(result.headers.connection, 'close');
    }
    assert.equal(x.db.prepare('SELECT count(*) AS n FROM unlock_attempts').get().n, 0);
    assert.equal(x.db.prepare('SELECT count(*) AS n FROM browser_sessions').get().n, 0);
    assert.deepEqual(readdirSync(x.root), []);
    assert.equal((await send(x.guest(), '/health/live')).status, 200);
    const status = await send(x.config.adminSocketPath, '/api/admin/intake', { headers: x.identity });
    assert.equal(status.body.open, false); assert.equal(status.body.closesAt, null);
    for (const headers of [{}, { ...x.admin, 'Tailscale-User-Login': 'other@example.invalid' },
      { ...x.admin, Origin: origin }, { ...x.admin, 'X-CSRF-Token': 'wrong' }]) {
      assert.equal((await send(x.config.adminSocketPath, '/api/admin/intake', { method: 'PUT', headers, body: JSON.stringify({ closesAt: new Date(x.now + 60000).toISOString() }) })).status, 403);
    }
    for (const body of [{}, { closesAt: true }, { closesAt: 'not-a-date' }, { closesAt: new Date(x.now).toISOString() },
      { closesAt: null, open: true }, { closesAt: '2026-02-30T12:00:00.000Z' }]) {
      assert.equal((await send(x.config.adminSocketPath, '/api/admin/intake', { method: 'PUT', headers: x.admin, body: JSON.stringify(body) })).status, 400);
    }
    assert.equal((await x.window(new Date(x.now + 60000).toISOString())).body.open, true);
    assert.equal((await send(x.guest(), `/api/c/${collection.token}/session`)).status, 401);
    await x.unlock(collection);
  } finally { await x.close(); }
});

test('window persists, expires at its boundary and reopens existing sessions without losing partial or completed files', async () => {
  const x = await setup();
  try {
    const deadline = x.now + 60000;
    assert.equal((await x.window(new Date(deadline).toISOString())).status, 200);
    const c = await x.create(), auth = await x.unlock(c), path = await x.post(c, auth, 6), id = path.split('/').at(-1);
    const patch = (offset, bytes) => send(x.guest(), path, { method: 'PATCH', headers: { ...auth, 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' }, body: bytes });
    assert.equal((await patch(0, 'abc')).status, 204);
    await until(() => send(x.guest(), path, { method: 'HEAD', headers: auth }), result => result.status === 200);
    assert.equal((await x.window(null)).body.open, false);
    assert.equal((await patch(3, 'def')).status, 403);
    assert.equal((await send(x.guest(), path, { method: 'DELETE', headers: auth })).status, 403);
    const partial = x.db.prepare('SELECT storage_locator FROM uploads WHERE id=?').get(id).storage_locator;
    assert.equal(readFileSync(join(x.root, partial), 'utf8'), 'abc');
    assert.equal(commitment(x.db, c.id).reservedBytes, 6);
    await x.restart();
    assert.equal((await send(x.config.adminSocketPath, '/api/admin/intake', { headers: x.identity })).body.open, false);
    assert.equal((await x.window(new Date(deadline).toISOString())).body.open, true);
    await x.restart();
    assert.equal((await send(x.config.adminSocketPath, '/api/admin/intake', { headers: x.identity })).body.closesAt, new Date(deadline).toISOString());
    x.now = deadline - 1;
    assert.equal((await send(x.guest(), path, { method: 'HEAD', headers: auth })).headers['upload-offset'], '3');
    x.now = deadline;
    assert.equal((await send(x.guest(), path, { method: 'HEAD', headers: auth })).status, 403);
    assert.equal((await send(x.config.adminSocketPath, '/api/admin/intake', { headers: x.identity })).body.open, false);
    await x.restart();
    assert.equal((await send(x.guest(), `/api/c/${c.token}/uploads`, { headers: auth })).status, 403);
    await x.window(new Date(x.now + 60000).toISOString());
    assert.equal((await patch(3, 'def')).status, 204);
    const receipt = await until(() => send(x.guest(), `/api/c/${c.token}/uploads/${id}`, { headers: auth }), result => result.body.status === 'completed');
    const row = x.db.prepare('SELECT storage_locator,content_hash FROM uploads WHERE id=?').get(id);
    assert.equal(readFileSync(join(x.root, row.storage_locator), 'utf8'), 'abcdef');
    assert.equal(row.content_hash, createHash('sha256').update('abcdef').digest('hex'));
    await x.window(null);
    assert.equal((await send(x.guest(), `/api/c/${c.token}/uploads/${id}`, { headers: auth })).status, 403);
    assert.equal(readFileSync(join(x.root, row.storage_locator), 'utf8'), 'abcdef');
    assert.equal(commitment(x.db, c.id).completedBytes, 6);
    assert.equal(receipt.body.id, id);
  } finally { await x.close(); }
});

test('upgrading v5 closes intake while preserving collections and upload reservations', async () => {
  const x = await setup();
  try {
    await x.window(new Date(x.now + 60000).toISOString());
    const c = await x.create(), auth = await x.unlock(c), path = await x.post(c, auth, 4), id = path.split('/').at(-1);
    await x.stop();
    const legacy = new DatabaseSync(x.config.dbPath);
    legacy.exec('DROP TABLE intake_window; DELETE FROM schema_migrations WHERE version=6; PRAGMA user_version=5'); legacy.close();
    await x.restart();
    assert.equal((await send(x.guest(), `/api/c/${c.token}/session`, { headers: auth })).status, 403);
    assert.equal(commitment(x.db, c.id).reservedBytes, 4);
    assert.equal(x.db.prepare('SELECT original_name FROM uploads WHERE id=?').get(id).original_name, 'saved.bin');
    await x.window(new Date(x.now + 60000).toISOString());
    assert.equal((await send(x.guest(), path, { method: 'HEAD', headers: auth })).headers['upload-offset'], '0');
  } finally { await x.close(); }
});

test('closing permits an already admitted chunk to settle but blocks its next request', async () => {
  const x = await setup();
  let req;
  try {
    await x.window(new Date(x.now + 60000).toISOString());
    const c = await x.create(), auth = await x.unlock(c), path = await x.post(c, auth, 6);
    const result = new Promise((resolve, reject) => {
      req = request(new URL(path, x.guest()), { method: 'PATCH', headers: { ...auth, 'Upload-Offset': '0',
        'Content-Type': 'application/offset+octet-stream', 'Content-Length': '3' } }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      });
      req.setTimeout(5000, () => req.destroy(new Error('Chunk did not settle')));
      req.on('error', reject); req.write('a');
    });
    // A same-ID HEAD cannot enter once the streaming request owns the ID.
    await until(() => send(x.guest(), path, { method: 'HEAD', headers: auth }), value => value.status === 503);
    await x.window(null);
    req.end('bc');
    assert.equal(await result, 204);
    assert.equal((await send(x.guest(), path, { method: 'HEAD', headers: auth })).status, 403);
    await x.window(new Date(x.now + 60000).toISOString());
    const head = await until(() => send(x.guest(), path, { method: 'HEAD', headers: auth }), value => value.status === 200);
    assert.equal(head.headers['upload-offset'], '3');
  } finally { req?.destroy(); await x.close(); }
});
