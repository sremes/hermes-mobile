# Upstream sync playbook

How this fork stays close to upstream Hermes Desktop **without** following every
commit. Model decision (2026-08-15): **throttled merges at release boundaries** —
a regular, small sync cost keeps divergence bounded, so porting an interesting
feature later never becomes a full re-port.

The alternative models were considered and rejected: continuous per-commit merge
(upstream moves ~38 desktop commits/day — pure churn), and watch-only selective
porting (divergence grows until a port IS a re-port). The watcher below decides
*when* a sync is due; the split-merge procedure below is *how* it runs.

## The containment problem (measured 2026-08-15)

A raw `git merge upstream/main` of the full monorepo was probed on a throwaway
branch (with the re-root graft applied). Result: **1,217 unmerged paths**:

- **1,149 outside the keep-paths** — pure monorepo noise. Upstream touches the
  agent core, TUI, web, CI, etc. constantly, and since those files are absent
  from our tree git raises a `modify/delete` conflict for each of them. Nothing
  gets resurrected (resolving = keep deleted), but the merge is unreadable and
  the noise re-accumulates on every cycle.
- **52 inside `apps/desktop`** — 13 real content conflicts (files both sides
  changed: i18n, composer, wiring, `global.d.ts`, keybinds) + ~39 `modify/delete`
  from the Electron shell files stage-1 stripped (electron-main, scripts/,
  `tsconfig.electron.json`, …), which upstream keeps modifying.

Conclusion: raw merges are *workable* only with scripted mass-resolution, and
they stay noisy forever. The fork merges a **split** of the renderer subtree
instead (the industry pattern — see below), which makes the non-app noise
structurally impossible: paths outside the split never enter the merge base, so
git never considers them. Removed code **cannot** come back.

## The mechanism: split-merge (subtree history, not the raw monorepo)

This is the standard answer for "fork one component of a monorepo" — the
Symfony/Laravel ecosystem does it with `git subtree split` / **splitsh-lite**
(identical SHAs for identical inputs). We implement it with **git-filter-repo**
(already in the toolchain from the domain scrub) because it handles both
`apps/desktop` and `apps/shared` in one split.

Split SHAs are deterministic: the same upstream input always produces the same
split commit, so the split history is stable and merges are incremental.

### One-time setup

```bash
# 1. Scratch clone of upstream, history only (no checkout). Plain clone —
#    NOT --filter=blob:none: the partial-clone filter is re-sent on later
#    fetches, so `git fetch --refetch` does NOT materialize blobs (measured
#    2026-08-16) and filter-repo dies with "Blob not found". A plain shallow
#    clone includes all blobs in the window.
git clone --no-checkout \
  --shallow-since=2026-07-25 https://github.com/NousResearch/hermes-agent.git \
  /opt/data/cache/upstream-split

# 2. Keep only the renderer subtree, minus the stripped paths (TWO passes).
#    --invert-paths is a single boolean that inverts the WHOLE accumulated
#    --path union (verified in source 2026-08-16) — it is not per-arg, so
#    "keep A∪B minus C" requires: pass 1 = keep A∪B, pass 2 = drop C.
cd /opt/data/cache/upstream-split
uvx git-filter-repo --path apps/desktop --path apps/shared --force
uvx git-filter-repo --force --invert-paths \
  --path apps/desktop/electron --path apps/desktop/e2e --path apps/desktop/pr-assets \
  --path apps/desktop/playwright.config.ts --path apps/desktop/tsconfig.electron.json \
  --path apps/desktop/tsconfig.e2e.json --path apps/desktop/preview-demo.html \
  --path apps/desktop/src/app/settings/keybind-settings.tsx \
  --path apps/desktop/src/plugins/hello-runtime/plugin.runtime.js \
  --path apps/desktop/scripts/{after-pack,before-build,before-pack,bundle-electron-main,dev-mock,dev-no-hmr,eval,notarize,notarize-artifact,patch-electron-builder-mac-binary,rebuild-native,run-electron-builder,set-exe-identity,stage-native-deps,test-desktop,assert-dist-built}.mjs

# 3. Import the split into the fork as a tracking branch (--no-tags: upstream's
#    release tags are stragglers here — see caveats). --force on the FIRST
#    import after a filter change: the re-hashed lineage shares no commits
#    with the old upstream-desktop (non-fast-forward).
cd /opt/data/hermes-mobile
git fetch --no-tags --force /opt/data/cache/upstream-split main:refs/heads/upstream-desktop

# 4. Re-root the fork onto the SPLIT of the fork-time upstream state.
#    filter-repo ELIDES commits that never touch the kept paths, so there is
#    no split of f15a38e (a non-desktop merge) — graft onto the NEWEST split
#    commit dated at or before the fork root (2026-08-07 15:29 UTC).
#    Verified target (2026-08-16 filter transition): 2f11039f (2026-08-07
#    14:30 UTC, the #81102 fmt commit — the old d77f5200 re-hashed by the new
#    filter). Recompute if the fork is ever re-based OR the filter config
#    changes:
#      EP=$(date -d '2026-08-07 15:29:55 UTC' +%s)
#      git log --format='%H %ct %s' upstream-desktop | awk -v e="$EP" '$2 <= e' | head -1 | cut -d' ' -f1
#    Sanity-check the pick: its tree must be near-identical to the fork root's
#    kept paths (`git diff --shortstat <X> fd25c86 -- apps/desktop apps/shared`
#    should be a handful of files). The date heuristic CAN pick a side-lineage
#    merge whose tree is wrong (2026-08-16: first pick lacked apps/shared
#    entirely — 1,320 files vs the fork root).
git replace --force --graft fd25c86dcf6bdfc8e51f29bba7582d06681dc407 2f11039f90d6f0f4c8de64f7f28f84dd7c955c7b
```

