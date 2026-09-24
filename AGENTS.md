# AGENTS.md — Hermes Mobile

Orientation for AI agents working in this repo. Read this first, then the
documentation map below — each file has one role, and every change or sync
must be checked against them for staleness.

## Documentation map

Five files, five roles. Keep them that way — no cross-loading:

- **README.md** — *what this is, for humans.* Overview, the fork model in
  one paragraph, features, run/deploy, known limits. No procedure, no
  roadmap, no agent rules.
- **AGENTS.md** (this file) — *how to work here, for agents.* Structure,
  invariants, seams, verification, deploy, and the essentials of each
  process, pointing to the authoritative doc.
- **UPSTREAM-SYNC.md** — *the sync, authoritatively.* Mechanism, exact
  commands, filter inventory, conflict surface, decision rules, per-sync
  records. It may point to a named ROADMAP section, but carries no roadmap
  content.
- **ROADMAP.md** — *what's shipped / what's planned.* Done and Next with
  explicit out-of-scope. No procedure.
- **apps/desktop/AGENTS.md** — the upstream desktop engineering contract
  (state authority, identity, reconciliation, resolvers-as-ladders,
  performance, testing). Still applies; this file only adds what the fork
  changes.

**Staleness is checked on every change.** These docs describe moving
mechanics — graft SHAs, filter inventory, conflict counts, sync records —
and every sync or filter change invalidates some of them. Whenever you make
repo changes, and after every sync, re-read the docs that describe what you
touched and fix anything stale in the same commit. Never leave "the docs are
wrong" as a known issue.

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
allows credentials. Therefore cookie-session production requires every request
to land on the gateway through the SAME origin the app is served from. The
renderer retains token-mode configuration only for compatibility; same-origin
saves are normalized to OAuth/WebSocket-ticket mode because legacy token
query authentication can be rejected:

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

- `src/bridge/browser-bridge.ts` — the browser shim. Implemented members include
  REST/WebSocket transport, cookie auth, file reads/uploads, clipboard,
  notifications, external opening, battery/wake-lock, and profile persistence.
  Unsupported members that select a fallback path are omitted (`undefined`);
  callers feature-detect them. `renamePath`, `trashPath`, terminal/local-Git
  bridge, and other Electron-only members remain omitted. Legacy token-mode
  connection values are stored in plaintext localStorage; that compatibility
  path assumes a personal, same-origin deployment. A broader deployment needs
  a documented threat model and safer credential storage.
- `src/bridge/capabilities.ts` — the capability gates. New UI must detect the
  actual bridge member, never infer support from viewport or pointer media
  queries.
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

1. `apps/desktop/public/sw.js` captures `POST /share`, stashes the payload (files + text
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
  and `use-composer-draft` repaints when an EXTERNAL stash targets its own
  scope. The composer's own pipeline (typing debounce, pagehide, unmount,
  HUD flush) raises `selfStashDepthRef` around `stashAt`, and the listener
  skips those — consuming its own stash repainted the editor and slammed the
  caret to the end on every typing pause (mobile cursor jump).
- Image attachments must carry `previewUrl` (data:) — the send path carries
  images via that preview, and the attachment chip renders from it.

## Subagent reconciliation

Backend roster snapshots are authoritative when a session is reopened.
Reconciliation must preserve accumulated stream history and session-scoped
retired child identities so late events cannot resurrect completed work.

## Mobile-first changes

The phone is the primary surface. Rules that have bitten before:

- **Gate desktop-only UI through existing capabilities** via
  `src/bridge/capabilities.ts` or `$narrowViewport` (the 768px breakpoint).
  Unavailable terminal panes must also be excluded from registration and layout
  presets, with stale terminal entries removed on boot; a null leaf alone leaves
  empty pane chrome behind. The Bot Mode routines rail never registers below
  the breakpoint. Preserve the rest of the tree and its saved state.
  Do not rebuild the shell.
