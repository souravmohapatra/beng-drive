import React, { useEffect, useState } from 'react';
import { Alert, Confirm, Shell, api, bytes, problem } from './ui';

type Collection = {
  id: string; token: string; title: string; welcome: string | null; expiresAt: string; allowance: number;
  state: 'active' | 'expired' | 'revoked'; completedBytes: number; reservedBytes: number; completedCount: number; reservedCount: number;
};
type Activity = { id: string; originalName: string; declaredSize: number; displayName: string; status: string; errorCode: string | null };
type Detail = Collection & { uploads: Activity[]; nextCursor: string | null };
type Health = { storage: string; cleanup: { lastAttemptAt: string | null; lastSuccessAt: string | null; pending: number; overdue: number; errors: number; errorCode: string | null } };
type OwnerSession = { csrfToken: string; publicOrigin: string };
type Intake = { open: boolean; closesAt: string | null; serverNow: string };

function localTime(value: string): string {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function CollectionForm({ current, save, cancel, busy }: {
  current: Collection | null; save: (data: Record<string, string | number>) => void; cancel: () => void; busy: boolean;
}) {
  const [title, setTitle] = useState(current?.title || '');
  const [welcome, setWelcome] = useState(current?.welcome || '');
  const [expiry, setExpiry] = useState(current ? localTime(current.expiresAt) : '');
  const [allowance, setAllowance] = useState(current ? String(current.allowance) : '');
  const [error, setError] = useState('');
  return <form className="form-card" onSubmit={event => {
    event.preventDefault(); setError('');
    const data: Record<string, string | number> = { title: title.trim(), welcome };
    if (expiry && (!current || expiry !== localTime(current.expiresAt))) {
      const time = new Date(expiry);
      if (!Number.isFinite(time.getTime()) || time.getTime() <= Date.now()) { setError('Choose an expiry in the future.'); return; }
      data.expiresAt = time.toISOString();
    }
    if (allowance !== '') {
      const amount = Number(allowance);
      if (!Number.isSafeInteger(amount) || amount < 0) { setError('Enter a nonnegative whole number of bytes.'); return; }
      data.allowance = amount;
    }
    save(data);
  }}>
    <h2>{current ? 'Edit collection' : 'Create a collection'}</h2><Alert message={error} />
    <div className="field"><label htmlFor="title">Collection title</label><input id="title" value={title} maxLength={120} required onChange={event => setTitle(event.target.value)} /></div>
    <div className="field"><label htmlFor="welcome">Welcome message (optional)</label><textarea id="welcome" value={welcome} maxLength={2000} onChange={event => setWelcome(event.target.value)} /></div>
    <div className="field"><label htmlFor="expiry">Expiry (your local time)</label><input id="expiry" type="datetime-local" value={expiry} onChange={event => setExpiry(event.target.value)} required={!!current} />
      {!current && <span className="field-hint">Leave blank for the server's configured lifetime (normally seven days).</span>}</div>
    <div className="field"><label htmlFor="allowance">Collection allowance in bytes</label><input id="allowance" type="number" min="0" step="1" value={allowance} onChange={event => setAllowance(event.target.value)} required={!!current} />
      <span className="field-hint">10 GB = 10,000,000,000 bytes. {current ? `Must cover ${bytes(current.completedBytes + current.reservedBytes)} already saved or reserved.` : 'Leave blank for the configured default.'}</span></div>
    <div className="button-row"><button className="primary" disabled={busy}>{busy ? 'Saving…' : current ? 'Save changes' : 'Create collection'}</button>
      <button type="button" className="secondary" disabled={busy} onClick={cancel}>Go back</button></div>
  </form>;
}

function IntakePanel({ intake, busy, save, refresh }: {
  intake: Intake; busy: boolean; save: (closesAt: string | null) => Promise<void>; refresh: () => void;
}) {
  const [until, setUntil] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => {
    setUntil(localTime(intake.open && intake.closesAt ? intake.closesAt : new Date(Date.parse(intake.serverNow) + 4 * 3600000).toISOString()));
    setElapsed(0);
    const started = performance.now();
    const timer = setInterval(() => setElapsed(performance.now() - started), 1000);
    return () => clearInterval(timer);
  }, [intake]);
  const now = Date.parse(intake.serverNow) + elapsed;
  const open = intake.open && !!intake.closesAt && Date.parse(intake.closesAt) > now;
  return <section className="summary-card intake-panel" aria-labelledby="intake-title">
    <h2 id="intake-title" role="status">{open ? 'Accepting uploads' : 'Uploads are closed'}</h2>
    <p>{open ? `Closes automatically at ${new Date(intake.closesAt!).toLocaleString()}. Collection keys and expiry still apply.` :
      'Visitors see the quiet page. Invitations and guest APIs stay closed until you open a window.'}</p>
    <form onSubmit={event => {
      event.preventDefault(); setError('');
      const date = new Date(until);
      if (!Number.isFinite(date.getTime()) || date.getTime() <= now) { setError('Choose a closing time in the future.'); return; }
      void save(date.toISOString());
    }}>
      <div className="field"><label htmlFor="intake-until">Accept uploads until (your local time)</label>
        <input id="intake-until" type="datetime-local" value={until} required disabled={busy} onChange={event => setUntil(event.target.value)} /></div>
      <Alert message={error} />
      <div className="button-row"><button className="primary" disabled={busy}>{open ? 'Update closing time' : 'Open uploads'}</button>
        {open && <button type="button" className="secondary" disabled={busy} onClick={() => { setError(''); void save(null); }}>Close uploads now</button>}
        <button type="button" className="text-button" disabled={busy} onClick={refresh}>Refresh window status</button></div>
    </form>
    <p className="product-note">Closing blocks new requests; a chunk already accepted may finish. It does not delete files or revoke keys. Normal partial-file cleanup still applies.</p>
  </section>;
}

export function Owner() {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [intake, setIntake] = useState<Intake | null>(null);
  const [origin, setOrigin] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<'create' | 'edit' | null>(null);
  const [confirmation, setConfirmation] = useState<'rotate-key' | 'revoke' | null>(null);
  const [issued, setIssued] = useState<{ key: string; invitation: string; title: string } | null>(null);
  const base = '/api/admin/collections';

  async function load(after?: string) {
    setError('');
    try {
      setIntake(await api<Intake>('/api/admin/intake'));
      const page = await api<{ items: Collection[]; nextCursor: string | null }>(`${base}${after ? `?cursor=${encodeURIComponent(after)}` : ''}`);
      setCollections(previous => after ? [...previous, ...page.items] : page.items); setCursor(page.nextCursor);
      setHealth(await api<Health>('/api/admin/health'));
    } catch (failure) { setError(problem(failure)); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    let alive = true;
    const hideKey = () => setIssued(null);
    window.addEventListener('pagehide', hideKey);
    void api<OwnerSession>('/api/admin/session').then(session => { if (alive) { setOrigin(session.publicOrigin); void load(); } })
      .catch(failure => { if (alive) { setError(problem(failure)); setLoading(false); } });
    return () => { alive = false; window.removeEventListener('pagehide', hideKey); };
  }, []);

  async function open(id: string, after?: string) {
    setBusy(true); setError('');
    try {
      const next = await api<Detail>(`${base}/${id}${after ? `?cursor=${encodeURIComponent(after)}` : ''}`);
      setDetail(previous => after && previous?.id === id ? { ...next, uploads: [...previous.uploads, ...next.uploads] } : next);
      setForm(null);
    } catch (failure) { setError(problem(failure)); }
    finally { setBusy(false); }
  }

  async function mutate<T>(path: string, method: string, data?: Record<string, string | number | null>): Promise<T> {
    // Refresh immediately before a mutation: the owner's CSRF token rotates across tabs.
    const session = await api<OwnerSession>('/api/admin/session');
    setOrigin(session.publicOrigin);
    return api<T>(path, { method, headers: { 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' },
      body: data ? JSON.stringify(data) : undefined });
  }

  async function saveIntake(closesAt: string | null) {
    setBusy(true); setError('');
    try {
      const next = await mutate<Intake>('/api/admin/intake', 'PUT', { closesAt });
      setIntake(next);
      setNotice(next.open ? 'Upload window opened. It will close automatically at the selected time.' : 'Uploads closed. Visitors now see the quiet page.');
    } catch (failure) { setError(problem(failure)); }
    finally { setBusy(false); }
  }

  async function save(data: Record<string, string | number>) {
    setBusy(true); setError('');
    try {
      if (form === 'edit' && detail) {
        await mutate(`${base}/${detail.id}`, 'PATCH', data);
        setForm(null); await open(detail.id); setNotice('Collection updated.');
      } else {
        const created = await mutate<Collection & { key: string; invitationUrl: string }>(base, 'POST', data);
        setIssued({ key: created.key, invitation: created.invitationUrl, title: created.title });
        setForm(null); await open(created.id);
      }
      await load();
    } catch (failure) { setError(problem(failure)); }
    finally { setBusy(false); }
  }

  async function confirm() {
    if (!detail || !confirmation) return;
    setBusy(true); setError('');
    try {
      const result = await mutate<Collection & { key?: string }>(`${base}/${detail.id}/${confirmation}`, 'POST');
      if (result.key) setIssued({ key: result.key, invitation: `${origin}/c/${result.token}`, title: result.title });
      else setNotice('Collection revoked. Completed files are retained.');
      setConfirmation(null); await open(detail.id); await load();
    } catch (failure) { setError(problem(failure)); }
    finally { setBusy(false); }
  }

  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setNotice('Copied. Share the link and key separately.'); }
    catch { setNotice('Clipboard access failed. Select the text below and copy it manually.'); }
  }

  return <Shell owner><Alert message={error} /><p className="product-note" role="status">{notice}</p>
    <div className="section-head"><div><h1 className="screen-title">{detail ? detail.title : 'Collections'}</h1>
      <p>Private invitations. Files saved directly to your storage.</p></div>
      <button className="secondary" disabled={busy} onClick={() => { setIssued(null); setDetail(null); setForm(form === 'create' ? null : 'create'); }}>New collection</button></div>
    {intake && <IntakePanel intake={intake} busy={busy} save={saveIntake} refresh={() => void load()} />}
    {issued && <section className="surface issued-key" aria-labelledby="issued-title"><h2 id="issued-title">Your new key — shown once</h2>
      <p>Save this key now. Share it separately from the link. It cannot be recovered later; rotation invalidates existing guest access.</p>
      <div className="field"><label htmlFor="issued-link">Invitation for {issued.title}</label><textarea id="issued-link" readOnly value={issued.invitation} /></div>
      <button className="secondary" onClick={() => void copy(issued.invitation)}>Copy invitation link</button>
      <div className="field"><label htmlFor="issued-key">New collection key</label><input id="issued-key" readOnly value={issued.key} autoComplete="off" /></div>
      <div className="button-row"><button className="secondary" onClick={() => void copy(issued.key)}>Copy new key</button>
        <button className="primary" onClick={() => { setIssued(null); setNotice('Key hidden. Rotate it if you need a replacement.'); }}>I saved the key — hide it</button></div>
    </section>}
    {health && <section className="summary-card health-panel" aria-labelledby="health-title"><h2 id="health-title">Storage: {health.storage}</h2>
      <p>{health.storage === 'busy' ? 'Transfers or recovery are in progress. New admission may need a retry.' : health.storage === 'available' ? 'Storage checks are passing.' : 'New uploads cannot be safely admitted. Check the mount and storage service.'}</p>
      <p>Cleanup: {health.cleanup.pending} pending · {health.cleanup.overdue} overdue · {health.cleanup.errors} errors</p>
      <p>Last successful cleanup: {health.cleanup.lastSuccessAt ? new Date(health.cleanup.lastSuccessAt).toLocaleString() : 'Not yet confirmed'}</p>
      {health.cleanup.errorCode && <p className="field-error">{health.cleanup.errorCode} — inspect the scoped cleanup procedure; never delete completed files.</p>}
      <button className="text-button" onClick={() => void load()}>Refresh storage and collections</button></section>}
    {loading ? <p role="status">Loading collections…</p> : form ? <CollectionForm key={form + (detail?.id || '')} current={form === 'edit' ? detail : null} busy={busy} save={data => void save(data)} cancel={() => setForm(null)} /> : detail ? <>
      <div className="button-row"><button className="text-button" onClick={() => { setDetail(null); setIssued(null); }}>Back to collections</button>
        <button className="secondary" disabled={busy} onClick={() => { setIssued(null); setForm('edit'); }}>Edit collection</button>
        <button className="secondary" disabled={busy} onClick={() => void open(detail.id)}>Refresh activity</button></div>
      <p className="product-note">{detail.state} · expires {new Date(detail.expiresAt).toLocaleString()}</p>
      <div className="summary-grid summary-card"><div><strong>{bytes(detail.completedBytes)}</strong><span>{detail.completedCount} saved files</span></div>
        <div><strong>{bytes(detail.reservedBytes)}</strong><span>{detail.reservedCount} reserved files</span></div>
        <div><strong>{bytes(Math.max(0, detail.allowance - detail.completedBytes - detail.reservedBytes))}</strong><span>Remaining allowance</span></div></div>
      <div className="field"><label htmlFor="invitation-link">Invitation link</label><textarea id="invitation-link" readOnly value={`${origin}/c/${detail.token}`} /></div>
      <button className="secondary" onClick={() => void copy(`${origin}/c/${detail.token}`)}>Copy invitation link</button>
      <p className="product-note">Old keys cannot be recovered. A display name is a guest label, not verified identity.</p>
      <div className="button-row"><button className="secondary" disabled={busy || detail.state === 'revoked'} onClick={() => setConfirmation('rotate-key')}>Rotate key</button>
        <button className="danger" disabled={busy || detail.state === 'revoked'} onClick={() => setConfirmation('revoke')}>Revoke collection</button></div>
      <h2 className="activity-title">Upload activity</h2>
      {!detail.uploads.length && <p className="notice">No uploads yet. Share the link and key separately to invite someone.</p>}
      <ul className="receipt-list activity-list">{detail.uploads.map(upload => <li className="receipt-row" key={upload.id}><div><strong>{upload.originalName}</strong>
        <p>{upload.displayName} · {bytes(upload.declaredSize)}</p>{upload.errorCode && <p className="field-error">{upload.errorCode}</p>}</div><strong>{upload.status}</strong></li>)}</ul>
      {detail.nextCursor && <button className="secondary" disabled={busy} onClick={() => void open(detail.id, detail.nextCursor!)}>More uploads</button>}
    </> : <>
      {!collections.length && <div className="surface"><h2>Make space for a new collection.</h2><p>Create an invitation, then share its link and key separately.</p></div>}
      <ul className="collection-list">{collections.map(collection => <li className="surface" key={collection.id}>
        <div className="section-head"><h2>{collection.title}</h2><span className="pill">{collection.state}</span></div>
        <p>Expires {new Date(collection.expiresAt).toLocaleString()}</p><p>{collection.completedCount} saved · {bytes(collection.completedBytes)} of {bytes(collection.allowance)}</p>
        <button className="text-button" disabled={busy} onClick={() => { setIssued(null); void open(collection.id); }}>Open collection</button></li>)}</ul>
      {cursor && <button className="secondary" disabled={busy} onClick={() => void load(cursor)}>More collections</button>}
    </>}
    {confirmation && <Confirm title={confirmation === 'rotate-key' ? 'Replace this collection key?' : 'Revoke this collection?'} busy={busy} close={() => setConfirmation(null)} confirm={() => void confirm()}>
      <p>{confirmation === 'rotate-key' ? 'Existing guest sessions stop working on their next request. Save the replacement key when it appears.' : 'Guests lose access on their next request. This cannot be undone. Completed files are retained.'}</p>
      <Alert message={error} />
    </Confirm>}
  </Shell>;
}
