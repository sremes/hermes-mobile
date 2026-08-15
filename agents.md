# AGENTS.md — Hermes Mobile

Orientation for AI agents working in this repo. Read this first, then
[`apps/desktop/AGENTS.md`](apps/desktop/AGENTS.md) — the desktop engineering
guide is the deep contract and still applies (state authority, identity,
reconciliation, resolvers-as-ladders, performance, testing). This file adds
what is true about this fork that the desktop guide does not cover.

## What this project is

A fork of the Hermes Desktop app with the Electron shell stripped out, shipped
as a browser PWA that talks to a Hermes **gateway** through a same-origin
reverse proxy. It exists so the household can use Hermes from an Android
phone.

The three authoritative parties, unchanged from desktop:

- **The gateway** owns the work: sessions, tools, model calls, streaming, and
  the filesystem the app can see (REST `/api/fs/*`, uploads).
- **The renderer** owns the experience: navigation, presentation, interaction.
- **nginx/the dev proxy** owns routing: it makes the gateway look same-origin
  to the browser. This is a hard constraint, not a convenience — see below.

There is no Electron, no local backend, no local filesystem. Never add one
back, and never reimplement gateway behavior in the renderer.

## The same-origin rule (why the app works at all)

The gateway's session cookie is **host-only** and the gateway's CORS never
allows credentials. Therefore every request the app makes must land on the
gateway through the SAME origin the app is served from:

- Dev: the Vite dev server proxies `/api`, `/auth`, `/login`, `/fonts` to the
  gateway (`HERMES_DEV_PROXY_TARGET`, default `http://192.168.89.100:9119`).
- Prod: the SWAG site serves `dist/` AND proxies those same four paths to the
  gateway (`deploy/nginx-hermes-mobile.conf`).

Consequences:

- The app's connection defaults to `window.location.origin` when nothing is
  stored (`resolveConnection` in `src/bridge/browser-bridge.ts`). **Never**
  revert to requiring a Remote URL — the setup pass is deliberately gone.
- The WebSocket upgrade leg is the fragile part: the `/api` location in the
  nginx config must keep `proxy_http_version 1.1` + `Upgrade`/`Connection`
  headers, must not `include proxy.conf` (duplicate-directive `[emerg]`), and
  the site file must not be duplicated in `site-confs/`.
- Never "helpfully" switch the app to call a gateway URL directly — cross-origin
  cookie auth is impossible and the failure is confusing.

## The bridge seam

`window.hermesDesktop` is the only channel between the renderer and the world:

- `src/bridge/browser-bridge.ts` — the browser shim. Implemented members use
  web APIs (fetch, WebSocket, FileReader, canvas). Members with no browser
  equivalent are **`undefined`** — do NOT stub them with silent no-ops (a
  no-op stub masks a dead capability; the `selectPaths` history is the lesson).
- `src/global.d.ts` — the bridge type; `REQUIRED_BRIDGE_MEMBERS` is the
  compile-time guard. Omitted members must be feature-detected (`?.`) at call
  sites.
- Renderer callers branch on capability, e.g. `window.hermesDesktop?.selectPaths
  ? legacy : browserPicker()`.

Rules: renderer code never touches Node/Electron APIs; the shim never
reimplements agent behavior; new capabilities arrive as small additions to the
shim + typed in `global.d.ts`.

## Share intake (Web Share Target)

Shares from other Android apps arrive as a POST navigation to `/share`; the
service worker is the only reader of that body. The seam, in order:

1. `public/sw.js` captures `POST /share`, stashes the payload (files + text
   fields) in the `hermes-mobile-share-v*` cache under `/share/items/N` +
   `/share/meta`, redirects to `/?shared=1`. `/share/*` reads are cache-only —
   a network revalidate would overwrite the stash with `index.html`.
2. `src/lib/share-inbox.ts` pulls the stash out on boot; the intake dialog
   (`src/app/chat/share-intake-dialog.tsx`) asks where it goes.
3. **Continue stages, never sends** — user decision, do not regress. The
   dialog uploads the files (HEIC-safe ladder), then stashes a draft into the
   target composer: `stashSessionDraft(resolveComposerSessionKey(...))` for an
   existing session, `stashSessionDraft(null, ...)` for a new chat, then
   `openSession(...)` / `navigate('/')`. The user reviews and presses the real
   Send in the composer.

Two invariants that bit hard:

- **Draft key domain.** The composer keys drafts/queues on the durable lineage
  root (`resolveComposerSessionKey`), never the raw stored id — a compressed
  session's composer never looks up the tip id.
- **Stash-while-mounted.** A share-launched PWA boots onto the fresh chat, so
  the composer is already mounted when the draft lands; scope-change restore
  never fires. `stashSessionDraft` dispatches `hermes:composer-draft-stashed`
  and `use-composer-draft` repaints when the stash targets its own scope.
