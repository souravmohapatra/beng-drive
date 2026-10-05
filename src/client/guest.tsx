import React, { useEffect, useRef, useState } from 'react';
import { Upload, DetailedError } from 'tus-js-client';
import { Alert, ApiError, Confirm, Shell, api, bytes, problem } from './ui';

type Session = { title: string; welcome: string | null; expiresAt: string; remainingBytes: number; displayName: string; csrfToken: string };
type Receipt = { id: string; originalName: string; declaredSize: number; status: string; errorCode: string | null; completedAt: string | null };
type State = 'queued' | 'uploading' | 'paused' | 'interrupted' | 'finalizing' | 'completed' | 'cancelling' | 'cancelled' | 'failed';
type Entry = { local: string; id?: string; name: string; size: number; file?: File; upload?: Upload; state: State; cancelPending?: boolean; sent: number; committed: number; rate: number; error: string; completedAt?: string | null };
const retries = [0, 2000, 5000, 10000];

function transferError(error: Error | DetailedError): string {
  if (error instanceof DetailedError && error.originalResponse) {
    const response = error.originalResponse;
    let code = 'REQUEST_FAILED';
    try { code = JSON.parse(response.getBody()).error.code; } catch { /* A proxy may return non-JSON. */ }
    return problem(new ApiError(response.getStatus(), code, Number(response.getHeader('Retry-After'))));
  }
  return problem(error);
}