After the graft, `git merge upstream-desktop` is a real 3-way merge whose base
contains **only** the renderer subtree. Verify: `git merge-base fd25c86
upstream-desktop` prints `2f11039f…`.

Caveats:

- Replace refs are **local repo state** (`refs/replace/`), not pushed by
  default. Every fresh clone needs the graft re-applied (SHAs above).
- The scratch clone is disposable — recreate it per sync. Deepen the
  `--shallow-since` as the fork ages (e.g. 2 months back) so the split covers
  everything since the last sync.
- `git filter-repo` strips remotes after the rewrite — re-add `origin` in the
  scratch clone each sync (see procedure).
- filter-repo NEEDS blob content (its fast-export→fast-import pipeline fails
  with `fatal: Blob not found` on a partial clone — first sync hit this).
  Use a PLAIN clone (step 1) so blobs arrive with the clone; do NOT rely on
  `git fetch --refetch` to materialize them (the partial-clone filter is
  re-sent on fetch, so --refetch is a no-op — measured 2026-08-16).
- Import the split with `--no-tags`: a plain fetch pulled upstream's release
  tags (v2026.7.30/v2026.8.3/v2026.8.13) into the fork on the first sync —
  delete them with `git tag -d <tag>` (they never reached origin).

### New files inside the tracked paths

Included automatically — the filter keeps the whole prefix, new or not, and a
3-way merge adds them cleanly (absent from base and our side). Two edge cases,
both ordinary merge mechanics:

- **Upstream adds a file at a path we own** (add/add conflict) — e.g. if they
  ever create something under `src/bridge/`, where we keep `browser-bridge.ts`.
  Different filename under the same dir = no conflict. Same path = resolve by
  merging/renaming manually. Rare.
- **Upstream moves files** inside the tracked paths (rename = delete + add): if
  we modified the old path we get a delete/modify conflict — port our change to
  the new path.

Nothing new enters via the split *outside* the tracked paths — that's the point
of the containment, and the dependency check below is the safety net for the
build graph escaping it.

## Sync procedure

```bash
# 1. Refresh the split (scratch clone at /opt/data/cache/upstream-split).
cd /opt/data/cache/upstream-split
git remote add origin https://github.com/NousResearch/hermes-agent.git   # filter-repo stripped it last run
git fetch --shallow-since=<2 months back> origin main                    # new commits
git fetch origin --refetch --no-tags main
# Re-run BOTH filter passes (see one-time setup step 2). --force makes
# filter-repo idempotent for identical args, which is what keeps the split
# SHAs deterministic across syncs.
uvx git-filter-repo --path apps/desktop --path apps/shared --force
uvx git-filter-repo --force --invert-paths \
  --path apps/desktop/electron --path apps/desktop/e2e --path apps/desktop/pr-assets \
  --path apps/desktop/playwright.config.ts --path apps/desktop/tsconfig.electron.json \
  --path apps/desktop/tsconfig.e2e.json --path apps/desktop/preview-demo.html \
  --path apps/desktop/src/app/settings/keybind-settings.tsx \
  --path apps/desktop/src/plugins/hello-runtime/plugin.runtime.js \
  --path apps/desktop/scripts/{after-pack,before-build,before-pack,bundle-electron-main,dev-mock,dev-no-hmr,eval,notarize,notarize-artifact,patch-electron-builder-mac-binary,rebuild-native,run-electron-builder,set-exe-identity,stage-native-deps,test-desktop,assert-dist-built}.mjs
cd /opt/data/hermes-mobile
git fetch --no-tags --force /opt/data/cache/upstream-split main:refs/heads/upstream-desktop

# 2. Merge
git checkout -b sync/upstream-<date> main
git merge upstream-desktop
```

