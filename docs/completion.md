# Durable completion and recovery (T10)

An upload remains reserved while `creating`, `uploading` or `finalizing`. The final committed PATCH offset, including zero length, moves its SQLite row to `finalizing` before any completion worker starts. Guest status polling can still report `finalizing`; it reports `completed` only after the NAS and SQLite steps below. The public tus endpoint remains behind the same session, grant, Origin and CSRF checks. No completed payload download route exists.

## Publication sequence

1. The bounded storage worker verifies the exact mounted root, generated 32-hex upload ID, collection UUID, sidecar metadata/declared size and full committed offset. It trims only an uncommitted partial tail. It fsyncs and closes the payload, then computes SHA-256 with 64 KiB reads.
2. It saves version-1 evidence to the sidecar atomically and durably: upload and collection IDs, exact final locator, declared size and hash. The original filename stays metadata. The final basename is independently sanitized and limited to 160 UTF-8 bytes; the upload ID prefixes it. Only the app-owned `0700` completed directories and `0600` payload are accepted.
3. `fs.link(partial, final)` exclusively publishes the same inode on the same filesystem. The worker verifies any existing final path before recovery, rejects a distinct inode even if its bytes match, fsyncs the destination directory, unlinks only the partial proven to share the final inode, then fsyncs the partial directory. It streams the final hash again. A failed or ambiguous link/fsync never means the final path is absent; retries inspect the exact paths. A final payload is never removed as rollback.
4. A short SQLite immediate transaction changes `finalizing` to `completed`, stores canonical locator/hash/metadata and one completion timestamp. No SQLite transaction spans NAS I/O. Accounting derives from row status: the full size/count moves from reserved to completed once. The worker then verifies the final path against the DB evidence and removes the sidecar; HEAD uses SQLite metadata and immutable full length after cleanup.

All upload operations retain same-ID exclusion through actual worker settlement. Up to ten PATCH claims may coexist using the chunk reservations described in [upload-api.md](upload-api.md); their automatic finalization stays under the original claim. Admission, deletion, unfinished HEAD and separately scheduled recovery use an exclusive claim that cannot overlap the PATCH group. HEAD for a `finalizing` upload reads known committed fields, releases its read claim, then asks the coordinator to retry under an exclusive claim; competing streams defer that retry until a later bounded poll. Startup scans DB-owned IDs in pages of 16 and recovers sequentially in the background. Liveness stays independent of NAS; readiness and new admission remain busy while storage claims are held. Guest status polling also retries a `finalizing` ID without requiring owner action. A failed attempt leaves a redacted `STORAGE_ERROR` or `CLEANUP_ERROR` and preserves accounting.

## Recovery matrix

| Persisted state and artifacts | Conservative action |
| --- | --- |
| `creating`, neither partial nor sidecar | Retain the reservation; a later exact owned DELETE can confirm absence. |
| Payload only or sidecar only | Report storage error; retain the artifact and reservation for explicit reconciliation. |
| Partial and sidecar, offset below size | Verify and resume from the worker sidecar; truncate only bytes beyond committed offset. |
| Full partial and sidecar, no prepared evidence | Enter/keep `finalizing`, flush/close and compute durable evidence. |
| Prepared evidence and partial only | Recheck exact identity, size and hash; retry exclusive publication. |
| Prepared evidence and partial plus final | Require the same device/inode, exact size and hash; complete directory sync and partial unlink. |
| Prepared evidence and final only | Verify exact path/type/mode/size and streamed hash; finish SQLite commit. |
| SQLite `completed` with sidecar present | Verify DB locator/hash against final payload, then remove only its sidecar. |
| SQLite `completed` with sidecar absent | Verify final payload on startup; repeated HEAD uses persisted metadata. |
| Distinct final inode, symlink, wrong bytes/permissions, missing evidence or unavailable mount | Preserve artifacts and reservation, annotate a redacted error, retry only after the conflict is resolved safely. |

The worker never uses a filename or path supplied by a guest as a locator. It never creates a local fallback when the expected NFS mount is absent. Scheduled partial cleanup uses the separate [deletion contract](cleanup.md); completion recovery never deletes saved files or releases ambiguous reservations.

## Backup and rollback

Schema v4 adds nullable completion hash and persisted upload metadata; schema v5 adds partial transfer activity and deletion debt. Both upgrades preserve earlier rows, ownership and timestamps, and reject newer schemas. SQLite WAL backups require the SQLite backup API or a consistent stopped checkpoint, coordinated with a NAS snapshot at the same logical point. Restoring only SQLite or only NAS may leave finalizing, completed or orphaned artifacts; keep new admission closed and run exact-ID reconciliation before use. Older code cannot open schema v5; use v5-compatible rollback code or a matched pre-migration SQLite/NAS pair. A backup does not replace the need to verify final payload hashes.

Local crash, router and memory fixtures are not production outage or public-route proof. A test-only child product server now exits after its storage worker publishes a payload and before SQLite completion; fresh product server processes recover it twice against the same SQLite, storage and untouched stale admin-socket path. The other test-only faults inject errors at named operation boundaries, often after a successful syscall; they do not prove a physical failed fsync or power loss. A scoped real-NAS fixture confirmed link, EEXIST preservation, same-inode identity and directory fsync under the approved app root; it did not deploy the product or interrupt the mount.
