import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureKey, createFixtureServer } from './fixtures/tus-server.mjs';

test('fixture-only tus HTTP creation, committed HEAD and resumed PATCH', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bd-tus-')));
  const { server, url } = await createFixtureServer({ root });
  const headers = { 'Tus-Resumable': '1.0.0', 'X-Fixture-Key': fixtureKey };
  try {
    let response = await fetch(`${url}/uploads`, { method: 'POST', headers: { ...headers, 'Upload-Length': '5', 'Upload-Metadata': `filename ${Buffer.from('../🪷.txt').toString('base64')}` } });
    assert.equal(response.status, 201);
    const location = response.headers.get('location');
    assert.match(location, /^\/uploads\/[0-9a-f]{32}$/);
    response = await fetch(`${url}${location}`, { method: 'HEAD', headers });
    assert.equal(response.headers.get('upload-offset'), '0');
    response = await fetch(`${url}${location}`, { method: 'PATCH', headers: { ...headers, 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' }, body: 'abc' });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('upload-offset'), '3');
    response = await fetch(`${url}${location}`, { method: 'HEAD', headers });
    assert.equal(response.headers.get('upload-offset'), '3');
    response = await fetch(`${url}${location}`, { method: 'PATCH', headers: { ...headers, 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' }, body: 'x' });
    assert.equal(response.status, 409);
    response = await fetch(`${url}${location}`, { method: 'PATCH', headers: { ...headers, 'Upload-Offset': '3', 'Content-Type': 'application/offset+octet-stream' }, body: 'de' });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('upload-offset'), '5');
    assert.equal(readFileSync(join(root, 'partials', `${location.split('/').at(-1)}.part`), 'utf8'), 'abcde');
    response = await fetch(`${url}${location}`, { method: 'HEAD', headers: { 'Tus-Resumable': '1.0.0' } });
    assert.equal(response.status, 403);
    response = await fetch(`${url}${location}`, { method: 'GET', headers });
    assert.equal(response.status, 403);
    response = await fetch(`${url}/uploads`, { method: 'POST', headers: { ...headers, 'Upload-Length': '0' } });
    assert.equal(response.status, 201);
    const zero = response.headers.get('location');
    response = await fetch(`${url}${zero}`, { method: 'HEAD', headers });
    assert.equal(response.headers.get('upload-offset'), '0');
    assert.equal(response.headers.get('upload-length'), '0');
    response = await fetch(`${url}/uploads`, { method: 'POST', headers: { ...headers, 'Upload-Length': '2' } });
    const short = response.headers.get('location');
    const streamed = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); } });
    response = await fetch(`${url}${short}`, { method: 'PATCH', headers: { ...headers, 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' }, body: streamed, duplex: 'half' });
    assert.notEqual(response.status, 204);
    response = await fetch(`${url}${short}`, { method: 'HEAD', headers });
    assert.equal(response.headers.get('upload-offset'), '0');
    response = await fetch(`${url}/uploads`, { method: 'POST', headers: { ...headers, 'Upload-Length': '10485761' } });
    const oversized = response.headers.get('location');
    let sent = 0;
    const body = new ReadableStream({ pull(controller) {
      const size = Math.min(65536, 10485761 - sent);
      controller.enqueue(new Uint8Array(size));
      sent += size;
      if (sent === 10485761) controller.close();
    } });
    response = await fetch(`${url}${oversized}`, { method: 'PATCH', headers: { ...headers, 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' }, body, duplex: 'half' });
    assert.equal(response.status, 413);
    response = await fetch(`${url}${oversized}`, { method: 'HEAD', headers });
    assert.equal(response.headers.get('upload-offset'), '0');
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
