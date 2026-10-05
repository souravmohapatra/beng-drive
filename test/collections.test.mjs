import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { configFrom } from '../src/server/config.mjs';
import { openDatabase } from '../src/server/db.mjs';
import { startServers } from '../src/server/http.mjs';
import { annotateUploadError, commitment, createCollection, editCollection, reserveUpload, rotateKey, transitionUpload } from '../src/server/collections.mjs';

const owner='owner@example.invalid';
const origin='https://admin.example.invalid';
const baselineDefaults={DEFAULT_ALLOWANCE_BYTES:10000000000,COLLECTION_DEFAULT_TTL_SECONDS:604800};
const future=()=>new Date(Date.now()+86400000).toISOString();
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'bd-collections-'));
  chmodSync(dir,0o700);
  return {dir,path:join(dir,'app.sqlite'),socket:join(dir,'admin.sock'),close(){rmSync(dir,{recursive:true,force:true});}};
}
function http(socket,path,{method='GET',headers={},body,chunks}={}) {
  return new Promise((resolve,reject)=>{
    const req=request({socketPath:socket,path,method,headers},res=>{
      const data=[];res.on('data',x=>data.push(x));res.on('end',()=>{
        const raw=Buffer.concat(data).toString();
        resolve({status:res.statusCode,headers:res.headers,body:raw?JSON.parse(raw):null});
      });
    });
    req.on('error',reject);
    if (chunks) { for(const chunk of chunks) req.write(chunk); req.end(); }
    else req.end(body===undefined?undefined:JSON.stringify(body));
  });
}
test('version1 migration preserves data, repeats, and refuses newer schema',()=>{
  const f=fixture();
  try {
    let db=new DatabaseSync(f.path);
    db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES (1,CURRENT_TIMESTAMP); CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('kept'); PRAGMA user_version=1");
    db.close();
    db=openDatabase(f.path);
    const c=createCollection(db,{title:'One'},'https://drive.example.invalid',baselineDefaults);
    db.close();
    db=openDatabase(f.path);
    assert.equal(db.prepare('SELECT value FROM sentinel').get().value,'kept');
    assert.equal(db.prepare('SELECT count(*) n FROM schema_migrations').get().n,5);
    assert.equal(db.prepare('SELECT title FROM collections WHERE id=?').get(c.id).title,'One');
    db.exec('PRAGMA user_version=99');db.close();
    assert.throws(()=>openDatabase(f.path),/Unsupported database schema/);
    db=openDatabaseWithNewerReadOnly(f.path);
    assert.equal(db.prepare('SELECT value FROM sentinel').get().value,'kept');db.close();
  } finally {f.close();}
});

