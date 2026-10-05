import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, chmodSync, rmSync, realpathSync, readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { Upload } from 'tus-js-client';
import { configFrom } from '../src/server/config.mjs';
import { openDatabase } from '../src/server/db.mjs';
import { startServers } from '../src/server/http.mjs';
import { StoragePool } from '../src/server/storage/pool.mjs';

const publicOrigin='https://drive.example.invalid';
const adminOrigin='https://admin.example.invalid';
const owner='owner@example.invalid';
const meta=name=>`filename ${Buffer.from(name).toString('base64')}`;
function send(target,path,{method='GET',headers={},body}={}) {
  return new Promise((resolve,reject)=>{
    const remote=target.startsWith('/')?{socketPath:target}:{hostname:'127.0.0.1',port:new URL(target).port};
    const clean=Object.fromEntries(Object.entries(headers).filter(([,value])=>value!==undefined));
    const req=request({...remote,path,method,headers:clean},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{
        const raw=Buffer.concat(chunks).toString();let payload=raw;
        try {payload=raw?JSON.parse(raw):null;} catch {}
        resolve({status:res.statusCode,headers:res.headers,body:payload});
      });
    });
    req.on('error',reject);req.end(body);
  });
}
async function eventually(run, accept, label) {
  for(let i=0;i<150;i++) {
    const value=await run();
    if(accept(value)) return value;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  throw new Error(`${label} did not settle`);
}
async function setup() {
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'bd-uploads-')));chmodSync(dir,0o700);
  const root=join(dir,'nas');mkdirSync(root,{mode:0o700});
  const env={APP_MODE:'fixture',ADMIN_OWNER_LOGIN:owner,ADMIN_SOCKET_PATH:join(dir,'admin.sock'),DB_PATH:join(dir,'app.sqlite'),
    PUBLIC_ORIGIN:publicOrigin,ADMIN_ORIGIN:adminOrigin,FREE_SPACE_FLOOR_BYTES:'1'};
  const config=configFrom(env),storage=new StoragePool({root,fixture:true,expectedSource:''});
  let db=openDatabase(config.dbPath);
  db.exec("UPDATE intake_window SET closes_at='9999-12-31T23:59:59.999Z' WHERE id=1");
  let servers=await startServers(config,[0,0],storage,db);
  const guest=()=>`http://127.0.0.1:${servers[0].address().port}`;
  const identity={'Tailscale-User-Login':owner};
  const adminSession=await send(config.adminSocketPath,'/api/admin/session',{headers:identity});
  const admin={...identity,Cookie:adminSession.headers['set-cookie'][0].split(';')[0],Origin:adminOrigin,
    'X-CSRF-Token':adminSession.body.csrfToken,'Content-Type':'application/json'};
  const create=async(title,allowance)=>{
    const r=await send(config.adminSocketPath,'/api/admin/collections',{method:'POST',headers:admin,
      body:JSON.stringify({title,allowance})});assert.equal(r.status,201);return r.body;
  };
  const unlock=async(c,name)=>{
    const r=await send(guest(),`/api/c/${c.token}/unlock`,{method:'POST',headers:{Origin:publicOrigin,'Content-Type':'application/json'},
      body:JSON.stringify({key:c.key,displayName:name})});assert.equal(r.status,200);
    return {Cookie:r.headers['set-cookie'][0].split(';')[0],Origin:publicOrigin,'X-CSRF-Token':r.body.csrfToken,'Tus-Resumable':'1.0.0'};
  };
  const stop=async()=>{await Promise.all(servers.map(s=>new Promise(resolve=>{s.closeAllConnections();s.close(resolve);})));db.close();};
  const close=async()=>{await stop();rmSync(dir,{recursive:true,force:true});};
  const restart=async()=>{
    await stop();db=openDatabase(config.dbPath);servers=await startServers(config,[0,0],storage,db);
    for(let i=0;i<100;i++) {
      if((await send(config.adminSocketPath,'/health/ready',{headers:identity})).status===200)return;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    throw new Error('startup recovery did not restore readiness');
  };
  return {dir,root,config,get db(){return db;},storage,get servers(){return servers;},guest,admin,create,unlock,close,restart};
}