export function Guest({ token }: { token: string }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [drag, setDrag] = useState(false);
  const [announcement, announce] = useState('');
  const [view, setView] = useState<Entry[]>([]);
  const [reselection, setReselection] = useState<{ entry: Entry; file: File } | null>(null);
  const [matching, setMatching] = useState(false);
  const entries = useRef<Entry[]>([]);
  const active = useRef(new Set<string>());
  const alive = useRef(true);
  const refreshing = useRef(false);
  const admitting = useRef(false);
  const pollFailures = useRef(0);
  const authorized = useRef(false);
  const receiptScope = useRef<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const reselect = useRef<HTMLInputElement>(null);
  const target = useRef<Entry | null>(null);
  const base = `/api/c/${encodeURIComponent(token)}`;
  const endpoint = `/uploads/${encodeURIComponent(token)}`;
  const render = () => { if (alive.current) setView(entries.current.map(item => ({ ...item }))); };
  const change = (entry: Entry, update: Partial<Entry>) => { Object.assign(entry, update); render(); };
  const stop = () => { for (const entry of entries.current) void entry.upload?.abort().catch(() => {}); active.current.clear(); };
  const identify = (entry: Entry, id: string) => {
    // Receipt polling may discover a row before its creation response arrives.
    // Merge by server ID only, never by filename.
    entries.current = entries.current.filter(item => item === entry || item.id !== id);
    change(entry, { id });
  };

  async function admitQueued(current: Session) {
    admitting.current = true;
    try {
      for (const entry of entries.current) {
        if (entry.id || !entry.file || entry.state !== 'queued') continue;
        const metadata = { filename: entry.file.name, filetype: entry.file.type, lastModified: String(entry.file.lastModified) };
        const encoded = Object.entries(metadata).map(([name, value]) =>
          `${name} ${btoa(String.fromCharCode(...new TextEncoder().encode(value)))}`).join(',');
        try {
          const response = await fetch(endpoint, { method: 'POST', headers: {
            'Tus-Resumable': '1.0.0', 'Upload-Length': String(entry.size),
            'Upload-Metadata': encoded, 'X-CSRF-Token': current.csrfToken,
          } });
          if (!response.ok) {
            const body = await response.json().catch(() => null);
            throw new ApiError(response.status, body?.error?.code || 'REQUEST_FAILED');
          }
          const id = response.headers.get('Location')?.split('/').at(-1);
          if (!id || !/^[0-9a-f]{32}$/.test(id)) throw new Error('Missing upload identity');
          identify(entry, id);
          if (['cancelled', 'cancelling'].includes(entry.state)) await cancel(entry);
        } catch (failure) {
          change(entry, { state: 'interrupted', error: `${problem(failure)} Refresh receipts before retrying an unconfirmed creation.` });
        }
      }
    } finally { admitting.current = false; render(); }
  }

  async function refresh(initial = false) {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const current = await api<Session>(`${base}/session`);
      const receipts: Receipt[] = [];
      let cursor: string | null = null;
      do {
        const page: { items: Receipt[]; nextCursor: string | null } = await api(`${base}/uploads${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
        receipts.push(...page.items); cursor = page.nextCursor;
      } while (cursor && alive.current);
      if (!alive.current) return;
      if (receiptScope.current && receiptScope.current !== current.csrfToken) {
        stop(); entries.current = [];
      }
      receiptScope.current = current.csrfToken;
      setSession(current);
      authorized.current = true;
      for (const receipt of receipts) {
        let entry = entries.current.find(item => item.id === receipt.id);
        if (!entry) {
          entry = { local: crypto.randomUUID(), id: receipt.id, name: receipt.originalName, size: receipt.declaredSize,
            state: 'interrupted', sent: 0, committed: 0, rate: 0, error: '' };
          entries.current.push(entry);
        }
        if (receipt.status === 'completed' || receipt.status === 'cancelled' || receipt.status === 'finalizing') {
          if (receipt.status === 'completed' && entry.state !== 'completed') announce(`${entry.name} is confirmed saved.`);
          entry.state = receipt.status;
          if (receipt.status !== 'cancelled') entry.sent = entry.committed = entry.size;
          entry.completedAt = receipt.completedAt;
          if (receipt.status === 'completed') { entry.file = undefined; entry.upload = undefined; entry.error = ''; }
        } else if (receipt.status === 'deleting') entry.state = 'cancelling';
        if (receipt.errorCode) entry.error = 'Storage needs attention. Keep this receipt and retry later; saved completion is not confirmed.';
      }
      pollFailures.current = 0;
      setError(''); render();
    } catch (failure) {
      if (!alive.current) return;
      pollFailures.current++;
      if (failure instanceof ApiError && [401, 404, 410].includes(failure.status)) {
        authorized.current = false;
        stop(); entries.current = []; render(); setSession(null);
        if (!(initial && failure.status === 401)) setError(problem(failure));
      } else setError(problem(failure));
    } finally { refreshing.current = false; if (alive.current) setLoading(false); }
  }

  useEffect(() => {
    alive.current = true;
    void refresh(true);
    const timer = setInterval(() => { if (authorized.current && pollFailures.current < 3) void refresh(); }, 3000);
    return () => { alive.current = false; clearInterval(timer); stop(); };
  }, [token]);

  useEffect(() => {
    if (!cooldown) return;
    const timer = setInterval(() => setCooldown(value => Math.max(0, value - 1)), 1000);
    return () => clearInterval(timer);
  }, [cooldown > 0]);

  async function unlock(event: React.FormEvent) {
    event.preventDefault(); setUnlocking(true); setError('');
    try {
      const current = await api<Session>(`${base}/unlock`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: key.trim(), displayName: name.trim() }) });
      setKey(''); setSession(current); authorized.current = true; pollFailures.current = 0; await refresh();
    } catch (failure) {
      setError(problem(failure));
      if (failure instanceof ApiError && failure.status === 429) setCooldown(failure.retryAfter || 60);
    } finally { setUnlocking(false); }
  }

  function choose(files: FileList | null) {
    if (!files) return;
    for (const file of files) {
      const invalid = file.size > 10000000000 || new TextEncoder().encode(file.name).length > 255 || /[/\\\x00-\x1f\x7f-\x9f]/.test(file.name);
      entries.current.push({ local: crypto.randomUUID(), file, name: file.name, size: file.size, state: invalid ? 'failed' : 'queued',
        sent: 0, committed: 0, rate: 0, error: invalid ? 'Choose a file up to 10 GB with a filename of at most 255 UTF-8 bytes and no path separators or control characters.' : '' });
    }
    render(); announce(`${files.length} files selected.`);
  }

  useEffect(() => {
    if (!session) return;
    if (admitting.current) return;
    if (entries.current.some(entry => entry.state === 'queued' && entry.file && !entry.id)) {
      if (!active.current.size) void admitQueued(session);
      return;
    }
    for (const entry of entries.current) {
      if (active.current.size >= 2) break;
      if (entry.state !== 'queued' || !entry.file) continue;
      active.current.add(entry.local);
      change(entry, { state: 'uploading', error: '', rate: 0 });
      const started = performance.now();
      let initialSent: number | null = null;
      const upload = new Upload(entry.file, {
        endpoint, uploadUrl: entry.id ? `${endpoint}/${entry.id}` : null,
        chunkSize: 10 * 1024 * 1024, retryDelays: retries, parallelUploads: 1,
        storeFingerprintForResuming: false,
        headers: { 'X-CSRF-Token': session.csrfToken },
        metadata: { filename: entry.file.name, filetype: entry.file.type, lastModified: String(entry.file.lastModified) },
        onShouldRetry: (failure, attempt) => {
          const status = failure.originalResponse?.getStatus() || 0;
          return attempt < retries.length && (status === 0 || status === 408 || status === 409 || status === 423 || status === 429 || status >= 500);
        },
        onUploadUrlAvailable: () => {
          const id = upload.url?.split('/').at(-1);
          if (id && /^[0-9a-f]{32}$/.test(id)) identify(entry, id);
        },
        onProgress: sent => {
          if (entry.state !== 'uploading') return;
          initialSent ??= sent;
          change(entry, { sent, rate: Math.max(0, sent - initialSent) / Math.max(1, (performance.now() - started) / 1000) });
        },
        onChunkComplete: (_chunk, committed) => change(entry, { committed }),
        onSuccess: () => {
          active.current.delete(entry.local);
          change(entry, { state: 'finalizing', sent: entry.size, committed: entry.size, rate: 0 });
          announce(`${entry.name} transmitted. Waiting for saved confirmation.`);
          void refresh();
        },
        onError: failure => {
          active.current.delete(entry.local);
          if (entry.state !== 'uploading') { render(); return; }
          change(entry, { state: 'interrupted', error: transferError(failure), rate: 0 });
          announce(`${entry.name} interrupted. Retry or reselect the file.`);
        },
      });
      entry.upload = upload;
      upload.start();
    }
  }, [view, session]);

  async function pause(entry: Entry) {
    change(entry, { state: 'paused', rate: 0 });
    try { await entry.upload?.abort(); }
    catch (failure) { change(entry, { error: problem(failure) }); }
    finally { active.current.delete(entry.local); render(); }
  }

  async function cancel(entry: Entry) {
    change(entry, { state: 'cancelling', cancelPending: true, rate: 0, error: '' });
    try {
      await entry.upload?.abort();
      if (entry.id && session) await Upload.terminate(`${endpoint}/${entry.id}`, {
        headers: { 'X-CSRF-Token': session.csrfToken }, retryDelays: retries,
      });
      change(entry, { state: 'cancelled', file: undefined, upload: undefined });
      announce(`${entry.name} cancelled.`); void refresh();
    } catch (failure) { change(entry, { state: 'cancelling', error: transferError(failure as Error) }); }
    finally { active.current.delete(entry.local); change(entry, { cancelPending: false }); }
  }

  async function matchFile() {
    if (!reselection) return;
    const { entry, file } = reselection;
    setMatching(true); setError('');
    try {
      const response = await fetch(`${endpoint}/${entry.id}`, { method: 'HEAD', cache: 'no-store', headers: { 'Tus-Resumable': '1.0.0' } });
      if (!response.ok) throw new ApiError(response.status, 'REQUEST_FAILED');
      const metadata = new Map((response.headers.get('Upload-Metadata') || '').split(',').map(item => {
        const [name, encoded] = item.trim().split(' ');
        return [name, new TextDecoder().decode(Uint8Array.from(atob(encoded || ''), char => char.charCodeAt(0)))];
      }));
      if (Number(response.headers.get('Upload-Length')) !== file.size || metadata.get('filename') !== file.name ||
        metadata.get('lastModified') !== String(file.lastModified)) {
        throw new Error('FILE_MISMATCH');
      }
      const committed = Number(response.headers.get('Upload-Offset'));
      change(entry, { file, state: 'queued', sent: committed, committed, error: '' });
      setReselection(null);
    } catch (failure) {
      setError(failure instanceof Error && failure.message === 'FILE_MISMATCH' ?
        'This file does not match the original name, size and modification time. Select the original file, or add this as a new upload.' : problem(failure));
      setReselection(null);
    } finally { setMatching(false); }
  }

  const selected = view.filter(item => item.state !== 'cancelled');
  const total = selected.reduce((sum, item) => sum + item.size, 0);
  const transmitted = selected.reduce((sum, item) => sum + item.sent, 0);
  const saved = selected.filter(item => item.state === 'completed');
  const savedBytes = saved.reduce((sum, item) => sum + item.size, 0);
  return <Shell><div className="live-only" role="status" aria-live="polite">{announcement}</div>
    <Alert message={error} />
    {loading ? <p role="status">Checking this invitation…</p> : !session ? <div className="hero-grid">
      <div className="hero-copy"><h1 className="screen-title">A little space to share.</h1><p>Enter the key shared separately by your host and the name you want shown on your files. Collection details appear after you unlock.</p>
        <p className="product-note">Your receipts belong only to this browser. Clearing cookies or switching devices loses access.</p></div>
      <form className="form-card" onSubmit={unlock}><h2>Unlock this collection</h2>
        <div className="field"><label htmlFor="collection-key">Collection key</label><input id="collection-key" type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} required /></div>
        <div className="field"><label htmlFor="display-name">Your display name</label><input id="display-name" autoComplete="nickname" value={name} maxLength={80} onChange={event => setName(event.target.value)} required /></div>
        <button className="primary" disabled={unlocking || cooldown > 0}>{cooldown ? `Try again in ${cooldown}s` : unlocking ? 'Unlocking…' : 'Unlock collection'}</button>
      </form></div> : <>
      <div className="collection-head"><div><h1 className="screen-title">{session.title}</h1><p>{session.welcome}</p></div>
        <span className="pill">Until {new Date(session.expiresAt).toLocaleDateString()}</span></div>
      <div className="summary-card summary-grid"><div><strong>{bytes(session.remainingBytes)}</strong><span>Remaining allowance</span></div>
        <div><strong>{saved.length} files</strong><span>{bytes(savedBytes)} confirmed saved</span></div><div><strong>{bytes(total)}</strong><span>Selected in this browser</span></div></div>
      <div className="overall-progress"><strong>{bytes(transmitted)} of {bytes(total)} transmitted</strong>
        <progress aria-label="Overall bytes transmitted, not saved confirmation" max={total || 1} value={transmitted} />
        <p>Transmitted bytes are not a saved receipt. Only “Completed” confirms storage.</p></div>
      <div className={`upload-zone ${drag ? 'dragging' : ''}`} onDragOver={event => { event.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
        onDrop={event => { event.preventDefault(); setDrag(false); if ([...event.dataTransfer.items].some(item => item.webkitGetAsEntry()?.isDirectory)) {
          setError('Folders are not supported. Select individual files.'); return;
        } choose(event.dataTransfer.files); }}>
        <div><strong>Drop files here, or choose from your device.</strong><p>Up to 10 GB per file, within the remaining allowance. Two files upload at a time.</p>
          <input ref={picker} type="file" multiple tabIndex={-1} aria-label="Choose files" onChange={event => { choose(event.target.files); event.target.value = ''; }} />
          <button className="primary" onClick={() => picker.current?.click()}>Choose files or photos</button></div></div>
      <p className="product-note">Keep this tab open and your phone awake. Background uploads are not guaranteed. After a reload, reselect the original file to resume.</p>
      <div className="section-head"><h2>Your private receipts</h2><button className="text-button" onClick={() => { pollFailures.current = 0; void refresh(); }}>Refresh status</button></div>
      {!view.length && <p className="notice">No files yet. Choose files to start your collection.</p>}
      <ul className="queue product-queue">{view.map(item => <li className="file-row" key={item.local}>
        <div className="file-icon" aria-hidden="true">{item.state === 'completed' ? '✓' : '↑'}</div>
        <div className="file-main"><strong>{item.name}</strong><small>{bytes(item.size)} · {bytes(item.sent)} transmitted · {item.state === 'interrupted' && !item.file ? 'reselect to read committed offset' : `${bytes(item.committed)} confirmed offset`}</small>
          <progress aria-label={`${item.name} bytes transmitted`} max={item.size || 1} value={item.sent} />
          {item.rate > 0 && item.state === 'uploading' && <small>{bytes(item.rate)}/s · about {Math.ceil((item.size - item.sent) / item.rate)}s remaining</small>}
          {item.error && <p className="field-error">{item.error}</p>}
          {item.completedAt && <small>Saved {new Date(item.completedAt).toLocaleString()}</small>}
        </div><div className="file-side"><span className="state-word">{item.state === 'finalizing' ? 'Finalizing — not yet saved' : item.state[0].toUpperCase() + item.state.slice(1)}</span>
          <div className="file-actions">
            {item.state === 'uploading' && <button className="text-button" onClick={() => { const entry = entries.current.find(e => e.local === item.local)!; void pause(entry); }}>Pause</button>}
            {['paused', 'interrupted', 'failed'].includes(item.state) && <button className="text-button" disabled={active.current.has(item.local)} onClick={() => {
              const entry = entries.current.find(e => e.local === item.local)!;
              if (entry.file) change(entry, { state: 'queued' }); else { target.current = entry; reselect.current?.click(); }
            }}>{item.file ? 'Retry / resume' : 'Reselect to resume'}</button>}
            {!['completed', 'cancelled', 'finalizing'].includes(item.state) && <button className="text-button" disabled={item.cancelPending} onClick={() => void cancel(entries.current.find(e => e.local === item.local)!)}>
              {item.cancelPending ? 'Cancelling…' : item.state === 'cancelling' ? 'Retry cancellation' : 'Cancel'}
            </button>}
          </div></div></li>)}</ul>
      <input className="live-only" ref={reselect} type="file" tabIndex={-1} aria-label="Reselect original file" onChange={event => {
        const file = event.target.files?.[0]; if (file && target.current) setReselection({ entry: target.current, file }); event.target.value = '';
      }} />
      {reselection && <Confirm title="Resume with this original file?" confirm={() => void matchFile()} close={() => setReselection(null)} busy={matching}>
        <p>Resume {reselection.entry.name} using {reselection.file.name}? Name, size and modification time must match. Those checks cannot prove identical contents: confirm this is the original, unchanged file.</p>
      </Confirm>}
    </>}
  </Shell>;
}
