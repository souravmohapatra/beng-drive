import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ERRORS, Server } from '@tus/server';
import { authorizeGuest } from './guest-auth.mjs';
import { reserveUpload, transitionUpload, annotateUploadError, completeUpload } from './collections.mjs';

const version = '1.0.0';
const ids = /^[0-9a-f]{32}$/;
const decimal = /^(0|[1-9][0-9]*)$/;
const scope = new AsyncLocalStorage();
const fail = (status, code, extra = {}) => { const error = new Error(code); Object.assign(error, { status, code, ...extra }); throw error; };
const busy = () => fail(503, 'STORAGE_BUSY', { retryAfterSeconds: 2 });
const service = () => fail(503, 'STORAGE_UNAVAILABLE', { retryAfterSeconds: 2 });
function number(value) {
  if (typeof value !== 'string' || !decimal.test(value) || !Number.isSafeInteger(Number(value))) fail(400, 'INVALID_LENGTH');
  return Number(value);
}
const utf8 = value => new TextDecoder('utf-8', { fatal: true }).decode(value);

function metadata(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 4096) fail(400, 'INVALID_METADATA');
  const result = {};
  let size = 0;
  for (const entry of raw ? raw.split(',') : []) {
    const match = /^(filename|filetype|lastModified) ([A-Za-z0-9+/]*={0,2})$/.exec(entry.trim());
    if (!match || Object.hasOwn(result, match[1]) || match[2].length % 4 === 1) fail(400, 'INVALID_METADATA');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.toString('base64') !== match[2] || (size += bytes.length) > 2048) fail(400, 'INVALID_METADATA');
    let value;
    try { value = utf8(bytes); } catch { fail(400, 'INVALID_METADATA'); }
    if (/[\x00-\x1f\x7f-\x9f]/.test(value)) fail(400, 'INVALID_METADATA');
    result[match[1]] = value;
  }
  const name = result.filename;
  if (!name || Buffer.byteLength(name) > 255 || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) fail(400, 'INVALID_METADATA');
  if (result.filetype && Buffer.byteLength(result.filetype) > 128) fail(400, 'INVALID_METADATA');
  if (result.lastModified !== undefined) {
    const n = number(result.lastModified);
    if (n > 8640000000000000 || n > Date.now() + 86400000) fail(400, 'INVALID_METADATA');
  }
  return result;
}

async function emptyBody(req) {
  if (req.headers['content-length'] && req.headers['content-length'] !== '0') fail(400, 'BODY_NOT_EMPTY');
  for await (const chunk of req) if (chunk.length) fail(400, 'BODY_NOT_EMPTY');
}

function send(res, status, code, extra = {}, head = false) {
  const headers = { 'Tus-Resumable': version, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra };
  if (code && !head) headers['Content-Type'] = 'application/json; charset=utf-8';
  res.writeHead(status, headers);
  res.end(code && !head ? JSON.stringify({ error: { code, message: status >= 500 ? 'Service unavailable' : 'Request unavailable' } }) : undefined);
}

