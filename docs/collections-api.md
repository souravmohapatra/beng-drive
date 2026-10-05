# T05 collection persistence and private API

Status: implemented locally and in an isolated container fixture; no production deployment or Tailscale/Cloudflare route exists. T04 external owner/account gates remain open.

## Database

Migration 2 extends version 1 in `BEGIN IMMEDIATE` and preserves `schema_migrations` and existing tables. It adds `collections`, `browser_sessions`, `grants`, `uploads`, and `admin_sessions`. Node's pinned SQLite connection retains foreign keys, WAL, FULL synchronization and a five-second busy timeout. Unique collection tokens, session hashes, upload IDs and storage locators are indexed. Upload status and owner/grant relationships have constraints and triggers. The database stores key, browser session, admin session and CSRF **hashes**, never plaintext values. Original filenames and generated storage locators are separate columns; there is no payload or duplicate tus offset in SQLite.

Collection summaries calculate completed/reserved bytes and file counts from upload rows. `creating`, `uploading`, `finalizing`, and `deleting` retain their full declared reservation; `completed` counts as committed; `cancelled` releases only after a confirmed deletion transition. A recoverable error annotates status without releasing space. Both `reserveUpload` (for T09) and `editCollection` use `BEGIN IMMEDIATE` and the same `commitment` query. This serializes concurrent allowance changes and future admission. T05 implements the repository contract only: it does not create a public upload endpoint, read NAS space, or claim T09 admission acceptance.

## Private endpoints

Every route below exists only on the admin Unix socket and requires the exact authenticated Serve login. `GET /api/admin/session` issues or reuses an eight-hour server-side session with a `__Host-beng_admin` Secure, HttpOnly, SameSite=Strict, Path=/ cookie and a separately generated CSRF token. Reissuing the session rotates the CSRF token. Mutations also require the session cookie, exact configured private `Origin`, and matching `X-CSRF-Token`. A guest listener cannot select these handlers by Host or headers.

The session response includes the configured `publicOrigin`, so the private dashboard constructs guest invitations without guessing a host. The dashboard refreshes the admin session token before each mutation because another owner tab may have rotated it.

| Method and path | Result |
| --- | --- |
| GET `/api/admin/intake` | `{open, closesAt, serverNow}` from the server clock |
| PUT `/api/admin/intake` | Persist exact `{closesAt}`: future canonical UTC ISO string opens/updates; null closes immediately |
| GET `/api/admin/collections?limit=1..100&cursor=...` | Ordered summaries and next cursor; default 100 |
| POST `/api/admin/collections` | 201 summary, configured invitation URL, one-time key |
| GET `/api/admin/collections/:id?limit=1..100&cursor=...` | Summary and paginated contributor/upload status metadata |
| PATCH `/api/admin/collections/:id` | Edit title, welcome, future expiry or allowance; 409 below commitments |
| POST `/api/admin/collections/:id/rotate-key` | New one-time key and incremented credential version; old grants expire |
| POST `/api/admin/collections/:id/revoke` | Idempotent revoked state and invalidated grants; completed file records retained |

Titles are trimmed, required and at most 120 UTF-8 bytes; welcome is optional/null and at most 2000 UTF-8 bytes. Prohibited controls and malformed Unicode are rejected; welcome permits tab and newline. Expiry uses future UTC ISO millisecond form. Allowance is a nonnegative safe integer. Unknown fields/types fail; JSON request bodies are limited to 16 KiB of actual streamed bytes, including chunked requests. Responses use `Cache-Control: no-store`; no CORS wildcard, file download, hard delete, or guest collection management endpoint exists. Unknown routes return 404, unsupported methods 405, malformed input 400, oversized body 413, unauthorized mutation 403, and allowance conflict 409. Logs contain status and generated request ID only.

When create omits allowance or expiry, it uses validated runtime `DEFAULT_ALLOWANCE_BYTES` and `COLLECTION_DEFAULT_TTL_SECONDS`; the baseline settings are 10,000,000,000 bytes and seven days. Explicit valid values, including zero allowance, take precedence. Default expiry is calculated from the collection's persisted creation timestamp. Startup rejects a configured TTL that could exceed JavaScript's representable date range.

## Intake window

Migration 6 adds a singleton `intake_window` row, defaulting to closed on fresh installations and upgrades. Existing collections, grants, reservations and completed receipts are retained. Only the private owner API changes the live setting; no public status or settings API exists while closed.

`GET /api/admin/intake` returns a boolean `open`, nullable UTC `closesAt` and UTC `serverNow`. `PUT` accepts exactly one property, `closesAt`: a future canonical `Date.toISOString()` timestamp or null. Missing/extra fields, wrong types, noncanonical dates and past/current deadlines return 400. It uses the same owner identity, secure admin session, Origin and CSRF checks as collection mutations. A successful response returns the persisted status.

The dashboard's **Accept uploads until (your local time)** control converts local time to UTC. **Open uploads**, **Update closing time** and **Close uploads now** manage the window; **Refresh window status** picks up another owner's tab. The displayed open/closed state advances from the server time, but the server always decides admission. Restart preserves the deadline; expiry needs no scheduler.

Closed public pages are static and contain no scripts or invitation information. All guest APIs/tus/assets are denied before auth, body parsing and storage; only minimal liveness remains. Already-admitted chunks may settle, but subsequent requests are rejected. Closing does not delete files or revoke credentials, and partial cleanup continues. This app-level gate requires no Workers or paid Cloudflare plan and does not stop requests at the edge.

## Owner dashboard

The admin listener serves the working collection list, create/edit forms, contributor/upload activity, one-time key display and rotation/revocation confirmations. Copy invitation links and keys separately. Keys stay in component memory only and disappear when hidden, navigating away or leaving the page; old keys cannot be recovered.

Storage and cleanup panels use the real private health API, including pending, overdue and error counts. Refresh storage/collections or activity explicitly when checking another guest's progress. Failed clipboard operations leave selectable text and an accessible explanation. Confirmation dialogs support Escape and restore focus to their trigger.

Local HTTPS browser verification uses an isolated fixture proxy with a synthetic owner identity, never a production authentication bypass. Owner-only Tailscale Serve identity stripping, grants and unauthorized-device denial still require T04 acceptance.

## Backup and rollback

No production database was migrated. Before a future live migration, use Node SQLite's consistent backup API to a local restricted file; do not copy a live main `.sqlite` file alone while WAL is active. Current schema is 6; older builds reject it. Roll back only to schema-6-compatible code, or restore a consistent pre-migration backup together with a reconciled NAS snapshot before reopening admission. Do not delete completed NAS payloads to make database state fit a rollback.