- Image attachments must carry `previewUrl` (data:) — the send path carries
  images via that preview, and the attachment chip renders from it.

## Mobile-first changes

The phone is the primary surface. Rules that have bitten before:

- **Gate desktop-only UI at the leaf** via `src/bridge/capabilities.ts` or
  `$narrowViewport` (the 768px breakpoint). The pane tree stays intact; dead
  surfaces render nothing. Do not rebuild the shell.
- **Touch paths must be verified on a real phone.** Headless/browser testing
  hides touch regressions (the DOM-detached file-input, the never-fired
  narrow-reveal event, and the pointer-quiet guard that ate the first touch
  scroll are the history).
- Android quirks that are real: dynamically created `<input type="file">` must
  be attached to `document.body` before `click()`; no Chromium build decodes
  HEIC (use the 3-rung decode ladder ending in lazy `heic2any` WASM → JPEG);
  hover-only affordances are dead on touch; a `pointer-events-none` overlay
  guard is invisible to touch until a tap wakes it.
- Secure-context features (service worker, installability, notifications,
  share target, clipboard read) only exist over HTTPS — plain-HTTP LAN dev
  cannot exercise them; only the production deploy can.

## Gateway REST = the app's filesystem

The phone has no local fs. All file operations go through the gateway:

- `GET /api/fs/list`, `GET /api/fs/default-cwd` — browsing
- `POST /api/files/upload` — `{path, data_url, overwrite}` JSON, returns a host
  path; the agent then reads the file from ITS filesystem
- `POST /api/chat/image-upload` — images only, accepts `png/jpg/jpeg/gif/webp`;
  anything else must be transcoded in the browser first
- Auth: 401 unauthenticated. Everything is cookie-authed, same-origin.

Do not add client-side storage as a substitute for gateway paths.

## Git preview

The gateway already exposes the full git surface (`/api/git/status`,
`/api/git/file-diff`, `/api/git/review/*`, `/api/git/worktrees`,
`/api/git/branches`; repo root via `/api/fs/git-root`) and the renderer's
`remoteGit` facade (`lib/desktop-git.ts`) is live in the browser — the review
pane reads real diffs today. Path context matters: gateway git routes return
paths relative to the **repo root**, while the review pane's cwd may be a
subdirectory — resolve the root via `desktopGitRoot(cwd)` before joining
(file-tree.tsx does this). `git.scanRepos` is out of scope (no gateway
endpoint). Remaining work (review writes, worktrees) is tracked in
[`ROADMAP.md`](ROADMAP.md).

## Repository hygiene

- **The real domain is scrubbed from history.** The repo uses the
  `example.lan` placeholder everywhere (`deploy/nginx-hermes-mobile.conf`,
  README). Never commit the real domain; substitute it only at deploy time.
  The git history was rewritten with `git-filter-repo` — force-push history
  rewrites only with explicit user approval.
- `apps/desktop/dist/` is build output (gitignored); deploy artifacts live in
  `deploy/`.
- Commits are small and per-stage; each stage is pushed and the remote SHA
  verified. Do not bundle unrelated changes.
- **Upstream sync = throttled merges at release boundaries**, not per-commit.
  The re-root graft, sync procedure, expected conflict surface, and watcher
  spec are in [`UPSTREAM-SYNC.md`](UPSTREAM-SYNC.md). The `upstream` remote is
  read-only; never merge it before applying the graft, and never let the fork
  drift more than a few weeks without a sync.

## Verification

```bash
cd apps/desktop
npx tsc -p . --noEmit        # typecheck (fast, run first)
npm run build                # vite build (~5 s)
npm run test                 # unit tests (vitest)
```

Then, for any UI change: `HERMES_DEV_PROXY_TARGET=http://<gateway>:9119 npm run dev`
and exercise the path (settings/auth via the proxied origin). For mobile
changes, hand off to the phone — the user tests on a real Android device.

## Deploying (for agents asked to ship)

1. `npm run build -w apps/desktop`
2. `scp -r apps/desktop/dist <swag-host>:/config/www/hermes-mobile/`
3. site-confs already in place (one file only); `docker exec swag nginx -t` +
   reload if the nginx config changed
4. Static files need no reload; the service worker updates hashed assets on
   the next visit (hard refresh or clear-site-data if the shell itself changed)
5. A manifest change (e.g. share_target) requires re-adding the PWA on the
   phone — Chrome only reads the manifest at install time.

## Current state

Shipped: browser bridge + same-origin auth, attach/HEIC pipeline, PWA shell,
drawer rails, touch-scroll fixes, review read path, Web Share Target
(Continue-to-composer flow). What's next lives in
[`ROADMAP.md`](ROADMAP.md) — check it before starting work; items are scoped
with explicit out-of-scope boundaries.
