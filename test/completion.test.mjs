import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configFrom } from '../src/server/config.mjs';
import { openDatabase } from '../src/server/db.mjs';
import { startServers } from '../src/server/http.mjs';
import { StoragePool } from '../src/server/storage/pool.mjs';
import { commitment } from '../src/server/collections.mjs';

const origin='https://drive.example.invalid', adminOrigin='https://admin.example.invalid', owner='owner@example.invalid';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const meta=name=>`filename ${Buffer.from(name).toString('base64')}`;
function send(target,path,{method='GET',headers={},body}={}) {
  return new Promise((resolve,reject)=>{
    const remote=target.startsWith('/')?{socketPath:target}:{hostname:'127.0.0.1',port:new URL(target).port};
    const req=request({...remote,path,method,headers},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{
        const raw=Buffer.concat(chunks).toString();let value=raw;
        try{value=raw?JSON.parse(raw):null;}catch{}
        resolve({status:res.statusCode,headers:res.headers,body:value});
      });
    });
    req.on('error',reject);req.end(body);
  });
}
async function waitFor(run,accept,label) {
  for(let i=0;i<250;i++) {const value=await run();if(accept(value))return value;await pause(20);}
  throw new Error(`${label} did not settle`);
}
async function setup() {
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'bd-completion-')));chmodSync(dir,0o700);
  const root=join(dir,'nas');mkdirSync(root,{mode:0o700});
  const config=configFrom({APP_MODE:'fixture',ADMIN_OWNER_LOGIN:owner,ADMIN_SOCKET_PATH:join(dir,'admin.sock'),DB_PATH:join(dir,'app.sqlite'),PUBLIC_ORIGIN:origin,ADMIN_ORIGIN:adminOrigin,FREE_SPACE_FLOOR_BYTES:'1'});
  let db=openDatabase(config.dbPath),storage=new StoragePool({root,fixture:true,expectedSource:''});
  let servers=await startServers(config,[0,0],storage,db);
  const guest=()=>`http://127.0.0.1:${servers[0].address().port}`;
  const identity={'Tailscale-User-Login':owner};
  const session=await send(config.adminSocketPath,'/api/admin/session',{headers:identity});
  const admin={...identity,Cookie:session.headers['set-cookie'][0].split(';')[0],Origin:adminOrigin,'X-CSRF-Token':session.body.csrfToken,'Content-Type':'application/json'};
  const create=async(title,allowance=200000000)=>{
    const result=await send(config.adminSocketPath,'/api/admin/collections',{method:'POST',headers:admin,body:JSON.stringify({title,allowance})});
    assert.equal(result.status,201);return result.body;
  };
  const unlock=async(c,name)=>{
    const result=await send(guest(),`/api/c/${c.token}/unlock`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({key:c.key,displayName:name})});
    assert.equal(result.status,200);
    return {Cookie:result.headers['set-cookie'][0].split(';')[0],Origin:origin,'X-CSRF-Token':result.body.csrfToken,'Tus-Resumable':'1.0.0'};
  };
  let open=true;
  const stop=async()=>{if(!open)return;await Promise.all(servers.map(s=>new Promise(resolve=>{s.closeAllConnections();s.close(resolve);})));db.close();open=false;};
  const restart=async()=>{
    await stop();db=openDatabase(config.dbPath);storage=new StoragePool({root,fixture:true,expectedSource:''});servers=await startServers(config,[0,0],storage,db);open=true;
    await waitFor(()=>send(config.adminSocketPath,'/health/ready',{headers:identity}),r=>r.status===200,'startup readiness');
  };
  const close=async()=>{await stop();rmSync(dir,{recursive:true,force:true});};
  const post=(c,a,size,name)=>send(guest(),`/uploads/${c.token}`,{method:'POST',headers:{...a,'Upload-Length':String(size),'Upload-Metadata':meta(name)}});
  const patch=(path,a,offset,data)=>send(guest(),path,{method:'PATCH',headers:{...a,'Content-Type':'application/offset+octet-stream','Upload-Offset':String(offset)},body:data});
  const receipt=(c,a,id)=>send(guest(),`/api/c/${c.token}/uploads/${id}`,{headers:a});
  const completed=(c,a,id)=>waitFor(()=>receipt(c,a,id),r=>r.status===200&&r.body.status==='completed','completed receipt');
  return {dir,root,config,get db(){return db;},get storage(){return storage;},guest,admin,create,unlock,post,patch,receipt,completed,restart,stop,close};
}

