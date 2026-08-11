# Hermes Mobile

Hermes Agent as an installable web app (PWA) for Android Chrome — the Hermes Desktop
renderer, with the Electron shell stripped out, running as a plain static web app
in front of a Hermes gateway.

Sessions live in Hermes (the gateway), never in the browser. The UI is a cache of
backend truth, per the desktop engineering invariants in
[`apps/desktop/AGENTS.md`](apps/desktop/AGENTS.md).

## Status (2026-08-11)

**Deployed and working.** The app is live at `https://hermes-mobile.<domain>`
(domain scrubbed from the repo; placeholder `example.lan` — see
[`deploy/nginx-hermes-mobile.conf`](deploy/nginx-hermes-mobile.conf)) and is the
daily driver on a real Android phone: chat, sessions, file/image attach, and
HEIC photos all work end-to-end through the gateway.

What is in place:

| Area | What works |
|---|---|
| Browser bridge | `window.hermesDesktop` shim over web APIs — REST, WebSocket dial, connection config, uploads. Missing members are `undefined` and callers feature-detect (`REQUIRED_BRIDGE_MEMBERS` guards compile-time) |
| Auth | Same-origin cookie login through the proxy (dev Vite proxy / prod nginx). **No gateway setup pass**: the app defaults to its own origin and only shows the login screen when the session cookie is missing |
| Attach | "+" menu uploads files, folders and images through the gateway; images outside `png/jpg/jpeg/gif/webp` (HEIC/HEIF/AVIF/BMP/TIFF) are transcoded to JPEG in the browser via lazily-loaded `heic2any` WASM |
| Mobile layout | Below 768px the sessions/files rails leave the grid and open as edge drawers with a tap-outside backdrop; desktop-only chrome (keybinds panel, layout editor doors, sidebar swap) is removed or gated |
| PWA shell | `manifest.webmanifest`, generated icons, app-shell service worker (hashed assets cache-first, navigation network-first, gateway routes never intercepted), safe-area insets |
| Deployment | Reference SWAG/nginx site config (static `dist/` + `/api`, `/auth`, `/login`, `/fonts` proxied to the gateway, WebSocket upgrade headers, LAN allowlist) |

Not started:

- **Preview/git bridge** (scoped — the "edited files → unavailable" gap): the
  gateway already exposes the full git surface (`/api/git/status`,
  `/api/git/file-diff`, `/api/git/review/*`, `/api/git/worktrees`,
  `/api/git/branches` — same paths `web_git.py` serves the dashboard), so this
  is pure shim work in `src/bridge/browser-bridge.ts`, no gateway changes:
  - Phase 1 (read-only, the user's pain): add `git.repoStatus`, `git.fileDiff`,
    `git.review.list`, `git.review.diff`, `git.review.revParse` mapped 1:1 to
    the GET routes; resolve repo root via `/api/fs/git-root`. Makes the
    composer coding rail's edited-file list clickable → diff preview; the
    plain file preview (`readFileText`/`readFileDataUrl`) already works.
  - Phase 2 (review writes): `review.stage/unstage/revert/commit/push/
    createPr` + `commitContext` over the POST routes — the review pane on
    mobile.
  - Phase 3 (worktrees): `worktreeList/add/remove`, `branchList/baseBranchList/
    branchSwitch` for the "Start work" flow.
  - Explicitly out of scope: `git.scanRepos` (no gateway scan endpoint — the
    PWA resolves the single repo via `git-root` from the workspace cwd).
- **Bundle/perf pass**: shiki chunk is ~3.3 MB gzipped; investigate lazy
  loading/code splitting beyond the already-split heic2any WASM chunk.
- **Web Share API** (navigator.share for messages/files).
- **Bottom navigation** on narrow viewports.
- **Touch-target polish** (titlebar buttons are ~20px).

## What was stripped

- `apps/desktop/electron/` — the Electron main process (window lifecycle, local backend spawning, native fs/git/terminal)
- `apps/desktop/e2e/` + playwright config — Electron e2e harness
- electron-builder packaging scripts, native-deps staging, notarization
- `node-pty`, `electron`, `electron-builder`, `rcedit`, `@electron/rebuild` deps

## What remains

- `apps/desktop/` — the full Vite + React 19 renderer (chat, approvals, clarify,
  sudo, secret prompts, slash commands, model picker, sessions)
- `apps/shared/` — `@hermes/shared` (JsonRpcGatewayClient, websocket-url, types)
- Everything is `window.hermesDesktop?.x`-guarded; the renderer degrades without
  Electron. The browser shim (`src/bridge/browser-bridge.ts`) implements the
  bridge over web APIs.

## Development

```bash
npm install              # root workspace install (mandatory)
npm run dev -w apps/desktop     # vite dev server on :5174 (LAN reachable)
npm run build -w apps/desktop   # static SPA in apps/desktop/dist
npm run preview -w apps/desktop # serve the build on :4174
npm run typecheck -w apps/desktop
npx vitest run -w apps/desktop  # unit tests
```

Node >= 22.22 (see `.nvmrc`) — the build fails with a readable error on older
Node. Workspace layout is preserved from the upstream repo so `file:../shared`
and the vite aliases keep working.

### Testing against a cookie-auth (username/password or OAuth) gateway

The gateway's CORS never sends `Access-Control-Allow-Credentials`, so the
browser build cannot authenticate cross-origin. The dev server proxies the
gateway instead — same-origin, cookies just work:

1. `npm run dev` (default proxy target `http://192.168.89.100:9119`; override
   with `HERMES_DEV_PROXY_TARGET=http://host:9119 npm run dev`)
2. Since 2026-08-11 the app **defaults to its own origin** (no stored
   connection → gateway = `window.location.origin`), so on the dev server you
   can skip Settings entirely: open `http://localhost:5174` and sign in. If a
   stored connection exists it still wins; Settings → Gateway shows the
   same-origin default as the Remote URL.
3. Sign in → the gateway's own `/login` page opens (proxied) → enter
   credentials → the session cookie lands on the dev origin → reconnect.

Production wants the PWA served same-origin with the gateway — the proxy is
dev-only. See [`deploy/nginx-hermes-mobile.conf`](deploy/nginx-hermes-mobile.conf)
for the production recipe.

### Production deployment (SWAG/nginx)

1. `npm run build -w apps/desktop`
2. `scp -r apps/desktop/dist <swag-host>:/config/www/hermes-mobile/`
3. Copy `deploy/nginx-hermes-mobile.conf` → `/config/nginx/site-confs/`
   (SWAG reloads automatically; there must be only ONE hermes-mobile site file —
   two files collide on `listen`/`proxy_http_version` and fail `nginx -t`)
4. DNS: `hermes-mobile.<domain>` → SWAG host (same as the dashboard)
5. Open the site on the phone and sign in — no Remote URL configuration needed
   (same-origin default). Settings → Gateway only exists for overrides.

The service worker + manifest only activate over HTTPS, so installability and
the offline shell appear on this deployment (not on plain-HTTP LAN dev).

### Known deployment gotchas

- **WebSocket upgrades are the make-or-break leg.** The `/api` location in the
  nginx config is deliberately self-sufficient (`proxy_http_version 1.1`,
  `Upgrade`/`Connection` headers spelled out). It must NOT `include proxy.conf`
  — SWAG's proxy.conf already sets those, and duplicating them is an nginx
  `[emerg] duplicate` error. Symptom of a broken upgrade leg: tickets mint but
  the app never connects (the gateway's 426 or silent close).
- The gateway's session cookie is host-only — the app and `/api` must share one
  origin. Never point the Remote URL at the real gateway host.
- The real domain must not appear in the repo (git history is scrubbed); use
  the `example.lan` placeholder and substitute at deploy time.

## Upstream

Forked from NousResearch/hermes-agent `apps/desktop` + `apps/shared` (MIT).
Tracked upstream sync: `git remote add upstream https://github.com/NousResearch/hermes-agent.git`
