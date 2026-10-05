import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { immediate, commitment } from './collections.mjs';

const cookieName='__Host-beng_session';
const hash=value=>createHash('sha256').update(value).digest('hex');
const secret=()=>randomBytes(32).toString('base64url');
const canonical=value=>typeof value==='string' && /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value,'base64url').length===32 && Buffer.from(value,'base64url').toString('base64url')===value;
const fail=(status,code,retryAfterSeconds,allow)=>{const e=new Error(code);e.status=status;e.code=code;if(retryAfterSeconds)e.retryAfterSeconds=retryAfterSeconds;if(allow)e.allow=allow;throw e;};
const iso=ms=>new Date(ms).toISOString();
export function normalizeSourceIP(value='') {
  if (isIP(value)===4) return value;
  if (isIP(value)===6) {
    const ip=new URL(`http://[${value}]/`).hostname.slice(1,-1);
    if (ip.startsWith('::ffff:')) {
      const parts=ip.slice(7).split(':');
      if (parts.length===2) {
        const a=parseInt(parts[0],16),b=parseInt(parts[1],16);
        return `${a>>>8}.${a&255}.${b>>>8}.${b&255}`;
      }
    }
    return ip;
  }
  return 'unknown';
}
function browserCookie(req) {
  const values=(req.headers.cookie||'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(`${cookieName}=`));
  const raw=values.length===1?values[0].slice(cookieName.length+1):'';
  return canonical(raw)?raw:null;
}
async function readUnlockBody(req) {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']||'')) fail(400,'INVALID_INPUT');
  if (Number(req.headers['content-length'])>16384) fail(413,'BODY_TOO_LARGE');
  let size=0;const chunks=[];
  for await (const chunk of req) {size+=chunk.length;if(size>16384)fail(413,'BODY_TOO_LARGE');chunks.push(chunk);}
  let body;
  try {body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}
  catch {fail(400,'INVALID_JSON');}
  if (!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).some(k=>k!=='key'&&k!=='displayName')) fail(400,'INVALID_INPUT');
  if (!canonical(body.key) || typeof body.displayName!=='string') fail(400,'INVALID_INPUT');
  const name=body.displayName.trim();
  if (!name || Buffer.byteLength(name,'utf8')>80 || Buffer.from(name,'utf8').toString('utf8')!==name || /[\x00-\x1f\x7f-\x9f]/.test(name)) fail(400,'INVALID_INPUT');
  return {key:body.key,displayName:name};
}
function retry(oldest,windowMs,at) {return Math.max(1,Math.min(900,Math.ceil((oldest+windowMs-at)/1000)));}
function limited(db,at,collectionId,ip) {
  const global=db.prepare('SELECT count(*) n,min(at_ms) oldest FROM unlock_attempts WHERE at_ms>?').get(at-60000);
  if (global.n>=1000) fail(429,'RATE_LIMITED',retry(global.oldest,60000,at));
  if (!collectionId) return;
  const coll=db.prepare('SELECT count(*) n,min(at_ms) oldest FROM unlock_attempts WHERE collection_id=? AND at_ms>?').get(collectionId,at-900000);
  if (coll.n>=100) fail(429,'RATE_LIMITED',retry(coll.oldest,900000,at));
  const perIP=db.prepare('SELECT count(*) n,min(at_ms) oldest FROM unlock_attempts WHERE collection_id=? AND source_ip=? AND failed=1 AND at_ms>?').get(collectionId,ip,at-900000);
  if (perIP.n>=5) fail(429,'RATE_LIMITED',retry(perIP.oldest,900000,at));
  const exists=db.prepare('SELECT 1 FROM unlock_buckets WHERE collection_id=? AND source_ip=?').get(collectionId,ip);
  if (!exists) {
    const capacity=db.prepare('SELECT count(*) n,min(last_at_ms) oldest FROM unlock_buckets').get();
    if (capacity.n>=10000) fail(429,'RATE_LIMITED',retry(capacity.oldest,900000,at));
  }
}
function record(db,at,collectionId,ip,failed) {
  db.prepare('INSERT INTO unlock_attempts(at_ms,collection_id,source_ip,failed) VALUES (?,?,?,?)').run(at,collectionId??null,collectionId?ip:null,failed?1:0);
  if (collectionId) db.prepare('INSERT INTO unlock_buckets VALUES (?,?,?) ON CONFLICT(collection_id,source_ip) DO UPDATE SET last_at_ms=excluded.last_at_ms').run(collectionId,ip,at);
}
function collectionSummary(db,c) {
  const used=commitment(db,c.id);
  return {title:c.title,welcome:c.welcome,expiresAt:c.expires_at,allowance:c.allowance,
    remainingBytes:Math.max(0,c.allowance-used.completedBytes-used.reservedBytes),
    completedBytes:used.completedBytes,reservedBytes:used.reservedBytes};
}
function sessionCookie(raw,expiryMs,at) {
  return `${cookieName}=${raw}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.max(1,Math.floor((expiryMs-at)/1000))}`;
}
export async function unlockGuest(db,req,config,token,{clock=Date.now}={}) {
  const ip=normalizeSourceIP(req.socket?.remoteAddress);
  let body,problem;
  try {body=await readUnlockBody(req);} catch(e){if(!e.status)throw e;problem=e;}
  if (req.headers.origin!==config.publicOrigin) problem=problem||{status:403,code:'ORIGIN_REJECTED'};
  const at=clock();
  const tokenValid=canonical(token);
  const outcome=immediate(db,()=>{
    db.prepare('DELETE FROM unlock_attempts WHERE at_ms<=?').run(at-900000);
    db.prepare('DELETE FROM unlock_buckets WHERE last_at_ms<=?').run(at-900000);
    const c=tokenValid?db.prepare('SELECT * FROM collections WHERE token=?').get(token):null;
    limited(db,at,c?.id,ip);
    let error;
    if (!tokenValid) error={status:400,code:'INVALID_INPUT'};
    else if (!c) error={status:404,code:'NOT_FOUND'};
    else if (c.revoked_at || Date.parse(c.expires_at)<=at) error={status:410,code:'COLLECTION_UNAVAILABLE'};
    else if (problem) error=problem;
    else if (!error) {
      const expected=Buffer.from(c.key_hash,'hex');const actual=Buffer.from(hash(body.key),'hex');
      if (expected.length!==32 || !timingSafeEqual(expected,actual)) error={status:401,code:'INVALID_KEY'};
    }
    if (error) {record(db,at,c?.id,ip,true);return {error};}
    const currentRaw=browserCookie(req);
    const current=currentRaw?db.prepare('SELECT * FROM browser_sessions WHERE token_hash=? AND expires_at>?').get(hash(currentRaw),iso(at)):null;
    const raw=current?currentRaw:secret();
    const sessionHash=hash(raw);
    const expiryMs=Date.parse(c.expires_at);
    let csrf;
    if (current) {
      csrf=db.prepare('SELECT secret FROM guest_csrf WHERE token_hash=?').get(sessionHash)?.secret;
      if (!csrf) {csrf=secret();db.prepare('INSERT INTO guest_csrf VALUES (?,?)').run(sessionHash,csrf);}
      db.prepare('UPDATE browser_sessions SET expires_at=? WHERE token_hash=? AND expires_at<?').run(c.expires_at,sessionHash,c.expires_at);
    } else {
      csrf=secret();
      db.prepare('INSERT INTO browser_sessions(token_hash,csrf_hash,created_at,expires_at) VALUES (?,?,?,?)').run(sessionHash,hash(csrf),iso(at),c.expires_at);
      db.prepare('INSERT INTO guest_csrf VALUES (?,?)').run(sessionHash,csrf);
    }
    const old=db.prepare('SELECT * FROM grants WHERE session_token_hash=? AND collection_id=?').get(sessionHash,c.id);
    const grantId=old?.id||randomUUID();
    if (old) db.prepare('UPDATE grants SET credential_version=?,expires_at=? WHERE id=?').run(c.credential_version,c.expires_at,grantId);
    else db.prepare('INSERT INTO grants VALUES (?,?,?,?,?,?)').run(grantId,sessionHash,c.id,c.credential_version,body.displayName,c.expires_at);
    record(db,at,c.id,ip,false);
    const sessionExpiry=db.prepare('SELECT expires_at FROM browser_sessions WHERE token_hash=?').get(sessionHash).expires_at;
    return {raw,csrf,sessionExpiry,summary:collectionSummary(db,c),displayName:old?.display_name||body.displayName};
  });
  if (outcome.error) fail(outcome.error.status,outcome.error.code);
  return {status:200,payload:{...outcome.summary,displayName:outcome.displayName,csrfToken:outcome.csrf},
    headers:{'Set-Cookie':sessionCookie(outcome.raw,Date.parse(outcome.sessionExpiry),at)}};
}
export function authorizeGuest(db,req,config,token,{uploadId,mutation=false,clock=Date.now}={}) {
  const at=clock();
  const c=canonical(token)?db.prepare('SELECT * FROM collections WHERE token=?').get(token):null;
  if (!c) fail(404,'NOT_FOUND');
  if (c.revoked_at || Date.parse(c.expires_at)<=at) fail(410,'COLLECTION_UNAVAILABLE');
  const raw=browserCookie(req);
  if (!raw) fail(401,'UNAUTHORIZED');
  const sessionHash=hash(raw);
  const session=db.prepare('SELECT * FROM browser_sessions WHERE token_hash=? AND expires_at>?').get(sessionHash,iso(at));
  if (!session) fail(401,'UNAUTHORIZED');
  const grant=db.prepare('SELECT * FROM grants WHERE session_token_hash=? AND collection_id=? AND credential_version=? AND expires_at>?').get(sessionHash,c.id,c.credential_version,iso(at));
  if (!grant) fail(401,'UNAUTHORIZED');
  const csrf=db.prepare('SELECT secret FROM guest_csrf WHERE token_hash=?').get(sessionHash)?.secret;
  if (!csrf) fail(401,'UNAUTHORIZED');
  if (mutation && (req.headers.origin!==config.publicOrigin || !canonical(req.headers['x-csrf-token']) || !timingSafeEqual(Buffer.from(csrf),Buffer.from(req.headers['x-csrf-token'])))) fail(403,'ORIGIN_REJECTED');
  let upload;
  if (uploadId) {
    upload=db.prepare('SELECT * FROM uploads WHERE id=? AND collection_id=? AND grant_id=?').get(uploadId,c.id,grant.id);
    if (!upload) fail(404,'NOT_FOUND');
  }
  return {collection:c,grant,sessionHash,csrf,upload,summary:collectionSummary(db,c)};
}
function pageQuery(url) {
  if ([...url.searchParams.keys()].some(k=>k!=='cursor'&&k!=='limit') || url.searchParams.getAll('cursor').length>1 || url.searchParams.getAll('limit').length>1) fail(400,'INVALID_INPUT');
  const n=url.searchParams.get('limit');const limit=n===null?100:Number(n);
  if (!Number.isInteger(limit)||limit<1||limit>100) fail(400,'INVALID_INPUT');
  const cursor=url.searchParams.get('cursor');let before;
  if (cursor) {
    if (cursor.length>512||!/^[A-Za-z0-9_-]+$/.test(cursor)) fail(400,'INVALID_CURSOR');
    try {before=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));} catch {fail(400,'INVALID_CURSOR');}
    if (!Array.isArray(before)||before.length!==2||typeof before[0]!=='string'||typeof before[1]!=='string') fail(400,'INVALID_CURSOR');
  }
  return {limit,before};
}
function receipt(row) {return {id:row.id,originalName:row.original_name,declaredSize:row.declared_size,status:row.status,errorCode:row.error_code,createdAt:row.created_at,completedAt:row.completed_at};}
export async function guestApi(req,config,db,url,{clock=Date.now}={}) {
  if (!db) fail(503,'DATABASE_UNAVAILABLE');
  const match=/^\/api\/c\/([^/]+)\/(unlock|session|uploads)(?:\/([^/]+))?$/.exec(url.pathname);
  if (!match) fail(404,'NOT_FOUND');
  const [,token,action,id]=match;
  if (action==='unlock'&&!id) {
    if (req.method!=='POST') fail(405,'METHOD_NOT_ALLOWED',undefined,'POST');
    return unlockGuest(db,req,config,token,{clock});
  }
  if (action==='session'&&!id) {
    if (req.method!=='GET') fail(405,'METHOD_NOT_ALLOWED',undefined,'GET');
    const auth=authorizeGuest(db,req,config,token,{clock});
    return {status:200,payload:{...auth.summary,displayName:auth.grant.display_name,csrfToken:auth.csrf}};
  }
  if (action==='uploads') {
    if (req.method!=='GET') fail(405,'METHOD_NOT_ALLOWED',undefined,'GET');
    const auth=authorizeGuest(db,req,config,token,{uploadId:id,clock});
    if (id) return {status:200,payload:receipt(auth.upload)};
    const {limit,before}=pageQuery(url);
    const rows=db.prepare(`SELECT * FROM uploads WHERE collection_id=? AND grant_id=? AND (? IS NULL OR created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?`)
      .all(auth.collection.id,auth.grant.id,before?.[0]??null,before?.[0]??null,before?.[0]??null,before?.[1]??null,limit+1);
    const page=rows.slice(0,limit);const last=page.at(-1);
    return {status:200,payload:{items:page.map(receipt),nextCursor:rows.length>limit?Buffer.from(JSON.stringify([last.created_at,last.id])).toString('base64url'):null}};
  }
  fail(404,'NOT_FOUND');
}
