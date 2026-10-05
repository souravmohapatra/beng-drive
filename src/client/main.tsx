import React from 'react';
import { createRoot } from 'react-dom/client';
import { Guest } from './guest';
import { Owner } from './owner';
import './style.css';

const root = document.getElementById('root')!;
const admin = root.dataset.view === 'admin';

if (import.meta.env.DEV && location.pathname === '/design-preview') {
  import('./preview').then(({ Preview }) => createRoot(root).render(<Preview />));
} else if (admin) {
  createRoot(root).render(<Owner />);
} else if (/^\/c\/[A-Za-z0-9_-]{43}\/?$/.test(location.pathname)) {
  createRoot(root).render(<Guest token={location.pathname.split('/')[2]} />);
} else {
  createRoot(root).render(
    <div className="site-shell">
      <header className="site-header"><a className="wordmark" href="/">beng<span>·</span>drive</a><span className="header-note">A calmer way to share</span></header>
      <main className="entry-wrap">
        <div className="entry-orb" aria-hidden="true" />
        <section className="glass entry-card" aria-labelledby="entry-title">
          <span className="eyebrow">PRIVATE FILE SHARING</span>
          <h1 id="entry-title">Your files, together in one place.</h1>
          <p>{location.pathname.startsWith('/c/') ? 'This invitation link is incomplete. Ask your host for the full link and a separate collection key.' : 'Have an invitation link? Open it to join a collection, then enter the key shared with you.'}</p>
          <div className="entry-rule" />
          <p className="small-copy">A collection link and key are both required. Ask the person who invited you if either is missing.</p>
        </section>
      </main>
    </div>,
  );
}