test('zero-byte completion publishes one private receipt, immutable HEAD and deterministic owned file',async()=>{
  const x=await setup();
  try {
    const c=await x.create('Zero'),a=await x.unlock(c,'A'),b=await x.unlock(c,'B');
    const one=await x.post(c,a,0,'🌿.txt');assert.equal(one.status,201);
    const id=one.headers.location.split('/').at(-1);
    const receipt=await x.completed(c,a,id);
    assert.equal(receipt.body.declaredSize,0);assert.ok(receipt.body.completedAt);
    assert.equal('storageLocator' in receipt.body,false);assert.equal('contentHash' in receipt.body,false);
    const row=x.db.prepare('SELECT * FROM uploads WHERE id=?').get(id);
    assert.equal(row.status,'completed');assert.equal(row.content_hash,createHash('sha256').update('').digest('hex'));
    assert.match(row.storage_locator,new RegExp(`^completed/${c.id}/${id}-`));
    assert.equal(statSync(join(x.root,row.storage_locator)).size,0);
    assert.equal(lstatSync(join(x.root,row.storage_locator)).mode&0o777,0o600);
    assert.deepEqual({...commitment(x.db,c.id)},{completedBytes:0,reservedBytes:0,completedCount:1,reservedCount:0});
    await waitFor(()=>Promise.resolve(existsSync(join(x.root,'partials',`${id}.json`))),v=>!v,'sidecar cleanup');
    assert.equal((await waitFor(()=>send(x.guest(),one.headers.location,{method:'HEAD',headers:a}),r=>r.status===200,'zero-byte HEAD')).headers['upload-offset'],'0');
    assert.equal((await x.receipt(c,b,id)).status,404);
    const foreignHead=await send(x.guest(),one.headers.location,{method:'HEAD',headers:b});assert.equal(foreignHead.status,404);assert.equal(foreignHead.headers['upload-offset'],undefined);
    assert.equal((await send(x.guest(),one.headers.location,{method:'DELETE',headers:a})).status,409);
    const two=await x.post(c,a,0,'🌿.txt');assert.equal(two.status,201);
    const second=await x.completed(c,a,two.headers.location.split('/').at(-1));assert.equal(second.body.status,'completed');
    const secondRow=x.db.prepare('SELECT * FROM uploads WHERE id=?').get(two.headers.location.split('/').at(-1));
    assert.notEqual(secondRow.storage_locator,row.storage_locator);
    await x.restart();
    const after=await x.receipt(c,a,id);assert.equal(after.body.completedAt,receipt.body.completedAt);
    assert.equal((await waitFor(()=>send(x.guest(),one.headers.location,{method:'HEAD',headers:a}),r=>r.status===200,'restart HEAD')).headers['upload-offset'],'0');
    assert.equal(x.db.prepare('SELECT count(*) n FROM uploads WHERE id=?').get(id).n,1);
  } finally {await x.close();}
});

test('128 MiB worker transfer automatically finalizes with exact hash and accounting',async()=>{
  const x=await setup();
  try {
    const size=128*1024*1024,chunk=Buffer.alloc(8*1024*1024,0x59);
    const c=await x.create('Large',size),a=await x.unlock(c,'A');
    const made=await x.post(c,a,size,'large.bin');assert.equal(made.status,201);
    for(let i=0;i<16;i++) {const response=await x.patch(made.headers.location,a,i*chunk.length,chunk);assert.equal(response.status,204);assert.equal(response.headers['upload-offset'],String((i+1)*chunk.length));}
    const id=made.headers.location.split('/').at(-1),receipt=await x.completed(c,a,id);
    assert.equal(receipt.body.status,'completed');
    const row=x.db.prepare('SELECT * FROM uploads WHERE id=?').get(id);
    const expected=createHash('sha256');for(let i=0;i<16;i++)expected.update(chunk);
    assert.equal(row.content_hash,expected.digest('hex'));
    assert.equal(createHash('sha256').update(readFileSync(join(x.root,row.storage_locator))).digest('hex'),row.content_hash);
    assert.deepEqual({...commitment(x.db,c.id)},{completedBytes:size,reservedBytes:0,completedCount:1,reservedCount:0});
    const head=await waitFor(()=>send(x.guest(),made.headers.location,{method:'HEAD',headers:a}),r=>r.status===200,'completed HEAD');
    assert.equal(head.headers['upload-offset'],String(size));
    assert.equal((await send(x.guest(),made.headers.location,{method:'DELETE',headers:a})).status,409);
  } finally {await x.close();}
});

test('actual worker exits before and after partial creation preserve conservative owned state',async()=>{
  for(const point of ['before_create','after_create_payload','after_create_sidecar']) {
    const x=await setup();
    try {
      const c=await x.create(`Create crash ${point}`),a=await x.unlock(c,'A');
      const submit=x.storage.submit.bind(x.storage);
      let id;
      x.storage.submit=(op,args,stream,deadline)=>{
        if(op==='create') { id=args.id;return submit(op,{...args,fault:point},stream,deadline); }
        return submit(op,args,stream,deadline);
      };
      const response=await x.post(c,a,5,'creation.txt');
      assert.equal(response.status,503);
      assert.match(id,/^[0-9a-f]{32}$/);
      const row=x.db.prepare('SELECT * FROM uploads WHERE id=?').get(id);
      assert.equal(row.status,'creating');assert.equal(row.completed_at,null);
      assert.deepEqual({...commitment(x.db,c.id)},{completedBytes:0,reservedBytes:5,completedCount:0,reservedCount:1});
      const payload=join(x.root,'partials',`${id}.part`),sidecar=join(x.root,'partials',`${id}.json`);
      assert.equal(existsSync(payload),point!=='before_create');
      assert.equal(existsSync(sidecar),point==='after_create_sidecar');
      await x.restart();
      const after=x.db.prepare('SELECT * FROM uploads WHERE id=?').get(id);
      assert.equal(after.status,point==='after_create_sidecar'?'uploading':'creating');
      assert.equal(after.completed_at,null);
      assert.equal(existsSync(payload),point!=='before_create');
      assert.equal(existsSync(sidecar),point==='after_create_sidecar');
      assert.deepEqual({...commitment(x.db,c.id)},{completedBytes:0,reservedBytes:5,completedCount:0,reservedCount:1});
    } finally {await x.close();}
  }
});