test('production guest route enforces session, tus headers, reservations, offsets and finalizing',async()=>{
  const x=await setup();
  try {
    const c=await x.create('Upload test',1024);const a=await x.unlock(c,'Alice');const b=await x.unlock(c,'Bob');
    const path=`/uploads/${c.token}`;
    const options=await send(x.guest(),path,{method:'OPTIONS'});
    assert.equal(options.status,204);assert.match(options.headers['tus-version'],/1\.0\.0/);
    assert.equal(options.headers['tus-extension'],'creation,termination');
    assert.equal(options.headers['tus-max-size'],'10000000000');
    assert.equal(options.headers['cache-control'],'no-store');
    assert.equal(options.headers['access-control-allow-origin'],undefined);
    assert.equal((await send(x.guest(),path,{method:'OPTIONS',headers:{'Transfer-Encoding':'chunked'},body:Buffer.from('x')})).status,400);
    const make=(headers,body)=>send(x.guest(),path,{method:'POST',headers:{...a,'Upload-Length':'5','Upload-Metadata':meta('café.txt'),...headers},body});
    const wrongVersion=await make({'Tus-Resumable':undefined});
    assert.equal(wrongVersion.status,412);assert.equal(wrongVersion.headers['tus-version'],'1.0.0');
    assert.equal((await make({'Upload-Length':'01'})).status,400);
    assert.equal((await make({'Upload-Length':'10000000001'})).status,413);
    assert.equal((await make({'Upload-Defer-Length':'1'})).status,400);
    assert.equal((await make({'Upload-Concat':'partial'})).status,400);
    assert.equal((await make({'Content-Type':'application/offset+octet-stream'})).status,400);
    assert.equal((await make({'Upload-Metadata':`${meta('a')},${meta('b')}`})).status,400);
    assert.equal((await make({'Upload-Metadata':meta('../escape')})).status,400);
    assert.equal((await make({Origin:'https://wrong.invalid'})).status,403);
    assert.equal((await make({},Buffer.from('x'))).status,400);
    const made=await make();assert.equal(made.status,201);
    assert.match(made.headers.location,new RegExp(`^/uploads/${c.token}/[0-9a-f]{32}$`));
    const item=made.headers.location;
    assert.equal((await send(x.guest(),item,{method:'HEAD',headers:{...b}})).status,404);
    assert.equal((await send(x.guest(),item,{method:'HEAD',headers:{...a,'Transfer-Encoding':'chunked'},body:Buffer.from('x')})).status,400);
    assert.equal((await send(x.guest(),item,{method:'DELETE',headers:{...a,'Transfer-Encoding':'chunked'},body:Buffer.from('x')})).status,400);
    assert.equal((await send(x.guest(),item,{method:'PATCH',headers:{...b,'Content-Type':'application/offset+octet-stream','Upload-Offset':'0'},body:Buffer.from('x')})).status,404);
    assert.equal((await send(x.guest(),item,{method:'DELETE',headers:{...b}})).status,404);
    assert.equal((await send(x.guest(),item,{method:'HEAD',headers:a})).headers['upload-offset'],'0');
    const patch=(offset,body,headers={})=>send(x.guest(),item,{method:'PATCH',headers:{...a,'Content-Type':'application/offset+octet-stream','Upload-Offset':String(offset),...headers},body});
    assert.equal((await patch(1,Buffer.from('x'))).status,409);
    assert.equal((await patch(0,Buffer.from('x'),{'Content-Type':'text/plain'})).status,415);
    assert.equal((await patch(0,Buffer.from('x'),{'Upload-Offset':'01'})).status,400);
    assert.equal((await patch(0,Buffer.from('abc'))).headers['upload-offset'],'3');
    assert.equal((await patch(0,Buffer.from('x'))).status,409);
    assert.equal((await patch(3,Buffer.from('def'))).status,413);
    assert.equal((await send(x.guest(),item,{method:'HEAD',headers:a})).headers['upload-offset'],'3');
    assert.equal((await patch(3,Buffer.from('de'))).headers['upload-offset'],'5');
    await eventually(()=>send(x.guest(),item,{method:'HEAD',headers:a}),r=>r.status===200,'completion HEAD');
    assert.equal(x.db.prepare('SELECT status FROM uploads WHERE id=?').get(item.split('/').at(-1)).status,'completed');
    const finalizingConflict=await send(x.guest(),item,{method:'DELETE',headers:a});
    assert.equal(finalizingConflict.status,409);
    assert.equal(finalizingConflict.headers['upload-offset'],undefined);
    assert.equal((await send(x.guest(),`/api/c/${c.token}/uploads`,{headers:a})).body.items[0].status,'completed');
    assert.equal((await send(x.guest(),item,{method:'GET',headers:a})).status,405);
    assert.equal((await send(x.guest(),`/api/admin/collections`,{headers:a})).status,404);
  } finally {await x.close();}
});

test('authorized stale PATCH returns only its committed offset before and after restart',async()=>{
  const x=await setup();
  try {
    const c=await x.create('Offset conflict',64),a=await x.unlock(c,'Alice'),b=await x.unlock(c,'Bob');
    const made=await send(x.guest(),`/uploads/${c.token}`,{method:'POST',headers:{...a,'Upload-Length':'8','Upload-Metadata':meta('offset.txt')}});
    assert.equal(made.status,201);
    const path=made.headers.location,id=path.split('/').at(-1);
    const part=join(x.root,'partials',`${id}.part`),sidecar=join(x.root,'partials',`${id}.json`);
    const patch=(auth,offset,data)=>send(x.guest(),path,{method:'PATCH',headers:{...auth,'Content-Type':'application/offset+octet-stream','Upload-Offset':String(offset)},body:Buffer.from(data)});
    const unchanged=()=>[createHash('sha256').update(readFileSync(part)).digest('hex'),readFileSync(sidecar,'utf8')];
    const first=unchanged();
    const wrong=await patch(a,1,'x');
    assert.equal(wrong.status,409);assert.equal(wrong.headers['upload-offset'],'0');
    assert.equal(wrong.headers['tus-resumable'],'1.0.0');assert.equal(wrong.headers['cache-control'],'no-store');
    assert.equal(wrong.body.error.code,'OFFSET_CONFLICT');assert.ok(wrong.body.requestId);
    assert.deepEqual(unchanged(),first);
    const foreign=await patch(b,1,'x');
    assert.equal(foreign.status,404);assert.equal(foreign.headers['upload-offset'],undefined);
    assert.deepEqual(unchanged(),first);
    assert.equal((await patch(a,0,'abc')).headers['upload-offset'],'3');
    const committed=unchanged();
    for (const restart of [false,true]) {
      if (restart) await x.restart();
      const stale=await patch(a,0,'x');
      assert.equal(stale.status,409);assert.equal(stale.headers['upload-offset'],'3');
      assert.deepEqual(unchanged(),committed);
      assert.equal((await send(x.guest(),path,{method:'HEAD',headers:a})).headers['upload-offset'],'3');
    }
  } finally {await x.close();}
});

test('actual chunked overflow rolls back and grant invalidation denies all upload methods',async()=>{
  const x=await setup();
  try {
    const c=await x.create('Overflow',20*1024*1024),a=await x.unlock(c,'A');
    const made=await send(x.guest(),`/uploads/${c.token}`,{method:'POST',headers:{...a,'Upload-Length':String(12*1024*1024),'Upload-Metadata':meta('safe.bin')}});
    assert.equal(made.status,201);
    const path=made.headers.location;
    const oversized=await send(x.guest(),path,{method:'PATCH',headers:{...a,'Content-Type':'application/offset+octet-stream','Upload-Offset':'0','Transfer-Encoding':'chunked'},body:Buffer.alloc(10*1024*1024+1,0x61)});
    assert.equal(oversized.status,413);
    assert.equal((await eventually(()=>send(x.guest(),path,{method:'HEAD',headers:a}),r=>r.headers['upload-offset']==='0','overflow settlement')).headers['upload-offset'],'0');
    const rotated=await send(x.config.adminSocketPath,`/api/admin/collections/${c.id}/rotate-key`,{method:'POST',headers:x.admin});
    assert.equal(rotated.status,200);
    assert.equal((await send(x.guest(),path,{method:'HEAD',headers:a})).status,401);
    assert.equal((await send(x.guest(),path,{method:'PATCH',headers:{...a,'Content-Type':'application/offset+octet-stream','Upload-Offset':'0'},body:Buffer.from('x')})).status,401);
    assert.equal((await send(x.guest(),path,{method:'DELETE',headers:a})).status,401);
    assert.equal((await send(x.guest(),`/uploads/${c.token}`,{method:'POST',headers:{...a,'Upload-Length':'1','Upload-Metadata':meta('new')}})).status,401);
  } finally {await x.close();}
});

