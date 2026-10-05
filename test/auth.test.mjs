import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configFrom } from '../src/server/config.mjs';
import { openDatabase } from '../src/server/db.mjs';
import { startServers } from '../src/server/http.mjs';
import { authorizeGuest, normalizeSourceIP } from '../src/server/guest-auth.mjs';

const owner='owner@example.invalid';
const guestOrigin='https://drive.example.invalid';
const adminOrigin='https://admin.example.invalid';
const digest=x=>createHash('sha256').update(x).digest('hex');
const badKey=()=>randomBytes(32).toString('base64url');
const now=Date.now();
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'bd-auth-'));chmodSync(dir,0o700);
  const path=join(dir,'app.sqlite'),socket=join(dir,'admin.sock');
  const env={NODE_ENV:'production',APP_MODE:'production',ADMIN_OWNER_LOGIN:owner,ADMIN_SOCKET_PATH:socket,DB_PATH:path,
    PUBLIC_ORIGIN:guestOrigin,ADMIN_ORIGIN:adminOrigin};
  return {dir,path,socket,env,close(){rmSync(dir,{recursive:true,force:true});}};
}
function send(target,path,{method='GET',headers={},body,chunks}={}) {
  return new Promise((resolve,reject)=>{
    const opts=target.startsWith('/')?{socketPath:target,path,method,headers}:{...new URL(path,target),method,headers};
    if (!target.startsWith('/')) {opts.hostname=new URL(target).hostname;opts.port=new URL(target).port;opts.path=path;}
    const req=request(opts,res=>{const data=[];res.on('data',x=>data.push(x));res.on('end',()=>{
      const raw=Buffer.concat(data).toString();let parsed=raw;
      try {parsed=raw?JSON.parse(raw):null;} catch {}
      resolve({status:res.statusCode,headers:res.headers,body:parsed});
    });});req.on('error',reject);
    if(chunks){for(const c of chunks)req.write(c);req.end();}
    else req.end(body===undefined?undefined:JSON.stringify(body));
  });
}
async function setup({clock=()=>now}={}) {
  const f=fixture();let db=openDatabase(f.path);const config=configFrom(f.env);
  db.exec("UPDATE intake_window SET closes_at='9999-12-31T23:59:59.999Z' WHERE id=1");
  let servers=await startServers(config,[0,0],undefined,db,{clock});
  const guest=()=>`http://127.0.0.1:${servers[0].address().port}`;
  const identity={'Tailscale-User-Login':owner};
  const session=await send(f.socket,'/api/admin/session',{headers:identity});
  const admin={...identity,Cookie:session.headers['set-cookie'][0].split(';')[0],Origin:adminOrigin,
    'X-CSRF-Token':session.body.csrfToken,'Content-Type':'application/json'};
  const create=async(title)=>{
    const r=await send(f.socket,'/api/admin/collections',{method:'POST',headers:admin,body:{title}});
    assert.equal(r.status,201);return r.body;
  };
  return {f,get db(){return db;},set db(x){db=x;},config,get servers(){return servers;},set servers(x){servers=x;},guest,admin,identity,create,
    async close(){await Promise.all(servers.map(s=>new Promise(resolve=>{s.closeAllConnections();s.close(resolve);})));db.close();f.close();}};
}
const unlock=(ctx,c,key,name='Same Name',headers={})=>send(ctx.guest(),`/api/c/${c.token}/unlock`,{
  method:'POST',headers:{Origin:guestOrigin,'Content-Type':'application/json',...headers},body:{key,displayName:name}});
const cookie=r=>r.headers['set-cookie']?.[0].split(';')[0];