export function uploadApi(config, storage, db, options = {}) {
  const clock = options.cleanupClock || Date.now;
  const stamp = () => new Date(clock()).toISOString();
  const workerClockOffset = () => config.fixture ? Math.round(clock() - Date.now()) : 0;
  const held = new Set();
  const sessions = new Map();
  let globalOwner = null;
  const transferOwners = new Set();
  const chunkReservations = new Map();
  let grantedChunkBytes = 0;
  let startupRecovering = false;
  let cleaning = false;
  const active = () => scope.getStore() || service();
  const call = (ctx, op, args, stream) => {
    let task;
    try { task = storage.submit(op, args, stream); }
    catch (error) { if (error.code === 'BUSY') busy(); service(); }
    const settlement = task.settled.catch(() => {});
    ctx.pending.add(settlement);
    settlement.finally(() => ctx.pending.delete(settlement));
    return task.catch(error => {
      if (op === 'create' || op === 'write') ctx.reconcileActivity = true;
      if (error.status) throw error;
      if (error.code === 'BUSY' || error.code === 'STORAGE_TIMEOUT') busy();
      if (error.code === 'OFFSET_CONFLICT') fail(409, 'OFFSET_CONFLICT');
      if (error.code === 'OVERLENGTH') fail(413, 'BODY_TOO_LARGE');
      service();
    });
  };
  const inspect = async (ctx, row) => {
    const state = await call(ctx, 'inspect', { id: row.id });
    if (!state.exists) {
      if (row.status === 'creating' || row.status === 'deleting') return null;
      service();
    }
    const info = state.info;
    if (info.id !== row.id || info.size !== row.declared_size || info.offset < 0 || info.offset > info.size || info.metadata?.filename !== row.original_name) service();
    return info;
  };
  const uploadRow = (ctx, id) => db.prepare('SELECT * FROM uploads WHERE id=? AND collection_id=? AND grant_id=?').get(id, ctx.auth.collection.id, ctx.auth.grant.id) || fail(404, 'NOT_FOUND');
  const snapshot = async ctx => {
    const probe = await call(ctx, 'probe', {});
    if (!Number.isSafeInteger(probe.freeBytes) || probe.freeBytes < 0) service();
    let outstanding = 0;
    for (const row of db.prepare("SELECT * FROM uploads WHERE status NOT IN ('completed','cancelled')").all()) {
      const info = await inspect(ctx, row);
      outstanding += row.declared_size - (info?.offset ?? 0);
      if (!Number.isSafeInteger(outstanding)) service();
    }
    return probe.freeBytes - outstanding;
  };
  const rowById = id => db.prepare('SELECT * FROM uploads WHERE id=?').get(id);
  const validActivityTime = (row, at) => {
    if (typeof at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(at) ||
      !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at ||
      Date.parse(at) < Date.parse(row.created_at) - 60000 || Date.parse(at) > clock() + 60000) service();
    return at;
  };
  const activity = (row, at) => {
    validActivityTime(row, at);
    db.prepare("UPDATE uploads SET transfer_at=? WHERE id=? AND status IN ('creating','uploading') AND (transfer_at IS NULL OR transfer_at<?)")
      .run(at, row.id, at);
  };
  const durableActivity = (row, info) => {
    if (info.owner && (info.owner.collectionId !== row.collection_id || info.owner.grantId !== row.grant_id)) service();
    if (!info.activity) return false; // Legacy sidecar: its last successful write time is unknown.
    if (!info.owner || info.activity.version !== 1 || info.activity.offset !== info.offset ||
      !Number.isSafeInteger(info.activity.offset) || info.activity.offset < 0 || info.activity.offset > row.declared_size)
      service();
    activity(row, info.activity.at);
    return true;
  };
  const reconcileActivity = async (id, ctx) => {
    const row = rowById(id);
    if (!row || !['creating','uploading'].includes(row.status)) return true;
    const state = await call(ctx, 'inspect', { id });
    if (!state.exists) return row.status === 'creating';
    const info = state.info;
    if (info.id !== id || info.size !== row.declared_size || info.metadata?.filename !== row.original_name ||
      !Number.isSafeInteger(info.offset) || info.offset < 0 || info.offset > info.size) service();
    return durableActivity(row, info);
  };
  const claim = (id, write, shared = false) => {
    if (shared && transferOwners.size >= 10) return false;
    if (held.has(id) || (write && (globalOwner !== null || (!shared && transferOwners.size)))) return false;
    held.add(id);
    if (shared) transferOwners.add(id);
    else if (write) globalOwner = id;
    return true;
  };
  const release = (id, sessionHash) => {
    held.delete(id);
    chunkReservations.delete(id);
    transferOwners.delete(id);
    if (!transferOwners.size) grantedChunkBytes = 0;
    if (globalOwner === id) globalOwner = null;
    if (sessionHash) {
      const count = sessions.get(sessionHash) ?? 1;
      if (count <= 1) sessions.delete(sessionHash); else sessions.set(sessionHash, count - 1);
    }
  };
  const recoverOne = async (id, ctx) => {
    let row = rowById(id);
    if (!row || row.status === 'cancelled' || row.status === 'deleting') return;
    try {
      if (row.status === 'creating' || row.status === 'uploading') {
        const state = await call(ctx, 'inspect', { id });
        if (!state.exists) return; // creating without artifacts retains its reservation.
        const info = state.info;
        if (info.id !== id || info.size !== row.declared_size || info.metadata?.filename !== row.original_name) service();
        durableActivity(row, info);
        if (row.status === 'creating') transitionUpload(db, id, 'creating', 'uploading');
        if (info.offset !== info.size) return;
        transitionUpload(db, id, 'uploading', 'finalizing');
        row = rowById(id);
      }
      if (row.status === 'finalizing') {
        const result = await call(ctx, 'finalize', { id, collectionId: row.collection_id, size: row.declared_size, originalName: row.original_name });
        row = completeUpload(db, id, result);
      }
      if (row.status === 'completed' && row.content_hash) {
        await call(ctx, 'cleanupCompletion', { id, collectionId: row.collection_id, size: row.declared_size,
          originalName: row.original_name, locator: row.storage_locator, hash: row.content_hash });
        db.prepare("UPDATE uploads SET error_code=NULL WHERE id=? AND status='completed'").run(id);
      }
    } catch {
      const current = rowById(id);
      if (current && current.status !== 'cancelled') {
        try { annotateUploadError(db, id, current.status, current.status === 'completed' ? 'CLEANUP_ERROR' : 'STORAGE_ERROR'); }
        catch { /* Preserve the original state for retry. */ }
      }
    }
  };
  const kick = id => {
    if (!ids.test(id)) return false;
    const row = rowById(id);
    if (!row || !['creating','uploading','finalizing'].includes(row.status)) return false;
    if (!claim(id, true)) return false;
    const ctx = { pending: new Set() };
    (async () => {
      try { await recoverOne(id, ctx); }
      finally { await Promise.allSettled(ctx.pending); release(id); }
    })().catch(() => {});
    return true;
  };
  const removeOwned = async (id, ctx) => {
    const row = rowById(id);
    if (!row || row.status === 'cancelled') return;
    if (!['creating','uploading','deleting'].includes(row.status)) return;
    if (row.status !== 'deleting') {
      transitionUpload(db, id, row.status, 'deleting');
      db.prepare("UPDATE uploads SET deleting_at=? WHERE id=? AND status='deleting'").run(stamp(), id);
    }
    try {
      if (!row.deletion_intent) {
        const prepared = await call(ctx, 'removePartial', { id, size: row.declared_size, collectionId: row.collection_id,
          grantId: row.grant_id, originalName: row.original_name, allowEmptyOrphan: true, prepare: true });
        if (prepared.absent && row.status !== 'creating') service();
        db.prepare("UPDATE uploads SET deletion_intent=1 WHERE id=? AND status='deleting'").run(id);
      }
      await call(ctx, 'removePartial', { id, size: row.declared_size, collectionId: row.collection_id,
        grantId: row.grant_id, originalName: row.original_name, allowEmptyOrphan: true });
      const state = await call(ctx, 'inspect', { id });
      if (state.exists) service();
      transitionUpload(db, id, 'deleting', 'cancelled', { deletionConfirmed: true });
    } catch (error) {
      try { annotateUploadError(db, id, 'deleting', 'STORAGE_ERROR'); } catch {}
      throw error;
    }
  };
  const cleanupState = () => db.prepare('SELECT * FROM cleanup_state WHERE id=1').get();
  const candidates = (cursor, limit = 16) => db.prepare(`SELECT u.id,u.status,u.transfer_at,c.expires_at,c.revoked_at FROM uploads u
    JOIN collections c ON c.id=u.collection_id WHERE u.id>? AND u.status IN ('creating','uploading','deleting')
    ORDER BY u.id LIMIT ?`).all(cursor, limit);
  const candidateById = id => db.prepare(`SELECT u.id,u.status,u.transfer_at,c.expires_at,c.revoked_at FROM uploads u
    JOIN collections c ON c.id=u.collection_id WHERE u.id=? AND u.status IN ('creating','uploading','deleting')`).get(id);
  const eligible = row => row.status === 'deleting' || !!row.revoked_at || Date.parse(row.expires_at) <= clock() ||
    (row.transfer_at && Date.parse(row.transfer_at) + config.limits.PARTIAL_IDLE_SECONDS * 1000 <= clock());
  const cleanup = async () => {
    if (cleaning || startupRecovering) return false;
    cleaning = true;
    const started = stamp();
    db.prepare('UPDATE cleanup_state SET last_attempt_at=? WHERE id=1').run(started);
    let failed = false;
    try {
      if (!await storage.readiness()) {
        db.prepare("UPDATE cleanup_state SET last_error_code='STORAGE_UNAVAILABLE' WHERE id=1").run();
        return false;
      }
      let cursor = '';
      while (true) {
        const rows = candidates(cursor);
        if (!rows.length) break;
        for (const row of rows) {
          cursor = row.id;
          if (!eligible(row)) continue;
          if (!claim(row.id, true)) { failed = true; continue; }
          const ctx = { pending: new Set() };
          try {
            const fresh = candidateById(row.id);
            if (fresh && eligible(fresh)) {
              const external = !!fresh.revoked_at || Date.parse(fresh.expires_at) <= clock();
              if (!external && fresh.status !== 'deleting' && !await reconcileActivity(row.id, ctx)) {
                annotateUploadError(db, row.id, fresh.status, 'ACTIVITY_UNKNOWN');
                failed = true;
              } else if (eligible(candidateById(row.id))) await removeOwned(row.id, ctx);
            }
          }
          catch { failed = true; }
          finally { await Promise.allSettled(ctx.pending); release(row.id); }
        }
        await new Promise(resolve => setImmediate(resolve));
      }
      db.prepare('UPDATE cleanup_state SET last_success_at=CASE WHEN ?=0 THEN ? ELSE last_success_at END,last_error_code=? WHERE id=1')
        .run(failed ? 1 : 0, stamp(), failed ? 'CLEANUP_PENDING' : null);
      return !failed;
    } catch {
      db.prepare("UPDATE cleanup_state SET last_error_code='CLEANUP_ERROR' WHERE id=1").run();
      return false;
    } finally { cleaning = false; }
  };
  const health = async () => {
    const state = cleanupState();
    const dueAt = stamp();
    const idleAt = new Date(clock() - config.limits.PARTIAL_IDLE_SECONDS * 1000).toISOString();
    const overdueAt = new Date(clock() - 86400000).toISOString();
    const oldIdleAt = new Date(clock() - config.limits.PARTIAL_IDLE_SECONDS * 1000 - 86400000).toISOString();
    const counts = db.prepare(`SELECT
      COUNT(*) FILTER (WHERE u.status='deleting' OR c.revoked_at IS NOT NULL OR c.expires_at<=? OR u.transfer_at<=?) AS pending,
      COUNT(*) FILTER (WHERE (u.status='deleting' AND u.deleting_at<=?) OR c.revoked_at<=? OR c.expires_at<=? OR u.transfer_at<=?) AS overdue,
      COUNT(*) FILTER (WHERE u.error_code IS NOT NULL) AS errors
      FROM uploads u JOIN collections c ON c.id=u.collection_id
      WHERE u.status IN ('creating','uploading','deleting')`).get(dueAt,idleAt,overdueAt,overdueAt,overdueAt,oldIdleAt);
    let storageState = 'unavailable';
    if (globalOwner !== null || transferOwners.size || startupRecovering) storageState = 'busy';
    else try { storageState = await storage.readiness() ? 'available' : 'unavailable'; } catch {}
    return { storage: storageState, cleanup: { lastAttemptAt: state.last_attempt_at,
      lastSuccessAt: state.last_success_at, pending: counts.pending, overdue: counts.overdue,
      errors: counts.errors, errorCode: state.last_error_code } };
  };
  class WorkerStore extends EventEmitter {
    extensions = ['creation', 'termination'];
    hasExtension(value) { return this.extensions.includes(value); }
    getExpiration() { return 0; }
    async create(upload) {
      const ctx = active();
      reserveUpload(db, { id: upload.id, collectionId: ctx.auth.collection.id, grantId: ctx.auth.grant.id,
        originalName: ctx.meta.filename, metadata: ctx.meta, storageLocator: `partials/${upload.id}.part`, declaredSize: upload.size,
        fileLimit: config.limits.COLLECTION_MAX_FILES });
      try {
        const result = await call(ctx, 'create', { id: upload.id, size: upload.size, metadata: ctx.meta,
          collectionId: ctx.auth.collection.id, grantId: ctx.auth.grant.id, clockOffsetMs: workerClockOffset() });
        transitionUpload(db, upload.id, 'creating', 'uploading');
        activity(rowById(upload.id), result.activityAt);
        if (upload.size === 0) transitionUpload(db, upload.id, 'uploading', 'finalizing');
        return upload;
      } catch (error) {
        ctx.reconcileActivity = true;
        try { annotateUploadError(db, upload.id, rowById(upload.id)?.status, 'STORAGE_ERROR'); } catch {}
        throw error;
      }
    }
    async getUpload(id) {
      const ctx = active();
      const row = uploadRow(ctx, id);
      if (row.status === 'cancelled' || row.status === 'deleting') fail(410, 'UPLOAD_UNAVAILABLE');
      if (row.status === 'completed' || row.status === 'finalizing') {
        const meta = row.upload_metadata ? JSON.parse(row.upload_metadata) : { filename: row.original_name };
        if (ctx.id === id && ctx.auth.upload?.id === id) ctx.currentOffset = { id, value: row.declared_size };
        return { id, size: row.declared_size, offset: row.declared_size, metadata: meta, sizeIsDeferred: false };
      }
      const info = await inspect(ctx, row);
      if (!info) service();
      if (ctx.id === id && ctx.auth.upload?.id === id) ctx.currentOffset = { id, value: info.offset };
      if (row.status === 'creating') transitionUpload(db, id, 'creating', 'uploading');
      if (info.offset === info.size && (row.status === 'creating' || row.status === 'uploading')) transitionUpload(db, id, 'uploading', 'finalizing');
      return { id, size: info.size, offset: info.offset, metadata: info.metadata, sizeIsDeferred: false };
    }
    async write(stream, id, offset) {
      const ctx = active();
      const row = uploadRow(ctx, id);
      if (row.status !== 'uploading') fail(409, 'UPLOAD_FINALIZING');
      const max = Math.min(config.limits.UPLOAD_CHUNK_MAX_BYTES, row.declared_size - offset);
      // Retain the pre-probe reservation total even if another writer settles
      // during the probe: its bytes may not be reflected in this free-space sample.
      const before = grantedChunkBytes;
      let reserved = 0;
      for (const bytes of chunkReservations.values()) reserved += bytes;
      const free = await call(ctx, 'probe', {});
      const required = reserved + (grantedChunkBytes - before) + max;
      if (!Number.isSafeInteger(free.freeBytes) || free.freeBytes < 0 ||
        !Number.isSafeInteger(required) || !Number.isSafeInteger(grantedChunkBytes + max)) service();
      if (free.freeBytes - required < config.limits.FREE_SPACE_FLOOR_BYTES) fail(507, 'INSUFFICIENT_STORAGE');
      // No await between checking the sample and publishing this reservation.
      // Release only with the request claim, after actual worker settlement.
      grantedChunkBytes += max;
      chunkReservations.set(id, max);
      let bytes = 0;
      const bounded = (async function* () {
        const source = stream[Symbol.asyncIterator]();
        while (true) {
          if (ctx.cancelled) fail(400, 'ABORTED');
          let onAbort;
          const aborted = new Promise(resolve => {
            onAbort = () => resolve({ cancelled: true });
            ctx.abortController.signal.addEventListener('abort', onAbort, { once: true });
          });
          let next;
          try { next = await Promise.race([source.next(), aborted]); }
          finally { ctx.abortController.signal.removeEventListener('abort', onAbort); }
          if (next.cancelled) fail(400, 'ABORTED');
          if (next.done) break;
          const chunk = next.value;
          bytes += chunk.length;
          if (bytes > max) fail(413, 'BODY_TOO_LARGE');
          yield chunk;
        }
        if (ctx.cancelled) fail(400, 'ABORTED');
      })();
      try {
        const result = await call(ctx, 'write', { id, offset, collectionId: row.collection_id,
          grantId: row.grant_id, clockOffsetMs: workerClockOffset() }, bounded);
        if (result.offset > offset) activity(row, result.activityAt);
        if (result.offset === row.declared_size) transitionUpload(db, id, 'uploading', 'finalizing');
        return result.offset;
      } catch (error) { ctx.reconcileActivity = true; throw error; }
    }
    async remove(id) {
      const ctx = active();
      const row = uploadRow(ctx, id);
      if (row.status === 'finalizing' || row.status === 'completed') fail(409, 'UPLOAD_FINALIZING');
      await removeOwned(id, ctx);
    }
  }
  const tus = new Server({
    path: '/uploads', datastore: new WorkerStore(), relativeLocation: true, allowedOrigins: () => false,
    maxSize: config.limits.FILE_MAX_BYTES,
    namingFunction: () => active().id,
    getFileIdFromRequest: req => {
      const path = new URL(req.url).pathname;
      const match = /^\/uploads\/[^/]+\/([0-9a-f]{32})$/.exec(path);
      return match?.[1];
    },
    generateUrl: (_req, { id }) => `/uploads/${active().token}/${id}`,
    onResponseError: (_req, error) => {
      const status = error.status || error.status_code || 503;
      const code = error.code || (status === 409 ? 'OFFSET_CONFLICT' : status === 413 ? 'BODY_TOO_LARGE' : 'UPLOAD_UNAVAILABLE');
      const ctx = active();
      if (error === ERRORS.INVALID_OFFSET && ctx.currentOffset?.id === ctx.id && ctx.auth.upload?.id === ctx.id) {
        _req.runtime?.node?.res?.setHeader('Upload-Offset', String(ctx.currentOffset.value));
      }
      if (error.retryAfterSeconds) _req.runtime?.node?.res?.setHeader('Retry-After', String(error.retryAfterSeconds));
      return { status_code: status, body: JSON.stringify({ error: { code, message: status >= 500 ? 'Service unavailable' : 'Request unavailable' }, requestId: ctx.requestId }) };
    },
  });
  const route = async (req, res, url, requestId) => {
    const match = /^\/uploads\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
    if (!match || url.search) fail(404, 'NOT_FOUND');
    const [, token, id] = match;
    if (req.method === 'OPTIONS' && !id) {
      await emptyBody(req);
      res.setHeader('Cache-Control', 'no-store');
      return scope.run({ pending: new Set(), requestId, token }, () => tus.handle(req, res));
    }
    if (!['POST', 'HEAD', 'PATCH', 'DELETE'].includes(req.method) || (id ? req.method === 'POST' : req.method !== 'POST')) fail(405, 'METHOD_NOT_ALLOWED', { allow: id ? 'HEAD, PATCH, DELETE' : 'OPTIONS, POST' });
    if (req.headers['tus-resumable'] !== version) fail(412, 'TUS_VERSION_REQUIRED', { tusVersion: version });
    if (id && !ids.test(id)) fail(404, 'NOT_FOUND');
    const auth = authorizeGuest(db, req, config, token, { uploadId: id, mutation: req.method !== 'HEAD' });
    let size, meta;
    if (req.method === 'POST') {
      if (req.headers['upload-defer-length'] !== undefined || req.headers['upload-concat'] !== undefined || req.headers['content-type'] === 'application/offset+octet-stream') fail(400, 'UNSUPPORTED_EXTENSION');
      size = number(req.headers['upload-length']);
      meta = metadata(req.headers['upload-metadata']);
      await emptyBody(req);
    } else if (req.method === 'HEAD' || req.method === 'DELETE') await emptyBody(req);
    else {
      if (req.headers['content-type'] !== 'application/offset+octet-stream') fail(415, 'INVALID_CONTENT_TYPE');
      if (req.headers['upload-length'] !== undefined || req.headers['upload-defer-length'] !== undefined || req.headers['upload-concat'] !== undefined) fail(400, 'UNSUPPORTED_EXTENSION');
      number(req.headers['upload-offset']);
      if (req.headers['content-length'] !== undefined && number(req.headers['content-length']) > config.limits.UPLOAD_CHUNK_MAX_BYTES) fail(413, 'BODY_TOO_LARGE');
    }
    if (req.method === 'DELETE' && auth.upload.status === 'cancelled') return send(res, 204);
    if (req.method === 'DELETE' && ['finalizing', 'completed'].includes(auth.upload.status)) fail(409, 'UPLOAD_FINALIZING');
    // Inspecting an unfinished sidecar may discard an uncommitted NAS tail.
    const write = req.method !== 'HEAD' || ['creating', 'uploading'].includes(auth.upload.status);
    if (write && startupRecovering) busy();
    const ctx = { auth, token, id: id || randomBytes(16).toString('hex'), meta, size, pending: new Set(), requestId, cancelled: false };
    ctx.abortController = new AbortController();
    ctx.cancel = () => { ctx.cancelled = true; ctx.abortController.abort(); };
    req.once('aborted', ctx.cancel);
    req.once('close', () => { if (!req.complete) ctx.cancel(); });
    req.once('error', ctx.cancel);
    if (req.method === 'PATCH') {
      const count = sessions.get(auth.sessionHash) ?? 0;
      if (count >= config.limits.SESSION_ACTIVE_TRANSFERS) busy();
    }
    // Resume HEAD may inspect/trim only its own partial. Same-ID exclusion
    // protects it, so it can coexist with streams for other uploads.
    if (!claim(ctx.id, write, req.method === 'PATCH' || (req.method === 'HEAD' && write))) busy();
    if (req.method === 'PATCH') {
      const count = sessions.get(auth.sessionHash) ?? 0;
      sessions.set(auth.sessionHash, count + 1);
    }
    try {
      return await scope.run(ctx, async () => {
        if (req.method === 'POST' && size <= config.limits.FILE_MAX_BYTES) {
          const available = await snapshot(ctx);
          if (available - size < config.limits.FREE_SPACE_FLOOR_BYTES) fail(507, 'INSUFFICIENT_STORAGE');
        }
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        return tus.handle(req, res);
      });
    } finally {
      Promise.allSettled(ctx.pending).then(async () => {
        try {
          if (write && ctx.reconcileActivity && ['POST','PATCH'].includes(req.method) && ['creating','uploading'].includes(rowById(ctx.id)?.status)) {
            try { await reconcileActivity(ctx.id, ctx); } catch { /* Durable evidence remains for the next owned retry. */ }
            await Promise.allSettled(ctx.pending);
          }
          if (write && rowById(ctx.id)?.status === 'finalizing') {
            await recoverOne(ctx.id, ctx);
            await Promise.allSettled(ctx.pending);
          }
        } finally {
          release(ctx.id, req.method === 'PATCH' ? auth.sessionHash : undefined);
        }
        if (!write && rowById(ctx.id)?.status === 'finalizing') kick(ctx.id);
      }).catch(() => {});
    }
  };
  route.kick = kick;
  route.cleanup = cleanup;
  route.health = health;
  route.ready = () => !startupRecovering && globalOwner === null && transferOwners.size === 0;
  route.recoverStartup = async () => {
    startupRecovering = true;
    try {
      let cursor = '';
      while (true) {
        const rows = db.prepare("SELECT id,status FROM uploads WHERE id>? AND status IN ('creating','uploading','finalizing','completed','deleting') ORDER BY id LIMIT 16").all(cursor);
        if (!rows.length) break;
        for (const row of rows) {
          cursor = row.id;
          if (!claim(row.id, true)) continue;
          const ctx = { pending: new Set() };
          try { if (row.status === 'deleting') await removeOwned(row.id, ctx); else await recoverOne(row.id, ctx); }
          catch { /* Persisted debt remains for the next scheduled pass. */ }
          finally { await Promise.allSettled(ctx.pending); release(row.id); }
        }
        await new Promise(resolve => setImmediate(resolve));
      }
    } finally { startupRecovering = false; }
  };
  return route;
}
