import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configFrom } from '../src/server/config.mjs';
import { reclaimStaleAdminSocket, startServers } from '../src/server/http.mjs';

async function fixture(run) {
  const dir=mkdtempSync(join(tmpdir(),'bd-socket-'));chmodSync(dir,0o700);
  const path=join(dir,'admin.sock');
  const config=configFrom({APP_MODE:'fixture',ADMIN_OWNER_LOGIN:'owner@example.invalid',ADMIN_SOCKET_PATH:path,
    DB_PATH:join(dir,'app.sqlite'),PUBLIC_ORIGIN:'https://drive.example.invalid',ADMIN_ORIGIN:'https://admin.example.invalid'});
  try { await run({dir,path,config}); }
  finally { rmSync(dir,{recursive:true,force:true}); }
}
async function listen(path) {
  const server=createServer(connection=>connection.end());
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(path,resolve);});
  chmodSync(path,0o600);
  return server;
}
const close=server=>new Promise(resolve=>server.close(resolve));
const connect=path=>new Promise((resolve,reject)=>{
  const connection=createConnection({path});
  connection.once('connect',()=>{connection.destroy();resolve();});
  connection.once('error',reject);
});

test('startup preserves a live private admin listener and its inode',async()=>fixture(async({path,config})=>{
  const live=await listen(path);
  try {
    const before=lstatSync(path);
    await assert.rejects(startServers(config,[0,0]),/Admin socket already active/);
    const after=lstatSync(path);
    assert.equal(after.dev,before.dev);assert.equal(after.ino,before.ino);
    await connect(path);
  } finally {await close(live);}
}));

test('startup rejects regular, symlink, wrong-mode socket and a concurrent startup lock',async()=>{
  await fixture(async({dir,path,config})=>{
    writeFileSync(path,'foreign artifact',{mode:0o600});
    const before=lstatSync(path);
    await assert.rejects(startServers(config,[0,0]),/Unsafe admin socket/);
    assert.equal(lstatSync(path).ino,before.ino);
  });
  await fixture(async({dir,path,config})=>{
    writeFileSync(join(dir,'target'),'untouched');symlinkSync(join(dir,'target'),path);
    await assert.rejects(startServers(config,[0,0]),/Unsafe admin socket/);
    assert.ok(lstatSync(path).isSymbolicLink());
  });
  await fixture(async({path,config})=>{
    const server=await listen(path);
    try {
      chmodSync(path,0o644);
      const inode=lstatSync(path).ino;
      await assert.rejects(startServers(config,[0,0]),/Unsafe admin socket/);
      assert.equal(lstatSync(path).ino,inode);
    } finally {await close(server);}
  });
  await fixture(async({path,config})=>{
    const lock=`${path}.startup-lock`;writeFileSync(lock,'busy',{mode:0o600});
    await assert.rejects(startServers(config,[0,0]),/EEXIST/);
    assert.equal(lstatSync(lock).mode&0o777,0o600);
  });
  await fixture(async({dir,config})=>{
    chmodSync(dir,0o755);
    await assert.rejects(startServers(config,[0,0]),/Invalid admin socket directory/);
  });
});

test('uncertain probe and changed socket identity fail closed without unlink',async()=>{
  await fixture(async({path})=>{
    const server=await listen(path);
    try {
      const before=lstatSync(path);
      await assert.rejects(reclaimStaleAdminSocket(path,async()=>{throw new Error('fixture EIO');}),/fixture EIO/);
      assert.equal(lstatSync(path).ino,before.ino);await connect(path);
    } finally {await close(server);}
  });
  await fixture(async({path})=>{
    let server=await listen(path);
    try {
      const before=lstatSync(path);
      await assert.rejects(reclaimStaleAdminSocket(path,async()=>{
        await close(server);server=await listen(path);return true;
      }),/changed during probe/);
      assert.notEqual(lstatSync(path).ino,before.ino);
      await connect(path);
    } finally {await close(server);}
  });
});
