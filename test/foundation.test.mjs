import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { configFrom } from '../src/server/config.mjs';
import { openDatabase } from '../src/server/db.mjs';
import { startServers } from '../src/server/http.mjs';

const owner = 'fixture-owner@example.invalid';
const base = {
  APP_MODE: 'fixture', NODE_ENV: 'test', ADMIN_OWNER_LOGIN: owner,
  TRUSTED_ADMIN_PROXY_IP: '127.0.0.1', DB_PATH: '/tmp/beng-drive-test.sqlite',
  PUBLIC_ORIGIN: 'https://drive.example.invalid', ADMIN_ORIGIN: 'https://admin.example.invalid',
};

test('configuration fails closed without exposing values', () => {
  for (const [patch, name] of [
    [{ APP_MODE: 'production', ADMIN_OWNER_LOGIN: '' }, 'ADMIN_OWNER_LOGIN'],
    [{ APP_MODE: 'production', ADMIN_SOCKET_PATH: '' }, 'ADMIN_SOCKET_PATH'],
    [{ PUBLIC_ORIGIN: 'http://secret.invalid' }, 'PUBLIC_ORIGIN'],
    [{ FILE_MAX_BYTES: 'not-a-number-secret' }, 'FILE_MAX_BYTES'],
    [{ DB_PATH: '/data/app.sqlite' }, 'DB_PATH'],
    [{ DEFAULT_ALLOWANCE_BYTES: '1' }, 'limits'],
  ]) {
    assert.throws(() => configFrom({ ...base, ...patch }), error => error.message.includes(name) && !error.message.includes('secret'));
  }
  assert.equal(configFrom({ ...base, TRUSTED_ADMIN_PROXY_IP: '::ffff:127.0.0.1' }).peer, '127.0.0.1');
  const start = spawnSync(process.execPath, ['src/server/main.mjs'], {
    encoding: 'utf8', env: { APP_MODE: 'production', PUBLIC_ORIGIN: 'https://secret.invalid' },
  });
  assert.equal(start.status, 1);
  assert.match(start.stderr, /"setting":"ADMIN_OWNER_LOGIN"/);
  assert.ok(!start.stderr.includes('secret.invalid'));
});

test('SQLite migration is repeatable and refuses a newer schema', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bd-db-'));
  const path = join(dir, 'app.sqlite');
  const sentinel = 'fixture-persisted-value';
  const assertSentinel = db => {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE name='fixture_sentinel'").get()) throw new Error('sentinel missing');
    assert.equal(db.prepare('SELECT value FROM fixture_sentinel').get()?.value, sentinel);
  };
  try {
    let db = openDatabase(path);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5);
    assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get().n, 5);
    db.exec('CREATE TABLE fixture_sentinel (value TEXT NOT NULL)');
    db.prepare('INSERT INTO fixture_sentinel VALUES (?)').run(sentinel);
    db.close();
    db = openDatabase(path);
    assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get().n, 5);
    assertSentinel(db);
    db.exec('PRAGMA user_version=6');
    db.close();
    assert.throws(() => openDatabase(path), /Unsupported database schema/);
    const replacement = join(dir, 'replacement.sqlite');
    db = openDatabase(replacement);
    db.exec('CREATE TABLE fixture_sentinel (value TEXT NOT NULL)');
    db.prepare('INSERT INTO fixture_sentinel VALUES (?)').run(sentinel);
    db.close();
    rmSync(replacement);
    db = openDatabase(replacement);
    try { assert.throws(() => assertSentinel(db), /sentinel missing/); }
    finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('real guest and admin listeners stay isolated and fail closed', async () => {
  const config = configFrom(base);
  const dir = mkdtempSync(join(tmpdir(), 'bd-http-'));
  const db = openDatabase(join(dir, 'app.sqlite'));
  const logs = [];
  const oldLog = console.info;
  console.info = line => logs.push(line);
  const servers = await startServers(config, [0, 0], undefined, db);
  const [guest, admin] = servers.map(s => `http://127.0.0.1:${s.address().port}`);
  const get = (url, options) => fetch(url, options);
  try {
    let r = await get(`${guest}/health/live`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).status, 'ok');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    r = await get(`${guest}/api/admin/session`, { headers: { Host: 'admin.example.invalid', 'Tailscale-User-Login': owner } });
    assert.equal(r.status, 404);
    r = await get(`${guest}/admin`, { headers: { Host: 'admin.example.invalid', 'Tailscale-User-Login': owner } });
    assert.equal(r.status, 404);
    r = await get(`${guest}/uploads/anything`); assert.equal(r.status, 404);
    r = await get(`${guest}/api/anything`); assert.equal(r.status, 404);
    r = await get(`${guest}/health/live`, { method: 'POST' });
    assert.equal(r.status, 405); assert.equal(r.headers.get('allow'), 'GET');
    r = await get(`${guest}/`); assert.equal(r.status, 200); assert.match(await r.text(), /beng-drive/);
    r = await get(`${admin}/api/admin/session`); assert.equal(r.status, 403);
    r = await get(`${admin}/api/admin/session`, { headers: { 'Tailscale-User-Login': 'foreign@example.invalid' } }); assert.equal(r.status, 403);
    r = await get(`${admin}/api/admin/session`, { headers: { 'Tailscale-User-Login': owner } });
    assert.equal(r.status, 200); assert.equal((await r.json()).status, 'ok');
    r = await get(`${admin}/health/live`, { headers: { 'Tailscale-User-Login': owner } }); assert.equal(r.status, 200);
    r = await get(`${admin}/health/ready`, { headers: { 'Tailscale-User-Login': owner } }); assert.equal(r.status, 503);
    assert.equal((await r.json()).error.code, 'STORAGE_UNAVAILABLE');
    assert.equal(r.headers.get('access-control-allow-origin'), null);
    const untrusted = await startServers({ ...config, peer: '192.0.2.44' }, [0, 0], undefined, db);
    try {
      r = await get(`http://127.0.0.1:${untrusted[1].address().port}/api/admin/session`, { headers: { 'Tailscale-User-Login': owner } });
      assert.equal(r.status, 403);
    } finally { await Promise.all(untrusted.map(s => new Promise(resolve => s.close(resolve)))); }
    const noOwner = await startServers({ ...config, owner: '' }, [0, 0], undefined, db);
    try {
      r = await get(`http://127.0.0.1:${noOwner[1].address().port}/api/admin/session`, { headers: { 'Tailscale-User-Login': owner } });
      assert.equal(r.status, 403);
    } finally { await Promise.all(noOwner.map(s => new Promise(resolve => s.close(resolve)))); }
    assert.ok(logs.length);
    assert.ok(logs.every(line => !line.includes(owner) && !line.includes('/api/') && !line.includes('foreign@')));
  } finally {
    await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
    console.info = oldLog;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