test('serialized admission accounts unwritten bytes and rejects a competing free-space claim',async()=>{
  const x=await setup();
  try {
    const a=await x.create('A',100),b=await x.create('B',100),ha=await x.unlock(a,'A'),hb=await x.unlock(b,'B');
    const actual=x.storage.submit.bind(x.storage);
    let observed=101;
    x.storage.submit=(op,args,stream,deadline)=>{
      if(op==='probe') {const task=Promise.resolve({freeBytes:observed});task.settled=task;return task;}
      return actual(op,args,stream,deadline);
    };
    const create=(c,h,n)=>send(x.guest(),`/uploads/${c.token}`,{method:'POST',headers:{...h,'Upload-Length':String(n),'Upload-Metadata':meta('a.txt')}});
    const first=await create(a,ha,60);assert.equal(first.status,201);
    assert.equal((await create(b,hb,41)).status,507);
    assert.equal((await create(b,hb,40)).status,201);
    observed=40; // external fixture consumption before PATCH
    assert.equal((await send(x.guest(),first.headers.location,{method:'PATCH',headers:{...ha,'Content-Type':'application/offset+octet-stream','Upload-Offset':'0'},body:Buffer.alloc(20)})).status,507);
    assert.equal((await send(x.guest(),first.headers.location,{method:'HEAD',headers:ha})).headers['upload-offset'],'0');
    observed=101;
    const patch=await send(x.guest(),first.headers.location,{method:'PATCH',headers:{...ha,'Content-Type':'application/offset+octet-stream','Upload-Offset':'0'},body:Buffer.alloc(20,0x31)});
    assert.equal(patch.status,204);
    observed=81; // fixture statfs after 20 persisted bytes; only 80 unwritten remain
    assert.equal((await create(a,ha,0)).status,201);
  } finally {await x.close();}
});

test('exact 10 GB declaration and zero-byte file count are admitted transactionally',async()=>{
  const x=await setup();
  try {
    x.config.limits.COLLECTION_MAX_FILES=1;
    const c=await x.create('Limit',10000000000),a=await x.unlock(c,'A');
    const actual=x.storage.submit.bind(x.storage);
    x.storage.submit=(op,args,stream,deadline)=>{
      if(op==='probe'){const task=Promise.resolve({freeBytes:10000000001});task.settled=task;return task;}
      return actual(op,args,stream,deadline);
    };
    const path=`/uploads/${c.token}`;
    const create=n=>send(x.guest(),path,{method:'POST',headers:{...a,'Upload-Length':n,'Upload-Metadata':meta('limit.bin')}});
    assert.equal((await create('10000000001')).status,413);
    assert.equal((await create('9007199254740992')).status,400);
    const exact=await create('10000000000');assert.equal(exact.status,201);
    assert.equal(x.db.prepare('SELECT declared_size FROM uploads').get().declared_size,10000000000);
    assert.equal((await create('0')).status,409);
  } finally {await x.close();}
});

test('simultaneous admission cannot reuse one free-space snapshot',async()=>{
  const x=await setup();
  try {
    const c=await x.create('Compete',200),a=await x.unlock(c,'A');
    const actual=x.storage.submit.bind(x.storage);
    x.storage.submit=(op,args,stream,deadline)=>{
      if(op==='probe'){
        const task=new Promise(resolve=>setTimeout(()=>resolve({freeBytes:101}),30));task.settled=task;return task;
      }
      return actual(op,args,stream,deadline);
    };
    const create=()=>send(x.guest(),`/uploads/${c.token}`,{method:'POST',headers:{...a,'Upload-Length':'100','Upload-Metadata':meta('race.bin')}});
    const pair=await Promise.all([create(),create()]);
    assert.deepEqual(pair.map(x=>x.status).sort(),[201,503]);
    assert.equal(x.db.prepare('SELECT count(*) n FROM uploads').get().n,1);
  } finally {await x.close();}
});

test('paused admission probe excludes a competing PATCH and keeps the 200/100/80 floor',async()=>{
  const x=await setup();
  try {
    x.config.limits.FREE_SPACE_FLOOR_BYTES=100;
    const c=await x.create('Probe race',300),a=await x.unlock(c,'A');
    const actual=x.storage.submit.bind(x.storage);
    let pause=false,started,release;
    const entered=new Promise(resolve=>{started=resolve;});
    const gate=new Promise(resolve=>{release=resolve;});
    x.storage.submit=(op,args,stream,deadline)=>{
      if(op==='probe'){
        const task=pause?gate.then(()=>({freeBytes:200})):Promise.resolve({freeBytes:200});
        if(pause)started();task.settled=task;return task;
      }
      return actual(op,args,stream,deadline);
    };
    const path=`/uploads/${c.token}`;
    const create=n=>send(x.guest(),path,{method:'POST',headers:{...a,'Upload-Length':String(n),'Upload-Metadata':meta('race.bin')}});
    const first=await create(100);assert.equal(first.status,201);
    pause=true;const second=create(80);await entered;
    const patch=await send(x.guest(),first.headers.location,{method:'PATCH',headers:{...a,'Content-Type':'application/offset+octet-stream','Upload-Offset':'0'},body:Buffer.alloc(80)});
    assert.equal(patch.status,503);
    release();assert.equal((await second).status,507);
    assert.equal((await send(x.guest(),first.headers.location,{method:'HEAD',headers:a})).headers['upload-offset'],'0');
    assert.equal(x.db.prepare('SELECT count(*) n FROM uploads').get().n,1);
  } finally {await x.close();}
});

