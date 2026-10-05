// Full disposable product process for a worker-commit-before-SQLite crash.
import { configFrom } from '../../src/server/config.mjs';
import { openDatabase } from '../../src/server/db.mjs';
import { startServers } from '../../src/server/http.mjs';
import { StoragePool } from '../../src/server/storage/pool.mjs';

const [root, databasePath, adminSocketPath, mode, clockValue] = process.argv.slice(2);
if (!['crash-write', 'recover'].includes(mode) || !Number.isSafeInteger(Number(clockValue))) throw new Error('Invalid fixture');
const config = configFrom({ APP_MODE: 'fixture', ADMIN_OWNER_LOGIN: 'owner@example.invalid',
  ADMIN_SOCKET_PATH: adminSocketPath, DB_PATH: databasePath, PUBLIC_ORIGIN: 'https://drive.example.invalid',
  ADMIN_ORIGIN: 'https://admin.example.invalid', FREE_SPACE_FLOOR_BYTES: '1' });
const db = openDatabase(databasePath);
const storage = new StoragePool({ root, fixture: true, expectedSource: '' });
if (mode === 'crash-write') {
  const original = storage.submit.bind(storage);
  storage.submit = (op, args, stream, deadline) => {
    const task = original(op, args, stream, deadline);
    if (op !== 'write') return task;
    const crash = task.then(() => process.exit(91));
    crash.settled = task.settled;
    return crash;
  };
}
let cleanup;
const servers = await startServers(config, [0, 0], storage, db,
  { cleanupClock: () => Number(clockValue), onCleanupReady: run => { cleanup = run; } });
process.send?.({ type: 'ready', url: `http://127.0.0.1:${servers[0].address().port}` });
process.on('message', async message => {
  if (message?.type === 'cleanup') process.send?.({ type: 'cleanup', result: await cleanup() });
  if (message?.type === 'stop') {
    await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
    db.close(); process.exit(0);
  }
});