test('worker process exits at durability boundaries recover one payload and one receipt',async()=>{
  for (const point of ['after_payload_fsync','after_payload_close','after_evidence','after_link','after_destination_fsync','after_partial_unlink','after_source_fsync']) {
    const x=await setup();
    try {
      const c=await x.create(`Crash ${point}`),a=await x.unlock(c,'A');
      const original=x.storage.submit.bind(x.storage);
      x.storage.submit=(op,args,stream,deadline)=>original(op,op==='finalize'?{...args,fault:point}:args,stream,deadline);
      const made=await x.post(c,a,5,`${point}.txt`);assert.equal(made.status,201);
      assert.equal((await x.patch(made.headers.location,a,0,Buffer.from('abcde'))).status,204);
      const id=made.headers.location.split('/').at(-1);
      await waitFor(()=>Promise.resolve(x.db.prepare('SELECT status,error_code FROM uploads WHERE id=?').get(id)),r=>r.error_code==='STORAGE_ERROR','fault annotation');
      const evidence=JSON.parse(readFileSync(join(x.root,'partials',`${id}.json`),'utf8'));
      if (['after_link','after_destination_fsync'].includes(point)) {
        const partial=statSync(join(x.root,'partials',`${id}.part`));
        const final=statSync(join(x.root,evidence.prepared.locator));
        assert.equal(partial.ino,final.ino);assert.equal(partial.dev,final.dev);
      }
      if (['after_partial_unlink','after_source_fsync'].includes(point)) assert.equal(existsSync(join(x.root,'partials',`${id}.part`)),false);
      assert.equal((await x.receipt(c,a,id)).body.completedAt,null);
      const before=commitment(x.db,c.id);assert.equal(before.reservedCount,1);assert.equal(before.completedCount,0);
      await x.restart();
      const done=await x.completed(c,a,id),row=x.db.prepare('SELECT * FROM uploads WHERE id=?').get(id);
      assert.equal(row.content_hash,createHash('sha256').update('abcde').digest('hex'));
      assert.equal(readFileSync(join(x.root,row.storage_locator),'utf8'),'abcde');
      assert.equal(done.body.completedAt,row.completed_at);
      assert.deepEqual({...commitment(x.db,c.id)},{completedBytes:5,reservedBytes:0,completedCount:1,reservedCount:0});
      const timestamp=row.completed_at;
      await x.restart();assert.equal(x.db.prepare('SELECT completed_at FROM uploads WHERE id=?').get(id).completed_at,timestamp);
    } finally {await x.close();}
  }
});

test('held finalization publishes no early receipt and retains the write claim until settlement',async()=>{
  const x=await setup();
  try {
    const c=await x.create('Held',20),a=await x.unlock(c,'A');
    const made=await x.post(c,a,5,'held.txt');assert.equal(made.status,201);
    const id=made.headers.location.split('/').at(-1);
    let enter,release;
    let finalizers=0;
    const entered=new Promise(resolve=>{enter=resolve;});
    const gate=new Promise(resolve=>{release=resolve;});
    const submit=x.storage.submit.bind(x.storage);
    x.storage.submit=(op,args,stream,deadline)=>{
      if(op!=='finalize')return submit(op,args,stream,deadline);
      finalizers++;
      enter();const task=gate.then(()=>submit(op,args,stream,deadline));task.settled=task;return task;
    };
    assert.equal((await x.patch(made.headers.location,a,0,Buffer.from('abcde'))).status,204);
    await entered;
    const pending=await x.receipt(c,a,id);
    assert.equal(pending.body.status,'finalizing');assert.equal(pending.body.completedAt,null);
    assert.deepEqual({...commitment(x.db,c.id)},{completedBytes:0,reservedBytes:5,completedCount:0,reservedCount:1});
    assert.equal((await send(x.guest(),'/health/live')).status,200);
    assert.equal((await send(x.config.adminSocketPath,'/health/ready',{headers:{'Tailscale-User-Login':owner}})).status,503);
    assert.equal((await x.post(c,a,1,'blocked.txt')).status,503);
    assert.equal((await send(x.guest(),made.headers.location,{method:'DELETE',headers:a})).status,409);
    await Promise.all([x.receipt(c,a,id),x.receipt(c,a,id)]);
    assert.equal(finalizers,1);
    release();
    const done=await x.completed(c,a,id);assert.equal(done.body.status,'completed');
    assert.equal((await send(x.guest(),made.headers.location,{method:'DELETE',headers:a})).status,409);
    assert.deepEqual({...commitment(x.db,c.id)},{completedBytes:5,reservedBytes:0,completedCount:1,reservedCount:0});
  } finally {await x.close();}
});