test('a delayed PATCH probe accounts for a competing chunk granted after its sample',async()=>{
  const x=await setup();
  try {
    x.config.limits.FREE_SPACE_FLOOR_BYTES=100;
    const c=await x.create('Patch race',400),a=await x.unlock(c,'A');
    const actual=x.storage.submit.bind(x.storage);
    let observed=500,pause=false,started,release;
    const entered=new Promise(resolve=>{started=resolve;});
    const gate=new Promise(resolve=>{release=resolve;});
    x.storage.submit=(op,args,stream,deadline)=>{
      if(op==='probe'){
        const sample = observed;
        const task=pause?gate.then(()=>({freeBytes:sample})):Promise.resolve({freeBytes:sample});
        if(pause){pause=false;started();}task.settled=task;return task;
      }
      return actual(op,args,stream,deadline);
    };
    const create=()=>send(x.guest(),`/uploads/${c.token}`,{method:'POST',headers:{...a,'Upload-Length':'80','Upload-Metadata':meta('p.bin')}});
    const first=await create(),second=await create();assert.equal(first.status,201);assert.equal(second.status,201);
    observed=180;pause=true;
    const patch=path=>send(x.guest(),path,{method:'PATCH',headers:{...a,'Content-Type':'application/offset+octet-stream','Upload-Offset':'0'},body:Buffer.alloc(80)});
    const inFlight=patch(first.headers.location);await entered;
    assert.equal((await patch(second.headers.location)).status,204);
    await eventually(()=>send(x.guest(),second.headers.location,{method:'HEAD',headers:a}),
      r=>r.status===200,'competing reservation released before delayed probe');
    release();assert.equal((await inFlight).status,507);
    observed=100;
    await eventually(()=>send(x.guest(),second.headers.location,{method:'HEAD',headers:a}),r=>r.status===200,'finalize unlock');
    assert.equal((await patch(first.headers.location)).status,507);
    assert.equal((await send(x.guest(),first.headers.location,{method:'HEAD',headers:a})).headers['upload-offset'],'0');
  } finally {await x.close();}
});

test('two files per session stream concurrently across five sessions with exact saved bytes',async()=>{
  const x=await setup();
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const pending=[];
  try {
    const c=await x.create('Concurrent guests',1000);
    const files=[];
    for(let session=0;session<5;session++){
      const headers=await x.unlock(c,`Guest ${session}`);
      for(let file=0;file<2;file++){
        const payload=Buffer.from(`guest ${session} file ${file}`);
        const made=await eventually(()=>send(x.guest(),`/uploads/${c.token}`,{method:'POST',
          headers:{...headers,'Upload-Length':String(payload.length),'Upload-Metadata':meta(`${session}-${file}.txt`)}}),
          r=>r.status===201,'create concurrent fixture');
        files.push({headers,payload,path:made.headers.location,id:made.headers.location.split('/').at(-1)});
      }
    }
    const third=await eventually(()=>send(x.guest(),`/uploads/${c.token}`,{method:'POST',
      headers:{...files[0].headers,'Upload-Length':'1','Upload-Metadata':meta('third.txt')}}),r=>r.status===201,'third fixture');
    const sixth=await x.unlock(c,'Sixth guest');
    const extra=await eventually(()=>send(x.guest(),`/uploads/${c.token}`,{method:'POST',
      headers:{...sixth,'Upload-Length':'1','Upload-Metadata':meta('extra.txt')}}),r=>r.status===201,'extra fixture');
    const actual=x.storage.submit.bind(x.storage);
    let entered=0,started;
    const allStarted=new Promise(resolve=>{started=resolve;});
    x.storage.submit=(op,args,stream,deadline)=>{
      if(op==='write'){
        const original=stream;
        stream=(async function*(){
          for await(const chunk of original) yield chunk;
          entered++;
          if(entered===10)started();
          await gate;
        })();
      }
      return actual(op,args,stream,deadline);
    };
    for(const file of files.slice(0,2)) pending.push(send(x.guest(),file.path,{method:'PATCH',
      headers:{...file.headers,'Content-Type':'application/offset+octet-stream','Upload-Offset':'0'},body:file.payload}));
    await eventually(()=>Promise.resolve(entered),count=>count===2,'first pair overlaps');
    assert.equal((await send(x.guest(),third.headers.location,{method:'HEAD',headers:files[0].headers})).status,200);
    assert.equal((await send(x.guest(),third.headers.location,{method:'PATCH',headers:{...files[0].headers,
      'Content-Type':'application/offset+octet-stream','Upload-Offset':'0'},body:'x'})).status,503);
    for(const file of files.slice(2)) pending.push(send(x.guest(),file.path,{method:'PATCH',
      headers:{...file.headers,'Content-Type':'application/offset+octet-stream','Upload-Offset':'0'},body:file.payload}));
    let timer;
    try {await Promise.race([allStarted,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('ten streams did not overlap')),10000);})]);}
    finally {clearTimeout(timer);}
    assert.equal((await send(x.guest(),'/health/live')).status,200);
    assert.equal((await send(x.guest(),files[0].path,{method:'PATCH',headers:{...files[0].headers,
      'Content-Type':'application/offset+octet-stream','Upload-Offset':'0'},body:files[0].payload})).status,503);
    assert.equal((await send(x.guest(),extra.headers.location,{method:'PATCH',headers:{...sixth,
      'Content-Type':'application/offset+octet-stream','Upload-Offset':'0'},body:'x'})).status,503);
    release();
    assert.deepEqual((await Promise.all(pending)).map(r=>r.status),Array(10).fill(204));
    for(const file of files){
      const receipt=await eventually(()=>send(x.guest(),`/api/c/${c.token}/uploads/${file.id}`,{headers:file.headers}),
        r=>r.status===200&&r.body.status==='completed','concurrent completion');
      assert.equal(receipt.body.status,'completed');
      const row=x.db.prepare('SELECT storage_locator FROM uploads WHERE id=?').get(file.id);
      assert.deepEqual(readFileSync(join(x.root,row.storage_locator)),file.payload);
    }
    const totals=x.db.prepare("SELECT SUM(declared_size) bytes,COUNT(*) count FROM uploads WHERE status='completed'").get();
    assert.equal(totals.bytes,files.reduce((sum,file)=>sum+file.payload.length,0));
    assert.equal(totals.count,10);
  } finally {
    release();
    await Promise.allSettled(pending);
    await eventually(()=>send(x.config.adminSocketPath,'/health/ready',{headers:{'Tailscale-User-Login':owner}}),r=>r.status===200,'writers settled');
    await x.close();
  }
});