- **Touch-primary Enter policy:** keep the composer-local
  `hooks/use-enter-newline.ts` capability heuristic (`pointer: coarse` minus
  fine+hover) and native `beforeinput` line-break handling when importing
  upstream composer changes. Preserve undo/draft synchronization, the
  `data-composer-caret` placeholder exclusions, and the touch-specific
  help-row omission.
- **Touch paths must be verified on a real phone.** Headless/browser testing
  hides touch regressions; handoff must cover the relevant device paths rather
  than treating DOM tests as phone acceptance.
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
- Production auth: 401 unauthenticated; the supported deployment is
  cookie-authenticated and same-origin. Legacy token mode exists only for
  compatibility with explicitly configured non-same-origin gateways.
- `GET /api/files/stream` and `GET /api/files/download` are cookie-authenticated
  gateway routes. Browser audio/video must keep using relative same-origin URLs,
  including Range semantics, rather than a `file://` or Electron protocol URL.

Do not add client-side storage as a substitute for gateway paths.

## Git preview

The gateway already exposes the full git surface (`/api/git/status`,
`/api/git/file-diff`, `/api/git/review/*`, `/api/git/worktrees`,
`/api/git/branches`; repo root via `/api/fs/git-root`) and the renderer's
`remoteGit` facade (`lib/desktop-git.ts`) is live in the browser — the review
pane reads and mutates real repository state through this facade. The shipped
surface includes review diffs, stage/unstage/revert, commit/push, PR operations,
branches, and worktrees. Path context matters: gateway git routes return paths
relative to the **repo root**, while the review pane's cwd may be a
subdirectory. The facade and file tree resolve the root before joining; tracked
row names use literal pathspecs, while untracked names remain raw filesystem
paths for the gateway's `git diff --no-index` fallback. `git.scanRepos` is out
of scope (no gateway endpoint). Remaining reliability work is tracked in
[`ROADMAP.md`](ROADMAP.md).

## Upstream sync

The fork tracks upstream Hermes Desktop via **throttled merges at release
boundaries** — not per-commit. The full procedure, measured numbers, fork
inventory, and decision rules live in [`UPSTREAM-SYNC.md`](UPSTREAM-SYNC.md);
read it before touching anything upstream-related. Essentials:

- **Never merge `upstream/main` directly** — that is the full monorepo; a raw
  merge produces ~1,200 modify/delete conflicts (measured). All merges happen
  against `upstream-desktop`, the filter-repo split of `apps/desktop` +
  `apps/shared` only.
- The re-root graft (`git replace --graft fd25c86… 2f11039f…`) is **local
  repo state** — re-applied as part of sync setup when the split lineage is
  re-imported (filter change or fork re-base). Once a sync lands, the split
  lineage is baked into `main`, so plain clones merge without it. SHAs and
  the recompute command in UPSTREAM-SYNC.md.
- Per sync: most stripped paths (Electron/e2e/packaging) never enter the
  split — the filter's `--invert-paths` pass removes them. Keep deleted any
  `DU` hits and assert the full strip list is empty. The historical
  `stage-native-deps.test.mjs` exception is now included in the explicit
  filter list shown in UPSTREAM-SYNC.md. Then run the dependency-drift
  check, `npm run check:lint`, build, full tests, and phone acceptance.
- Drift signals that mean STOP and decide, never merge blindly: a kept feature
  starts importing outside the split paths, or the post-sync stripped-path
  assertion finds anything.

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

## Verification

```bash
cd apps/desktop
npm run check:lint           # typecheck + repository-wide ESLint; 0 errors required
npm run build                # vite build (~5 s)
npm run test                 # unit tests (vitest)
```

Warnings are tracked separately; do not describe the tree as warning-free.
UI changes still require real-device acceptance when they depend on touch,
viewport, keyboard, clipboard, media, or PWA behavior.

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

What's shipped and what's next live in [`ROADMAP.md`](ROADMAP.md) (Done /
Next) — check it before starting work; items are scoped with explicit
out-of-scope boundaries.