test('HEAD retry owns global completion claim and blocks other collection admission and writes',async()=>{
  const x=await setup();
  try {
    const c=await x.create('HEAD completion'),d=await x.create('Other collection');
    const a=await x.unlock(c,'A'),b=await x.unlock(d,'B');
    const other=await x.post(d,b,2,'other.txt');assert.equal(other.status,201);
    const made=await x.post(c,a,5,'head.txt');assert.equal(made.status,201);
    const id=made.headers.location.split('/').at(-1);
    const submit=x.storage.submit.bind(x.storage);
    let first=true,entered,release,finalizers=0;
    const started=new Promise(resolve=>{entered=resolve;});
    const gate=new Promise(resolve=>{release=resolve;});
    x.storage.submit=(op,args,stream,deadline)=>{
      if(op!=='finalize')return submit(op,args,stream,deadline);
      finalizers++;
      if(first){first=false;const task=Promise.reject(Object.assign(new Error('fixture'),{code:'EIO'}));task.settled=task.catch(()=>{});return task;}
      entered();const task=gate.then(()=>submit(op,args,stream,deadline));task.settled=task;return task;
    };
    assert.equal((await x.patch(made.headers.location,a,0,Buffer.from('abcde'))).status,204);
    await waitFor(()=>Promise.resolve(x.db.prepare('SELECT error_code FROM uploads WHERE id=?').get(id)),r=>r.error_code==='STORAGE_ERROR','first failure');
    await waitFor(()=>send(x.config.adminSocketPath,'/health/ready',{headers:{'Tailscale-User-Login':owner}}),r=>r.status===200,'claim release');
    assert.equal((await send(x.guest(),made.headers.location,{method:'HEAD',headers:a})).status,200);
    await started;
    assert.equal(finalizers,2);
    assert.equal((await send(x.config.adminSocketPath,'/health/ready',{headers:{'Tailscale-User-Login':owner}})).status,503);
    assert.equal((await x.post(d,b,1,'denied.txt')).status,503);
    assert.equal((await x.patch(other.headers.location,b,0,Buffer.from('xy'))).status,503);
    assert.equal((await x.receipt(c,a,id)).body.status,'finalizing');
    assert.equal(finalizers,2);
    release();
    const done=await x.completed(c,a,id),row=x.db.prepare('SELECT * FROM uploads WHERE id=?').get(id);
    const saved=join(x.root,row.storage_locator),hash=createHash('sha256').update(readFileSync(saved)).digest('hex');
    assert.equal(row.content_hash,hash);
    assert.deepEqual({...commitment(x.db,c.id)},{completedBytes:5,reservedBytes:0,completedCount:1,reservedCount:0});
    const completedAt=done.body.completedAt;
    assert.equal((await waitFor(()=>send(x.guest(),made.headers.location,{method:'HEAD',headers:a}),r=>r.status===200,'completed HEAD')).headers['upload-offset'],'5');
    assert.equal((await send(x.guest(),made.headers.location,{method:'DELETE',headers:a})).status,409);
    assert.equal(createHash('sha256').update(readFileSync(saved)).digest('hex'),hash);
    await x.restart();assert.equal((await x.completed(c,a,id)).body.completedAt,completedAt);
    assert.equal(x.db.prepare('SELECT count(*) n FROM uploads WHERE id=?').get(id).n,1);
  } finally {await x.close();}
});

test('HEAD defers completion when another writer owns the global claim',async()=>{
  const x=await setup();
  try {
    const c=await x.create('Deferred HEAD'),d=await x.create('Current writer');
    const a=await x.unlock(c,'A'),b=await x.unlock(d,'B');
    const made=await x.post(c,a,5,'deferred.txt');assert.equal(made.status,201);
    const other=await x.post(d,b,2,'writer.txt');assert.equal(other.status,201);
    const id=made.headers.location.split('/').at(-1);
    const submit=x.storage.submit.bind(x.storage);
    let first=true,finalizers=0,entered,release;
    const started=new Promise(resolve=>{entered=resolve;});const gate=new Promise(resolve=>{release=resolve;});
    x.storage.submit=(op,args,stream,deadline)=>{
      if(op==='finalize') {
        finalizers++;
        if(first){first=false;const task=Promise.reject(Object.assign(new Error('fixture'),{code:'EIO'}));task.settled=task.catch(()=>{});return task;}
      }
      if(op==='write'&&args.id===other.headers.location.split('/').at(-1)) {
        entered();const task=gate.then(()=>submit(op,args,stream,deadline));task.settled=task;return task;
      }
      return submit(op,args,stream,deadline);
    };
    assert.equal((await x.patch(made.headers.location,a,0,Buffer.from('abcde'))).status,204);
    await waitFor(()=>Promise.resolve(x.db.prepare('SELECT error_code FROM uploads WHERE id=?').get(id)),r=>r.error_code==='STORAGE_ERROR','first failure');
    await waitFor(()=>send(x.config.adminSocketPath,'/health/ready',{headers:{'Tailscale-User-Login':owner}}),r=>r.status===200,'first claim release');
    const heldPatch=x.patch(other.headers.location,b,0,Buffer.from('x'));
    await started;
    assert.equal((await send(x.guest(),made.headers.location,{method:'HEAD',headers:a})).status,200);
    assert.equal((await x.receipt(c,a,id)).body.status,'finalizing');
    assert.equal(finalizers,1);
    assert.equal((await send(x.config.adminSocketPath,'/health/ready',{headers:{'Tailscale-User-Login':owner}})).status,503);
    assert.equal((await x.post(c,a,1,'blocked.txt')).status,503);
    release();assert.equal((await heldPatch).status,204);
    const done=await x.completed(c,a,id);
    assert.equal(done.body.status,'completed');assert.equal(finalizers,2);
    assert.deepEqual({...commitment(x.db,c.id)},{completedBytes:5,reservedBytes:0,completedCount:1,reservedCount:0});
  } finally {await x.close();}
});

