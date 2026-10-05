import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workerPath = fileURLToPath(new URL('./worker.mjs', import.meta.url));
const maxChunk = 65536;

export class StorageError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export class StoragePool {
  constructor({ root, expectedSource, fixture = false, maxActive = 10, maxPending = 10 }) {
    this.root = root;
    this.expectedSource = expectedSource;
    this.fixture = fixture;
    this.maxActive = maxActive;
    this.maxPending = maxPending;
    this.active = 0;
    this.pending = [];
    this.activeIds = new Set();
    this.probeCache = { until: 0, value: false };
  }

  get counts() { return { active: this.active, pending: this.pending.length }; }

  submit(op, args = {}, stream, deadlineMs = 120000) {
    const id = args.id;
    if (this.pending.length >= this.maxPending) throw new StorageError('BUSY');
    let task;
    const work = new Promise((resolve, reject) => {
      task = { op, args, stream, id, resolve, reject, started: false };
      this.pending.push(task);
      this.pump();
    });
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (!task.started) {
          const index = this.pending.indexOf(task);
          if (index >= 0) this.pending.splice(index, 1);
          task.reject(new StorageError('STORAGE_TIMEOUT'));
        }
        reject(new StorageError('STORAGE_TIMEOUT'));
      }, deadlineMs);
    });
    const response = Promise.race([work, deadline]).finally(() => clearTimeout(timer));
    // The response can time out while the worker remains blocked in kernel I/O.
    // Callers that serialize a logical upload retain its lock until settled.
    response.settled = work;
    return response;
  }

  pump() {
    while (this.active < this.maxActive) {
      const index = this.pending.findIndex(task => !task.id || !this.activeIds.has(task.id));
      if (index < 0) return;
      const [task] = this.pending.splice(index, 1);
      task.started = true;
      this.active++;
      if (task.id) this.activeIds.add(task.id);
      this.execute(task).then(task.resolve, task.reject).finally(() => {
        this.active--;
        if (task.id) this.activeIds.delete(task.id);
        this.pump();
      });
    }
  }

  async execute(task) {
    const child = fork(workerPath, [], {
      serialization: 'advanced',
      env: { ...process.env, STORAGE_ROOT: this.root, STORAGE_EXPECTED_SOURCE: this.expectedSource, STORAGE_FIXTURE: this.fixture ? '1' : '0' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const messages = [];
    let waiter;
    let exited = false;
    let closed = false;
    let ready = false;
    let workerErrored = false;
    child.on('error', () => {});
    child.on('message', message => {
      if (waiter) { const resolve = waiter; waiter = undefined; resolve(message); }
      else messages.push(message);
    });
    const exit = new Promise(resolve => child.once('exit', () => {
      exited = true;
      resolve();
    }));
    // A final IPC result can still be delivered after 'exit'. 'close' is the
    // point at which the IPC channel and stdio have drained.
    child.once('close', () => {
      closed = true;
      if (waiter) { const wake = waiter; waiter = undefined; wake({ type: 'error', code: 'WORKER_EXIT' }); }
    });
    const next = async () => {
      const message = messages.shift() || (closed ? { type: 'error', code: 'WORKER_EXIT' } : await new Promise(resolve => { waiter = resolve; }));
      if (message.type === 'error') { workerErrored = true; throw new StorageError(message.code); }
      return message;
    };
    try {
      child.send({ type: 'start', op: task.stream ? 'beginWrite' : task.op, args: task.args });
      if (task.stream) {
        if ((await next()).type !== 'ready') throw new StorageError('WORKER_PROTOCOL');
        ready = true;
        for await (const chunk of task.stream) {
          for (let i = 0; i < chunk.length; i += maxChunk) {
            child.send({ type: 'chunk', data: chunk.subarray(i, i + maxChunk) });
            if ((await next()).type !== 'ack') throw new StorageError('WORKER_PROTOCOL');
          }
        }
        child.send({ type: 'end' });
      }
      const result = await next();
      if (result.type !== 'result') throw new StorageError('WORKER_PROTOCOL');
      await exit;
      return result.value;
    } catch (error) {
      if (task.stream && ready && !workerErrored && !exited && child.connected) child.send({ type: 'abort' }, () => {});
      await exit;
      throw error;
    }
  }

  async readiness() {
    if (Date.now() < this.probeCache.until) return this.probeCache.value;
    if (this.active >= this.maxActive) return false;
    try {
      await this.submit('probe', {}, undefined, 2000);
      this.probeCache = { until: Date.now() + 5000, value: true };
      return true;
    } catch {
      this.probeCache = { until: Date.now() + 5000, value: false };
      return false;
    }
  }
}
