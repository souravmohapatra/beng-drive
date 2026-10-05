import { configFrom } from './config.mjs';
import { openDatabase } from './db.mjs';
import { startServers } from './http.mjs';
import { StoragePool } from './storage/pool.mjs';

let db;
let servers;
try {
  const config = configFrom();
  db = openDatabase(config.dbPath);
  const storage = new StoragePool({ root: '/data', expectedSource: '192.168.68.67:/volume3/workspace/beng-drive' });
  servers = await startServers(config, undefined, storage, db);
  console.info(JSON.stringify({ event: 'started', guestPort: config.guestPort, adminTransport: config.adminSocketPath ? 'unix' : 'fixture_tcp' }));
} catch (error) {
  console.error(JSON.stringify({ event: 'startup_failed', ...(error.setting ? { setting: error.setting } : {}) }));
  process.exitCode = 1;
  if (db) db.close();
}

if (servers) {
  const stop = async () => {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    db.close();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