test('timed-out finalizer retains claim until the underlying worker settles',async()=>{
  const x=await setup();
  try {
    const c=await x.create('Timeout'),a=await x.unlock(c,'A');
    const made=await x.post(c,a,5,'timeout.txt');assert.equal(made.status,201);
    const id=made.headers.location.split('/').at(-1),submit=x.storage.submit.bind(x.storage);
    let release,attempts=0;
    const gate=new Promise(resolve=>{release=resolve;});
    x.storage.submit=(op,args,stream,deadline)=>{
      if(op==='finalize'&&attempts++===0){
        const task=Promise.reject(Object.assign(new Error('fixture timeout'),{code:'STORAGE_TIMEOUT'}));
        task.settled=gate;return task;
      }
      return submit(op,args,stream,deadline);
    };
    assert.equal((await x.patch(made.headers.location,a,0,Buffer.from('abcde'))).status,204);
    await waitFor(()=>Promise.resolve(x.db.prepare('SELECT error_code FROM uploads WHERE id=?').get(id)),r=>r.error_code==='STORAGE_ERROR','timeout annotation');
    assert.equal((await send(x.config.adminSocketPath,'/health/ready',{headers:{'Tailscale-User-Login':owner}})).status,503);
    assert.equal((await send(x.guest(),made.headers.location,{method:'HEAD',headers:a})).status,503);
    for(let i=0;i<3;i++)assert.equal((await x.receipt(c,a,id)).body.status,'finalizing');
    assert.equal(attempts,1);
    assert.equal((await x.post(c,a,1,'blocked.txt')).status,503);
    assert.equal((await send(x.guest(),'/health/live')).status,200);
    release();
    await waitFor(()=>send(x.config.adminSocketPath,'/health/ready',{headers:{'Tailscale-User-Login':owner}}),r=>r.status===200,'true settlement');
    const done=await x.completed(c,a,id);assert.equal(done.body.status,'completed');
    assert.equal(attempts,2);
    assert.deepEqual({...commitment(x.db,c.id)},{completedBytes:5,reservedBytes:0,completedCount:1,reservedCount:0});
  } finally {await x.close();}
});

test('distinct destination inode, including identical content or symlink, remains a preserved conflict',async()=>{
  for (const variant of ['same-content','different-content','symlink']) {
    const x=await setup();
    try {
      const c=await x.create(`Conflict ${variant}`),a=await x.unlock(c,'A');
      const submit=x.storage.submit.bind(x.storage);
      x.storage.submit=(op,args,stream,deadline)=>submit(op,op==='finalize'?{...args,fault:'after_evidence'}:args,stream,deadline);
      const made=await x.post(c,a,5,'conflict.txt');assert.equal(made.status,201);
      const id=made.headers.location.split('/').at(-1);
      assert.equal((await x.patch(made.headers.location,a,0,Buffer.from('abcde'))).status,204);
      await waitFor(()=>Promise.resolve(x.db.prepare('SELECT error_code FROM uploads WHERE id=?').get(id)),r=>r.error_code==='STORAGE_ERROR','prepared crash');
      const evidence=JSON.parse(readFileSync(join(x.root,'partials',`${id}.json`),'utf8'));
      assert.equal(evidence.prepared.sha256,createHash('sha256').update('abcde').digest('hex'));
      const final=join(x.root,evidence.prepared.locator),completed=join(x.root,'completed'),collection=join(completed,c.id);
      mkdirSync(completed,{mode:0o700});mkdirSync(collection,{mode:0o700});
      if(variant==='symlink') {
        const target=join(x.root,'foreign.txt');writeFileSync(target,'abcde',{mode:0o600});
        symlinkSync(target,final);
      } else writeFileSync(final,variant==='same-content'?'abcde':'xxxxx',{mode:0o600});
      const before=lstatSync(final),bytes=variant==='symlink'?null:readFileSync(final,'utf8');
      await x.restart();
      const row=x.db.prepare('SELECT status,error_code,completed_at FROM uploads WHERE id=?').get(id);
      assert.equal(row.status,'finalizing');assert.equal(row.error_code,'STORAGE_ERROR');assert.equal(row.completed_at,null);
      assert.equal(lstatSync(final).ino,before.ino);
      if(bytes!==null)assert.equal(readFileSync(final,'utf8'),bytes);
      assert.deepEqual({...commitment(x.db,c.id)},{completedBytes:0,reservedBytes:5,completedCount:0,reservedCount:1});
    } finally {await x.close();}
  }
});

