import { join } from 'node:path';
import { configFrom } from '../../src/server/config.mjs';
import { openDatabase } from '../../src/server/db.mjs';
import { StoragePool } from '../../src/server/storage/pool.mjs';
import { startServers } from '../../src/server/http.mjs';

const dir = process.argv[2];
if (!dir || !['/private/var/folders/','/private/tmp/','/tmp/bd-product-rss-'].some(prefix => dir.startsWith(prefix))) throw new Error('Fixture directory required');
const config = configFrom({ APP_MODE: 'fixture', ADMIN_OWNER_LOGIN: 'owner@example.invalid',
  ADMIN_SOCKET_PATH: join(dir, 'admin.sock'), DB_PATH: join(dir, 'app.sqlite'),
  PUBLIC_ORIGIN: 'https://drive.example.invalid', ADMIN_ORIGIN: 'https://admin.example.invalid',
  FREE_SPACE_FLOOR_BYTES: '1' });
const db = openDatabase(config.dbPath);
db.exec("UPDATE intake_window SET closes_at='9999-12-31T23:59:59.999Z' WHERE id=1");
const storage = new StoragePool({ root: join(dir, 'nas'), fixture: true, expectedSource: '' });
const servers = await startServers(config, [0, 0], storage, db);
process.send({ guestPort: servers[0].address().port, socket: config.adminSocketPath });
process.on('message', async message => {
  if (message !== 'stop') return;
  await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
  db.close();
  process.disconnect();
});
