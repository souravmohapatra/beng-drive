import { randomBytes } from 'node:crypto';
import { digest, createCollection, listCollections, detailCollection, editCollection, rotateKey, revokeCollection } from './collections.mjs';

const cookieName = '__Host-beng_admin';
const token = () => randomBytes(32).toString('base64url');
const fail = (status, code, allow) => { const error = new Error(code); error.status=status; error.code=code; error.allow=allow; throw error; };
function cookie(req) {
  const values = (req.headers.cookie || '').split(';').map(x=>x.trim()).filter(x=>x.startsWith(`${cookieName}=`));
  return values.length === 1 ? values[0].slice(cookieName.length+1) : '';
}
function existing(db, req) {
  const raw = cookie(req);
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
  const row = db.prepare('SELECT * FROM admin_sessions WHERE token_hash=? AND expires_at>?').get(digest(raw),new Date().toISOString());
  return row ? { raw, row } : null;
}
function session(db, req) {
  db.prepare('DELETE FROM admin_sessions WHERE expires_at<=?').run(new Date().toISOString());
  const current = existing(db,req);
  const raw = current?.raw || token();
  const csrf = token();
  const created = new Date().toISOString();
  const expires = current?.row.expires_at || new Date(Date.parse(created)+28800000).toISOString();
  if (current) db.prepare('UPDATE admin_sessions SET csrf_hash=? WHERE token_hash=?').run(digest(csrf),digest(raw));
  else db.prepare('INSERT INTO admin_sessions VALUES (?,?,?,?)').run(digest(raw),digest(csrf),created,expires);
  return { status:200, payload:{ status:'ok', csrfToken:csrf, expiresAt:expires }, headers:{ 'Set-Cookie':`${cookieName}=${raw}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.max(1,Math.floor((Date.parse(expires)-Date.now())/1000))}` } };
}
function mutation(db, req, origin) {
  const current = existing(db,req);
  if (!current || req.headers.origin !== origin || !/^[A-Za-z0-9_-]{43}$/.test(req.headers['x-csrf-token'] || '') || current.row.csrf_hash !== digest(req.headers['x-csrf-token'])) fail(403,'FORBIDDEN');
}
async function jsonBody(req) {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) fail(400,'INVALID_INPUT');
  if (Number(req.headers['content-length']) > 16384) fail(413,'BODY_TOO_LARGE');
  const chunks=[];
  let size=0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) fail(413,'BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))); }
  catch { fail(400,'INVALID_JSON'); }
}
function query(url) {
  if ([...url.searchParams.keys()].some(k=>k!=='cursor' && k!=='limit') || url.searchParams.getAll('cursor').length>1 || url.searchParams.getAll('limit').length>1) fail(400,'INVALID_INPUT');
  const n=url.searchParams.get('limit');
  const limit=n===null?100:Number(n);
  if (!Number.isInteger(limit) || limit<1 || limit>100) fail(400,'INVALID_INPUT');
  const cursor=url.searchParams.get('cursor');
  if (cursor && (cursor.length>512 || !/^[A-Za-z0-9_-]+$/.test(cursor))) fail(400,'INVALID_CURSOR');
  return {cursor,limit};
}
export async function adminApi(req,config,db,url,uploads) {
  if (!db) fail(503,'DATABASE_UNAVAILABLE');
  const path=url.pathname;
  if (path==='/api/admin/session') {
    if (req.method!=='GET') fail(405,'METHOD_NOT_ALLOWED','GET');
    const result = session(db,req);
    result.payload.publicOrigin = config.publicOrigin;
    return result;
  }
  if (path==='/api/admin/health') {
    if (req.method!=='GET') fail(405,'METHOD_NOT_ALLOWED','GET');
    if (url.search) fail(400,'INVALID_INPUT');
    if (!uploads?.health) fail(503,'STORAGE_UNAVAILABLE');
    return {status:200,payload:await uploads.health()};
  }
  if (path==='/api/admin/collections') {
    if (req.method==='GET') { const {cursor,limit}=query(url); return {status:200,payload:listCollections(db,cursor,limit)}; }
    if (req.method==='POST') { mutation(db,req,config.adminOrigin); return {status:201,payload:createCollection(db,await jsonBody(req),config.publicOrigin,config.limits)}; }
    fail(405,'METHOD_NOT_ALLOWED','GET, POST');
  }
  const match=/^\/api\/admin\/collections\/([0-9a-f-]{36})(?:\/(rotate-key|revoke))?$/.exec(path);
  if (!match) fail(404,'NOT_FOUND');
  const [,id,operation]=match;
  if (operation==='rotate-key' || operation==='revoke') {
    if (req.method!=='POST') fail(405,'METHOD_NOT_ALLOWED','POST');
    mutation(db,req,config.adminOrigin);
    return {status:200,payload:operation==='rotate-key'?rotateKey(db,id):revokeCollection(db,id)};
  }
  if (req.method==='GET') { const {cursor,limit}=query(url); return {status:200,payload:detailCollection(db,id,cursor,limit)}; }
  if (req.method==='PATCH') { mutation(db,req,config.adminOrigin); return {status:200,payload:editCollection(db,id,await jsonBody(req))}; }
  fail(405,'METHOD_NOT_ALLOWED','GET, PATCH');
}