test('guest grants stay private across jars, collections, restart and rotation',async()=>{
  let tick=now;
  const ctx=await setup({clock:()=>tick});
  const logs=[];const oldInfo=console.info;console.info=x=>logs.push(x);
  try {
    const a=await ctx.create('Private A');const b=await ctx.create('Private B');
    const before=await send(ctx.guest(),`/c/${a.token}`);
    assert.equal(before.status,200);assert.ok(!JSON.stringify(before).includes('Private A'));
    const jar1=await unlock(ctx,a,a.key);const jar2=await unlock(ctx,a,a.key);
    assert.equal(jar1.status,200);assert.equal(jar2.status,200);
    assert.match(jar1.headers['set-cookie'][0],/Secure; HttpOnly; SameSite=Lax; Path=\//);
    assert.ok(!jar1.headers['set-cookie'][0].includes('Domain='));
    assert.notEqual(cookie(jar1),cookie(jar2));assert.notEqual(jar1.body.csrfToken,cookie(jar1).split('=')[1]);
    const j1=cookie(jar1),j2=cookie(jar2);
    assert.equal(ctx.db.prepare('SELECT count(*) n FROM browser_sessions').get().n,2);
    assert.equal(ctx.db.prepare('SELECT token_hash FROM browser_sessions').get().token_hash.length,64);
    assert.ok(!JSON.stringify(ctx.db.prepare('SELECT * FROM browser_sessions').all()).includes(j1.split('=')[1]));
    const bUnlock=await unlock(ctx,b,b.key,'B name',{Cookie:j1});
    assert.equal(bUnlock.status,200);assert.equal(cookie(bUnlock),j1);
    const grant1=ctx.db.prepare('SELECT id FROM grants WHERE session_token_hash=? AND collection_id=?').get(digest(j1.split('=')[1]),a.id).id;
    const grant2=ctx.db.prepare('SELECT id FROM grants WHERE session_token_hash=? AND collection_id=?').get(digest(j2.split('=')[1]),a.id).id;
    assert.notEqual(grant1,grant2);
    const stamp=new Date(tick).toISOString();
    for(const [id,grant] of [['owned-by-1',grant1],['owned-by-2',grant2]])
      ctx.db.prepare('INSERT INTO uploads(id,collection_id,grant_id,original_name,storage_locator,declared_size,status,created_at,updated_at) VALUES (?,?,?,?,?,0,\'creating\',?,?)')
        .run(id,a.id,grant,'sample.txt',`p/${id}`,stamp,stamp);
    const list1=await send(ctx.guest(),`/api/c/${a.token}/uploads`,{headers:{Cookie:j1}});
    const list2=await send(ctx.guest(),`/api/c/${a.token}/uploads`,{headers:{Cookie:j2}});
    assert.deepEqual(list1.body.items.map(x=>x.id),['owned-by-1']);assert.deepEqual(list2.body.items.map(x=>x.id),['owned-by-2']);
    assert.equal(list1.headers['cache-control'],'no-store');
    ctx.db.prepare('INSERT INTO uploads(id,collection_id,grant_id,original_name,storage_locator,declared_size,status,created_at,updated_at) VALUES (?,?,?,?,?,0,\'creating\',?,?)')
      .run('owned-by-0',a.id,grant1,'other.txt','p/owned-by-0',stamp,stamp);
    const page1=await send(ctx.guest(),`/api/c/${a.token}/uploads?limit=1`,{headers:{Cookie:j1}});
    assert.deepEqual(page1.body.items.map(x=>x.id),['owned-by-1']);assert.ok(page1.body.nextCursor);
    const page2=await send(ctx.guest(),`/api/c/${a.token}/uploads?limit=1&cursor=${page1.body.nextCursor}`,{headers:{Cookie:j1}});
    assert.deepEqual(page2.body.items.map(x=>x.id),['owned-by-0']);assert.equal(page2.body.nextCursor,null);
    assert.equal((await send(ctx.guest(),`/api/c/${a.token}/uploads?limit=101`,{headers:{Cookie:j1}})).status,400);
    const guardReq={headers:{cookie:j1},socket:{remoteAddress:'127.0.0.1'}};
    assert.equal(authorizeGuest(ctx.db,guardReq,ctx.config,a.token,{uploadId:'owned-by-1'}).upload.id,'owned-by-1');
    assert.throws(()=>authorizeGuest(ctx.db,guardReq,ctx.config,a.token,{uploadId:'owned-by-2'}),{status:404});
    assert.equal((await send(ctx.guest(),`/api/c/${a.token}/uploads/owned-by-2`,{headers:{Cookie:j1}})).status,404);
    assert.equal((await send(ctx.guest(),`/api/c/${b.token}/session`,{headers:{Cookie:j2}})).status,401);
    assert.equal((await send(ctx.guest(),`/api/c/${a.token}/session`,{headers:{Cookie:'__Host-beng_admin=fake'}})).status,401);
    assert.equal((await send(ctx.guest(),`/api/c/${a.token}/session`,{headers:{Cookie:`${j1}; ${j1}`}})).status,401);
    const session=await send(ctx.guest(),`/api/c/${a.token}/session`,{headers:{Cookie:j1}});
    assert.equal(session.status,200);assert.equal(session.body.csrfToken,jar1.body.csrfToken);
    const repeat=await unlock(ctx,a,a.key,'Updated name',{Cookie:j1});assert.equal(repeat.status,200);
    assert.equal(ctx.db.prepare('SELECT id,display_name FROM grants WHERE session_token_hash=? AND collection_id=?').get(digest(j1.split('=')[1]),a.id).id,grant1);
    assert.equal(ctx.db.prepare('SELECT display_name FROM grants WHERE id=?').get(grant1).display_name,'Same Name');
    await Promise.all(ctx.servers.map(s=>new Promise(resolve=>{s.closeAllConnections();s.close(resolve);})))
    ctx.db.close();ctx.db=openDatabase(ctx.f.path);
    ctx.servers=await startServers(ctx.config,[0,0],undefined,ctx.db,{clock:()=>tick});
    assert.equal((await send(ctx.guest(),`/api/c/${a.token}/uploads/owned-by-1`,{headers:{Cookie:j1}})).status,200);
    const rotated=await send(ctx.f.socket,`/api/admin/collections/${a.id}/rotate-key`,{method:'POST',headers:ctx.admin});
    assert.equal(rotated.status,200);
    assert.equal((await send(ctx.guest(),`/api/c/${a.token}/session`,{headers:{Cookie:j1}})).status,401);
    assert.equal((await send(ctx.guest(),`/api/c/${b.token}/session`,{headers:{Cookie:j1}})).status,200);
    assert.equal((await unlock(ctx,a,a.key)).status,401);
    const refreshed=await unlock(ctx,a,rotated.body.key,'Different name',{Cookie:j1});assert.equal(refreshed.status,200);
    assert.equal(ctx.db.prepare('SELECT id FROM grants WHERE session_token_hash=? AND collection_id=?').get(digest(j1.split('=')[1]),a.id).id,grant1);
    assert.equal((await send(ctx.guest(),`/api/c/${a.token}/uploads/owned-by-1`,{headers:{Cookie:j1}})).status,200);
    const revoked=await send(ctx.f.socket,`/api/admin/collections/${a.id}/revoke`,{method:'POST',headers:ctx.admin});assert.equal(revoked.status,200);
    assert.equal((await send(ctx.guest(),`/api/c/${a.token}/session`,{headers:{Cookie:j1}})).status,410);
    assert.equal((await unlock(ctx,a,rotated.body.key)).status,410);
    const soon=new Date(Date.now()+1000).toISOString();
    assert.equal((await send(ctx.f.socket,`/api/admin/collections/${b.id}`,{method:'PATCH',headers:ctx.admin,body:{expiresAt:soon}})).status,200);
    tick=Date.parse(soon)+1;
    assert.equal((await send(ctx.guest(),`/api/c/${b.token}/session`,{headers:{Cookie:j1}})).status,410);
    for(const line of logs) for(const sensitive of [a.token,b.token,a.key,b.key,rotated.body.key,'Same Name']) assert.ok(!line.includes(sensitive));
  } finally {console.info=oldInfo;await ctx.close();}
});

test('unlock input, origin, cookies and future write guard fail closed',async()=>{
  let tick=now;const ctx=await setup({clock:()=>tick});
  try {
    const c=await ctx.create('Guarded');
    const path=`/api/c/${c.token}/unlock`;
    const valid={'Content-Type':'application/json',Origin:guestOrigin};
    const post=(body,headers=valid)=>{tick+=900001;return send(ctx.guest(),path,{method:'POST',headers,body});};
    assert.equal((await send(ctx.guest(),path)).status,405);
    assert.equal((await send(ctx.guest(),`/api/c/${c.token}/session`,{method:'POST'})).headers.allow,'GET');
    assert.equal((await send(ctx.guest(),`/api/c/${c.token}/uploads`,{method:'DELETE'})).status,405);
    assert.equal((await post({key:c.key,displayName:'n'},{...valid,Origin:'https://other.invalid'})).status,403);
    assert.equal((await post({key:c.key,displayName:'n'},{'Content-Type':'application/json'})).status,403);
    assert.equal((await post({key:c.key,displayName:'n'},{...valid,Host:'evil.invalid',Origin:'https://evil.invalid'})).status,403);
    assert.equal((await post({key:c.key,displayName:'n',extra:true})).status,400);
    assert.equal((await post({displayName:'n'})).status,400);
    assert.equal((await post({key:c.key})).status,400);
    assert.equal((await post({key:'not-a-key',displayName:'n'})).status,400);
    assert.equal((await post({key:c.key,displayName:' '})).status,400);
    assert.equal((await post({key:c.key,displayName:'x'.repeat(81)})).status,400);
    assert.equal((await post({key:c.key,displayName:'\u0000'})).status,400);
    assert.equal((await post({key:c.key,displayName:'\ud800'})).status,400);
    assert.equal((await send(ctx.guest(),path,{method:'POST',headers:valid,chunks:[Buffer.from('{"key":"'),Buffer.alloc(16384,65),Buffer.from('"}')]})).status,413);
    assert.equal((await send(ctx.guest(),path,{method:'POST',headers:valid,chunks:[Buffer.from([0xff])]})).status,400);
    assert.equal((await post({key:badKey(),displayName:'n'})).status,401);
    assert.equal((await post({key:c.key,displayName:'n'})).status,200);
    assert.equal((await send(ctx.guest(),'/api/c/bad/unlock',{method:'POST',headers:valid,body:{key:c.key,displayName:'n'}})).status,400);
    assert.equal((await send(ctx.guest(),`/api/c/${badKey()}/unlock`,{method:'POST',headers:valid,body:{key:c.key,displayName:'n'}})).status,404);
    assert.equal(ctx.db.prepare('SELECT count(*) n FROM browser_sessions').get().n,1);
  } finally {await ctx.close();}
  const ctx2=await setup();
  try {
    const c=await ctx2.create('Write guard');const good=await unlock(ctx2,c,c.key,'  Alex  ');
    assert.equal(good.status,200);assert.equal(good.body.displayName,'Alex');
    const j=cookie(good),secret=good.body.csrfToken;
    const req=(origin,csrf,cookieValue=j)=>({headers:{origin,'x-csrf-token':csrf,cookie:cookieValue},socket:{remoteAddress:'127.0.0.1'}});
    assert.equal(authorizeGuest(ctx2.db,req(guestOrigin,secret),ctx2.config,c.token,{mutation:true}).grant.display_name,'Alex');
    assert.throws(()=>authorizeGuest(ctx2.db,req('https://evil.invalid',secret),ctx2.config,c.token,{mutation:true}),{status:403});
    assert.throws(()=>authorizeGuest(ctx2.db,req(guestOrigin,badKey()),ctx2.config,c.token,{mutation:true}),{status:403});
    assert.throws(()=>authorizeGuest(ctx2.db,req(guestOrigin,secret,'__Host-beng_admin=forged'),ctx2.config,c.token,{mutation:true}),{status:401});
    assert.equal((await send(ctx2.f.socket,`/api/c/${c.token}/session`,{headers:ctx2.admin})).status,404);
    assert.equal((await send(ctx2.guest(),'/api/admin/collections',{headers:{'Tailscale-User-Login':owner,Cookie:j}})).status,404);
    assert.equal((await send(ctx2.guest(),`/api/c/${c.token}/session`,{headers:{Cookie:j,Origin:'https://evil.invalid'}})).status,200);
  } finally {await ctx2.close();}
});

test('persisted limits honor exact boundaries, forged forwarding and recovery',async()=>{
  let tick=now;const ctx=await setup({clock:()=>tick});
  try {
    const c=await ctx.create('Limited');
    for(let i=0;i<5;i++) {
      const r=await unlock(ctx,c,badKey(),'n',{'CF-Connecting-IP':`198.51.100.${i+1}`,'X-Forwarded-For':`192.0.2.${i+1}`,Forwarded:`for=203.0.113.${i+1}`,Host:'forged.invalid'});
      assert.equal(r.status,401);
    }
    let r=await unlock(ctx,c,c.key);assert.equal(r.status,429);assert.equal(r.headers['retry-after'],'900');assert.equal(r.body.error.retryAfterSeconds,900);
    assert.equal(ctx.db.prepare('SELECT count(*) n FROM unlock_attempts').get().n,5);
    await Promise.all(ctx.servers.map(s=>new Promise(resolve=>{s.closeAllConnections();s.close(resolve);})));ctx.db.close();ctx.db=openDatabase(ctx.f.path);
    ctx.servers=await startServers(ctx.config,[0,0],undefined,ctx.db,{clock:()=>tick});
    r=await unlock(ctx,c,c.key);assert.equal(r.status,429);assert.equal(r.headers['retry-after'],'900');
    tick+=899000;r=await unlock(ctx,c,c.key);assert.equal(r.status,429);assert.equal(r.headers['retry-after'],'1');
    tick+=1001;r=await unlock(ctx,c,c.key);assert.equal(r.status,200);
    assert.equal(ctx.db.prepare('SELECT count(*) n FROM unlock_attempts').get().n,1);
    assert.equal(normalizeSourceIP('::ffff:127.0.0.1'),'127.0.0.1');
    assert.equal(normalizeSourceIP('2001:0db8:0000:0000:0000:0000:0000:0001'),'2001:db8::1');
  } finally {await ctx.close();}
});

test('collection, global and distinct-source caps are bounded and recover',async()=>{
  let tick=now;const ctx=await setup({clock:()=>tick});
  try {
    const c=await ctx.create('Collection cap');
    let jar;
    for(let i=0;i<100;i++) {const r=await unlock(ctx,c,c.key,'n',jar?{Cookie:jar}:{});assert.equal(r.status,200);jar=cookie(r);}
    let r=await unlock(ctx,c,c.key,'n',{Cookie:jar});assert.equal(r.status,429);assert.equal(r.headers['retry-after'],'900');
    assert.equal(ctx.db.prepare('SELECT count(*) n FROM unlock_attempts').get().n,100);
    tick+=900001;r=await unlock(ctx,c,c.key,'n',{Cookie:jar});assert.equal(r.status,200);
    ctx.db.prepare('DELETE FROM unlock_attempts').run();ctx.db.prepare('DELETE FROM unlock_buckets').run();
    for(let i=0;i<1000;i++) {
      r=await send(ctx.guest(),`/api/c/${badKey()}/unlock`,{method:'POST',headers:{Origin:guestOrigin,'Content-Type':'application/json'},body:{key:c.key,displayName:'n'}});
      assert.equal(r.status,404);
    }
    r=await send(ctx.guest(),`/api/c/${badKey()}/unlock`,{method:'POST',headers:{Origin:guestOrigin,'Content-Type':'application/json'},body:{key:c.key,displayName:'n'}});
    assert.equal(r.status,429);assert.equal(r.headers['retry-after'],'60');
    assert.equal(ctx.db.prepare('SELECT count(*) n FROM unlock_attempts WHERE collection_id IS NOT NULL').get().n,0);
    assert.equal(ctx.db.prepare('SELECT count(*) n FROM unlock_buckets').get().n,0);
    tick+=60001;r=await send(ctx.guest(),`/api/c/${badKey()}/unlock`,{method:'POST',headers:{Origin:guestOrigin,'Content-Type':'application/json'},body:{key:c.key,displayName:'n'}});assert.equal(r.status,404);
    ctx.db.prepare('DELETE FROM unlock_attempts').run();
    const add=ctx.db.prepare('INSERT INTO unlock_buckets VALUES (?,?,?)');ctx.db.exec('BEGIN IMMEDIATE');
    try {for(let i=0;i<10000;i++)add.run(c.id,`2001:db8::${i.toString(16)}`,tick);ctx.db.exec('COMMIT');}
    catch(e){ctx.db.exec('ROLLBACK');throw e;}
    r=await unlock(ctx,c,c.key);assert.equal(r.status,429);assert.equal(r.headers['retry-after'],'900');
    assert.equal(ctx.db.prepare('SELECT count(*) n FROM unlock_buckets').get().n,10000);
    tick+=900001;r=await unlock(ctx,c,c.key);assert.equal(r.status,200);
    assert.equal(ctx.db.prepare('SELECT count(*) n FROM unlock_buckets').get().n,1);
  } finally {await ctx.close();}
});

test('in-flight unlock observes rotation after body arrival and concurrent attempts are atomic',async()=>{
  const ctx=await setup();
  try {
    const c=await ctx.create('Concurrent');
    const path=`/api/c/${c.token}/unlock`;
    const body=JSON.stringify({key:c.key,displayName:'Concurrent person'});
    let finish;
    const pending=new Promise((resolve,reject)=>{
      const req=request({hostname:'127.0.0.1',port:ctx.servers[0].address().port,path,method:'POST',headers:{Origin:guestOrigin,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
        const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString())}));
      });req.on('error',reject);req.write(body.slice(0,10));finish=()=>req.end(body.slice(10));
    });
    const rotated=await send(ctx.f.socket,`/api/admin/collections/${c.id}/rotate-key`,{method:'POST',headers:ctx.admin});assert.equal(rotated.status,200);
    finish();assert.equal((await pending).status,401);
    assert.equal(ctx.db.prepare('SELECT count(*) n FROM browser_sessions').get().n,0);
    assert.equal(ctx.db.prepare('SELECT count(*) n FROM grants').get().n,0);
    const attempts=await Promise.all(Array.from({length:7},()=>unlock(ctx,c,badKey())));
    assert.deepEqual(attempts.map(x=>x.status).sort(),[401,401,401,401,429,429,429]);
    assert.equal(ctx.db.prepare('SELECT count(*) n FROM unlock_attempts WHERE collection_id=?').get(c.id).n,5);
    assert.equal((await unlock(ctx,c,rotated.body.key)).status,429);
  } finally {await ctx.close();}
});

