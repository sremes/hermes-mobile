# Roadmap

What is proven and what is next, scoped per item. This is a working document —
items move from "Done" to "Next" as they ship.

## Done (proven on the phone)

- **Same-origin boot** — no setup screen; the app defaults to its own origin
  and only shows login when the session cookie is missing
- **Attach pipeline** — gateway uploads for files/folders/images; HEIC and
  friends transcoded to JPEG in the browser (3-rung decode ladder → lazy
  `heic2any` WASM)
- **PWA shell** — manifest, icons, app-shell service worker, installability
  over HTTPS
- **Mobile layout** — narrow-viewport drawer rails with tap-outside backdrop;
  desktop-only chrome gated at the leaf
- **Touch fixes** — model picker (and every cmdk list) scrolls on touch;
  review-pane file clicks open real diffs (repo-root path join)
- **Web Share Target** — share media/text from any Android app into Hermes,
  pick an existing session or a new chat, Continue stages the share in the
  composer as a draft (never auto-sends)
- **Model menu** — backend model cache busted on every open

## Next

### 1. Git review edge cases

Review reads and mutations now run from the resolved repository root, and tracked
row paths are sent as literal Git pathspecs. Remaining reliability work against
the existing gateway contract:

- Expand collapsed untracked-directory rows into a bounded, Git-visible preview;
  the current `git diff --no-index /dev/null <dir>/` call returns no useful diff.
- Reject or specially handle rows that cannot be restored from `HEAD` (staged
  additions, renames, staged deletions) before relying on the current revert
  endpoint; do not present a discarded-step response as success.
- Verify every mutation against the refreshed review state, so a gateway reply
  of `{ok: true}` cannot mask a failed required Git command.
- Add authenticated disposable-repository probes for nested cwd, special
  filenames, ignored files, directories, additions, renames, and failures.

These are reliability gaps, not reasons to reintroduce Electron or change the
Hermes Agent backend. Keep the fix at the PWA facade or track the gateway
contract separately with explicit agreement.

### 2. Bundle/perf pass

- shiki chunk ~3.3 MB gzipped — investigate lazy loading / code splitting
  beyond the already-split heic2any chunk

### 3. Bottom navigation (narrow viewports)

### 4. Touch-target polish

- Titlebar buttons are ~20px; target the 44px touch guideline

### 5. Large uploads

- `POST /api/files/upload` is base64 JSON — tens-of-MB files may hit gateway
  size limits. Fine for typical photos/PDFs; chunked or multipart upload if it
  becomes real

### 6. Remaining bridge gaps

- `writeText` shim member (the one unguarded `quickEntry` call site)
- rename/trash degrade gracefully (no REST equivalent on the gateway)

### 7. Outgoing share

- `navigator.share` for sharing messages/files OUT of Hermes (the share
  *target* is done; the share *API* is not wired)

### 8. Upstream sync routine

- Throttled merges at release boundaries; first merge + filter transition
  done 2026-08-16

### 9. Skills hub mobile layout

- The upstream Skills hub (hub browser + full-skill detail pane, landed in the
  2026-08-16 sync) does not scale on narrow viewports: the top skills box is
  too small to use while the hub browser dominates the screen. Needs a mobile
  separation — likely a narrow-viewport layout (drill-in list or tabs) instead
  of the desktop split.
- `src/app/skills/*` is upstream-owned and keeps moving in syncs — expect to
  re-apply the mobile layout each sync until upstream fixes it upstream

### 10. PWA link handling — always use the external browser

- Normal HTTP(S) link clicks currently route to `openPreview()`, whose Browser
  surface depends on Electron's `<webview>`. The PWA has no such element, so
  the link does not load on the phone.
- In the browser bridge, send user-activated web links directly to the system
  browser; keep the in-app Browser for the real Electron desktop build.
- Hide the "Open in in-app browser" context-menu action in the PWA and leave
  "Open in external browser" as the direct choice.
- Gate this on `isBrowserBridge()` (the capability), not phone width or
  `pointer: coarse`: the failure exists at every PWA viewport size. Local HTML
  artifact previews remain in-app because they already use a sandboxed iframe.

## Explicitly out of scope

- `git.scanRepos` — no gateway repo-scan endpoint; the app resolves the single
  repo via `/api/fs/git-root` from the workspace cwd
