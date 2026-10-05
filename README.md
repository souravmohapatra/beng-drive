# beng-drive foundation

This is the application foundation and scoped T03 storage adapter. It serves a minimal invitation-required guest shell and a protected admin placeholder. Collections, authentication and production uploads are not implemented yet. The [runtime contract](docs/runtime-contract.md) defines the planned behavior and later gates. No `.agent` document is needed to build or run this source.

## Local setup

Use Node **24.21.0**. Install with `npm ci`, then run `npm run check`, `npm run build`, and `npm test`. `npm start` serves the built assets; build first. The only durable state today is the numbered SQLite migration at `DB_PATH`. For local testing, use a disposable DB path and the explicit fixture mode; do not use a production owner identity:

```sh
APP_MODE=fixture NODE_ENV=test \
PUBLIC_ORIGIN=https://drive.example.invalid ADMIN_ORIGIN=https://admin.example.invalid \
ADMIN_OWNER_LOGIN=fixture-owner@example.invalid TRUSTED_ADMIN_PROXY_IP=127.0.0.1 \
DB_PATH=/tmp/beng-drive-local-fixture.sqlite npm start
```

Fixture mode permits an empty owner login for fail-closed checks. Production mode requires a nonempty exact owner login and exact trusted peer IP. Never treat an identity header alone as proof of origin. The server listens on loopback locally; Compose publishes both container ports only on host loopback. Admin access additionally needs private Tailscale Serve and owner-only effective policy in T04. No public skeleton deployment is authorized.

## Container contract

`compose.yaml` mounts local SQLite state at `/var/lib/beng-drive` and only the scoped NAS directory at `/data`. Both bind sources must already exist (`create_host_path: false`). The app does not use `/data` in T02. Supply the settings from `.env.example` privately and set `STATE_BIND_SOURCE`, `NAS_BIND_SOURCE`, and `TRUSTED_ADMIN_PROXY_IP` for the target host. The existing Cloudflare connector credentials stay outside this app. The repository `.gitignore` excludes secret configuration, dependencies, builds and SQLite state; `.agent` and `.agents` use this checkout's Git local exclusion and must remain outside commits. Never package `.env`, `.agent`, `.agents`, `.git`, local dependencies or state.

The image is pinned to Node 24.21.0 by digest. `npm run smoke:container` uses a unique disposable fixture under `/home/beng` on the verified mini PC when local Docker is unavailable (its Snap Docker cannot bind `/tmp`). It transfers only source/build inputs, checks the image and loopback routes, then removes its named fixture. The fixture's discovered gateway is temporary; discover and configure the actual trusted Serve peer at deployment. It does not deploy the app or access the real NAS. T03 storage proof is pending review, and T04 must prove real tunnel/Serve identity, policy and network isolation before production use.

## Storage spike checks

`npm run test:storage` exercises bounded child-process storage and a loopback-only tus 1.0.0 fixture. `npm run smoke:storage -- --nas-write` checks a 1 MiB scoped NAS write. Run `npm run smoke:storage -- --cleanup-negative` before `--nas-transfer`: it times out an attached Docker CLI against disposable local test storage and proves cleanup retains files until the exact writer container exits. `--nas-transfer` first compares active server-plus-storage-worker RSS for 16 MiB and 128 MiB transfers under the same 8 MiB chunk and single-transfer load; it samples `/proc` every 25 ms while PATCHes run and reports the upload client separately. It then runs the 128 MiB tus server restart/resume/hash case and removes the unique NAS fixture only after its container exits. `--hard-nfs` builds a dedicated internal Ganesha NFS server/client pair, proves normal I/O and unmount/remount, then uses an independent watchdog to restore a paused fixture server while measuring timed-out-but-still-blocked workers and HTTP liveness. It never pauses or mounts the shared NAS. These checks do not enable production uploads. The exact mount and failure evidence is in the [runtime contract](docs/runtime-contract.md#t03-storage-spike-status-2026-09-23).
