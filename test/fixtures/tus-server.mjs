import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { Server } from '@tus/server';
import { StoragePool } from '../../src/server/storage/pool.mjs';

export const fixtureKey = 'synthetic-fixture-key';
const fixtureCollectionId = '00000000-0000-4000-8000-000000000001';
const fixtureGrantId = '00000000-0000-4000-8000-000000000002';

class FixtureStore extends EventEmitter {
  extensions = ['creation', 'termination'];
  constructor(pool) { super(); this.pool = pool; }
  hasExtension(value) { return this.extensions.includes(value); }
  getExpiration() { return 0; }
  async create(file) { await this.pool.submit('create', { id: file.id, size: file.size, metadata: file.metadata,
    collectionId: fixtureCollectionId, grantId: fixtureGrantId }); return file; }
  async write(stream, id, offset) { return (await this.pool.submit('write', { id, offset,
    collectionId: fixtureCollectionId, grantId: fixtureGrantId }, stream)).offset; }
  async getUpload(id) {
    const value = await this.pool.submit('stat', { id });
    return { ...value, sizeIsDeferred: false, storage: { type: 'fixture', path: '' } };
  }
  async remove(id) { await this.pool.submit('remove', { id }); }
}

export async function createFixtureServer({ root, fixture = true, expectedSource, port = 0 }) {
  const pool = new StoragePool({ root, fixture, expectedSource });
  const tus = new Server({
    path: '/uploads', datastore: new FixtureStore(pool), relativeLocation: true,
    allowedOrigins: () => false, maxSize: 10000000000,
    namingFunction: () => randomBytes(16).toString('hex'),
    disableTerminationForFinishedUploads: true,
    onResponseError: (_request, error) => error.code === 'OVERLENGTH' ? { status_code: 413, body: 'File too large' } : undefined,
  });
  const server = createServer((req, res) => {
    if (req.headers['x-fixture-key'] !== fixtureKey) {
      res.writeHead(403, { 'Cache-Control': 'no-store' }); res.end(); return;
    }
    if (req.url === '/health/live') {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'ok' })); return;
    }
    if (req.url === '/fixture/metrics') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ pid: process.pid, rss: process.memoryUsage().rss, ...pool.counts })); return;
    }
    if (req.url?.startsWith('/fixture/finalize/') && req.method === 'POST') {
      const id = req.url.split('/').at(-1);
      pool.submit('finalize', { id, collectionId: fixtureCollectionId, size: Number(req.headers['x-fixture-size']), originalName: 'fixture.bin' }).then(async value => {
        await pool.submit('cleanupCompletion', { id, collectionId: fixtureCollectionId, size: Number(req.headers['x-fixture-size']), originalName: 'fixture.bin', hash: value.hash, locator: value.locator });
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ completed: `${root}/${value.locator}` }));
      }, () => { res.writeHead(503); res.end(); });
      return;
    }
    if (!['POST', 'HEAD', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method)) {
      res.writeHead(403); res.end(); return;
    }
    if (req.method === 'POST' && !/^(0|[1-9]\d*)$/.test(req.headers['upload-length'] || '')) {
      res.writeHead(400); res.end(); return;
    }
    if (req.method === 'PATCH' && Number(req.headers['content-length'] || 0) > 10485760) {
      res.writeHead(413); res.end(); return;
    }
    tus.handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(503); res.end(); });
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { server, pool, url: `http://127.0.0.1:${server.address().port}` };
}