test('v2 migration retains collection, admin and referenced receipt rows',async()=>{
  const f=fixture();let db=openDatabase(f.path);
  try {
    const stamp=new Date(now).toISOString(),expired=new Date(now-1000).toISOString();
    db.prepare('INSERT INTO collections(id,token,title,key_hash,expires_at,allowance,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('c',badKey(),'Saved',digest(badKey()),new Date(now+86400000).toISOString(),123,stamp,stamp);
    db.prepare('INSERT INTO browser_sessions VALUES (?,?,?,?)').run('sessionhash','csrfhash',stamp,expired);
    db.prepare('INSERT INTO grants VALUES (?,?,?,?,?,?)').run('grant','sessionhash','c',1,'Saved person',expired);
    db.prepare('INSERT INTO uploads(id,collection_id,grant_id,original_name,storage_locator,declared_size,status,created_at,updated_at,completed_at) VALUES (?,?,?,?,?,0,\'completed\',?,?,?)')
      .run('upload','c','grant','saved.txt','path/saved',stamp,stamp,stamp);
    db.prepare('INSERT INTO admin_sessions VALUES (?,?,?,?)').run('adminhash','admincsrf',stamp,stamp);
    db.exec('DROP TABLE intake_window; DROP TABLE cleanup_state; DROP INDEX uploads_cleanup_idx; ALTER TABLE uploads DROP COLUMN transfer_at; ALTER TABLE uploads DROP COLUMN deletion_intent; ALTER TABLE uploads DROP COLUMN deleting_at; DROP TABLE guest_csrf; DROP TABLE unlock_attempts; DROP TABLE unlock_buckets; DROP INDEX uploads_recovery_idx; ALTER TABLE uploads DROP COLUMN content_hash; ALTER TABLE uploads DROP COLUMN upload_metadata; DELETE FROM schema_migrations WHERE version IN (3,4,5,6); PRAGMA user_version=2');
    db.close();db=openDatabase(f.path);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,6);
    assert.equal(db.prepare('SELECT count(*) n FROM collections').get().n,1);
    assert.equal(db.prepare('SELECT count(*) n FROM uploads WHERE grant_id=?').get('grant').n,1);
    assert.equal(db.prepare('SELECT count(*) n FROM admin_sessions').get().n,1);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
    db.close();db=openDatabase(f.path);assert.equal(db.prepare('SELECT count(*) n FROM schema_migrations WHERE version=3').get().n,1);
    db.exec('PRAGMA user_version=7');db.close();
    assert.throws(()=>openDatabase(f.path),/Unsupported database schema/);
    db=null;
  } finally {db?.close();f.close();}
});
