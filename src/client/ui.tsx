import React, { useEffect, useRef } from 'react';

export class ApiError extends Error {
  constructor(public status: number, public code: string, public retryAfter = 0) {
    super(code);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, body?.error?.code || 'REQUEST_FAILED',
    Number(response.headers.get('Retry-After')) || 0);
  return body as T;
}

export function problem(error: unknown): string {
  if (!(error instanceof ApiError)) return 'The connection was interrupted. Keep this tab open and try again.';
  if (error.status === 429) return `Too many attempts. Try again in ${error.retryAfter || 60} seconds.`;
  const messages: Record<string, string> = {
    INVALID_KEY: 'That key does not match. Check the separate key from your host.',
    UNAUTHORIZED: 'Your access has ended. Unlock again with the current collection key.',
    COLLECTION_UNAVAILABLE: 'This invitation has expired or been revoked. Ask your host for help.',
    NOT_FOUND: 'This invitation or upload is not available to this browser.',
    ALLOWANCE_CONFLICT: 'The allowance or file count cannot cover these files. Ask your host to adjust the collection.',
    FILE_TOO_LARGE: 'This file exceeds the allowed file size. Choose a smaller file.',
    INSUFFICIENT_STORAGE: 'There is not enough storage space to save this file. Ask your host for help.',
    INVALID_INPUT: 'Check the entered values and try again. Text limits count UTF-8 bytes.',
    INVALID_METADATA: 'The filename or file information is not supported. Rename the file and try again.',
    UPLOAD_FINALIZING: 'This file is already being saved or is completed. It cannot be cancelled.',
    FORBIDDEN: 'This action is no longer authorized. Refresh your access and try again.',
    ORIGIN_REJECTED: 'Your access could not be verified. Refresh this page and try again.',
  };
  return messages[error.code] || (error.status === 503 ? 'Storage is busy or unavailable. Try again shortly; no saved receipt has been confirmed.' :
    error.status === 507 ? 'Storage is full. Ask your host for help.' : `The request could not complete (${error.code}). Try again or ask your host.`);
}

export function bytes(value: number): string {
  if (value < 1000) return `${value} B`;
  const scale = value >= 1e9 ? 1e9 : value >= 1e6 ? 1e6 : 1e3;
  return `${(value / scale).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${scale === 1e9 ? 'GB' : scale === 1e6 ? 'MB' : 'KB'}`;
}

export function Shell({ children, owner = false }: { children: React.ReactNode; owner?: boolean }) {
  return <div className="site-shell"><a className="skip-link" href="#content">Skip to content</a>
    <header className="site-header"><a className="wordmark" href="/">beng<span>·</span>drive</a>
      <span className="header-note">{owner ? 'Private owner space' : 'A calmer way to share'}</span></header>
    <main id="content" className="product-main glass app-frame"><div className="frame-content">{children}</div></main></div>;
}

export function Alert({ message }: { message: string }) {
  return message ? <p className="notice bad" role="alert">{message}</p> : null;
}

export function Confirm({ title, children, confirm, close, busy = false }: {
  title: string; children: React.ReactNode; confirm: () => void; close: () => void; busy?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current!;
    const trigger = document.activeElement;
    node.showModal();
    return () => {
      node.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={dialog} className="dialog" aria-labelledby="confirmation-title" onCancel={event => {
    event.preventDefault(); if (!busy) close();
  }}><h2 id="confirmation-title">{title}</h2>{children}<div className="dialog-actions">
    <button className="secondary" disabled={busy} onClick={close}>Go back</button>
    <button className="primary" disabled={busy} onClick={confirm}>{busy ? 'Working…' : 'Confirm'}</button>
  </div></dialog>;
}