test('configured creation defaults and explicit overrides survive restart',async()=>{
  const f=fixture();
  const env={NODE_ENV:'production',APP_MODE:'production',ADMIN_OWNER_LOGIN:owner,ADMIN_SOCKET_PATH:f.socket,
    DB_PATH:f.path,PUBLIC_ORIGIN:'https://drive.example.invalid',ADMIN_ORIGIN:origin,
    DEFAULT_ALLOWANCE_BYTES:'20000000000',COLLECTION_DEFAULT_TTL_SECONDS:'3600'};
  assert.throws(()=>configFrom({...env,COLLECTION_DEFAULT_TTL_SECONDS:'8640000000001'}),/COLLECTION_DEFAULT_TTL_SECONDS/);
  const config=configFrom(env);
  let db=openDatabase(f.path);
  let servers=await startServers(config,[0,0],undefined,db);
  try {
    const identity={'Tailscale-User-Login':owner};
    const session=await http(f.socket,'/api/admin/session',{headers:identity});
    assert.equal(session.status,200);
    const auth={...identity,Cookie:session.headers['set-cookie'][0].split(';')[0],Origin:origin,
      'X-CSRF-Token':session.body.csrfToken,'Content-Type':'application/json'};
    const configured=await http(f.socket,'/api/admin/collections',{method:'POST',headers:auth,body:{title:'Configured'}});
    assert.equal(configured.status,201);
    assert.equal(configured.body.allowance,20000000000);
    assert.equal(Date.parse(configured.body.expiresAt)-Date.parse(configured.body.createdAt),3600000);
    const saved=db.prepare('SELECT allowance,expires_at,created_at FROM collections WHERE id=?').get(configured.body.id);
    assert.equal(saved.allowance,20000000000);
    assert.equal(Date.parse(saved.expires_at)-Date.parse(saved.created_at),3600000);
    const explicitExpiry=new Date(Date.now()+7200000).toISOString();
    const explicit=await http(f.socket,'/api/admin/collections',{method:'POST',headers:auth,
      body:{title:'Explicit',allowance:0,expiresAt:explicitExpiry}});
    assert.equal(explicit.status,201);assert.equal(explicit.body.allowance,0);assert.equal(explicit.body.expiresAt,explicitExpiry);
    const savedExplicit=db.prepare('SELECT allowance,expires_at FROM collections WHERE id=?').get(explicit.body.id);
    assert.equal(savedExplicit.allowance,0);assert.equal(savedExplicit.expires_at,explicitExpiry);
    await Promise.all(servers.map(s=>new Promise(resolve=>s.close(resolve))));
    db.close();
    db=openDatabase(f.path);
    servers=await startServers(config,[0,0],undefined,db);
    for(const [item,expectedAllowance,expectedExpiry] of [[configured.body,20000000000,configured.body.expiresAt],[explicit.body,0,explicitExpiry]]) {
      const detail=await http(f.socket,`/api/admin/collections/${item.id}`,{headers:identity});
      assert.equal(detail.status,200);assert.equal(detail.body.allowance,expectedAllowance);assert.equal(detail.body.expiresAt,expectedExpiry);
    }
  } finally {await Promise.all(servers.map(s=>new Promise(resolve=>s.close(resolve))));db.close();f.close();}
});
function openDatabaseWithNewerReadOnly(path) {
  // Observe records without invoking the migration guard again.
  return new DatabaseSync(path,{readOnly:true});
}