test('metadata byte limits, Unicode and HEAD round-trip survive restart without path use',async()=>{
  const x=await setup();
  try {
    const c=await x.create('Metadata',100),a=await x.unlock(c,'A');
    const name='🌿'.repeat(63)+'abc';assert.equal(Buffer.byteLength(name),255);
    const mime='x'.repeat(128),stamp='1700000000000';
    const field=(key,value)=>`${key} ${Buffer.from(value).toString('base64')}`;
    const encoded=[field('filename',name),field('filetype',mime),field('lastModified',stamp)].join(',');
    const path=`/uploads/${c.token}`;
    const create=raw=>send(x.guest(),path,{method:'POST',headers:{...a,'Upload-Length':'1','Upload-Metadata':raw}});
    assert.equal((await create(field('filename',name+'a'))).status,400);
    assert.equal((await create([field('filename','safe'),field('filetype',mime+'a')].join(','))).status,400);
    assert.equal((await create([field('filename','safe'),field('filename','again')].join(','))).status,400);
    assert.equal((await create(field('filename','../escape'))).status,400);
    assert.equal((await create(`filename ${Buffer.from([0xc0,0xaf]).toString('base64')}`)).status,400);
    assert.equal((await create('filename !!!')).status,400);
    assert.equal((await create('filename '+('A'.repeat(4097)))).status,400);
    const made=await create(encoded);assert.equal(made.status,201);
    const id=made.headers.location.split('/').at(-1);
    assert.match(id,/^[0-9a-f]{32}$/);
    assert.equal(existsSync(join(x.root,'partials',`${id}.part`)),true);
    assert.equal(existsSync(join(x.root,name)),false);
    const before=await send(x.guest(),made.headers.location,{method:'HEAD',headers:a});
    assert.equal(before.status,200);assert.equal(before.body,null);
    assert.equal(before.headers['cache-control'],'no-store');
    assert.equal(before.headers['upload-length'],'1');
    assert.equal(before.headers['upload-offset'],'0');
    assert.equal(before.headers['upload-metadata'],encoded);
    await x.restart();
    const after=await send(x.guest(),made.headers.location,{method:'HEAD',headers:a});
    assert.equal(after.status,200);assert.equal(after.headers['upload-metadata'],encoded);
  } finally {await x.close();}
});

test('owner title/welcome and guest display-name UTF-8 bounds remain enforced at entry',async()=>{
  const x=await setup();
  try {
    const create=(title,welcome)=>send(x.config.adminSocketPath,'/api/admin/collections',{method:'POST',headers:x.admin,
      body:JSON.stringify({title,welcome})});
    assert.equal((await create('🌿'.repeat(31),'ok')).status,400);
    assert.equal((await create('A'.repeat(121),'ok')).status,400);
    assert.equal((await create('A','w'.repeat(2001))).status,400);
    const good=await create('🌿'.repeat(30),'w'.repeat(2000));assert.equal(good.status,201);
    const unlock=name=>send(x.guest(),`/api/c/${good.body.token}/unlock`,{method:'POST',headers:{Origin:publicOrigin,'Content-Type':'application/json'},
      body:JSON.stringify({key:good.body.key,displayName:name})});
    assert.equal((await unlock('🌿'.repeat(21))).status,400);
    assert.equal((await unlock('🌿'.repeat(20))).status,200);
  } finally {await x.close();}
});

test('pinned tus-js-client creates, resumes after restart and terminates an owned partial',async()=>{
  const x=await setup();
  try {
    const bytes=Buffer.alloc(8*1024*1024,0x3a);
    const c=await x.create('Client',bytes.length*2),a=await x.unlock(c,'A');
    const endpoint=()=>`${x.guest()}/uploads/${c.token}`;
    const options={endpoint:endpoint(),metadata:{filename:'client.bin',filetype:'application/octet-stream'},
      headers:a,chunkSize:4*1024*1024,retryDelays:[]};
    let firstUrl;
    await new Promise((resolve,reject)=>{
      const upload=new Upload(bytes,{...options,onUploadUrlAvailable:()=>{firstUrl=upload.url;},
        onChunkComplete:()=>{upload.abort().then(resolve,reject);},onError:reject});
      upload.start();
    });
    assert.ok(firstUrl);
    const partial=await send(x.guest(),new URL(firstUrl).pathname,{method:'HEAD',headers:a});
    assert.equal(partial.headers['upload-offset'],String(4*1024*1024));
    await x.restart();
    await new Promise((resolve,reject)=>{
      const upload=new Upload(bytes,{...options,endpoint:endpoint(),uploadUrl:`${x.guest()}${new URL(firstUrl).pathname}`,onSuccess:resolve,onError:reject});
      upload.start();
    });
    const final=await eventually(()=>send(x.guest(),new URL(firstUrl).pathname,{method:'HEAD',headers:a}),r=>r.status===200,'client completion HEAD');
    assert.equal(final.headers['upload-offset'],String(bytes.length));
    assert.equal(x.db.prepare('SELECT status FROM uploads WHERE id=?').get(new URL(firstUrl).pathname.split('/').at(-1)).status,'completed');
    const made=await send(x.guest(),`/uploads/${c.token}`,{method:'POST',headers:{...a,'Upload-Length':'10','Upload-Metadata':meta('terminate.bin')}});
    assert.equal(made.status,201);
    await Upload.terminate(new URL(made.headers.location,x.guest()).href,{headers:a,retryDelays:[]});
    assert.equal(x.db.prepare('SELECT status FROM uploads WHERE id=?').get(made.headers.location.split('/').at(-1)).status,'cancelled');
  } finally {await x.close();}
});