Resolve, in order:

1. **Scripted first**: `modify/delete` (`DU`) conflicts — the stripped Electron
   files upstream keeps touching. Keep deleted:
   `git status --porcelain | grep '^DU' | cut -c4- | xargs git rm`
   (expect 0 since the 2026-08-16 filter transition — stripped paths no
   longer enter the split; the script stays as a safety net)
   Then assert stripped paths are empty — upstream re-creations arrive as
   **clean adds**, not conflicts (sync #1 leaked 45 files this way):
   `test -z "$(git ls-files apps/desktop/electron apps/desktop/e2e)"` — `git rm` any hits.
2. **Real work**: the `UU` content conflicts — ~13 files, table below.
3. **Dependency drift check** (the split is the renderer; the *build graph* is
   not — root-level files the build depends on live outside the split paths
   and upstream changes them constantly; measured 2026-08-15: upstream root
   `package.json` carries 14 `overrides`, ours 4 — the split never sees root
   manifests):
   ```bash
   # a. Root manifest parity (upstream/main is kept read-only for this)
   git diff upstream/main -- package.json   # workspaces, overrides, engines, allowScripts
   #    Port upstream's overrides wholesale — they only apply to deps actually installed.
   # b. Resolution closure: every dep of the MERGED manifests resolves inside the repo
   git show :2:apps/desktop/package.json | grep -E 'file:|workspace:'
   git show :2:apps/shared/package.json  | grep -E 'file:|workspace:'
   #    @hermes/shared = file:../shared is expected. ANY new file:/workspace: ref
   #    pointing outside apps/desktop + apps/shared → STOP. Decide: add the path to
   #    the split (--path <new>) or vendor the package into the fork.
   # c. Config chain closure: every `extends` in apps/desktop tsconfigs/eslint
   #    configs must resolve inside the repo (currently none — guards future refactors).
   # d. The build (next step) is the real backstop.
   ```
   **Pitfall (hit on the first sync)**: `npm install` can ETARGET with
   "No matching version found for X with a date before …" — upstream's
   `.npmrc` sets `min-release-age=14` (fresh-supply-chain gate), and a
   freshly-pinned override (dompurify, mermaid were 11–12 days old) trips it.
   Fix = upstream's own pattern: `min-release-age-exclude[]=<pkg>` entry with
   a "remove when > 2wks old" comment. Check `npm view <pkg>@<ver> time` to
   confirm age before adding.
4. `npm install` (root workspace) — deps changed almost every cycle
5. `cd apps/desktop && npx tsc -p . --noEmit && npm run build`
6. `npm run test` (vitest) — update tests whose signatures upstream moved
7. **Phone test** (the acceptance bar — headless hides touch regressions):
   sign-in flow, share-into-composer (stash repaint), attach incl. HEIC, drawer
   rails <768px, model-menu touch scroll, composer send, review-pane diffs
8. Commit per stage, push, verify remote SHA (`git ls-remote origin main`)
9. Update the "Last sync" line below; delete the sync branch

## Expected conflict surface (measured 2026-08-15, fork Aug 7 → Aug 15)

Upstream desktop churn in 8 days: **305 commits**. Real conflicts after the
split: ~13 files, half mechanical (first-sync actual: 11 `UU` — i18n,
`global.d.ts` and `main.tsx` merged cleanly that cycle; treat the table as a
watch list, not a guarantee):

| File | Upstream touches/8d | Resolution |
|---|---|---|
| `src/i18n/{en,zh,ja,ar,zh-hant,types}.ts` | ~124 | mechanical: script block-scoped inserts of our keys (`share`, `revealExplorer`, …) into the new structure; i18n types must match across all locales or tsc fails |
| `src/global.d.ts` | 14 | contract diff: new members → implement in `browser-bridge.ts` or leave `undefined` (feature-detect); removed members → no action (we ship our own snapshot) |
| `src/app/chat/composer/**` | 29 | our share/stash event logic (`COMPOSER_DRAFT_STASHED_EVENT`, lineage-root keys) must survive upstream composer changes — the delicate one |
| `src/app/contrib/wiring.tsx` | 17 | our boot wiring (share-inbox consume) vs upstream boot changes |
| `apps/desktop/package.json` | 13 | keep Electron-strip + heic2any; take upstream deps |
| `src/app/hooks/use-keybinds.ts`, `lib/keybinds/*`, `app/shell/titlebar-controls.tsx` | ~22 | keep our pointer-coarse/hotkey chrome removals in the new shape |
| `src/main.tsx` | 2 | keep prod-only SW registration |
| Stripped paths (electron/, e2e/, pr-assets/, packaging `.mjs`, …) | none since 2026-08-16 | filtered out of the split (filter pass 2) — structurally cannot conflict or leak |

Never-conflict (ours, new files): `src/bridge/*`, `src/lib/share-inbox.ts`,
`src/app/chat/share-intake-dialog.tsx`, `public/`, `deploy/`, `templates/`.

## Fork inventory (what the next sync must preserve)

**Ours — new files, no upstream equivalent (never take upstream's version):**
- `src/bridge/browser-bridge.ts`, `src/bridge/capabilities.ts` — the PWA shim
  and capability gates (the whole fork's reason to exist)
- `src/lib/share-inbox.ts`, `src/app/chat/share-intake-dialog.tsx` — Web Share
  Target intake (staging-only, user's explicit design)
- `public/` (manifest, `sw.js`, icons), `deploy/`, `templates/` — PWA shell +
  nginx site
- `UPSTREAM-SYNC.md`, `ROADMAP.md`, `AGENTS.md`, README — fork docs

**Ours — modified files upstream also owns (the conflict surface; re-apply our
intent in upstream's new shape):**
- `apps/desktop/package.json` — PWA scripts (dev/build/preview/typecheck
  without Electron), `heic2any` dep
- `src/main.tsx` — prod-only SW registration; `vitest.config.ts` — no electron
  test project; `scripts/assert-root-install.mjs` — Node ≥22.22 gate
- capability gating in `src/app/settings/index.tsx`, `settings/gateway-settings.tsx`,
  `app/contrib/wiring.tsx`, `app/shell/titlebar-controls.tsx`,
  `components/boot-failure-overlay.tsx`, `app/contrib/surfaces.tsx`
- mobile fixes in `components/pane-shell/tree/renderer/narrow-overlays.tsx`
  (tap-to-close backdrop), `app/contrib/controller.tsx` (`h-dvh` + safe-area),
  `store/composer.ts` + `chat/composer/hooks/use-composer-draft.ts`
  (`COMPOSER_DRAFT_STASHED_EVENT`)
- `src/app/chat/hooks/use-composer-actions.ts` — browser file picker + HEIC
  decode ladder; upstream refactored the preview path once already, re-add
  after any refactor
- `src/global.d.ts` (fork-note header), `.npmrc` (age-gate excludes)

**Removed from upstream — 201 files (measured 2026-08-15). Since the
2026-08-16 filter transition these paths never enter the split (filter pass
2), so upstream can no longer resurrect them — the fork-side deletions below
are historical. The post-sync assertion is the tripwire:**
- `apps/desktop/electron/**` — the entire Electron main-process surface
  (~170 files incl. tests)
- `apps/desktop/e2e/**`, `playwright.config.ts` — Playwright UI tests
- electron packaging: `scripts/{after-pack,before-build,before-pack,bundle-electron-main,dev-mock,dev-no-hmr,eval,notarize,notarize-artifact,patch-electron-builder-mac-binary,rebuild-native,run-electron-builder,set-exe-identity,stage-native-deps,test-desktop,assert-dist-built}.mjs`
- `tsconfig.electron.json`, `tsconfig.e2e.json`, `pr-assets/`, `preview-demo.html`
- `src/app/settings/keybind-settings.tsx` (mobile chrome removal),
  `src/plugins/hello-runtime/plugin.runtime.js`
- package.json electron scripts + deps (`node-pty`, `@electron/rebuild`,
  `@playwright/test`)

If upstream ever re-creates a stripped path, the new files arrive as **clean
adds** (absent from base and our side) — NOT `DU` conflicts, so the `DU`
script never sees them. Measured: sync #1 leaked 45 files this way (42
`electron/` + 3 `e2e/`). The post-sync assertion above is the tripwire — keep
deleted. If a KEPT feature starts importing one of these, that is a
dependency-drift signal (check 3b) — stop and decide, don't merge blindly.

## Decision rules (when to sync, when to skip)

| Trigger | Action |
|---|---|
| Desktop release with notable renderer features | sync |
| `global.d.ts` / `apps/shared` contract diff is non-trivial (new bridge members the renderer will call) | sync |
| Gateway (agent) release touching REST endpoints the shim uses (`/api/auth`, `/api/chat`, `/api/fs`, `/api/files`, `/api/git`, `/api/ws`) | **fix shim immediately** — urgent, not a desktop-sync issue |
| Upstream diff since last sync touches none of our files | skip (cheap) |
| Churn is Electron-only (HUD, registry, updater, packaging) | skip |

Skipping cycles is safe; skipping **months** is what makes the next sync a
re-port. Floor cadence: every 2–4 weeks, or at each desktop release, whichever
comes first.

## Watcher (planned — cron, weekly)

Not yet created (2026-08-15). Spec:

1. Refresh the split, then report:
   - `git log --oneline <last-sync-sha>..upstream-desktop | wc -l` + touch
     counts per file in the conflict surface (the table above)
   - contract diff: `git diff <last-sync-sha> upstream-desktop -- apps/desktop/src/global.d.ts apps/shared` → list new/removed bridge members (the porting checklist)
   - **dependency drift (before any sync, so the split can be adjusted)**: diff
     upstream root `package.json` (overrides/workspaces/engines/allowScripts)
     vs ours; scan upstream `apps/desktop` + `apps/shared` manifests for
     `file:`/`workspace:` refs pointing outside the split paths
2. Desktop releases scan (GitHub) for notable renderer features.
3. Agent releases scan for gateway REST endpoint changes (the urgent trigger).
4. Deliver a 30-second drift report → user decides sync / skip.

## Long-term exit ramp

The browser bridge is a genuine contribution: a web/PWA target for the desktop
renderer. If upstream ever accepts it (MIT, community PRs), that part of our
delta disappears and the fork shrinks toward "deploy config + PWA shell".

## Last sync

- Fork baseline: upstream `f15a38e` (2026-08-07); split graft target `d77f5200`
  (last desktop-touching split commit before the fork root)
- **First sync (2026-08-15)**: merged `upstream-desktop` at `385e3720`
  (505 desktop commits since fork). 52 conflicts: 41 scripted `DU` (stripped
  Electron files) + 11 `UU` (settings/index, vitest.config, assert-root-install
  → ours; narrow-overlays, titlebar-controls, controller, wiring, composer
  store → merged; use-composer-actions → theirs + re-added PWA picker/HEIC
  ladder; use-composer-draft → union imports; package.json → our scripts).
  Deps: ported 10 missing root overrides; `.npmrc` gained
  `min-release-age-exclude` for dompurify + mermaid (fresh security pins).
  Tests: 3 files adapted (capability-gate mocks — fork notes inline).
  Phone test: PASSED (user deployed 2026-08-15, working on device).
- **2026-08-16 cleanup**: sync #1's merge silently leaked 45 files (42
  `electron/` + 3 `e2e/`) as clean adds — upstream created them in the sync
  window, and a 3-way merge adds files absent from both base and our side
  (the `DU` script only catches modify/delete). No renderer imports them
  (typecheck clean); removed in `532b994`.
- **Second sync (2026-08-16)**: filter transition — pass 2 (`--invert-paths`)
  now strips electron/, e2e/, pr-assets/, playwright.config.ts, tsconfigs,
  preview-demo.html, keybind-settings.tsx, hello-runtime and the 16 packaging
  `.mjs` from the split itself. Re-grafted the fork root onto the re-hashed
  fork-time split commit `2f11039f` (the old `d77f5200` re-hashed; the date
  heuristic's first pick `7c706e51` was a side-lineage merge lacking
  apps/shared — the tree-parity check caught it). Merged upstream-desktop
  `c1772812` (Skills hub rework, MCP catalog unification, turn timing).
  0 `DU` from stripped paths (was ~39); 1 `DU` remained for
  `scripts/stage-native-deps.test.mjs` (not on the exclusion list — keep
  deleted). 28 `UU`: 11 real fork-file resolutions (composer draft stash,
  browser picker/HEIC, controller, wiring, settings, titlebar, narrow
  overlays, store, package.json, assert-root-install, vitest.config), the
  rest take-theirs. Vendored `tests/fixtures/session-resume-active-turn.json`
  (repo-root fixture outside split paths). Typecheck + build pass; 465 test
  files / 4331 tests pass. Phone test: PASSED (user, 2026-08-16 — PWA works
  on Android; Skills hub mobile layout flagged → ROADMAP #10).