test('private Unix API validates credentials, CSRF, pagination and one-time keys',async()=>{
  const f=fixture();let db=openDatabase(f.path);
  const config=configFrom({NODE_ENV:'production',APP_MODE:'production',ADMIN_OWNER_LOGIN:owner,ADMIN_SOCKET_PATH:f.socket,
    DB_PATH:f.path,PUBLIC_ORIGIN:'https://drive.example.invalid',ADMIN_ORIGIN:origin});
  let servers=await startServers(config,[0,0],undefined,db);
  try {
    const guest=`http://127.0.0.1:${servers[0].address().port}`;
    assert.equal((await fetch(`${guest}/api/admin/collections`,{headers:{Host:'admin.example.invalid','Tailscale-User-Login':owner}})).status,404);
    assert.equal((await http(f.socket,'/api/admin/collections')).status,403);
    assert.equal((await http(f.socket,'/api/admin/collections',{headers:{'Tailscale-User-Login':'wrong@example.invalid'}})).status,403);
    const identity={'Tailscale-User-Login':owner};
    const session=await http(f.socket,'/api/admin/session',{headers:identity});
    assert.equal(session.status,200);
    assert.match(session.headers['set-cookie'][0],/Secure; HttpOnly; SameSite=Strict; Path=\//);
    const cookie=session.headers['set-cookie'][0].split(';')[0];
    const csrf=session.body.csrfToken;
    assert.notEqual(cookie.split('=')[1],csrf);
    const auth={...identity,Cookie:cookie,Origin:origin,'X-CSRF-Token':csrf,'Content-Type':'application/json'};
    for(const headers of [{...auth,Origin:'https://evil.invalid'},{...auth,'X-CSRF-Token':'wrong'},{...auth,Cookie:''},{...identity,Origin:origin,'Content-Type':'application/json'}])
      assert.equal((await http(f.socket,'/api/admin/collections',{method:'POST',headers,body:{title:'No'}})).status,403);
    for(const body of [{title:''},{title:'A'.repeat(121)},{title:'ok',unexpected:1},{title:'ok',allowance:-1},{title:'ok',expiresAt:'2099-99-99T00:00:00.000Z'},{title:'bad\nname'}])
      assert.equal((await http(f.socket,'/api/admin/collections',{method:'POST',headers:auth,body})).status,400);
    const huge=await http(f.socket,'/api/admin/collections',{method:'POST',headers:{...auth,'Transfer-Encoding':'chunked'},chunks:['{"title":"', 'a'.repeat(17000), '"}']});
    assert.equal(huge.status,413);
    const first=await http(f.socket,'/api/admin/collections',{method:'POST',headers:auth,body:{title:'  One  '}});
    assert.equal(first.status,201);assert.equal(first.body.title,'One');assert.equal(first.body.allowance,10000000000);assert.equal(first.body.key.length>=43,true);
    assert.equal(Date.parse(first.body.expiresAt)-Date.parse(first.body.createdAt),604800000);
    assert.equal(first.body.invitationUrl,`https://drive.example.invalid/c/${first.body.token}`);
    const second=await http(f.socket,'/api/admin/collections',{method:'POST',headers:auth,body:{title:'Two',welcome:'Hello\nGuest',allowance:0}});
    assert.equal(second.status,201);assert.notEqual(first.body.key,second.body.key);assert.notEqual(first.body.token,second.body.token);
    const page=await http(f.socket,'/api/admin/collections?limit=1',{headers:identity});
    assert.equal(page.status,200);assert.equal(page.body.items.length,1);assert.ok(page.body.nextCursor);
    const page2=await http(f.socket,`/api/admin/collections?limit=1&cursor=${page.body.nextCursor}`,{headers:identity});
    assert.equal(page2.body.items.length,1);assert.notEqual(page.body.items[0].id,page2.body.items[0].id);
    const bh='e'.repeat(64);
    db.prepare('INSERT INTO browser_sessions VALUES (?,?,?,?)').run(bh,'f'.repeat(64),new Date().toISOString(),future());
    db.prepare('INSERT INTO grants VALUES (?,?,?,?,?,?)').run('api-grant',bh,first.body.id,1,'Contributor',future());
    for(const id of ['api-u1','api-u2']) reserveUpload(db,{id,collectionId:first.body.id,grantId:'api-grant',originalName:'example.txt',storageLocator:`p/${id}`,declaredSize:0,fileLimit:1000});
    const detail=await http(f.socket,`/api/admin/collections/${first.body.id}?limit=1`,{headers:identity});
    assert.equal(detail.status,200);assert.equal(detail.body.uploads.length,1);assert.equal(detail.body.uploads[0].displayName,'Contributor');
    assert.equal(detail.body.reservedCount,2);assert.ok(detail.body.nextCursor);
    const detail2=await http(f.socket,`/api/admin/collections/${first.body.id}?limit=1&cursor=${detail.body.nextCursor}`,{headers:identity});
    assert.equal(detail2.body.uploads.length,1);assert.notEqual(detail.body.uploads[0].id,detail2.body.uploads[0].id);
    assert.equal((await http(f.socket,'/api/admin/collections/not-an-id',{headers:identity})).status,404);
    const wrongMethod=await http(f.socket,'/api/admin/collections',{method:'DELETE',headers:identity});
    assert.equal(wrongMethod.status,405);assert.equal(wrongMethod.headers.allow,'GET, POST');
    db.prepare('UPDATE collections SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z',second.body.id);
    const expired=await http(f.socket,'/api/admin/collections',{headers:identity});
    assert.equal(expired.body.items.find(x=>x.id===second.body.id).state,'expired');
    const edited=await http(f.socket,`/api/admin/collections/${first.body.id}`,{method:'PATCH',headers:auth,body:{title:'Changed',welcome:'Message'}});
    assert.equal(edited.body.title,'Changed');
    const rotated=await http(f.socket,`/api/admin/collections/${first.body.id}/rotate-key`,{method:'POST',headers:auth});
    assert.equal(rotated.status,200);assert.notEqual(rotated.body.key,first.body.key);assert.equal(rotated.body.credentialVersion,2);
    assert.ok(Date.parse(db.prepare('SELECT expires_at FROM grants WHERE id=?').get('api-grant').expires_at)<=Date.now());
    const revoked=await http(f.socket,`/api/admin/collections/${first.body.id}/revoke`,{method:'POST',headers:auth});
    assert.equal(revoked.body.state,'revoked');
    const again=await http(f.socket,`/api/admin/collections/${first.body.id}/revoke`,{method:'POST',headers:auth});
    assert.equal(again.body.credentialVersion,revoked.body.credentialVersion);
    for(const response of [page,page2,detail,detail2,edited,revoked,again]) {
      const raw=JSON.stringify(response.body);assert.ok(!raw.includes(first.body.key)&&!raw.includes(rotated.body.key));assert.ok(!raw.includes('key_hash'));
    }
    assert.equal(db.prepare('SELECT key_hash FROM collections WHERE id=?').get(first.body.id).key_hash.length,64);
    assert.equal(db.prepare('SELECT count(*) n FROM admin_sessions').get().n,1);
    const sess=await http(f.socket,'/api/admin/session',{headers:{...identity,Cookie:cookie}});
    assert.equal(sess.status,200);assert.equal(sess.headers['set-cookie'][0].split(';')[0],cookie);
    assert.notEqual(sess.body.csrfToken,csrf);
    assert.equal((await http(f.socket,'/api/admin/collections',{method:'POST',headers:auth,body:{title:'Old CSRF'}})).status,403);
    await Promise.all(servers.map(s=>new Promise(resolve=>s.close(resolve))));
    db.close();
    db=openDatabase(f.path);
    servers=await startServers(config,[0,0],undefined,db);
    assert.equal((await http(f.socket,'/api/admin/collections',{method:'POST',headers:{...auth,'X-CSRF-Token':sess.body.csrfToken},body:{title:'After restart'}})).status,201);
    db.prepare('UPDATE admin_sessions SET expires_at=?').run('2000-01-01T00:00:00.000Z');
    assert.equal((await http(f.socket,'/api/admin/collections',{method:'POST',headers:{...auth,'X-CSRF-Token':sess.body.csrfToken},body:{title:'Expired'}})).status,403);
  } finally {await Promise.all(servers.map(s=>new Promise(resolve=>s.close(resolve))));db.close();f.close();}
});

test('accounting, lifecycle and allowance guard use real SQLite',()=>{
  const f=fixture();const db=openDatabase(f.path);
  try {
    const c=createCollection(db,{title:'Quota',allowance:10},'https://drive.example.invalid',baselineDefaults);
    const tokenHash='a'.repeat(64);const grant='grant-1';
    db.prepare('INSERT INTO browser_sessions VALUES (?,?,?,?)').run(tokenHash,'b'.repeat(64),new Date().toISOString(),future());
    db.prepare('INSERT INTO grants VALUES (?,?,?,?,?,?)').run(grant,tokenHash,c.id,1,'Guest',future());
    const add=(id,size)=>reserveUpload(db,{id,collectionId:c.id,grantId:grant,originalName:'file',storageLocator:`p/${id}`,declaredSize:size,fileLimit:1000});
    add('u1',10);assert.equal(commitment(db,c.id).reservedBytes,10);
    annotateUploadError(db,'u1','creating','STORAGE_UNAVAILABLE');
    assert.equal(db.prepare('SELECT error_code FROM uploads WHERE id=?').get('u1').error_code,'STORAGE_UNAVAILABLE');
    assert.throws(()=>editCollection(db,c.id,{allowance:9}),e=>e.status===409);
    assert.equal(editCollection(db,c.id,{allowance:10}).allowance,10);
    assert.throws(()=>add('u2',1),e=>e.status===409);
    assert.throws(()=>db.prepare("UPDATE uploads SET status='completed' WHERE id='u1'").run(),/invalid upload transition/);
    transitionUpload(db,'u1','creating','uploading');
    transitionUpload(db,'u1','uploading','finalizing');
    transitionUpload(db,'u1','finalizing','completed');
    assert.equal(commitment(db,c.id).completedBytes,10);assert.equal(commitment(db,c.id).completedCount,1);
    assert.throws(()=>transitionUpload(db,'u1','completed','cancelled',{deletionConfirmed:true}),/invalid upload transition/);
    assert.throws(()=>db.prepare("INSERT INTO uploads (id,collection_id,grant_id,original_name,storage_locator,declared_size,status,created_at,updated_at) VALUES ('bad',?,?,'x','p/bad',0,'unknown','x','x')").run(c.id,grant),/CHECK constraint/);
    assert.throws(()=>db.prepare("INSERT INTO uploads (id,collection_id,grant_id,original_name,storage_locator,declared_size,status,created_at,updated_at) VALUES ('bad',?,?,'x','p/bad',0,'creating','x','x')").run('other',grant));
    const zero=createCollection(db,{title:'Zero',allowance:0},'https://drive.example.invalid',baselineDefaults);
    db.prepare('INSERT INTO grants VALUES (?,?,?,?,?,?)').run('grant-2',tokenHash,zero.id,1,'Guest',future());
    reserveUpload(db,{id:'zero',collectionId:zero.id,grantId:'grant-2',originalName:'empty',storageLocator:'p/zero',declaredSize:0,fileLimit:1});
    assert.equal(commitment(db,zero.id).reservedCount,1);
    assert.throws(()=>reserveUpload(db,{id:'zero2',collectionId:zero.id,grantId:'grant-2',originalName:'empty',storageLocator:'p/zero2',declaredSize:0,fileLimit:1}),e=>e.status===409);
    transitionUpload(db,'zero','creating','deleting');
    assert.throws(()=>db.prepare("UPDATE uploads SET status='cancelled' WHERE id='zero'").run(),/invalid upload transition/);
    assert.throws(()=>transitionUpload(db,'zero','deleting','cancelled'),e=>e.status===409);
    transitionUpload(db,'zero','deleting','cancelled',{deletionConfirmed:true});
    assert.equal(commitment(db,zero.id).reservedCount,0);
    const oldExpiry=db.prepare('SELECT expires_at FROM grants WHERE id=?').get(grant).expires_at;
    rotateKey(db,c.id);
    assert.ok(db.prepare('SELECT expires_at FROM grants WHERE id=?').get(grant).expires_at < oldExpiry);
  } finally {db.close();f.close();}
});

test('separate process reservation serializes behind allowance reduction',async()=>{
  const f=fixture();const db=openDatabase(f.path);
  try {
    const c=createCollection(db,{title:'Race',allowance:10},'https://drive.example.invalid',baselineDefaults);
    const hash='c'.repeat(64);
    db.prepare('INSERT INTO browser_sessions VALUES (?,?,?,?)').run(hash,'d'.repeat(64),new Date().toISOString(),future());
    db.prepare('INSERT INTO grants VALUES (?,?,?,?,?,?)').run('race-grant',hash,c.id,1,'Guest',future());
    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE collections SET allowance=0 WHERE id=?').run(c.id);
    const script=`import {openDatabase} from './src/server/db.mjs'; import {reserveUpload} from './src/server/collections.mjs';
      const d=openDatabase(process.argv[1]); console.log('READY');
      try { reserveUpload(d,{id:'race-upload',collectionId:process.argv[2],grantId:'race-grant',originalName:'x',storageLocator:'p/race',declaredSize:1,fileLimit:1000}); console.log('ADMITTED'); }
      catch(e) { console.log(e.code || 'ERROR'); } finally { d.close(); }`;
    const child=spawn(process.execPath,['--input-type=module','-e',script,f.path,c.id],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});
    let output='';let error='';let commitScheduled=false;
    child.stdout.on('data',x=>{output+=x.toString();if(output.includes('READY')&&!commitScheduled){commitScheduled=true;setTimeout(()=>db.exec('COMMIT'),100);}});
    child.stderr.on('data',x=>error+=x.toString());
    const exit=await new Promise(resolve=>child.on('exit',resolve));
    assert.equal(exit,0,error);assert.match(output,/READY/);assert.match(output,/ALLOWANCE_CONFLICT/);assert.ok(!output.includes('ADMITTED'));
    assert.equal(db.prepare('SELECT allowance FROM collections WHERE id=?').get(c.id).allowance,0);
    assert.equal(commitment(db,c.id).reservedCount,0);
  } finally { try { db.exec('ROLLBACK'); } catch {} db.close();f.close(); }
});