test('zero-byte count, allowance conflict and owned deletion',async()=>{
  const x=await setup();
  try {
    const c=await x.create('Count',1);const a=await x.unlock(c,'A');const path=`/uploads/${c.token}`;
    const create=size=>send(x.guest(),path,{method:'POST',headers:{...a,'Upload-Length':String(size),'Upload-Metadata':meta('file.txt')}});
    const first=await create(1);assert.equal(first.status,201);
    assert.equal((await create(1)).status,409);
    const id=first.headers.location.split('/').at(-1);
    assert.equal((await send(x.guest(),first.headers.location,{method:'DELETE',headers:a})).status,204);
    assert.equal((await send(x.guest(),first.headers.location,{method:'DELETE',headers:a})).status,204);
    assert.equal(x.db.prepare('SELECT status,deletion_confirmed FROM uploads WHERE id=?').get(id).status,'cancelled');
    const zero=await create(0);assert.equal(zero.status,201);
    assert.equal(x.db.prepare('SELECT status FROM uploads WHERE id=?').get(zero.headers.location.split('/').at(-1)).status,'finalizing');
  } finally {await x.close();}
});

test('failed partial creation keeps its reservation until exact absence is confirmed',async()=>{
  const x=await setup();
  try {
    const c=await x.create('Failed create',10),a=await x.unlock(c,'A');
    const actual=x.storage.submit.bind(x.storage);
    let injected=false;
    x.storage.submit=(op,args,stream,deadline)=>{
      if(op==='create'&&!injected){
        injected=true;const partials=join(x.root,'partials');mkdirSync(partials,{mode:0o700});
        writeFileSync(join(partials,`${args.id}.part`),'',{mode:0o600,flag:'wx'});
        const task=Promise.reject(Object.assign(new Error('fixture'),{code:'EACCES'}));task.settled=task;return task;
      }
      return actual(op,args,stream,deadline);
    };
    const path=`/uploads/${c.token}`;
    const headers={...a,'Upload-Length':'8','Upload-Metadata':meta('failed.txt')};
    const failed=await send(x.guest(),path,{method:'POST',headers});
    assert.equal(failed.status,503);assert.equal(failed.headers.location,undefined);
    const row=x.db.prepare("SELECT id,status,error_code FROM uploads WHERE collection_id=?").get(c.id);
    assert.equal(row.status,'creating');assert.equal(row.error_code,'STORAGE_ERROR');
    await x.restart();
    assert.equal((await send(x.guest(),path,{method:'POST',headers})).status,503);
    const remove=await send(x.guest(),`${path}/${row.id}`,{method:'DELETE',headers:a});
    assert.equal(remove.status,204);
    assert.equal(existsSync(join(x.root,'partials',`${row.id}.part`)),false);
    assert.equal(x.db.prepare('SELECT status FROM uploads WHERE id=?').get(row.id).status,'cancelled');
    assert.equal((await send(x.guest(),path,{method:'POST',headers})).status,201);
  } finally {await x.close();}
});

test('creation response failure after durable sidecar reconciles after restart without duplicate reserve',async()=>{
  const x=await setup();
  try {
    const c=await x.create('Reconcile',10),a=await x.unlock(c,'A');
    const actual=x.storage.submit.bind(x.storage);
    let injected=false;
    x.storage.submit=(op,args,stream,deadline)=>{
      if(op==='create'&&!injected){
        injected=true;
        const durable=actual(op,args,stream,deadline);
        const task=durable.then(()=>{throw Object.assign(new Error('lost response'),{code:'STORAGE_TIMEOUT'});});
        task.settled=durable;return task;
      }
      return actual(op,args,stream,deadline);
    };
    const path=`/uploads/${c.token}`;
    const result=await send(x.guest(),path,{method:'POST',headers:{...a,'Upload-Length':'8','Upload-Metadata':meta('reconcile.txt')}});
    assert.equal(result.status,503);assert.equal(result.headers.location,undefined);
    const row=x.db.prepare('SELECT id,status FROM uploads WHERE collection_id=?').get(c.id);
    assert.equal(row.status,'creating');
    assert.equal(existsSync(join(x.root,'partials',`${row.id}.json`)),true);
    await x.restart();
    const head=await send(x.guest(),`${path}/${row.id}`,{method:'HEAD',headers:a});
    assert.equal(head.status,200);assert.equal(head.headers['upload-offset'],'0');
    assert.equal(x.db.prepare('SELECT status FROM uploads WHERE id=?').get(row.id).status,'uploading');
    assert.equal(x.db.prepare('SELECT count(*) n FROM uploads').get().n,1);
  } finally {await x.close();}
});

test('failed owned deletion retains reservation and exact retry cancels once',async()=>{
  const x=await setup();
  try {
    const c=await x.create('Delete retry',20),a=await x.unlock(c,'A');
    const made=await send(x.guest(),`/uploads/${c.token}`,{method:'POST',headers:{...a,'Upload-Length':'10','Upload-Metadata':meta('delete.bin')}});
    assert.equal(made.status,201);
    const id=made.headers.location.split('/').at(-1);
    const actual=x.storage.submit.bind(x.storage);
    let injected=false;
    x.storage.submit=(op,args,stream,deadline)=>{
      if(op==='removePartial'&&!injected){injected=true;const task=Promise.reject(Object.assign(new Error('fixture'),{code:'EACCES'}));task.settled=task;return task;}
      return actual(op,args,stream,deadline);
    };
    assert.equal((await send(x.guest(),made.headers.location,{method:'DELETE',headers:a})).status,503);
    assert.equal(x.db.prepare('SELECT status FROM uploads WHERE id=?').get(id).status,'deleting');
    assert.equal(existsSync(join(x.root,'partials',`${id}.part`)),true);
    assert.equal((await send(x.guest(),made.headers.location,{method:'DELETE',headers:a})).status,204);
    assert.equal((await send(x.guest(),made.headers.location,{method:'DELETE',headers:a})).status,204);
    assert.equal(x.db.prepare('SELECT status,deletion_confirmed FROM uploads WHERE id=?').get(id).deletion_confirmed,1);
  } finally {await x.close();}
});

