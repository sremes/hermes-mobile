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

## Upstream

Forked from NousResearch/hermes-agent `apps/desktop` + `apps/shared` (MIT).
Tracked upstream sync: `git remote add upstream https://github.com/NousResearch/hermes-agent.git`
