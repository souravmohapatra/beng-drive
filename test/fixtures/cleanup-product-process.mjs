// Disposable product process: exits after worker deletion, before SQLite cancellation.
import { configFrom } from '../../src/server/config.mjs';
import { openDatabase } from '../../src/server/db.mjs';
import { startServers } from '../../src/server/http.mjs';
import { StoragePool } from '../../src/server/storage/pool.mjs';

const [root, databasePath, adminSocketPath, mode] = process.argv.slice(2);
if (!['crash', 'recover'].includes(mode)) throw new Error('Invalid fixture mode');
const config = configFrom({ APP_MODE: 'fixture', ADMIN_OWNER_LOGIN: 'owner@example.invalid',
  ADMIN_SOCKET_PATH: adminSocketPath, DB_PATH: databasePath, PUBLIC_ORIGIN: 'https://drive.example.invalid',
  ADMIN_ORIGIN: 'https://admin.example.invalid', FREE_SPACE_FLOOR_BYTES: '1' });
const db = openDatabase(databasePath);
const storage = new StoragePool({ root, fixture: true, expectedSource: '' });
if (mode === 'crash') {
  const original = storage.submit.bind(storage);
  storage.submit = (op, args, stream, deadline) => {
    if (op !== 'removePartial' || args.prepare) return original(op, args, stream, deadline);
    const task = original(op, args, stream, deadline);
    const crash = task.then(() => process.exit(91));
    crash.settled = task.settled;
    return crash;
  };
}
let cleanup;
const servers = await startServers(config, [0, 0], storage, db,
  { onCleanupReady: run => { cleanup = run; } });
process.send?.({ type: 'ready', url: `http://127.0.0.1:${servers[0].address().port}` });
process.on('message', async message => {
  if (message?.type === 'cleanup') {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await cleanup()) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  if (message?.type === 'stop') {
    await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
    db.close(); process.exit(0);
  }
});
