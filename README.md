# Hermes Mobile

Hermes Agent as an installable web app (PWA) for Android Chrome — the Hermes Desktop
renderer, with the Electron shell stripped out, running as a plain static web app.

Sessions live in Hermes (the gateway), never in the browser. The UI is a cache of
backend truth, per the desktop engineering invariants.

## Status

Stage 1 (2026-08-07): Electron stripped fork. Builds and typechecks clean.
Next: browser bridge shim for the boot path (`window.hermesDesktop`), connection
UX, mobile responsive pass, PWA packaging.

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
  Electron. A browser shim (next stage) implements that bridge over web APIs.

## Development

```bash
npm install
npm run dev -w apps/desktop     # vite dev server on :5174 (LAN reachable)
npm run build -w apps/desktop   # static SPA in apps/desktop/dist
npm run preview -w apps/desktop # serve the build on :4174
npm run typecheck -w apps/desktop
```

Node >= 22.22 (see `.nvmrc`). Workspace layout is preserved from the upstream
repo so `file:../shared` and the vite aliases keep working.

### Testing against a cookie-auth (username/password or OAuth) gateway

The gateway's CORS never sends `Access-Control-Allow-Credentials`, so the
browser build cannot authenticate cross-origin (a dev server on another port
gets `Failed to fetch` on the ws-ticket mint). The dev server proxies the
gateway instead — same-origin, cookies just work:

1. `npm run dev` (default proxy target `http://192.168.89.100:9119`; override
   with `HERMES_DEV_PROXY_TARGET=http://host:9119 npm run dev`)
2. In Settings → Gateway: **Remote URL = `http://localhost:5174`** (or
   `http://<LAN-IP>:5174` on a phone) — the app talks to the gateway through
   the proxy.
3. Sign in → the gateway's own `/login` page opens (proxied) → enter
   credentials → the session cookie lands on the dev origin → reconnect.

Production still wants the PWA served same-origin with the gateway (reverse
proxy under the gateway's domain) — the proxy is dev-only.

## Upstream

Forked from NousResearch/hermes-agent `apps/desktop` + `apps/shared` (MIT).
Tracked upstream sync: `git remote add upstream https://github.com/NousResearch/hermes-agent.git`
