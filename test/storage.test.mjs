import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, mkdirSync, symlinkSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { StoragePool } from '../src/server/storage/pool.mjs';

const id = 'a'.repeat(32);
const other = 'b'.repeat(32);

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bd-storage-')));
  return { root, pool: new StoragePool({ root, fixture: true }), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('bounded worker writes committed offsets and never creates fallback roots', async () => {
  const f = fixture();
  try {
    assert.equal(await f.pool.readiness(), true);
    const created = await f.pool.submit('create', { id, size: 5, metadata: { filename: '../🪷.txt' } });
    assert.equal(created.offset, 0);
    assert.equal((await f.pool.submit('write', { id, offset: 0 }, Readable.from([Buffer.from('abc')]))).offset, 3);
    assert.equal((await f.pool.submit('stat', { id })).offset, 3);
    const resumed = new StoragePool({ root: f.root, fixture: true });
    assert.equal((await resumed.submit('stat', { id })).offset, 3);
    await assert.rejects(resumed.submit('write', { id, offset: 0 }, Readable.from([Buffer.from('x')])), /OFFSET_CONFLICT/);
    assert.equal((await resumed.submit('write', { id, offset: 3 }, Readable.from([Buffer.from('de')]))).offset, 5);
    assert.equal(readFileSync(join(f.root, 'partials', `${id}.part`), 'utf8'), 'abcde');
    await assert.rejects(resumed.submit('remove', { id }), /COMPLETED/);
    const collectionId='11111111-1111-1111-1111-111111111111';
    const result=await resumed.submit('finalize', { id, collectionId, size:5, originalName:'../🪷.txt' });
    assert.match(result.locator,new RegExp(`^completed/${collectionId}/${id}-`));
    assert.equal(readFileSync(join(f.root, result.locator), 'utf8'), 'abcde');
    assert.ok(!existsSync(join(f.root, '🪷.txt')));
    await resumed.submit('create', { id: other, size: 2 });
    await assert.rejects(resumed.submit('create', { id: other, size: 2 }), /EEXIST/);
    await assert.rejects(resumed.submit('write', { id: other, offset: 0 }, Readable.from([Buffer.from('too long')])), /OVERLENGTH/);
    assert.equal((await resumed.submit('stat', { id: other })).offset, 0);
    await assert.rejects(resumed.submit('create', { id: '../x', size: 1 }), /INVALID_ID/);
    assert.equal((await resumed.submit('probe')).freeBytes > 0, true);
    const missing = join(f.root, 'missing');
    await assert.rejects(new StoragePool({ root: missing, fixture: true }).submit('create', { id: other, size: 1 }), /ENOENT/);
    assert.equal(existsSync(missing), false);
    await assert.rejects(new StoragePool({ root: f.root, expectedSource: 'wrong' }).submit('probe'), /ENOENT|WRONG_MOUNT/);
  } finally { f.cleanup(); }
});

test('symlink roots, parents and payloads are rejected', async () => {
  const f = fixture();
  const external = realpathSync(mkdtempSync(join(tmpdir(), 'bd-outside-')));
  try {
    const link = join(external, 'root-link');
    symlinkSync(f.root, link);
    await assert.rejects(new StoragePool({ root: link, fixture: true }).submit('probe'), /WRONG_MOUNT/);
    symlinkSync(external, join(f.root, 'partials'));
    await assert.rejects(f.pool.submit('create', { id, size: 1 }), /UNSAFE_PATH/);
    rmSync(join(f.root, 'partials'));
    await f.pool.submit('create', { id, size: 1 });
    const payload = join(f.root, 'partials', `${id}.part`);
    rmSync(payload);
    writeFileSync(join(external, 'outside'), 'safe');
    symlinkSync(join(external, 'outside'), payload);
    await assert.rejects(f.pool.submit('stat', { id }), /UNSAFE_PATH/);
    assert.equal(readFileSync(join(external, 'outside'), 'utf8'), 'safe');
  } finally { f.cleanup(); rmSync(external, { recursive: true, force: true }); }
});

test('active/queue limits retain timed-out worker slots; fixture errors stay distinct', async () => {
  const f = fixture();
  const pool = new StoragePool({ root: f.root, fixture: true, maxActive: 2, maxPending: 2 });
  try {
    const jobs = Array.from({ length: 4 }, () => pool.submit('delay', { ms: 150 }));
    assert.deepEqual(pool.counts, { active: 2, pending: 2 });
    assert.throws(() => pool.submit('delay', { ms: 1 }), /BUSY/);
    await Promise.all(jobs);
    assert.deepEqual(pool.counts, { active: 0, pending: 0 });
    const sameId = Array.from({ length: 3 }, () => pool.submit('delay', { id, ms: 50 }));
    assert.deepEqual(pool.counts, { active: 1, pending: 2 });
    assert.throws(() => pool.submit('delay', { id, ms: 1 }), /BUSY/);
    await Promise.all(sameId);
    await assert.rejects(pool.submit('delay', { ms: 150 }, undefined, 10), /STORAGE_TIMEOUT/);
    assert.equal(pool.counts.active, 1);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(pool.counts.active, 0);
    await assert.rejects(pool.submit('fail', { code: 'EACCES' }), /EACCES/);
    await assert.rejects(pool.submit('fail', { code: 'ENOSPC' }), /ENOSPC/);
  } finally { f.cleanup(); }
});

test('aborted input rolls back bytes and releases the worker before the next write', async () => {
  const f = fixture();
  try {
    await f.pool.submit('create', { id, size: 6 });
    async function* broken() {
      yield Buffer.from('abc');
      throw new Error('input broke');
    }
    await assert.rejects(f.pool.submit('write', { id, offset: 0 }, broken()), /input broke/);
    assert.deepEqual(f.pool.counts, { active: 0, pending: 0 });
    assert.equal((await f.pool.submit('stat', { id })).offset, 0);
    assert.equal(readFileSync(join(f.root, 'partials', `${id}.part`)).length, 0);
    assert.equal((await f.pool.submit('write', { id, offset: 0 }, Readable.from([Buffer.from('abcdef')]))).offset, 6);
  } finally { f.cleanup(); }
});