test('timed-out worker settlement retains upload and global claims until actual settlement',async()=>{
  const x=await setup();
  try {
    const c=await x.create('Timed',100),a=await x.unlock(c,'A');
    const path=`/uploads/${c.token}`;
    const made=await send(x.guest(),path,{method:'POST',headers:{...a,'Upload-Length':'50','Upload-Metadata':meta('timed.bin')}});
    assert.equal(made.status,201);
    const actual=x.storage.submit.bind(x.storage);
    let release,entered;
    const settled=new Promise(resolve=>{release=resolve;});
    const started=new Promise(resolve=>{entered=resolve;});
    x.storage.submit=(op,args,stream,deadline)=>{
      if(op==='write'){
        entered();
        const task=Promise.reject(Object.assign(new Error('timeout'),{code:'STORAGE_TIMEOUT'}));
        task.settled=settled;return task;
      }
      return actual(op,args,stream,deadline);
    };
    const patch=send(x.guest(),made.headers.location,{method:'PATCH',headers:{...a,'Content-Type':'application/offset+octet-stream','Upload-Offset':'0'},body:Buffer.from('x')});
    await started;const timed=await patch;assert.equal(timed.status,503);assert.equal(timed.headers['retry-after'],'2');
    assert.equal((await send(x.guest(),made.headers.location,{method:'HEAD',headers:a})).status,503);
    assert.equal((await send(x.guest(),made.headers.location,{method:'DELETE',headers:a})).status,503);
    assert.equal((await send(x.guest(),path,{method:'POST',headers:{...a,'Upload-Length':'1','Upload-Metadata':meta('other.bin')}})).status,503);
    release();await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal((await eventually(()=>send(x.guest(),made.headers.location,{method:'HEAD',headers:a}),r=>r.headers['upload-offset']==='0','timed-out settlement')).headers['upload-offset'],'0');
  } finally {await x.close();}
});