test('fresh product server process recovers published payload before SQLite completion twice',async()=>{
  const x=await setup(),helper=fileURLToPath(new URL('./fixtures/completion-product-process.mjs',import.meta.url));
  const children=[];
  const launch=async mode=>{
    const child=spawn(process.execPath,[helper,x.root,x.config.dbPath,x.config.adminSocketPath,mode],{stdio:['ignore','pipe','pipe','ipc']});
    children.push(child);
    let stderr='';child.stderr.on('data',part=>{stderr+=part.toString();});child.stdout.resume();
    const ready=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error(`${mode} product process did not start: ${stderr.slice(-500)}`)),10000);
      child.once('message',message=>{clearTimeout(timer);resolve(message);});
      child.once('exit',(code,signal)=>{clearTimeout(timer);reject(new Error(`${mode} exited before ready ${code}/${signal}: ${stderr.slice(-500)}`));});
    });
    assert.equal(ready.type,'ready');
    return {child,url:ready.url,stderr:()=>stderr};
  };
  const exited=async(child,expected)=>{
    const result=child.exitCode!==null?{code:child.exitCode,signal:child.signalCode}:await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('product process did not exit in bound'));},10000);
      child.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});
    });
    assert.deepEqual(result,{code:expected,signal:null});
  };
  try {
    const c=await x.create('Product process'),a=await x.unlock(c,'A');
    const made=await x.post(c,a,5,'process.txt');assert.equal(made.status,201);
    const id=made.headers.location.split('/').at(-1),submit=x.storage.submit.bind(x.storage);
    x.storage.submit=(op,args,stream,deadline)=>{
      if(op!=='finalize')return submit(op,args,stream,deadline);
      const task=Promise.reject(Object.assign(new Error('fixture'),{code:'EIO'}));task.settled=task.catch(()=>{});return task;
    };
    assert.equal((await x.patch(made.headers.location,a,0,Buffer.from('abcde'))).status,204);
    await waitFor(()=>Promise.resolve(x.db.prepare('SELECT error_code FROM uploads WHERE id=?').get(id)),r=>r.error_code==='STORAGE_ERROR','parent completion failure');
    await waitFor(()=>send(x.config.adminSocketPath,'/health/ready',{headers:{'Tailscale-User-Login':owner}}),r=>r.status===200,'parent settlement');
    await x.stop();
    const crash=await launch('crash');await exited(crash.child,91);
    console.log('PRODUCT_PROCESS_EXIT',JSON.stringify({pid:crash.child.pid,exitCode:crash.child.exitCode,boundary:'published_before_db'}));
    const staleSocket=lstatSync(x.config.adminSocketPath);
    assert.ok(staleSocket.isSocket());assert.equal(staleSocket.mode&0o777,0o600);
    let db=openDatabase(x.config.dbPath);
    const pending=db.prepare('SELECT * FROM uploads WHERE id=?').get(id);
    assert.equal(pending.status,'finalizing');assert.equal(pending.completed_at,null);
    const evidence=JSON.parse(readFileSync(join(x.root,'partials',`${id}.json`),'utf8')).prepared;
    const final=join(x.root,evidence.locator),hash=createHash('sha256').update(readFileSync(final)).digest('hex');
    assert.equal(hash,evidence.sha256);assert.equal(readFileSync(final,'utf8'),'abcde');
    console.log('PRODUCT_PROCESS_RECOVERY_EVIDENCE',JSON.stringify({uploadId:id,status:pending.status,sha256:hash}));
    assert.deepEqual({...commitment(db,c.id)},{completedBytes:0,reservedBytes:5,completedCount:0,reservedCount:1});
    db.close();
    let completedAt;
    for(let i=0;i<2;i++) {
      const live=await launch('recover');
      const receipt=await waitFor(()=>send(live.url,`/api/c/${c.token}/uploads/${id}`,{headers:a}),r=>r.status===200&&r.body.status==='completed','child product receipt');
      completedAt??=receipt.body.completedAt;assert.equal(receipt.body.completedAt,completedAt);
      const head=await waitFor(()=>send(live.url,made.headers.location,{method:'HEAD',headers:a}),r=>r.status===200,'child completed HEAD');
      assert.equal(head.headers['upload-offset'],'5');
      assert.equal((await send(live.url,made.headers.location,{method:'DELETE',headers:a})).status,409);
      assert.equal(createHash('sha256').update(readFileSync(final)).digest('hex'),hash);
      live.child.send({type:'stop'});await exited(live.child,0);
      db=openDatabase(x.config.dbPath);
      const row=db.prepare('SELECT * FROM uploads WHERE id=?').get(id);
      assert.equal(row.status,'completed');assert.equal(row.completed_at,completedAt);assert.equal(row.content_hash,hash);
      assert.equal(createHash('sha256').update(readFileSync(join(x.root,row.storage_locator))).digest('hex'),hash);
      assert.equal(db.prepare('SELECT count(*) n FROM uploads WHERE id=?').get(id).n,1);
      assert.deepEqual({...commitment(db,c.id)},{completedBytes:5,reservedBytes:0,completedCount:1,reservedCount:0});
      console.log('PRODUCT_PROCESS_RESTART_PASS',JSON.stringify({iteration:i+1,pid:live.child.pid,exitCode:live.child.exitCode,completedAt,sha256:hash}));
      db.close();
    }
  } finally {
    for(const child of children) if(child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}
    await x.close();
  }
});

