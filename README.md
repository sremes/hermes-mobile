# Hermes Mobile

Hermes Agent as an installable web app for Android Chrome. It is the Hermes
Desktop renderer with the Electron shell stripped out — a plain static web app
served in front of a Hermes gateway.

Install it from the browser ("Add to Home screen") and use it like a native
chat app: sessions, files, images, and the agent's full toolset, on the phone.

## How it works

- **No local backend.** The app is a thin client. Sessions, messages, models,
  tools, and the filesystem live on the Hermes gateway; the app talks to it
  over REST + WebSocket.
- **One origin.** The gateway's session cookie is host-only, so the app is
  served from the *same origin* it calls `/api` on. In production a single
  reverse-proxy site serves the static app and proxies the gateway paths; in
  development the Vite dev server proxies them.
- **Sessions are shared.** A session started on the phone is the same session
  on the desktop app — there is only the gateway's session store.

## What currently works

| Area | What works |
|---|---|
| Chat | Full conversation surface: sessions, streaming, approvals/clarify/sudo prompts, slash commands, model picker, voice notes (dictation/read-aloud) |
| Sign-in | Cookie login through the same-origin proxy. No setup screen: the app defaults to its own origin and only asks for credentials when the session cookie is missing |
| Attach | "+" menu uploads files, folders, and images through the gateway. Images outside `png/jpg/jpeg/gif/webp` (HEIC/HEIF/AVIF/BMP/TIFF) are transcoded to JPEG in the browser |
| Share to Hermes | Android share target: share photos/files/links from any app into Hermes, pick an existing session or a new chat, add a message, and the share lands in the composer as a staged draft — nothing is sent until you press Send |
| Files & git review | File browser through the gateway; the review pane lists changed files with working diffs (read-only) |
| Mobile layout | Below 768px the sidebar rails become edge drawers with a tap-outside close; desktop-only chrome is removed or hidden |
| PWA shell | Installable manifest + icons, app-shell service worker (offline shell, hashed-asset caching — gateway traffic is never cached), safe-area insets, Web Share Target registration |
| Deployment | Reference SWAG/nginx site config: static app + `/api`, `/auth`, `/login`, `/fonts` proxied to the gateway with working WebSocket upgrades |

Known limits: no native file picker (browser picker instead), no desktop-only
features (terminal, local git writes, native menus), and the outgoing
`navigator.share` API is not wired up yet.

## Development

```bash
npm install              # root workspace install (mandatory)
npm run dev -w apps/desktop     # vite dev server on :5174 (LAN reachable)
npm run build -w apps/desktop   # static SPA in apps/desktop/dist
npm run preview -w apps/desktop # serve the build on :4174
npm run typecheck -w apps/desktop
npm run test -w apps/desktop    # unit tests (vitest)
```

Node >= 22.22 (see `.nvmrc`) — the build fails with a readable error on older
Node.

The gateway's CORS never allows credentials, so the browser build cannot
authenticate cross-origin. The dev server proxies the gateway instead —
same-origin, cookies just work:

1. `npm run dev` (default proxy target `http://192.168.89.100:9119`; override
   with `HERMES_DEV_PROXY_TARGET=http://host:9119 npm run dev`)
2. The app defaults to its own origin, so no configuration is needed — open
   `http://localhost:5174` and sign in through the proxied login page.
3. The session cookie lands on the dev origin and the app reconnects.

## Production deployment (SWAG/nginx)

1. `npm run build -w apps/desktop`
2. `scp -r apps/desktop/dist <swag-host>:/config/www/hermes-mobile/`
3. Copy `deploy/nginx-hermes-mobile.conf` → `/config/nginx/site-confs/`
   (SWAG reloads automatically; there must be only ONE hermes-mobile site
   file — two files collide and fail `nginx -t`)
4. Point `hermes-mobile.<domain>` DNS at the SWAG host, open the site on the
   phone, sign in — no Remote URL configuration needed.

The service worker and manifest only activate over HTTPS, so installability,
the offline shell, and the share target appear on this deployment (not on
plain-HTTP LAN dev).

Two deployment gotchas that have bitten before:

- **WebSocket upgrades are the make-or-break leg.** The `/api` location in the
  nginx config is deliberately self-sufficient (`proxy_http_version 1.1`,
  `Upgrade`/`Connection` headers spelled out). It must NOT `include
  proxy.conf` — SWAG's proxy.conf already sets those headers, and duplicating
  them fails `nginx -t` (which then silently serves the stale config).
  Symptom of a broken upgrade leg: tickets mint but the app never connects.
- **One origin, always.** Never point the app at the real gateway URL — the
  host-only cookie makes cross-origin auth impossible.

## Repository layout

- `apps/desktop/` — the full Vite + React renderer (chat, approvals, model
  picker, sessions), plus `src/bridge/browser-bridge.ts`, the browser shim
  that replaces the Electron bridge with web APIs
- `apps/shared/` — `@hermes/shared` (JSON-RPC gateway client, types)
- `public/` — PWA shell: manifest, service worker, icons
- `deploy/` — the reference nginx site config
- Everything the renderer needs from the "outside" goes through
  `window.hermesDesktop?.x`; missing members are `undefined` and callers
  feature-detect

For agents working in this repo: [`AGENTS.md`](AGENTS.md) is the orientation.
For what's next: [`ROADMAP.md`](ROADMAP.md).

## Upstream

Forked from NousResearch/hermes-agent `apps/desktop` + `apps/shared` (MIT).
Track upstream sync with `git remote add upstream https://github.com/NousResearch/hermes-agent.git`
