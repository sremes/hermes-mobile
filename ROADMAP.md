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

### 1. Preview/git bridge — review writes (Phase 2)

The read side works (edited files clickable, diffs render). Write side:

- Map `review.stage` / `review.unstage` / `review.revert` / `review.commit` /
  `review.push` / `review.createPr` + `commitContext` onto the existing gateway
  POST routes (`/api/git/review/*`) — pure shim work in
  `src/bridge/browser-bridge.ts`, no gateway changes
- The review pane's stage/unstage/commit actions become live on mobile

### 2. Preview/git bridge — worktrees (Phase 3)

- `worktreeList` / `worktreeAdd` / `worktreeRemove`, `branchList` /
  `baseBranchList` / `branchSwitch` for the "Start work" flow

### 3. Bundle/perf pass

- shiki chunk ~3.3 MB gzipped — investigate lazy loading / code splitting
  beyond the already-split heic2any chunk

### 4. Bottom navigation (narrow viewports)

### 5. Touch-target polish

- Titlebar buttons are ~20px; target the 44px touch guideline

### 6. Large uploads

- `POST /api/files/upload` is base64 JSON — tens-of-MB files may hit gateway
  size limits. Fine for typical photos/PDFs; chunked or multipart upload if it
  becomes real

### 7. Remaining bridge gaps

- `writeText` shim member (the one unguarded `quickEntry` call site)
- rename/trash degrade gracefully (no REST equivalent on the gateway)

### 8. Outgoing share

- `navigator.share` for sharing messages/files OUT of Hermes (the share
  *target* is done; the share *API* is not wired)

### 9. Upstream sync routine

- Weekly contract-diff watcher (cron) — procedure and spec in
  `UPSTREAM-SYNC.md`; first throttled merge + filter transition done
  2026-08-16

### 10. Skills hub mobile layout

- The upstream Skills hub (hub browser + full-skill detail pane, landed in the
  2026-08-16 sync) does not scale on narrow viewports: the top skills box is
  too small to use while the hub browser dominates the screen. Needs a mobile
  separation — likely a narrow-viewport layout (drill-in list or tabs) instead
  of the desktop split.
- `src/app/skills/*` is upstream-owned and keeps moving in syncs — expect to
  re-apply the mobile layout each sync until upstream fixes it upstream

## Explicitly out of scope

- `git.scanRepos` — no gateway repo-scan endpoint; the app resolves the single
  repo via `/api/fs/git-root` from the workspace cwd