test('exclusive link loses a destination-creation race without overwriting the competing inode',async()=>{
  const x=await setup();
  try {
    const c=await x.create('Raced publication'),a=await x.unlock(c,'A');
    const submit=x.storage.submit.bind(x.storage);
    x.storage.submit=(op,args,stream,deadline)=>submit(op,op==='finalize'?{...args,raceDestination:true}:args,stream,deadline);
    const made=await x.post(c,a,5,'raced.txt');assert.equal(made.status,201);
    const id=made.headers.location.split('/').at(-1);
    assert.equal((await x.patch(made.headers.location,a,0,Buffer.from('abcde'))).status,204);
    await waitFor(()=>Promise.resolve(x.db.prepare('SELECT error_code FROM uploads WHERE id=?').get(id)),r=>r.error_code==='STORAGE_ERROR','EEXIST race');
    const evidence=JSON.parse(readFileSync(join(x.root,'partials',`${id}.json`),'utf8'));
    const final=join(x.root,evidence.prepared.locator),partial=join(x.root,'partials',`${id}.part`);
    assert.equal(readFileSync(final,'utf8'),'competing fixture');
    assert.notEqual(statSync(final).ino,statSync(partial).ino);
    assert.equal((await x.receipt(c,a,id)).body.completedAt,null);
    await x.restart();
    assert.equal(readFileSync(final,'utf8'),'competing fixture');
    assert.equal(x.db.prepare('SELECT status FROM uploads WHERE id=?').get(id).status,'finalizing');
    assert.deepEqual({...commitment(x.db,c.id)},{completedBytes:0,reservedBytes:5,completedCount:0,reservedCount:1});
  } finally {await x.close();}
});

test('real coordinator process exit before/after DB commit and sidecar cleanup is idempotent',async()=>{
  const helper=fileURLToPath(new URL('./fixtures/completion-crash.mjs',import.meta.url));
  for (const point of ['before_db_commit','after_db_commit','after_sidecar_cleanup']) {
    const x=await setup();
    try {
      const c=await x.create(`Database crash ${point}`),a=await x.unlock(c,'A');
      const submit=x.storage.submit.bind(x.storage);
      x.storage.submit=(op,args,stream,deadline)=>{
        if(op!=='finalize')return submit(op,args,stream,deadline);
        const task=Promise.reject(Object.assign(new Error('fixture'),{code:'WORKER_EXIT'}));task.settled=task.catch(()=>{});return task;
      };
      const made=await x.post(c,a,5,'db-crash.txt');assert.equal(made.status,201);
      assert.equal((await x.patch(made.headers.location,a,0,Buffer.from('abcde'))).status,204);
      const id=made.headers.location.split('/').at(-1);
      await waitFor(()=>Promise.resolve(x.db.prepare('SELECT error_code FROM uploads WHERE id=?').get(id)),r=>r.error_code==='STORAGE_ERROR','blocked automatic completion');
      const child=spawnSync(process.execPath,[helper,x.root,x.config.dbPath,id,point],{encoding:'utf8',timeout:10000});
      assert.equal(child.status,91,child.stderr);
      const interim=x.db.prepare('SELECT * FROM uploads WHERE id=?').get(id);
      assert.equal(interim.status,point==='before_db_commit'?'finalizing':'completed');
      assert.equal(interim.completed_at===null,point==='before_db_commit');
      await x.restart();
      const done=await x.completed(c,a,id),row=x.db.prepare('SELECT * FROM uploads WHERE id=?').get(id);
      assert.equal(done.body.completedAt,row.completed_at);
      assert.equal(readFileSync(join(x.root,row.storage_locator),'utf8'),'abcde');
      assert.equal(row.content_hash,createHash('sha256').update('abcde').digest('hex'));
      assert.deepEqual({...commitment(x.db,c.id)},{completedBytes:5,reservedBytes:0,completedCount:1,reservedCount:0});
      const stamp=row.completed_at;
      await x.restart();assert.equal(x.db.prepare('SELECT completed_at FROM uploads WHERE id=?').get(id).completed_at,stamp);
    } finally {await x.close();}
  }
});

test('storage fsync, close, link, NFS-style and space failures retain reservation without false receipt',async()=>{
  const cases=[
    {point:'after_payload_fsync',code:'EIO'},
    {point:'after_payload_close',code:'EIO'},
    {point:'after_evidence',code:'ENOSPC'},
    {point:'before_link',code:'EACCES'},
    {point:'before_link',code:'ENOTSUP'},
    {point:'before_link',code:'EXDEV'},
    {point:'after_link',code:'EIO'},
    {point:'after_destination_fsync',code:'EIO'},
    {point:'after_partial_unlink',code:'EIO'},
    {point:'after_source_fsync',code:'EIO'},
  ];
  for(const failure of cases) {
    const x=await setup();
    try {
      const c=await x.create(`Failure ${failure.point} ${failure.code}`),a=await x.unlock(c,'A');
      const submit=x.storage.submit.bind(x.storage);
      x.storage.submit=(op,args,stream,deadline)=>submit(op,op==='finalize'?{...args,failure}:args,stream,deadline);
      const made=await x.post(c,a,5,'fault.txt');assert.equal(made.status,201);
      assert.equal((await x.patch(made.headers.location,a,0,Buffer.from('abcde'))).status,204);
      const id=made.headers.location.split('/').at(-1);
      await waitFor(()=>Promise.resolve(x.db.prepare('SELECT status,error_code,completed_at FROM uploads WHERE id=?').get(id)),r=>r.error_code==='STORAGE_ERROR','storage failure');
      const pending=x.db.prepare('SELECT * FROM uploads WHERE id=?').get(id);
      assert.equal(pending.status,'finalizing');assert.equal(pending.completed_at,null);
      assert.equal(commitment(x.db,c.id).reservedCount,1);
      await x.restart();
      const done=await x.completed(c,a,id),row=x.db.prepare('SELECT * FROM uploads WHERE id=?').get(id);
      assert.equal(done.body.status,'completed');
      assert.equal(readFileSync(join(x.root,row.storage_locator),'utf8'),'abcde');
    } finally {await x.close();}
  }
});

