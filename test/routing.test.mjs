import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { request } from 'node:http';
import { mkdtempSync, chmodSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configFrom } from '../src/server/config.mjs';
import { openDatabase } from '../src/server/db.mjs';
import { startServers } from '../src/server/http.mjs';

const owner = 'owner@example.invalid';
function socketGet(socketPath, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, headers }, res => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('production admin is socket-only and guest cannot select its router', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bd-routing-'));
  chmodSync(dir, 0o700);
  const socketPath = join(dir, 'admin.sock');
  const env = {
    NODE_ENV: 'production', APP_MODE: 'production', ADMIN_OWNER_LOGIN: owner,
    ADMIN_SOCKET_PATH: socketPath, DB_PATH: join(dir, 'app.sqlite'),
    PUBLIC_ORIGIN: 'https://drive.example.invalid', ADMIN_ORIGIN: 'https://admin.example.invalid',
  };
  assert.throws(() => configFrom({ ...env, ADMIN_SOCKET_PATH: '' }), /ADMIN_SOCKET_PATH/);
  assert.throws(() => configFrom({ ...env, TRUSTED_ADMIN_PROXY_IP: '127.0.0.1' }), /ADMIN_SOCKET_PATH/);
  assert.throws(() => configFrom({ ...env, ADMIN_SOCKET_PATH: '/tmp/other.sock' }), /ADMIN_SOCKET_PATH/);
  const config = configFrom(env);
  const db = openDatabase(join(dir, 'app.sqlite'));
  const servers = await startServers(config, [0, 0], undefined, db);
  try {
    const guest = `http://127.0.0.1:${servers[0].address().port}`;
    const forged = { Host: 'admin.example.invalid', 'Tailscale-User-Login': owner, 'X-Forwarded-For': '127.0.0.1' };
    assert.equal((await fetch(`${guest}/api/admin/session`, { headers: forged })).status, 404);
    assert.equal((await fetch(`${guest}/admin`, { headers: forged })).status, 404);
    assert.equal((await fetch(`${guest}/`, { headers: forged })).status, 200);
    assert.equal(typeof servers[1].address(), 'string');
    assert.equal(lstatSync(socketPath).mode & 0o777, 0o600);
    const connect = createConnection({ port: config.adminPort, host: '127.0.0.1' });
    assert.equal(await new Promise(resolve => { connect.once('error', () => resolve('refused')); connect.once('connect', () => resolve('open')); }), 'refused');
    assert.equal((await socketGet(socketPath, '/api/admin/session')).status, 403);
    assert.equal((await socketGet(socketPath, '/health/live')).status, 403);
    assert.equal((await socketGet(socketPath, '/api/admin/session', { 'Tailscale-User-Login': 'wrong@example.invalid' })).status, 403);
    const ok = await socketGet(socketPath, '/api/admin/session', { 'Tailscale-User-Login': owner });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['cache-control'], 'no-store');
  } finally {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
