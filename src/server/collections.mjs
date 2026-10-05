import { createHash, randomBytes, randomUUID } from 'node:crypto';

const now = () => new Date().toISOString();
export const digest = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const fail = (status, code) => { const error = new Error(code); error.status = status; error.code = code; throw error; };
const text = (value, max, required) => {
  if (typeof value !== 'string') fail(400, 'INVALID_INPUT');
  const clean=required?value.trim():value;
  if ((required && !clean) || Buffer.byteLength(clean, 'utf8') > max || Buffer.from(clean,'utf8').toString('utf8') !== clean ||
      (required ? /[\x00-\x1f\x7f-\x9f]/ : /[\x00-\x08\x0b-\x1f\x7f-\x9f]/).test(clean)) fail(400, 'INVALID_INPUT');
  return clean;
};
const allowance = value => {
  if (!Number.isSafeInteger(value) || value < 0) fail(400, 'INVALID_INPUT');
  return value;
};
const expiry = (value, current) => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value || Date.parse(value) <= Date.parse(current)) fail(400, 'INVALID_INPUT');
  return value;
};
function validate(input, edit, current) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'INVALID_INPUT');
  const allowed = ['title','welcome','expiresAt','allowance'];
  if (Object.keys(input).some(key => !allowed.includes(key)) || (edit && !Object.keys(input).length)) fail(400, 'INVALID_INPUT');
  const out = {};
  if ('title' in input || !edit) out.title = text(input.title, 120, true);
  if ('welcome' in input) out.welcome = input.welcome === null ? null : text(input.welcome, 2000, false);
  if ('expiresAt' in input) out.expiresAt = expiry(input.expiresAt, current);
  if ('allowance' in input) out.allowance = allowance(input.allowance);
  return out;
}
export function immediate(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function commitment(db, id) {
  return db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN status='completed' THEN declared_size ELSE 0 END),0) completedBytes,
    COALESCE(SUM(CASE WHEN status NOT IN ('completed','cancelled') THEN declared_size ELSE 0 END),0) reservedBytes,
    COALESCE(SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END),0) completedCount,
    COALESCE(SUM(CASE WHEN status NOT IN ('completed','cancelled') THEN 1 ELSE 0 END),0) reservedCount
    FROM uploads WHERE collection_id=?`).get(id);
}
function row(db, id) { return db.prepare('SELECT * FROM collections WHERE id=?').get(id) || fail(404, 'NOT_FOUND'); }
function summary(db, item) {
  const counts = commitment(db, item.id);
  return {
    id: item.id, token: item.token, title: item.title, welcome: item.welcome,
    expiresAt: item.expires_at, allowance: item.allowance, revokedAt: item.revoked_at,
    createdAt: item.created_at, updatedAt: item.updated_at, credentialVersion: item.credential_version,
    state: item.revoked_at ? 'revoked' : Date.parse(item.expires_at) <= Date.now() ? 'expired' : 'active', ...counts,
  };
}
export function createCollection(db, input, publicOrigin, defaults) {
  const timestamp = now();
  const data = validate(input, false, timestamp);
  return immediate(db, () => {
    const id = randomUUID();
    const token = secret();
    const key = secret();
    const expiresAt = data.expiresAt ?? new Date(Date.parse(timestamp) + defaults.COLLECTION_DEFAULT_TTL_SECONDS * 1000).toISOString();
    const limit = data.allowance ?? defaults.DEFAULT_ALLOWANCE_BYTES;
    db.prepare(`INSERT INTO collections (id,token,title,welcome,key_hash,expires_at,allowance,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(id, token, data.title, data.welcome ?? null, digest(key), expiresAt, limit, timestamp, timestamp);
    return { ...summary(db, row(db, id)), invitationUrl: `${publicOrigin}/c/${token}`, key };
  });
}
export function listCollections(db, cursor, limit = 100) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail(400, 'INVALID_INPUT');
  let before = null;
  if (cursor) {
    try { before = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); }
    catch { fail(400, 'INVALID_CURSOR'); }
    if (!Array.isArray(before) || before.length !== 2 || typeof before[0] !== 'string' || typeof before[1] !== 'string') fail(400, 'INVALID_CURSOR');
  }
  const rows = db.prepare(`SELECT * FROM collections WHERE (? IS NULL OR created_at < ? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?`)
    .all(before?.[0] ?? null, before?.[0] ?? null, before?.[0] ?? null, before?.[1] ?? null, limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { items: page.map(item => summary(db, item)), nextCursor: rows.length > limit ? Buffer.from(JSON.stringify([last.created_at,last.id])).toString('base64url') : null };
}
export function detailCollection(db, id, cursor, limit = 100) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail(400, 'INVALID_INPUT');
  const item = row(db, id);
  let before = null;
  if (cursor) {
    try { before = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); }
    catch { fail(400, 'INVALID_CURSOR'); }
    if (!Array.isArray(before) || before.length !== 2 || typeof before[0] !== 'string' || typeof before[1] !== 'string') fail(400, 'INVALID_CURSOR');
  }
  const uploads = db.prepare(`SELECT u.id,u.original_name,u.declared_size,u.status,u.error_code,u.created_at,g.display_name FROM uploads u JOIN grants g ON g.id=u.grant_id
    WHERE u.collection_id=? AND (? IS NULL OR u.created_at < ? OR (u.created_at=? AND u.id<?)) ORDER BY u.created_at DESC,u.id DESC LIMIT ?`)
    .all(id, before?.[0] ?? null, before?.[0] ?? null, before?.[0] ?? null, before?.[1] ?? null, limit + 1);
  const page = uploads.slice(0, limit);
  const last = page.at(-1);
  return { ...summary(db,item), uploads: page.map(u => ({ id:u.id, originalName:u.original_name, declaredSize:u.declared_size, status:u.status, errorCode:u.error_code, createdAt:u.created_at, displayName:u.display_name })), nextCursor: uploads.length > limit ? Buffer.from(JSON.stringify([last.created_at,last.id])).toString('base64url') : null };
}
export function editCollection(db, id, input) {
  const timestamp = now();
  const data = validate(input, true, timestamp);
  return immediate(db, () => {
    const old = row(db, id);
    const next = { title: data.title ?? old.title, welcome: 'welcome' in data ? data.welcome : old.welcome,
      expiresAt: data.expiresAt ?? old.expires_at, allowance: data.allowance ?? old.allowance };
    const used = commitment(db, id);
    if (next.allowance < used.completedBytes + used.reservedBytes) fail(409, 'ALLOWANCE_CONFLICT');
    db.prepare('UPDATE collections SET title=?,welcome=?,expires_at=?,allowance=?,updated_at=? WHERE id=?')
      .run(next.title,next.welcome,next.expiresAt,next.allowance,timestamp,id);
    return summary(db,row(db,id));
  });
}
export function rotateKey(db,id) {
  const key = secret();
  return immediate(db, () => {
    row(db,id);
    db.prepare('UPDATE collections SET key_hash=?,credential_version=credential_version+1,updated_at=? WHERE id=?').run(digest(key),now(),id);
    db.prepare('UPDATE grants SET expires_at=? WHERE collection_id=?').run(now(),id);
    return { ...summary(db,row(db,id)), key };
  });
}
export function revokeCollection(db,id) {
  return immediate(db, () => {
    row(db,id);
    db.prepare('UPDATE collections SET revoked_at=COALESCE(revoked_at,?),credential_version=CASE WHEN revoked_at IS NULL THEN credential_version+1 ELSE credential_version END,updated_at=? WHERE id=?')
      .run(now(),now(),id);
    db.prepare('UPDATE grants SET expires_at=? WHERE collection_id=?').run(now(),id);
    return summary(db,row(db,id));
  });
}
export function reserveUpload(db, data) {
  if (!Number.isSafeInteger(data.fileLimit) || data.fileLimit < 1 || data.fileLimit > 100000) fail(400,'INVALID_INPUT');
  return immediate(db, () => {
    const c = row(db,data.collectionId);
    if (c.revoked_at || Date.parse(c.expires_at) <= Date.now()) fail(410,'COLLECTION_UNAVAILABLE');
    const grant = db.prepare('SELECT * FROM grants WHERE id=? AND collection_id=?').get(data.grantId,data.collectionId);
    if (!grant || grant.credential_version !== c.credential_version || Date.parse(grant.expires_at) <= Date.now()) fail(403,'FORBIDDEN');
    const bytes = allowance(data.declaredSize);
    const used = commitment(db,data.collectionId);
    if (used.completedBytes + used.reservedBytes + bytes > c.allowance || used.completedCount + used.reservedCount >= data.fileLimit) fail(409,'ALLOWANCE_CONFLICT');
    const timestamp = now();
    db.prepare(`INSERT INTO uploads (id,collection_id,grant_id,original_name,storage_locator,declared_size,status,created_at,updated_at,upload_metadata,transfer_at) VALUES (?,?,?,?,?,?,'creating',?,?,?,?)`)
      .run(data.id,data.collectionId,data.grantId,data.originalName,data.storageLocator,bytes,timestamp,timestamp,JSON.stringify(data.metadata ?? {filename:data.originalName}),timestamp);
    return data.id;
  });
}
export function completeUpload(db,id,{locator,hash,metadata}) {
  if (typeof locator !== 'string' || !/^completed\/[0-9a-f-]{36}\/[0-9a-f]{32}-[^/]{1,160}$/.test(locator) || !/^[0-9a-f]{64}$/.test(hash)) fail(503,'STORAGE_UNAVAILABLE');
  return immediate(db, () => {
    const row=db.prepare('SELECT * FROM uploads WHERE id=?').get(id);
    if (!row) fail(404,'NOT_FOUND');
    if (row.status==='completed') {
      if (row.storage_locator!==locator || row.content_hash!==hash) fail(503,'STORAGE_UNAVAILABLE');
      return row;
    }
    if (row.status!=='finalizing') fail(409,'INVALID_TRANSITION');
    const timestamp=now();
    db.prepare(`UPDATE uploads SET status='completed',storage_locator=?,content_hash=?,upload_metadata=?,completed_at=?,updated_at=?,error_code=NULL WHERE id=? AND status='finalizing'`)
      .run(locator,hash,JSON.stringify(metadata),timestamp,timestamp,id);
    return db.prepare('SELECT * FROM uploads WHERE id=?').get(id);
  });
}
export function transitionUpload(db,id,from,to,{ deletionConfirmed=false,errorCode=null }={}) {
  if (to==='cancelled' && !deletionConfirmed) fail(409,'DELETION_UNCONFIRMED');
  return immediate(db, () => {
    const result = db.prepare('UPDATE uploads SET status=?,error_code=?,deletion_confirmed=CASE WHEN ?=\'cancelled\' THEN 1 ELSE deletion_confirmed END,updated_at=?,completed_at=CASE WHEN ?=\'completed\' THEN ? ELSE completed_at END WHERE id=? AND status=?')
      .run(to,errorCode,to,now(),to,now(),id,from);
    if (!result.changes) fail(409,'INVALID_TRANSITION');
  });
}
export function annotateUploadError(db,id,status,errorCode) {
  if (typeof errorCode!=='string' || !/^[A-Z_]{1,64}$/.test(errorCode)) fail(400,'INVALID_INPUT');
  return immediate(db, () => {
    const result=db.prepare('UPDATE uploads SET error_code=?,updated_at=? WHERE id=? AND status=?')
      .run(errorCode,now(),id,status);
    if (!result.changes) fail(409,'INVALID_TRANSITION');
  });
}