test('SQLite commit failure leaves prepared NAS payload reserved and recovers after restart',async()=>{
  const x=await setup();
  try {
    const c=await x.create('Database fault'),a=await x.unlock(c,'A');
    const made=await x.post(c,a,5,'db-fault.txt');assert.equal(made.status,201);
    const id=made.headers.location.split('/').at(-1);
    x.db.exec("CREATE TRIGGER fixture_db_failure BEFORE UPDATE OF status ON uploads WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT,'fixture DB failure'); END");
    assert.equal((await x.patch(made.headers.location,a,0,Buffer.from('abcde'))).status,204);
    await waitFor(()=>Promise.resolve(x.db.prepare('SELECT error_code FROM uploads WHERE id=?').get(id)),r=>r.error_code==='STORAGE_ERROR','DB failure');
    const row=x.db.prepare('SELECT * FROM uploads WHERE id=?').get(id);
    assert.equal(row.status,'finalizing');assert.equal(row.completed_at,null);
    assert.deepEqual({...commitment(x.db,c.id)},{completedBytes:0,reservedBytes:5,completedCount:0,reservedCount:1});
    x.db.exec('DROP TRIGGER fixture_db_failure');
    await x.restart();
    const done=await x.completed(c,a,id);assert.equal(done.body.status,'completed');
    assert.deepEqual({...commitment(x.db,c.id)},{completedBytes:5,reservedBytes:0,completedCount:1,reservedCount:0});
  } finally {await x.close();}
});

test('missing evidence and partial-only or sidecar-only artifacts remain unsaved and accounted',async()=>{
  for(const variant of ['missing-evidence','payload-only','sidecar-only']) {
    const x=await setup();
    try {
      const c=await x.create(`Artifact ${variant}`),a=await x.unlock(c,'A');
      const made=await x.post(c,a,5,'artifact.txt');assert.equal(made.status,201);
      const id=made.headers.location.split('/').at(-1),payload=join(x.root,'partials',`${id}.part`),sidecar=join(x.root,'partials',`${id}.json`);
      if(variant==='missing-evidence') {
        const submit=x.storage.submit.bind(x.storage);
        x.storage.submit=(op,args,stream,deadline)=>submit(op,op==='finalize'?{...args,fault:'after_evidence'}:args,stream,deadline);
        assert.equal((await x.patch(made.headers.location,a,0,Buffer.from('abcde'))).status,204);
        await waitFor(()=>Promise.resolve(x.db.prepare('SELECT error_code FROM uploads WHERE id=?').get(id)),r=>r.error_code==='STORAGE_ERROR','prepared failure');
        unlinkSync(sidecar);
      } else if(variant==='payload-only') unlinkSync(sidecar);
      else unlinkSync(payload);
      await x.restart();
      const row=x.db.prepare('SELECT status,completed_at,error_code FROM uploads WHERE id=?').get(id);
      assert.equal(row.completed_at,null);assert.equal(row.error_code,'STORAGE_ERROR');
      assert.equal(commitment(x.db,c.id).reservedCount,1);
      assert.equal(existsSync(payload),variant!=='sidecar-only');
      assert.equal(existsSync(sidecar),variant==='sidecar-only');
    } finally {await x.close();}
  }
});

test('wrong or missing expected root fails closed while liveness stays responsive',async()=>{
  const x=await setup();
  try {
    const c=await x.create('Mount'),a=await x.unlock(c,'A');
    const made=await x.post(c,a,5,'mount.txt');assert.equal(made.status,201);
    const id=made.headers.location.split('/').at(-1);
    const submit=x.storage.submit.bind(x.storage);
    x.storage.submit=(op,args,stream,deadline)=>submit(op,op==='finalize'?{...args,fault:'after_evidence'}:args,stream,deadline);
    assert.equal((await x.patch(made.headers.location,a,0,Buffer.from('abcde'))).status,204);
    await waitFor(()=>Promise.resolve(x.db.prepare('SELECT error_code FROM uploads WHERE id=?').get(id)),r=>r.error_code==='STORAGE_ERROR','prepared failure');
    await waitFor(()=>Promise.resolve(x.storage.counts),v=>v.active===0&&v.pending===0,'worker exit');
    const parked=join(x.dir,'parked-nas');renameSync(x.root,parked);symlinkSync(parked,x.root);
    assert.equal((await send(x.guest(),'/health/live')).status,200);
    await assert.rejects(x.storage.submit('probe'),/WRONG_MOUNT/);
    assert.equal((await x.receipt(c,a,id)).body.status,'finalizing');
    await waitFor(()=>Promise.resolve(x.storage.counts),v=>v.active===0&&v.pending===0,'failed wrong-root worker');
    assert.equal(x.db.prepare('SELECT completed_at FROM uploads WHERE id=?').get(id).completed_at,null);
    unlinkSync(x.root);renameSync(parked,x.root);
    await x.restart();
    const done=await x.completed(c,a,id);assert.equal(done.body.status,'completed');
  } finally {await x.close();}
});
