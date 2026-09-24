# Roadmap

What is proven and what is next, scoped per item. This is a working document —
items move from **Shipped** to **Next** only when the implementation and its
automated acceptance evidence exist. “Shipped” means present in `main`, not that
every later change has received a fresh real-phone pass; the latest post-sync
phone re-test remains part of the release acceptance checklist.

## Shipped

- **PWA foundation** — the Electron shell is stripped; same-origin cookie/ticket
  auth boots directly to the gateway; installable manifest/icons, app-shell
  service worker, safe-area layout, and the reference SWAG deployment are in
  place. Gateway `/api`, `/auth`, `/login`, `/ws`, and WebSocket traffic are
  never service-worker intercepted; same-origin static resources are cached.
- **Mobile shell and interaction** — narrow sidebars/panes are explicit touch
  overlays with edge reveal and tap-outside close; terminal/local-only chrome
  is removed from registration and restored layouts; Bot Mode's routines rail
  stays desktop-only; command/model lists scroll on the first touch gesture.
- **Composer and session reliability** — touch-primary Enter inserts a newline,
  touch-generated mouse movement cannot steal focus, the model menu refreshes
  backend catalogs on open, stale subagent state reconciles when sessions resume,
  stale same-origin token connections self-heal, and untagged gateway sidebar
  rows no longer route through a nonexistent local agent.
- **Attachments and inbound share** — the browser picker works on Android,
  files/folders/images upload through the gateway, unsupported image formats
  use the browser HEIC/HEIF/AVIF decode ladder, and the Web Share Target stages
  media/text into an existing or new composer draft without auto-sending.
- **Media and voice** — audio/video/file playback and downloads use authenticated
  same-origin gateway routes with range support; on-device Android TTS is the
  default read-aloud rung with Finnish/English sentence detection, while
  configured server voices remain the fallback.
- **Remote Git review and shipping** — review diffs, stage/unstage/revert,
  commit/push, PR actions when GitHub readiness is reported, branches, and
  worktrees run through the gateway. Repository-root resolution and literal
  tracked pathspecs fix nested workspaces and special filenames; untracked
  names remain raw for the gateway's `--no-index` fallback. The renderer can
  present a multi-file untracked-directory payload when the gateway supplies
  one. Review rows and ship controls are explicit, finger-sized paths on coarse
  pointers.
- **Upstream containment and verification** — five throttled renderer-split syncs
  are documented; the workflow checks dependency drift and stripped paths.
  Repository-wide typecheck/lint, full tests, build, diff checks, and phone
  acceptance are explicit gates. Lint currently has 0 errors and 291 warnings;
  warning cleanup is opportunistic maintenance, not a claim of a warning-free
  tree.

## Next

### 1. PWA link routing and URL safety

- Normal HTTP(S) link clicks currently route to `openPreview()`, whose Browser
  surface depends on Electron's `<webview>`. The PWA has no such element, so
  the link does not load on the phone.
- In the browser bridge, validate the URL/scheme and send user-activated web
  links directly to the system browser; keep the in-app Browser for the real
  Electron desktop build.
- Hide the "Open in in-app browser" context-menu action in the PWA and leave
  "Open in external browser" as the direct choice.
- Gate this on `isBrowserBridge()` (the capability), not phone width or
  `pointer: coarse`: the missing capability exists at every PWA viewport size.
  Local HTML artifact previews remain in-app because they use a sandboxed iframe.
- Re-evaluate this against upstream's post-`b5b8cad7` always-external-link
  setting during the next split sync; do not duplicate policy if upstream's
  new shape already covers the browser target.

### 2. Gateway Git mutation contract

The PWA transport and path handling are shipped. The remaining work is the
unchanged gateway contract:

- A collapsed untracked-directory row can still return an empty diff when the
  gateway's `git diff --no-index /dev/null <dir>/` fallback cannot enumerate
  files. The renderer already parses a multi-file payload; the gateway must
  provide a bounded, Git-visible preview for the empty case.
- Reject or specially handle rows that cannot be restored from `HEAD` (staged
  additions, renames, staged deletions) before relying on the current revert
  endpoint; do not present a discarded-step response as success.
- Verify every mutation against the refreshed review state, so a gateway reply
  of `{ok: true}` cannot mask a failed required Git command.
- Add authenticated disposable-repository probes for nested cwd, special
  filenames, ignored files, directories, additions, renames, and failures.

These are reliability gaps, not reasons to reintroduce Electron or change the
Hermes Agent backend without explicit agreement.

### 3. Browser-bridge capability truthfulness

- Hide or remove unavailable native log actions and their empty shims
  (`getRecentLogs`, `revealLogs`). Keep `resetBootstrap`/`repairBootstrap`
  compatibility shims only while every caller performs a real browser reload;
  hide the local-only install-repair action in browser mode. Do not return
  silent success for an effect that never happens.
- Audit `openExternal` against an allowlist of safe schemes before exposing it
  to user/agent-provided URLs. This is part of the PWA link work above.
- Scope or invalidate the review file tree's repository-root cache by
  connection/profile, like the Git facade. This is a latent multi-source seam;
  the current single-origin PWA limits exposure but should not rely on that.

### 4. Remote file management

- Rename/trash degrade to an unavailable action because the gateway currently
  has no equivalent REST operations. Add explicit gateway contracts or keep the
  UI disabled; do not fake success in the renderer.

### 5. Bundle and upload limits

- Shiki remains the dominant chunk (~3.1 MiB gzipped). Investigate lazy loading
  and code splitting beyond the existing `heic2any` split.
- `POST /api/files/upload` is base64 JSON. Typical photos/PDFs work, but large
  files are fully buffered and can hit gateway size limits. The gateway's
  multipart/chunked upload route still needs renderer support for metadata and
  progress/error handling.

### 6. Remaining mobile layout work

- Titlebar icon controls remain substantially below the 44px touch guideline;
  review/branch/PR controls have already been corrected.
- The upstream Skills hub's master/detail split still needs a narrow-viewport
  presentation. `src/app/skills/*` is upstream-owned, so re-evaluate on each sync
  instead of carrying a permanent local fork if upstream fixes the layout.

### 7. Outgoing share

- Add `navigator.share` for sharing selected messages/files out of Hermes. The
  inbound share *target* is done; the outgoing share *API* is not wired.

## Explicitly out of scope

- `git.scanRepos` — no gateway repo-scan endpoint; resolve the active repository
  via `/api/fs/git-root` from the workspace cwd.
- Reintroducing Electron, a local agent/backend, a local filesystem, or terminal
  capability doors.
- Auto-sending inbound shares; staging for user review is intentional.
- Broad product redesigns such as bottom navigation without a concrete user
  need. They are not defects and do not belong on this engineering roadmap.
