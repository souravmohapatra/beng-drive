# Beng Drive visual preview

**Review checkpoint:** BD2-T07. These screens show the proposed modern glass, pastel mint and sage direction with deep forest text. The gallery is synthetic development data. It sends no upload, owner or key request and makes no claim that a file was saved.

Start from the repository root with `npm run preview:design`, then open `http://127.0.0.1:4177/design-preview?screen=unlock`. Vite binds only to `127.0.0.1:4177` and requires the port to be free. Use the Guest/Owner navigation or the `screen` query parameter. The preview gallery is loaded only by Vite development mode. Production `/` provides invitation guidance, `/c/:token` serves the integrated guest flow, and the admin listener serves the owner dashboard; admin API access still requires the private Unix socket.

## A small review set

| Guest desktop | Guest mobile | Owner desktop |
| --- | --- | --- |
| [Unlock at 1440 × 900](design-previews/desktop-unlock-1440.png) | [Unlock at 390 × 844](design-previews/mobile-unlock-390.png) | [Collections at 1440 × 900](design-previews/desktop-owner-list-1440.png) |
| [Mixed queue and finalizing](design-previews/desktop-queue-1440.png) | [Mixed queue and finalizing](design-previews/mobile-queue-390.png) | [Collection detail](design-previews/desktop-owner-detail-1440.png) |
| [Storage unavailable](design-previews/desktop-storage-error-1440.png) | [Private receipt](design-previews/mobile-receipt-390.png) | [Create collection](design-previews/desktop-owner-create-1440.png) |

Additional revised states: [desktop wrong key/cooldown](design-previews/desktop-unlock-error-1440.png), [mobile wrong key/cooldown](design-previews/mobile-unlock-error-390.png), [mobile owner list](design-previews/mobile-owner-list-390.png), [mobile owner detail](design-previews/mobile-owner-detail-390.png), and [mobile storage error](design-previews/mobile-storage-error-390.png).

All are Chrome 153.0.8010.53 full-page captures from the responsive device toolbar at the stated CSS viewport; screenshots use device pixel ratio 2. Mobile is simulated, not a physical phone. The tall images include content below the initial viewport. No screenshot contains a real invitation or key.

## State walkthrough

| Area | Preview states | Key point to review |
| --- | --- | --- |
| Invitation and unlock | `welcome`, `unlock`, `unlock-error` | Link and key are separate; wrong key and cooldown appear inline. Collection title, welcome, expiry and allowance remain hidden before successful unlock. |
| Upload journey | `queue`, `receipt` | The post-unlock sample shows collection details. Queue covers queued, uploading, paused, interrupted, finalizing, completed, cancelled and failed files. Transmitted bytes and confirmed saved status use separate language. Receipt is browser-session private in the proposed flow. |
| Guest exceptions | `error-storage`, `error-quota`, `error-expired`, `error-revoked`, `error-invalid` | Each offers a next step; unavailable storage never implies saved completion. |
| Owner | `owner-list`, `owner-empty`, `owner-create`, `owner-edit`, `owner-detail`, `owner-key` | Expiry and allowance, contributor summary, storage warning, one-time key, rotation/revocation and validation conflict. Saved files remain after revocation. |

The queue says “SIMULATED · NO TRANSFER”; `finalizing` says bytes arrived but saving is unconfirmed. Its fixed sample uses decimal MB: 24 + 1,200 + 1 + 8 + 6 + 500 + 12 = **1,751 MB selected** across seven uploadable files. The 3 KB cancelled file is excluded. Transmitted amounts are 16 + 360 + 1 + 0 + 6 + 215 + 0 = **598 MB**, so the aggregate bar is 34.2%; only the completed 6 MB file is confirmed saved. This is fixture arithmetic, not runtime transfer. On mobile, the copy tells guests to keep the tab open and to reselect the same file after an interruption once real uploads exist. The copy button in the one-time-key preview copies only a synthetic key and reports clipboard failure.

## Interaction and accessibility inspection

Chrome 153 on macOS: the 390 px and 320 px queue and error layouts measured `document.documentElement.scrollWidth === innerWidth` (390/390 and 320/320). At 200% Chrome page zoom, the owner detail reflowed and remained readable in the available browser window; a full physical-device audit remains open. Labels and status words are present in the accessibility tree. The rotate confirmation starts on **Keep as is**, wraps Shift+Tab/Tab between its two buttons, closes on Escape and returns focus to **Rotate key**. Visible keyboard focus uses a 3 px forest outline.

With DevTools `prefers-reduced-motion: reduce`, a representative button's computed transition and animation duration both resolved to `1e-05s`. With `prefers-reduced-transparency: reduce`, a `.glass` panel resolved to `rgb(255, 255, 255)` and `backdrop-filter: none`. The stylesheet also has an opaque `@supports not (backdrop-filter)` fallback; Chrome supports the property, so that unsupported-browser branch was not directly exercised.

Rendered normal input colors in Chrome are border `rgb(104, 141, 114)`, fill `rgb(251, 255, 250)`, and adjacent form surface `rgb(255, 255, 255)`. WCAG luminance calculations give **3.68:1** border/fill and **3.72:1** border/form. Wrong-key border `rgb(166, 66, 56)` gives 6.01:1 against fill and 6.07:1 against white. Keyboard focus showed the visible 3 px outline; its forest color gives 6.12:1 against white. A disabled input style, if used later, gives 3.28:1 border/fill; this gallery has no disabled input. The owner edit conflict shows a disabled Save button and text error. Representative text ratios remain primary 11.82:1, secondary 5.61:1, warning 5.79:1, error 5.93:1, white/action 5.52:1. These are selected pairs, not an exhaustive per-pixel translucent-surface audit.

**Limits:** this gallery's historical captures do not prove authentication, transfer or routing. The owner approved this visual direction on 2026-09-23. Real guest and owner API integration was browser-checked on isolated local storage on 2026-10-04; see the browser flow in [upload-api.md](upload-api.md) and dashboard contract in [collections-api.md](collections-api.md). Physical iOS/Android, Safari, Firefox, screen-reader, real-NAS/public transfer and private-network acceptance remain separate release gates.
