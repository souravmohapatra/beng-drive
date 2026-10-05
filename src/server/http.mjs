import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { chmod, lstat, open, readFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeIP } from './config.mjs';
import { adminApi } from './admin-api.mjs';
import { guestApi } from './guest-auth.mjs';
import { uploadApi } from './uploads.mjs';

const assets = resolve('dist/client');
const mime = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const ownSocket = st => st.isSocket() && st.uid === process.getuid() && (st.mode & 0o777) === 0o600;
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode && a.isSocket() === b.isSocket();

async function probeAdminSocket(path) {
  return new Promise((resolve, reject) => {
    const connection = createConnection({ path });
    connection.setTimeout(1000);
    connection.once('connect', () => { connection.destroy(); reject(new Error('Admin socket already active')); });
    connection.once('error', error => {
      connection.destroy();
      if (error.code === 'ECONNREFUSED') resolve(true);
      else reject(new Error('Admin socket probe uncertain'));
    });
    connection.once('timeout', () => { connection.destroy(); reject(new Error('Admin socket probe timed out')); });
  });
}
export async function reclaimStaleAdminSocket(path, probe = probeAdminSocket) {
  let before;
  try { before = await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!ownSocket(before)) throw new Error('Unsafe admin socket');
  const refused = await probe(path);
  if (!refused) throw new Error('Admin socket probe uncertain');
  let after;
  try { after = await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!ownSocket(after) || !sameIdentity(before, after)) throw new Error('Admin socket changed during probe');
  await unlink(path);
}

