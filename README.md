# beng-drive

Private, resumable file intake with a guest upload portal and an owner-only dashboard. Collection/session APIs, NAS-backed transfers, recovery and cleanup are implemented; production routing and release acceptance remain gated. The [runtime contract](docs/runtime-contract.md) defines the behavior and boundaries. No `.agent` document is needed to build or run this source.

## Local setup

Use Node **24.21.0**. Install with `npm ci`, then run `npm run check`, `npm run build`, and `npm test`. `npm start` serves the built assets; build first. SQLite persists collections, sessions, upload accounting and the intake deadline at `DB_PATH`; payloads belong on the NAS. For local testing, use a disposable DB path and explicit fixture mode; do not use a production owner identity:

```sh
APP_MODE=fixture NODE_ENV=test \
PUBLIC_ORIGIN=https://drive.example.invalid ADMIN_ORIGIN=https://admin.example.invalid \
ADMIN_OWNER_LOGIN=fixture-owner@example.invalid TRUSTED_ADMIN_PROXY_IP=127.0.0.1 \
DB_PATH=/tmp/beng-drive-local-fixture.sqlite npm start
```

Fixture mode permits an empty owner login for fail-closed checks and a trusted loopback TCP proxy for isolated tests. Production requires a nonempty exact owner login and a private admin Unix socket; TCP proxy trust is not a production option. Secure-cookie browser flows require HTTPS. Compose publishes only the guest port on host loopback. Admin access additionally needs private Tailscale Serve and owner-only effective policy; no public test deployment is implied.

## Opening an upload window

Public intake is **closed by default**, including after upgrading an existing database to schema 6. Visitors to `/` or an invitation see a static “A little quiet, for now” page with no JavaScript. Guest APIs, tus operations and frontend assets are blocked before authentication, body processing or storage work. Only the minimal `/health/live` response remains available.

In the private owner dashboard, set **Accept uploads until (your local time)** and select **Open uploads**. While open, use **Update closing time** or **Close uploads now**. The server persists the UTC deadline and checks it on every guest request; expiry does not depend on leaving the dashboard open or running a scheduler. Collection keys, expiry, revocation and quotas still apply.

Closing blocks subsequent requests, not a chunk already accepted. It does not delete files or revoke keys/sessions; reopening restores access while those credentials remain valid. Normal partial-file cleanup continues. An already-open guest screen switches to the quiet page when its next request receives `INTAKE_CLOSED`.

This is an application-level gate compatible with the intended free Cloudflare Tunnel setup; no Workers or paid Cloudflare features are required. Closed requests still reach the origin—it is not an edge firewall or a substitute for DDoS protection. See the [private intake API](docs/collections-api.md#intake-window) for automation.

## Container contract

`compose.yaml` mounts local SQLite state at `/var/lib/beng-drive` and only the scoped NAS directory at `/data`. Both bind sources must already exist (`create_host_path: false`). Supply settings from `.env.example` privately and set `STATE_BIND_SOURCE` and `NAS_BIND_SOURCE` for the target host. Serve targets the private admin socket in the state directory. Existing Cloudflare connector credentials stay outside this app. The repository `.gitignore` excludes secret configuration, dependencies, builds and SQLite state; `.agent` and `.agents` use this checkout's Git local exclusion and must remain outside commits. Never package `.env`, `.agent`, `.agents`, `.git`, local dependencies or state.

The image is pinned to Node 24.21.0 by digest. `npm run smoke:container` uses a unique disposable fixture under `/home/beng` on the verified mini PC when local Docker is unavailable (its Snap Docker cannot bind `/tmp`). It transfers only source/build inputs, checks the image, default-closed guest routes, private socket and persistence, then removes its named fixture. It does not deploy the app or access the real NAS. Real tunnel/Serve identity, policy and network isolation still require acceptance before production use.

## Storage spike checks

`npm run test:storage` exercises bounded child-process storage and a loopback-only tus 1.0.0 fixture. `npm run smoke:storage -- --nas-write` checks a 1 MiB scoped NAS write. Run `npm run smoke:storage -- --cleanup-negative` before `--nas-transfer`: it times out an attached Docker CLI against disposable local test storage and proves cleanup retains files until the exact writer container exits. `--nas-transfer` first compares active server-plus-storage-worker RSS for 16 MiB and 128 MiB transfers under the same 8 MiB chunk and single-transfer load; it samples `/proc` every 25 ms while PATCHes run and reports the upload client separately. It then runs the 128 MiB tus server restart/resume/hash case and removes the unique NAS fixture only after its container exits. `--hard-nfs` builds a dedicated internal Ganesha NFS server/client pair, proves normal I/O and unmount/remount, then uses an independent watchdog to restore a paused fixture server while measuring timed-out-but-still-blocked workers and HTTP liveness. It never pauses or mounts the shared NAS. These checks do not enable production uploads. The exact mount and failure evidence is in the [runtime contract](docs/runtime-contract.md#t03-storage-spike-status-2026-09-23).
