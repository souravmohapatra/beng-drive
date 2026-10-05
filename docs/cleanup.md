# Partial upload cleanup and private health

The guest's official tus DELETE handler and the hourly cleanup pass use per-upload exclusion and an exclusive storage claim. They cannot overlap concurrent PATCH claims; PATCH streams use the bounded reservation protocol in [upload-api.md](upload-api.md). Claims stay held until their storage workers settle, including after a caller timeout. DELETE requires the current collection session and CSRF/origin guard. A second authorized DELETE of a cancelled upload returns 204; completed and finalizing uploads return 409 without deleting bytes.

Schema v5 adds `uploads.transfer_at`, `deleting_at`, and `deletion_intent`, plus one `cleanup_state` row. The worker persists versioned owner, committed offset, and worker commit time in the fsynced sidecar after successful create or payload fsync. SQLite `transfer_at` is updated from this evidence under the upload's held claim. A response timeout or process exit after that NAS commit can leave SQLite behind; startup, late settlement, and idle cleanup reconcile the sidecar before deleting. HEAD, status/receipt polls, errors, failed writes, and key rotation do not themselves refresh activity. Older sidecars lack a provable last-commit time: idle cleanup retains their reservation and reports `ACTIVITY_UNKNOWN`; expiry or revocation can still trigger validated deletion. Existing v1–v4 partials migrate conservatively from `updated_at`; new completed receipts, ownership, and timestamps are preserved. Schema versions above v5 are rejected. Back up SQLite WAL using the backup API or a stopped consistent checkpoint paired with a NAS snapshot; a database-only or NAS-only restore needs exact-ID reconciliation before reopening admission.

The pass runs every `CLEANUP_INTERVAL_SECONDS` (default 3600, maximum 3600) and scans at most 16 DB-owned rows at a time. It selects creating/uploading partials whose last transfer was at least `PARTIAL_IDLE_SECONDS` old (default 172800), or whose collection expired or was revoked. Rotation alone does not qualify. It also resumes persisted `deleting` rows on startup. Only one pass runs at a time. A failed or busy pass records debt for a later tick; with available storage, the hourly retry cadence is within 24 hours of expiry or revocation. Missing NAS keeps reservations and reports an error. The pass never scans arbitrary NAS orphans or touches completed/finalizing uploads.

Deletion first persists `deleting`, then validates the exact generated ID, collection, original name, root/mount and owned regular partial/sidecar. It rejects links, unsafe modes/ownership, prepared finalization evidence and any destination already present under `completed`. When a sidecar exists, the worker writes a scoped deletion marker and fsyncs it before unlinking the payload and sidecar; an empty payload orphan from interrupted creation is verified separately. SQLite records deletion intent before unlink. A retry can resume a sidecar-only marked deletion or verify exact absence after a process crash; cancellation and reservation release happen only after the worker confirms absence. Unexpected missing or conflicting artifacts keep the row `deleting` with its reservation and error. There is no SQLite transaction across NAS I/O and no local payload fallback.

`GET /api/admin/health` is served only on the private admin Unix socket after the owner identity check. Its no-store response is:

```json
{
  "storage": "available",
  "cleanup": {
    "lastAttemptAt": "2026-09-23T00:00:00.000Z",
    "lastSuccessAt": null,
    "pending": 1,
    "overdue": 0,
    "errors": 1,
    "errorCode": "CLEANUP_PENDING"
  }
}
```

Storage is `available` or `unavailable` from a bounded worker probe, or `busy` while the coordinator holds a write/startup claim. A null success means no successful pass is proved. Counts are bounded SQL aggregates; errors and codes reveal no paths, hashes, credentials or session identities. `/health/live` stays NAS independent. `/health/ready` returns 503 while a write claim is held or storage cannot be probed. T08 can wire these fields to the owner dashboard after its private-browser and T04 device gates; this backend does not claim that UI verification.

For an overdue or uncertain deletion, first inspect `/api/admin/health` through the authorized private socket and stop new admission if storage identity is uncertain. Check the exact upload row and generated ID against the expected NAS root, mount, ownership, partial sidecar and completed destination. Keep any conflicting artifact and its reservation. Restore storage availability and let the bounded startup/hourly pass retry; do not recursively sweep the NAS or clear the DB row by hand. For a startup lock/socket refusal, verify that no process/listener owns the exact private socket and inspect the exact path's type, mode, UID and inode before any operator repair. Never blindly remove the lock or socket: a live or changed listener must be preserved. Resume with the normal startup check and verify readiness and private routing.

Local fixture tests cover injected clock boundaries, a committed-write response timeout, full product-process exits after worker commit and after unlink, claim retention, outage/retry, and scoped conflicts. The timeout injection is at the response boundary after a real worker commit. These tests do not prove a physical NFS timeout, power-loss fsync boundary, or a production NAS deletion sweep.