test('real interrupted PATCH rolls back and blocks same-ID DELETE until worker exit',async()=>{
  const x=await setup();
  try {
    const c=await x.create('Abort',20*1024*1024),a=await x.unlock(c,'A');
    const made=await send(x.guest(),`/uploads/${c.token}`,{method:'POST',headers:{...a,'Upload-Length':String(12*1024*1024),'Upload-Metadata':meta('abort.bin')}});
    assert.equal(made.status,201);
    const id=made.headers.location.split('/').at(-1);
    const committed=Buffer.alloc(1024*1024,0x35);
    const first=await send(x.guest(),made.headers.location,{method:'PATCH',headers:{...a,'Content-Type':'application/offset+octet-stream','Upload-Offset':'0'},body:committed});
    assert.equal(first.status,204);assert.equal(first.headers['upload-offset'],String(committed.length));
    const beforeHash=createHash('sha256').update(readFileSync(join(x.root,'partials',`${id}.part`))).digest('hex');
    const url=new URL(made.headers.location,x.guest());
    const req=request({hostname:url.hostname,port:url.port,path:url.pathname,method:'PATCH',
      headers:{...a,'Content-Type':'application/offset+octet-stream','Upload-Offset':String(committed.length),'Transfer-Encoding':'chunked'}});
    req.on('error',()=>{});
    const closed=new Promise(resolve=>req.once('close',resolve));
    req.write(Buffer.alloc(1024*1024,0x71));
    const deadline=Date.now()+3000;
    while(!x.storage.activeIds.has(id) && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(x.storage.activeIds.has(id),true);
    const competing=await send(x.guest(),made.headers.location,{method:'DELETE',headers:a});
    assert.equal(competing.status,503);
    req.destroy();await closed;
    let head;
    for(let i=0;i<100;i++){
      head=await send(x.guest(),made.headers.location,{method:'HEAD',headers:a});
      if(head.status===200)break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(head.status,200);assert.equal(head.headers['upload-offset'],String(committed.length));
    const after=readFileSync(join(x.root,'partials',`${id}.part`));
    assert.equal(after.length,committed.length);
    assert.equal(createHash('sha256').update(after).digest('hex'),beforeHash);
  } finally {await x.close();}
});

test('128 MiB direct fixture transfer resumes from worker sidecar after server restart',async()=>{
  const x=await setup();
  try {
    const total=128*1024*1024,chunk=Buffer.alloc(8*1024*1024,0x5a);
    const c=await x.create('Resume',total);const a=await x.unlock(c,'Uploader');
    const made=await send(x.guest(),`/uploads/${c.token}`,{method:'POST',headers:{...a,'Upload-Length':String(total),'Upload-Metadata':meta('large.bin')}});
    assert.equal(made.status,201);
    const path=made.headers.location,id=path.split('/').at(-1);
    const patch=async offset=>send(x.guest(),path,{method:'PATCH',headers:{...a,'Content-Type':'application/offset+octet-stream','Upload-Offset':String(offset)},body:chunk});
    for(let i=0;i<4;i++)assert.equal((await patch(i*chunk.length)).headers['upload-offset'],String((i+1)*chunk.length));
    await x.restart();
    assert.equal((await send(x.guest(),path,{method:'HEAD',headers:a})).headers['upload-offset'],String(32*1024*1024));
    for(let i=4;i<16;i++)assert.equal((await patch(i*chunk.length)).headers['upload-offset'],String((i+1)*chunk.length));
    await eventually(()=>send(x.guest(),path,{method:'HEAD',headers:a}),r=>r.status===200,'large completion HEAD');
    const row=x.db.prepare('SELECT status,storage_locator FROM uploads WHERE id=?').get(id);
    assert.equal(row.status,'completed');
    const actual=createHash('sha256').update(readFileSync(join(x.root,row.storage_locator))).digest('hex');
    const expected=createHash('sha256');for(let i=0;i<16;i++)expected.update(chunk);
    assert.equal(actual,expected.digest('hex'));
    assert.equal(existsSync(join(x.root,'completed',id)),false);
  } finally {await x.close();}
});

test('paired 16/128 MiB product-route transfers keep server plus live worker RSS bounded',async t=>{
  if(process.platform!=='linux'){t.skip('Linux /proc worker sampler runs in isolated mini-PC container');return;}
  const chunk=Buffer.alloc(8*1024*1024,0x26);
  const sample=pid=>{
    let server=0,workers=0,count=0;
    for(const name of readdirSync('/proc')){
      if(!/^\d+$/.test(name))continue;
      try{
        const stat=readFileSync(`/proc/${name}/stat`,'utf8');
        const parent=Number(stat.slice(stat.lastIndexOf(') ')+2).split(' ')[1]);
        if(Number(name)!==pid && parent!==pid)continue;
        const status=readFileSync(`/proc/${name}/status`,'utf8');
        const rss=Number(/^VmRSS:\s+(\d+) kB/m.exec(status)?.[1]||0)*1024;
        if(Number(name)===pid)server=rss;
        else {workers+=rss;count++;}
      }catch(error){if(error.code!=='ENOENT')throw error;}
    }
    return {server,workers,count,total:server+workers};
  };
  const paced=(target,path,headers,body)=>new Promise(async(resolve,reject)=>{
    const remote=new URL(target);
    const req=request({hostname:remote.hostname,port:remote.port,path,method:'PATCH',headers},res=>{
      const data=[];res.on('data',part=>data.push(part));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(data)}));
    });
    req.on('error',reject);
    try {
      for(let at=0;at<body.length;at+=65536){
        if(!req.write(body.subarray(at,at+65536)))await once(req,'drain');
        await new Promise(done=>setTimeout(done,2));
      }
      req.end();
    } catch(error){req.destroy();reject(error);}
  });
  async function measure(mib){
    const dir=realpathSync(mkdtempSync(join(tmpdir(),'bd-product-rss-')));chmodSync(dir,0o700);mkdirSync(join(dir,'nas'),{mode:0o700});
    const child=fork(new URL('./fixtures/product-upload-server.mjs',import.meta.url),[dir],{execArgv:[],stdio:['ignore','ignore','ignore','ipc']});
    let exited=false;child.once('exit',()=>{exited=true;});
    try {
      const [ready]=await once(child,'message');
      const guest=`http://127.0.0.1:${ready.guestPort}`;
      const identity={'Tailscale-User-Login':owner};
      const session=await send(ready.socket,'/api/admin/session',{headers:identity});
      const admin={...identity,Cookie:session.headers['set-cookie'][0].split(';')[0],Origin:adminOrigin,
        'X-CSRF-Token':session.body.csrfToken,'Content-Type':'application/json'};
      const created=await send(ready.socket,'/api/admin/collections',{method:'POST',headers:admin,
        body:JSON.stringify({title:`Memory ${mib}`,allowance:mib*1024*1024})});assert.equal(created.status,201);
      const unlocked=await send(guest,`/api/c/${created.body.token}/unlock`,{method:'POST',headers:{Origin:publicOrigin,'Content-Type':'application/json'},
        body:JSON.stringify({key:created.body.key,displayName:'Sampler'})});assert.equal(unlocked.status,200);
      const auth={Cookie:unlocked.headers['set-cookie'][0].split(';')[0],Origin:publicOrigin,'X-CSRF-Token':unlocked.body.csrfToken,'Tus-Resumable':'1.0.0'};
      const made=await send(guest,`/uploads/${created.body.token}`,{method:'POST',headers:{...auth,'Upload-Length':String(mib*1024*1024),'Upload-Metadata':meta('sample.bin')}});
      assert.equal(made.status,201);
      const baseline=sample(child.pid).server;
      let peak=baseline,activeSamples=0,maxWorkers=0,finalizationSamples=0,finalizing=false;
      const timer=setInterval(()=>{const point=sample(child.pid);peak=Math.max(peak,point.total);if(point.count)activeSamples++;if(finalizing&&point.count)finalizationSamples++;maxWorkers=Math.max(maxWorkers,point.count);},25);
      try {
        for(let i=0;i<mib/8;i++){
          const result=await paced(guest,made.headers.location,{...auth,'Content-Type':'application/offset+octet-stream','Upload-Offset':String(i*chunk.length)},chunk);
          assert.equal(result.status,204);
          assert.equal(result.headers['upload-offset'],String((i+1)*chunk.length));
        }
        finalizing=true;
        const id=made.headers.location.split('/').at(-1);
        await eventually(()=>send(guest,`/api/c/${created.body.token}/uploads/${id}`,{headers:auth}),r=>r.status===200&&r.body.status==='completed','sample completion');
      } finally {clearInterval(timer);}
      const id=made.headers.location.split('/').at(-1);
      const actual=createHash('sha256').update(readFileSync(join(dir,'nas','completed',created.body.id,`${id}-sample.bin`))).digest('hex');
      const expected=createHash('sha256');for(let i=0;i<mib/8;i++)expected.update(chunk);
      assert.equal(actual,expected.digest('hex'));
      assert.ok(activeSamples>0);assert.ok(finalizationSamples>0);assert.equal(maxWorkers,1);
      return {mib,baseline,peak,activeSamples,finalizationSamples,maxWorkers};
    } finally {
      if(!exited){child.send('stop');await Promise.race([once(child,'exit'),new Promise((_,reject)=>setTimeout(()=>reject(new Error(`fixture server ${child.pid} did not exit`)),5000))]);}
      if(exited)rmSync(dir,{recursive:true,force:true});
    }
  }
  const small=await measure(16),large=await measure(128);
  const increase=large.peak-small.peak;
  console.log('PRODUCT_WORKER_RSS',JSON.stringify({small,large,increase}));
  assert.ok(increase<64*1024*1024);
});
