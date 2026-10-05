import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const root = process.env.STORAGE_ROOT;
const expectedSource = process.env.STORAGE_EXPECTED_SOURCE;
const fixture = process.env.STORAGE_FIXTURE === '1';
const ids = /^[0-9a-f]{32}$/;
const collections = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const grants = collections;
let writing;

function owner(args) {
  if (fixture && args.collectionId === undefined && args.grantId === undefined) return undefined;
  if (!collections.test(args.collectionId) || !grants.test(args.grantId)) throw new Error('INVALID_ID');
  return { collectionId: args.collectionId, grantId: args.grantId };
}
function committedAt(args) {
  const offset = args.clockOffsetMs === undefined ? 0 : args.clockOffsetMs;
  if (!Number.isSafeInteger(offset) || Math.abs(offset) > 366 * 86400000 ||
      (!fixture && offset !== 0)) throw new Error('INVALID_TIME');
  const value = Date.now() + offset;
  if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000) throw new Error('INVALID_TIME');
  return new Date(value).toISOString();
}

function validId(id) {
  if (!ids.test(id)) throw new Error('INVALID_ID');
  return id;
}
async function verify() {
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await fs.realpath(root) !== root) throw new Error('WRONG_MOUNT');
  if (!fixture) {
    if (rootStat.uid !== 1000 || (rootStat.mode & 0o777) !== 0o700) throw new Error('WRONG_MOUNT');
    const mounts = await fs.readFile('/proc/self/mountinfo', 'utf8');
    const line = mounts.split('\n').find(part => part.split(' - ')[0]?.split(' ')[4] === root);
    if (!line) throw new Error('WRONG_MOUNT');
    const [type, source] = line.split(' - ')[1]?.split(' ') || [];
    if (type !== 'nfs' || source !== expectedSource) throw new Error('WRONG_MOUNT');
    const stats = await fs.statfs(root);
    if (stats.type !== 0x6969) throw new Error('WRONG_MOUNT');
  }
  return rootStat;
}
async function paths(id) {
  validId(id);
  await verify();
  const dir = join(root, 'partials');
  const info = await fs.lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || (!fixture && info.uid !== 1000) || (info.mode & 0o777) !== 0o700) throw new Error('UNSAFE_PATH');
  return { dir, payload: join(dir, `${id}.part`), sidecar: join(dir, `${id}.json`) };
}
async function sidecar(path) {
  const st = await regular(path);
  if (st.nlink !== 1) throw new Error('UNSAFE_PATH');
  return JSON.parse(await fs.readFile(path, 'utf8'));
}
async function syncDirectory(dir) {
  const handle = await fs.open(dir, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function saveSidecar(path, value, dir) {
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const file = await fs.open(temp, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
  finally { await file.close(); }
  await fs.rename(temp, path);
  await syncDirectory(dir);
}
function basename(name) {
  if (typeof name !== 'string' || !name || Buffer.byteLength(name) > 255) throw new Error('UNSAFE_PATH');
  let clean = '';
  for (const c of name.normalize('NFC')) {
    const part = /[\\/\x00-\x1f\x7f-\x9f]/u.test(c) ? '_' : c;
    if (Buffer.byteLength(clean + part) > 160) break;
    clean += part;
  }
  if (!clean || clean === '.' || clean === '..') clean = 'file';
  return clean;
}
async function ownedDir(path, parent) {
  let made = false;
  try { await fs.mkdir(path, { mode: 0o700 }); made = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const st = await fs.lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o777) !== 0o700) throw new Error('UNSAFE_PATH');
  if (made) await syncDirectory(parent);
}
async function regular(path) {
  const st = await fs.lstat(path);
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o777) !== 0o600) throw new Error('UNSAFE_PATH');
  return st;
}
async function maybeRegular(path) {
  try { return await regular(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function hashFile(path, expectedSize) {
  const st = await regular(path);
  if (st.size !== expectedSize) throw new Error('UNSAFE_PARTIAL');
  const file = await fs.open(path, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(65536);
  try {
    for (let at = 0; at < expectedSize;) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, expectedSize - at), at);
      if (!bytesRead) throw new Error('SHORT_READ');
      hash.update(buffer.subarray(0, bytesRead));
      at += bytesRead;
    }
  } finally { await file.close(); }
  return hash.digest('hex');
}
function fault(args, point) {
  if (!fixture) return;
  if (args.fault === point) process.exit(91);
  if (args.failure?.point === point && ['EACCES','ENOSPC','EIO','ENOTSUP','EXDEV'].includes(args.failure.code)) {
    const error = new Error(args.failure.code); error.code = args.failure.code; throw error;
  }
}
async function complete(args) {
  validId(args.id);
  if (!collections.test(args.collectionId) || !Number.isSafeInteger(args.size) || args.size < 0 || args.size > 10000000000) throw new Error('INVALID_ID');
  const { dir, payload, sidecar: infoPath } = await paths(args.id);
  const info = await sidecar(infoPath);
  if (info.id !== args.id || info.size !== args.size || info.offset !== info.size || info.metadata?.filename !== args.originalName) throw new Error('UNSAFE_PARTIAL');
  const completed = join(root, 'completed');
  const collectionDir = join(completed, args.collectionId);
  const name = `${args.id}-${basename(info.metadata.filename)}`;
  const locator = `completed/${args.collectionId}/${name}`;
  const destination = join(collectionDir, name);
  let partialStat = await maybeRegular(payload);
  if (!info.prepared) {
    if (!partialStat) throw new Error('UNSAFE_PARTIAL');
    if (partialStat.size > info.size) {
      const extra = await fs.open(payload, 'r+');
      try { await extra.truncate(info.size); await extra.sync(); } finally { await extra.close(); }
      partialStat = await regular(payload);
    }
    if (partialStat.size !== info.size) throw new Error('INCOMPLETE');
    const file = await fs.open(payload, 'r+');
    try { await file.sync(); fault(args, 'after_payload_fsync'); } finally { await file.close(); }
    fault(args, 'after_payload_close');
    const hash = await hashFile(payload, info.size);
    info.prepared = { version: 1, id: args.id, collectionId: args.collectionId, size: info.size, locator, sha256: hash };
    await saveSidecar(infoPath, info, dir);
    fault(args, 'after_evidence');
  }
  const evidence = info.prepared;
  if (evidence.version !== 1 || evidence.id !== args.id || evidence.collectionId !== args.collectionId || evidence.size !== info.size || evidence.locator !== locator || !/^[0-9a-f]{64}$/.test(evidence.sha256)) throw new Error('UNSAFE_EVIDENCE');
  await ownedDir(completed, root);
  await ownedDir(collectionDir, completed);
  let finalStat = await maybeRegular(destination);
  if (finalStat && partialStat && (finalStat.dev !== partialStat.dev || finalStat.ino !== partialStat.ino)) throw new Error('FINAL_CONFLICT');
  if (!finalStat) {
    if (!partialStat) throw new Error('UNSAFE_PARTIAL');
    fault(args, 'before_link');
    if (fixture && args.raceDestination) await fs.writeFile(destination, 'competing fixture', { flag: 'wx', mode: 0o600 });
    await fs.link(payload, destination);
    fault(args, 'after_link');
    finalStat = await regular(destination);
  }
  if (finalStat.size !== info.size || await hashFile(destination, info.size) !== evidence.sha256) throw new Error('FINAL_CONFLICT');
  await syncDirectory(collectionDir);
  fault(args, 'after_destination_fsync');
  if (partialStat) {
    const currentPartial = await regular(payload);
    if (currentPartial.dev !== finalStat.dev || currentPartial.ino !== finalStat.ino) throw new Error('FINAL_CONFLICT');
    await fs.unlink(payload);
    fault(args, 'after_partial_unlink');
  }
  await syncDirectory(dir);
  fault(args, 'after_source_fsync');
  if (await hashFile(destination, info.size) !== evidence.sha256) throw new Error('FINAL_CONFLICT');
  return { locator, hash: evidence.sha256, metadata: info.metadata };
}
async function current(id) {
  const { dir, payload, sidecar: infoPath } = await paths(id);
  const info = await sidecar(infoPath);
  const st = await regular(payload);
  if (st.nlink !== 1) throw new Error('UNSAFE_PATH');
  if (st.size < info.offset) throw new Error('UNSAFE_PARTIAL');
  if (st.size > info.offset) {
    const file = await fs.open(payload, 'r+');
    try { await file.truncate(info.offset); await file.sync(); }
    finally { await file.close(); }
  }
  return { dir, payload, infoPath, info };
}
async function inspectPartial(id) {
  let scoped;
  try { scoped = await paths(id); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await verify();
    return { exists: false };
  }
  const { dir, payload, sidecar: infoPath } = scoped;
  const check = async path => {
    try {
      const st = await fs.lstat(path);
      if (!st.isFile() || st.isSymbolicLink()) throw new Error('UNSAFE_PATH');
      return true;
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  const payloadExists = await check(payload);
  const sidecarExists = await check(infoPath);
  return { dir, payload, infoPath, exists: payloadExists || sidecarExists, payloadExists, sidecarExists };
}
async function action(op, args) {
  await verify();
  if (op === 'probe') {
    const s = await fs.statfs(root);
    return { freeBytes: s.bavail * s.bsize };
  }
  if (op === 'create') {
    validId(args.id);
    if (!Number.isSafeInteger(args.size) || args.size < 0 || args.size > 10000000000) throw new Error('INVALID_LENGTH');
    const identity = owner(args);
    fault(args, 'before_create');
    const dir = join(root, 'partials');
    try { await fs.mkdir(dir, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const dirStat = await fs.lstat(dir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || (!fixture && dirStat.uid !== 1000) || (dirStat.mode & 0o777) !== 0o700) throw new Error('UNSAFE_PATH');
    await syncDirectory(root);
    const payload = join(dir, `${args.id}.part`);
    const file = await fs.open(payload, 'wx', 0o600);
    try { await file.sync(); } finally { await file.close(); }
    fault(args, 'after_create_payload');
    const activityAt = committedAt(args);
    await saveSidecar(join(dir, `${args.id}.json`), { id: args.id, size: args.size, offset: 0,
      metadata: args.metadata || {}, owner: identity,
      activity: { version: 1, offset: 0, at: activityAt } }, dir);
    fault(args, 'after_create_sidecar');
    return { id: args.id, size: args.size, offset: 0, activityAt };
  }
  if (op === 'stat') return (await current(args.id)).info;
  if (op === 'inspect') {
    const state = await inspectPartial(args.id);
    if (!state.exists) return { exists: false };
    if (!state.payloadExists || !state.sidecarExists) throw new Error('UNSAFE_PARTIAL');
    return { exists: true, info: (await current(args.id)).info };
  }
  if (op === 'removePartial') {
    validId(args.id);
    if (!collections.test(args.collectionId) || !grants.test(args.grantId) || !Number.isSafeInteger(args.size) || args.size < 0 ||
      typeof args.originalName !== 'string' || !args.originalName) throw new Error('INVALID_ID');
    const state = await inspectPartial(args.id);
    if (!state.exists) return { absent: true };
    const completedDir = join(root, 'completed');
    const collectionDir = join(completedDir, args.collectionId);
    for (const dir of [completedDir, collectionDir]) {
      let st;
      try { st = await fs.lstat(dir); }
      catch (error) { if (error.code !== 'ENOENT') throw error; break; }
      if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o777) !== 0o700)
        throw new Error('UNSAFE_PATH');
    }
    const destination = join(collectionDir, `${args.id}-${basename(args.originalName)}`);
    let final;
    try { final = await fs.lstat(destination); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (final) throw new Error('FINAL_CONFLICT');
    if (!state.sidecarExists) {
      if (!args.allowEmptyOrphan || !state.payloadExists) throw new Error('UNSAFE_PARTIAL');
      const st = await fs.lstat(state.payload);
      if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || st.size !== 0 || st.nlink !== 1 || (st.mode & 0o777) !== 0o600) throw new Error('UNSAFE_PARTIAL');
      if (args.prepare) return { ready: true };
      await fs.unlink(state.payload);
      await syncDirectory(state.dir);
      return { absent: true };
    }
    const info = await sidecar(state.infoPath);
    const sidecarStat = await regular(state.infoPath);
    if (sidecarStat.nlink !== 1 || info.id !== args.id || info.size !== args.size || info.metadata?.filename !== args.originalName ||
      info.prepared || !Number.isSafeInteger(info.offset) || info.offset < 0 || info.offset > info.size) throw new Error('UNSAFE_PARTIAL');
    if (info.owner && (info.owner.collectionId !== args.collectionId || info.owner.grantId !== args.grantId)) throw new Error('UNSAFE_PARTIAL');
    if (info.deleting && (info.deleting.id !== args.id || info.deleting.collectionId !== args.collectionId ||
      info.deleting.size !== args.size || info.deleting.originalName !== args.originalName)) throw new Error('UNSAFE_PARTIAL');
    let payloadStat;
    if (state.payloadExists) {
      payloadStat = await regular(state.payload);
      if (payloadStat.nlink !== 1 || payloadStat.size < info.offset || payloadStat.size > info.size + 10485760) throw new Error('UNSAFE_PARTIAL');
    } else if (!info.deleting || info.deleting.id !== args.id || info.deleting.collectionId !== args.collectionId ||
      info.deleting.size !== args.size || info.deleting.originalName !== args.originalName) throw new Error('UNSAFE_PARTIAL');
    if (state.payloadExists && !info.deleting) await saveSidecar(state.infoPath, { ...info,
      deleting: { id: args.id, collectionId: args.collectionId, size: args.size, originalName: args.originalName } }, state.dir);
    if (args.prepare) return { ready: true };
    if (state.payloadExists) {
      try { await fs.lstat(destination); throw new Error('FINAL_CONFLICT'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const currentPayload = await regular(state.payload);
      if (currentPayload.dev !== payloadStat.dev || currentPayload.ino !== payloadStat.ino || currentPayload.nlink !== 1) throw new Error('UNSAFE_PARTIAL');
      await fs.unlink(state.payload); fault(args, 'after_remove_payload');
    }
    await fs.unlink(state.infoPath);
    fault(args, 'after_remove_sidecar');
    await syncDirectory(state.dir);
    return { absent: true };
  }
  if (op === 'remove') {
    const { dir, payload, infoPath, info } = await current(args.id);
    if (info.offset === info.size) throw new Error('COMPLETED');
    await fs.unlink(payload); await fs.unlink(infoPath); await syncDirectory(dir);
    return {};
  }
  if (op === 'finalize') {
    return complete(args);
  }
  if (op === 'cleanupCompletion') {
    validId(args.id);
    if (!collections.test(args.collectionId) || !/^[0-9a-f]{64}$/.test(args.hash)) throw new Error('INVALID_ID');
    const { dir, payload, sidecar: infoPath } = await paths(args.id);
    const completed = join(root, 'completed');
    const collectionDir = join(completed, args.collectionId);
    const name = `${args.id}-${basename(args.originalName)}`;
    if (args.locator !== `completed/${args.collectionId}/${name}`) throw new Error('UNSAFE_EVIDENCE');
    await ownedDir(completed, root);
    await ownedDir(collectionDir, completed);
    const destination = join(collectionDir, name);
    if (await hashFile(destination, args.size) !== args.hash) throw new Error('FINAL_CONFLICT');
    const partial = await maybeRegular(payload);
    if (partial) throw new Error('FINAL_CONFLICT');
    let info;
    try { info = await sidecar(infoPath); }
    catch (error) { if (error.code === 'ENOENT') return { cleaned: true }; throw error; }
    if (info.prepared?.sha256 !== args.hash || info.prepared?.locator !== args.locator || info.id !== args.id) throw new Error('UNSAFE_EVIDENCE');
    await fs.unlink(infoPath);
    fault(args, 'after_sidecar_unlink');
    await syncDirectory(dir);
    return { cleaned: true };
  }
  if (op === 'beginWrite') {
    const state = await current(args.id);
    if (state.info.offset !== args.offset) throw new Error('OFFSET_CONFLICT');
    const identity = owner(args);
    if (state.info.owner && (!identity || state.info.owner.collectionId !== identity.collectionId ||
      state.info.owner.grantId !== identity.grantId)) throw new Error('UNSAFE_PARTIAL');
    committedAt(args); // Validate internal clock offset before the first payload byte.
    const file = await fs.open(state.payload, 'r+');
    writing = { ...state, file, written: 0, owner: identity, clockOffsetMs: args.clockOffsetMs };
    return { ready: true };
  }
  if (fixture && op === 'delay') {
    await new Promise(resolve => setTimeout(resolve, args.ms));
    return {};
  }
  if (fixture && op === 'fail' && ['EACCES', 'ENOSPC'].includes(args.code)) {
    const error = new Error(args.code);
    error.code = args.code;
    throw error;
  }
  throw new Error('INVALID_OPERATION');
}
async function finish() {
  const { file, info, written, infoPath, dir, owner: identity, clockOffsetMs } = writing;
  try {
    await file.sync();
    const activityAt = written > 0 ? committedAt({ clockOffsetMs }) : undefined;
    await saveSidecar(infoPath, { ...info, offset: info.offset + written, owner: identity,
      activity: activityAt ? { version: 1, offset: info.offset + written, at: activityAt } : info.activity }, dir);
    return { offset: info.offset + written, activityAt };
  } finally { await file.close(); writing = undefined; }
}
async function abort() {
  if (!writing) return;
  const { file, info } = writing;
  try { await file.truncate(info.offset); await file.sync(); }
  finally { await file.close(); writing = undefined; }
}
function done(message) { process.send(message, () => process.disconnect()); }
process.on('message', async message => {
  try {
    if (message.type === 'start') {
      const value = await action(message.op, message.args);
      return message.op === 'beginWrite' ? process.send({ type: 'ready' }) : done({ type: 'result', value });
    }
    if (message.type === 'chunk') {
      if (!writing || !Buffer.isBuffer(message.data) || message.data.length > 65536 || writing.written + message.data.length > 10485760 || writing.info.offset + writing.written + message.data.length > writing.info.size) throw new Error('OVERLENGTH');
      const { bytesWritten } = await writing.file.write(message.data, 0, message.data.length, writing.info.offset + writing.written);
      if (bytesWritten !== message.data.length) throw new Error('SHORT_WRITE');
      writing.written += bytesWritten;
      return process.send({ type: 'ack' });
    }
    if (message.type === 'end') return done({ type: 'result', value: await finish() });
    if (message.type === 'abort') { await abort(); return done({ type: 'error', code: 'ABORTED' }); }
  } catch (error) {
    try { await abort(); } catch {}
    const code = error.code || error.message;
    done({ type: 'error', code: /^[A-Z_]+$/.test(code) ? code : 'STORAGE_ERROR' });
  }
});