function reply(res, status, payload, requestId, allow, extraHeaders={}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(allow ? { Allow: allow } : {}),
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
  console.info(JSON.stringify({ event: 'request', status, requestId }));
}
function error(res, status, code, requestId, allow, retryAfterSeconds) {
  reply(res, status, { error: { code, message: status >= 500 ? 'Service unavailable' : 'Request unavailable',
    ...(retryAfterSeconds ? {retryAfterSeconds} : {}) }, requestId }, requestId, allow,
  retryAfterSeconds ? {'Retry-After':String(retryAfterSeconds)} : {});
}
async function shell(res, requestId, kind) {
  try {
    const body = (await readFile(join(assets, 'index.html'), 'utf8')).replace('data-view="guest"', `data-view="${kind}"`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  } catch { error(res, 500, 'INTERNAL_ERROR', requestId); }
}
async function asset(res, pathname, requestId) {
  const path = resolve(assets, `.${pathname}`);
  if (!path.startsWith(`${assets}${sep}`)) return error(res, 404, 'NOT_FOUND', requestId);
  try {
    const body = await readFile(path);
    const ext = path.slice(path.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  } catch { error(res, 404, 'NOT_FOUND', requestId); }
}
function handler(kind, config, storage, db, options, uploads) {
  return async (req, res) => {
    const requestId = randomUUID();
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;
    const peer = normalizeIP(req.socket.remoteAddress);
    const trusted = kind === 'admin' && config.adminSocketPath ? true : peer === config.peer && !!config.peer;
    const admin = kind === 'admin';
    if (admin && !trusted) return error(res, 403, 'FORBIDDEN', requestId);
    if (admin && (!config.owner || req.headers['tailscale-user-login'] !== config.owner)) return error(res, 403, 'FORBIDDEN', requestId);

    if (path === '/health/live' || (admin && path === '/health/ready')) {
      if (req.method !== 'GET') return error(res, 405, 'METHOD_NOT_ALLOWED', requestId, 'GET');
      if (path === '/health/ready') {
        if (!storage || !uploads?.ready() || !await storage.readiness()) return error(res, 503, 'STORAGE_UNAVAILABLE', requestId);
        return reply(res, 200, { status: 'ok' }, requestId);
      }
      return reply(res, 200, { status: 'ok' }, requestId);
    }
    if (admin && path.startsWith('/api/admin/')) {
      try {
        const result = await adminApi(req, config, db, url, uploads);
        return reply(res, result.status, result.payload, requestId, undefined, result.headers);
      } catch (failure) {
        if (failure.status) return error(res, failure.status, failure.code, requestId, failure.allow);
        throw failure;
      }
    }
    if (!admin && path.startsWith('/api/c/')) {
      try {
        const result=await guestApi(req,config,db,url,options);
        if (uploads && path.includes('/uploads')) {
          if (result.payload?.id && result.payload.status === 'finalizing') uploads.kick(result.payload.id);
          for (const item of result.payload?.items || []) if (item.status === 'finalizing') uploads.kick(item.id);
        }
        return reply(res,result.status,result.payload,requestId,undefined,result.headers);
      } catch (failure) {
        if (failure.status) return error(res,failure.status,failure.code,requestId,failure.allow,failure.retryAfterSeconds);
        throw failure;
      }
    }
    if (!admin && path.startsWith('/uploads/')) {
      if (!uploads) return error(res, 404, 'NOT_FOUND', requestId);
      try { return await uploads(req, res, url, requestId); }
      catch (failure) {
        if (!failure.status) throw failure;
        if (res.headersSent) return res.destroy();
        const headers = { 'Tus-Resumable': '1.0.0', ...(failure.tusVersion ? { 'Tus-Version': failure.tusVersion } : {}),
          ...(failure.offset !== undefined ? { 'Upload-Offset': String(failure.offset) } : {}) };
        return reply(res, failure.status, { error: { code: failure.code, message: failure.status >= 500 ? 'Service unavailable' : 'Request unavailable' }, requestId }, requestId,
          failure.allow, { ...headers, ...(failure.retryAfterSeconds ? { 'Retry-After': String(failure.retryAfterSeconds) } : {}) });
      }
    }
    const page = path === '/' || (!admin && /^\/c\/[^/]+$/.test(path));
    const staticAsset = path.startsWith('/assets/');
    if (page || staticAsset) {
      if (req.method !== 'GET') return error(res, 405, 'METHOD_NOT_ALLOWED', requestId, 'GET');
      return staticAsset ? asset(res, path, requestId) : shell(res, requestId, kind);
    }
    return error(res, 404, 'NOT_FOUND', requestId);
  };
}
export async function startServers(config, ports = [config.guestPort, config.adminPort], storage, db, options) {
  const uploads = storage && db ? uploadApi(config, storage, db, options) : null;
  if (config.fixture && options?.onCleanupReady && uploads) options.onCleanupReady(uploads.cleanup);
  const servers = ['guest', 'admin'].map(kind => {
    const route = handler(kind, config, storage, db, options, uploads);
    return createServer({ maxHeaderSize: 16384 }, (req, res) => {
      route(req, res).catch(() => res.headersSent ? res.destroy() : error(res, 500, 'INTERNAL_ERROR', randomUUID()));
    });
  });
  for (const server of servers) {
    server.headersTimeout = 10000;
    server.requestTimeout = 15000;
  }
  let ownSocketIdentity;
  let startupLock;
  let lockIdentity;
  const lockPath = config.adminSocketPath && `${config.adminSocketPath}.startup-lock`;
  const releaseStartupLock = async () => {
    if (!startupLock) return;
    const handle = startupLock;
    startupLock = undefined;
    await handle.close();
    const current = await lstat(lockPath);
    if (current.dev !== lockIdentity.dev || current.ino !== lockIdentity.ino || current.uid !== process.getuid() || !current.isFile() || (current.mode & 0o777) !== 0o600) throw new Error('Admin startup lock changed');
    await unlink(lockPath);
  };
  try {
    if (config.adminSocketPath) {
      const parent = await lstat(dirname(config.adminSocketPath));
      if (!parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o777) !== 0o700) throw new Error('Invalid admin socket directory');
      startupLock = await open(lockPath, 'wx', 0o600);
      lockIdentity = await startupLock.stat();
      await reclaimStaleAdminSocket(config.adminSocketPath);
    }
    for (let i = 0; i < servers.length; i++) {
      await new Promise((resolve, reject) => {
        servers[i].once('error', reject);
        if (i === 1 && config.adminSocketPath) servers[i].listen(config.adminSocketPath, resolve);
        else servers[i].listen(ports[i], config.host, resolve);
      });
    }
    if (config.adminSocketPath) {
      const created = await lstat(config.adminSocketPath);
      if (!created.isSocket() || created.uid !== process.getuid()) throw new Error('Invalid new admin socket');
      await chmod(config.adminSocketPath, 0o600);
      ownSocketIdentity = await lstat(config.adminSocketPath);
      if (!ownSocket(ownSocketIdentity) || created.dev !== ownSocketIdentity.dev || created.ino !== ownSocketIdentity.ino) throw new Error('Admin socket changed after bind');
      servers[1].once('close', async () => {
        try { if (sameIdentity(await lstat(config.adminSocketPath), ownSocketIdentity)) await unlink(config.adminSocketPath); }
        catch { /* Keep an uncertain path for operator inspection. */ }
      });
      await releaseStartupLock();
    }
    if (uploads && db.prepare("SELECT 1 FROM uploads WHERE status IN ('creating','uploading','finalizing','completed','deleting') LIMIT 1").get()) {
      setImmediate(() => uploads.recoverStartup().catch(() => {}));
    }
    if (uploads) {
      const timer = setInterval(() => uploads.cleanup().catch(() => {}), config.limits.CLEANUP_INTERVAL_SECONDS * 1000);
      timer.unref();
      servers[0].once('close', () => clearInterval(timer));
    }
    return servers;
  } catch (e) {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    if (startupLock) await releaseStartupLock();
    throw e;
  }
}
