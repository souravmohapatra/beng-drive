// Disposable test-only product server process for a published-before-DB crash.
import { configFrom } from '../../src/server/config.mjs';
import { openDatabase } from '../../src/server/db.mjs';
import { startServers } from '../../src/server/http.mjs';
import { StoragePool } from '../../src/server/storage/pool.mjs';

const [root, databasePath, adminSocketPath, mode] = process.argv.slice(2);
if (!['crash','recover'].includes(mode)) throw new Error('Invalid fixture mode');
const config=configFrom({APP_MODE:'fixture',ADMIN_OWNER_LOGIN:'owner@example.invalid',ADMIN_SOCKET_PATH:adminSocketPath,
  DB_PATH:databasePath,PUBLIC_ORIGIN:'https://drive.example.invalid',ADMIN_ORIGIN:'https://admin.example.invalid',FREE_SPACE_FLOOR_BYTES:'1'});
const db=openDatabase(databasePath);
const storage=new StoragePool({root,fixture:true,expectedSource:''});
if(mode==='crash') {
  const submit=storage.submit.bind(storage);
  storage.submit=(op,args,stream,deadline)=>{
    if(op!=='finalize')return submit(op,args,stream,deadline);
    const task=submit(op,args,stream,deadline);
    const published=task.then(()=>process.exit(91));
    published.settled=task.settled;
    return published;
  };
}
const servers=await startServers(config,[0,0],storage,db);
process.send?.({type:'ready',url:`http://127.0.0.1:${servers[0].address().port}`});
process.on('message',async message=>{
  if(message?.type!=='stop')return;
  await Promise.all(servers.map(server=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})));db.close();
  process.exit(0);
});
