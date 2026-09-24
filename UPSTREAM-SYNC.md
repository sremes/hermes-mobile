# Upstream sync playbook

How this fork stays close to upstream Hermes Desktop **without** following every
commit. Model decision (2026-08-15): **throttled merges at release boundaries** —
a regular, small sync cost keeps divergence bounded, so porting an interesting
feature later never becomes a full re-port.

The alternative models were considered and rejected: continuous per-commit merge
(upstream moves ~38 desktop commits/day — pure churn), and watch-only selective
porting (divergence grows until a port IS a re-port). Sync timing follows the
decision rules below; the split-merge procedure below is *how* it runs.

## The containment problem (measured 2026-08-15)

A raw `git merge upstream/main` of the full monorepo was probed on a throwaway
branch (with the re-root graft applied). Result: **1,217 unmerged paths**.
The historical breakdown recorded ~1,149 outside the keep-paths and 52 inside
`apps/desktop`; those component counts do not reconcile exactly to the total,
so use 1,217 as the measured headline and derive current conflict counts from
the actual probe rather than summing this historical breakdown.

Conclusion: raw merges are *workable* only with scripted mass-resolution, and
they stay noisy forever. The fork merges a **split** of the renderer subtree
instead (the industry pattern — see below), which keeps non-app merge conflicts
out of the ordinary path: paths outside the split never enter the merge base.
Removed code still requires the filter inventory and post-sync assertion to
stay correct; a path omitted from pass 2 can arrive as a clean add.

## The mechanism: split-merge (subtree history, not the raw monorepo)

This is the standard answer for "fork one component of a monorepo" — the
Symfony/Laravel ecosystem does it with `git subtree split` / **splitsh-lite**
(identical SHAs for identical inputs). We implement it with **git-filter-repo**
(already in the toolchain from the domain scrub) because it handles both
`apps/desktop` and `apps/shared` in one split.

Split SHAs are deterministic only when both the upstream input and the
`git-filter-repo` version are identical. The current `uvx` invocation is
unpinned, so version drift can re-hash the lineage; the tree-match check below
distinguishes that benign re-hash from a real content/filter change. Pin the
tool version once it is selected and rerun the import verification.

### One-time setup

```bash
# 1. Scratch clone of upstream, history only (no checkout). Plain clone —
#    NOT --filter=blob:none: the partial-clone filter is re-sent on later
#    fetches, so `git fetch --refetch` does NOT materialize blobs (measured
#    2026-08-16) and filter-repo dies with "Blob not found". A plain shallow
#    clone includes all blobs in the window.
git clone --no-checkout --no-tags \
  --shallow-since=2026-07-25 https://github.com/NousResearch/hermes-agent.git \
  /opt/data/cache/upstream-split

# 2. Keep only the renderer subtree, minus the stripped paths (TWO passes).
#    --invert-paths is a single boolean that inverts the WHOLE accumulated
#    --path union (verified in source 2026-08-16) — it is not per-arg, so
#    "keep A∪B minus C" requires: pass 1 = keep A∪B, pass 2 = drop C.
#    NOTE (2026-08-27): the current git-filter-repo (uvx, unpinned) MISPARses
#    the space form `--path X --path Y` when X/Y contain hyphens (argparse
#    leaves the later values as unrecognized positionals). Use `--path=X`.
#    The uvx version is unpinned — version drift re-hashes the whole split
#    lineage (harmless content-wise — see "re-hash detection" below — but
#    it inflates the merge's conflict surface). Pin the version once the
#    toolchain settles.
cd /opt/data/cache/upstream-split
uvx git-filter-repo --path=apps/desktop --path=apps/shared --force
rm -rf .git/filter-repo/already_ran   # pass 1 writes it; pass 2 would prompt (EOF) otherwise
# NOTE (2026-09-05): do NOT quote the scripts brace expansion below. Quoted,
# `--path="apps/desktop/scripts/{...}.mjs"` reaches filter-repo as one literal
# brace path, strips NOTHING under scripts/, and the tree-match check then
# fails with content divergence (misread as a re-hash). Keep it unquoted so
# bash expands it to one --path= per file.
uvx git-filter-repo --force --invert-paths \
  --path=apps/desktop/electron --path=apps/desktop/e2e --path=apps/desktop/pr-assets \
  --path=apps/desktop/playwright.config.ts --path=apps/desktop/tsconfig.electron.json \
  --path=apps/desktop/tsconfig.e2e.json --path=apps/desktop/preview-demo.html \
  --path=apps/desktop/src/app/settings/keybind-settings.tsx \
  --path=apps/desktop/src/plugins/hello-runtime/plugin.runtime.js \
  --path=apps/desktop/scripts/{after-pack,before-build,before-pack,bundle-electron-main,dev-mock,dev-no-hmr,eval,notarize,notarize-artifact,patch-electron-builder-mac-binary,rebuild-native,run-electron-builder,set-exe-identity,stage-native-deps,test-desktop,assert-dist-built}.mjs \
  --path=apps/desktop/scripts/stage-native-deps.test.mjs

# 3. Import the split into the fork as a tracking branch (--no-tags: upstream's
#    release tags are stragglers here — see caveats). --force: the import is
#    non-fast-forward whenever the lineage re-hashed — after a filter change
#    OR after git-filter-repo version drift (safe: the old head is an
#    ancestor of main).
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
  default. The graft is bootstrap + filter-change machinery (step 4): after
  a sync lands, the split lineage is baked into `main` and plain clones
  merge without it, and the graft ref becomes inert. It is NOT needed after
  a version-drift re-hash (the tree-identical lineage still shares the fork
  root's history — verified 2026-08-27). Re-apply only after an intentional
  filter change or a fork re-base.
- The scratch clone is disposable — recreate it per sync; the sync procedure
  below does exactly that. An in-place refresh silently filters stale history.
  Deepen the `--shallow-since` window as the fork ages so the split covers
  everything since the last sync.
- `git filter-repo` strips remotes after the rewrite. Harmless in the
  rebuild-fresh flow: the scratch's `origin` exists at clone time, and nothing
  after pass 1 needs it (the split is imported into the fork by PATH fetch).
  (The old in-place-refresh procedure needed it re-added — that procedure is
  gone.)
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
3-way merge adds them cleanly (absent from base and our side). Exception: the
pass-2 exclusions (stripped paths) — new files under them never enter the
split; the post-sync assertion is the tripwire. Two edge cases, both ordinary
merge mechanics:

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
# 1. REBUILD the split scratch FRESH — do NOT refresh in place.
#    filter-repo only processes LOCAL refs (refs/heads/*); refs/remotes/* are
#    ignored AND stripped, so an in-place refresh silently filters the stale
#    local main and the new commits vanish with the gc (measured 2026-08-27).
cd /opt/data/cache
rm -rf upstream-split
git clone --no-checkout --no-tags \
  --shallow-since=2026-07-25 https://github.com/NousResearch/hermes-agent.git \
  upstream-split
# --shallow-since window: extend as the fork ages (see caveats) so the split
# still covers everything since the last sync.
# Re-run BOTH filter passes (see one-time setup step 2). --force makes
# filter-repo idempotent for identical args, which is what keeps the split
# SHAs deterministic across syncs (module a git-filter-repo version pin!).
# Between the passes, clear the already_ran marker: pass 1 writes it and
# pass 2 would otherwise prompt non-interactively (input() EOF crash).
uvx git-filter-repo --path=apps/desktop --path=apps/shared --force
rm -rf .git/filter-repo/already_ran
uvx git-filter-repo --force --invert-paths \
  --path=apps/desktop/electron --path=apps/desktop/e2e --path=apps/desktop/pr-assets \
  --path=apps/desktop/playwright.config.ts --path=apps/desktop/tsconfig.electron.json \
  --path=apps/desktop/tsconfig.e2e.json --path=apps/desktop/preview-demo.html \
  --path=apps/desktop/src/app/settings/keybind-settings.tsx \
  --path=apps/desktop/src/plugins/hello-runtime/plugin.runtime.js \
  --path=apps/desktop/scripts/{after-pack,before-build,before-pack,bundle-electron-main,dev-mock,dev-no-hmr,eval,notarize,notarize-artifact,patch-electron-builder-mac-binary,rebuild-native,run-electron-builder,set-exe-identity,stage-native-deps,test-desktop,assert-dist-built}.mjs \
  --path=apps/desktop/scripts/stage-native-deps.test.mjs
cd /opt/data/hermes-mobile
git fetch --no-tags --force /opt/data/cache/upstream-split main:refs/heads/upstream-desktop

# 2. Verify the import BEFORE merging — lineage continuity + content parity
#    (FAILING the first check is NORMAL after a filter-repo version drift;
#    see "Import verification" below for the benign-vs-broken decision tree):
#    REMEMBER the value of old-split-head (e.g. c1772812e before 2026-08-27).
git merge-base --is-ancestor <old-split-head> upstream-desktop && echo CONTINUOUS

# 3. Merge
git checkout -b sync/upstream-<date> main
git merge upstream-desktop
```

## Import verification (post-import, pre-merge) — the "re-hash detection" step

`git merge-base --is-ancestor <old-split-head> upstream-desktop` is the
deterministic-continuation check. It FAILS whenever the split lineage was
re-hashed — i.e. the same upstream commits produced different split SHAs.
Two causes; only the first is potentially benign after verification:

1. **git-filter-repo version drift.** uvx
   unpinned resolves a newer tool; identical args + identical input no longer
   hash identically. The whole lineage re-hashes and the merge base rolls
   back to the last shared commit. Verify content equivalence by TREE MATCH —
   the old split head's tree must exist verbatim somewhere on the new lineage:
   ```bash
   T_OLD=$(git rev-parse <old-split-head>^{tree})
   git rev-list upstream-desktop | while read c; do
     [ "$(git rev-parse "$c^{tree}")" = "$T_OLD" ] && { echo "$c"; break; }
   done
   # a match (e.g. f04955bf for c1772812e) proves a benign re-hash: same
   # content, different SHAs. git's 3-way collapses the identical-content
   # segment at merge time — EXPECT a massively inflated UU surface because
   # every fork-touched file upstream churned since the rolled-back base
   # conflicts. No re-graft needed: the fork root and the last shared commit
   # are both in the common prefix, and the old graft ref stays consistent.
   # NO match = content genuinely diverged → STOP. Suspect an upstream
   # force-push/rebuild or a filter-args change; follow the filter-change
   # procedure below only after identifying the cause.
2. **A filter-args change** (intentional) → follow the re-graft procedure in
   the one-time setup section; the re-hash is then expected and the graft
   target must be recomputed.

Resolve, in order:

1. **Scripted first**: `modify/delete` (`DU`) conflicts — the stripped Electron
   files upstream keeps touching. Keep deleted:
   `git status --porcelain | grep '^DU' | cut -c4- | xargs git rm`
   (expect 0 since the 2026-08-16 filter transition — stripped paths no
   longer enter the split; the script stays as a safety net)
   Then assert the COMPLETE strip list is empty — upstream re-creations arrive
   as **clean adds**, not conflicts (sync #1 leaked 45 files this way):
   ```bash
   STRIPPED=(
     apps/desktop/electron
     apps/desktop/e2e
     apps/desktop/pr-assets
     apps/desktop/playwright.config.ts
     apps/desktop/tsconfig.electron.json
     apps/desktop/tsconfig.e2e.json
     apps/desktop/preview-demo.html
     apps/desktop/src/app/settings/keybind-settings.tsx
     apps/desktop/src/plugins/hello-runtime/plugin.runtime.js
     apps/desktop/scripts/after-pack.mjs
     apps/desktop/scripts/before-build.mjs
     apps/desktop/scripts/before-pack.mjs
     apps/desktop/scripts/bundle-electron-main.mjs
     apps/desktop/scripts/dev-mock.mjs
     apps/desktop/scripts/dev-no-hmr.mjs
     apps/desktop/scripts/eval.mjs
     apps/desktop/scripts/notarize.mjs
     apps/desktop/scripts/notarize-artifact.mjs
     apps/desktop/scripts/patch-electron-builder-mac-binary.mjs
     apps/desktop/scripts/rebuild-native.mjs
     apps/desktop/scripts/run-electron-builder.mjs
     apps/desktop/scripts/set-exe-identity.mjs
     apps/desktop/scripts/stage-native-deps.mjs
     apps/desktop/scripts/test-desktop.mjs
     apps/desktop/scripts/assert-dist-built.mjs
     apps/desktop/scripts/stage-native-deps.test.mjs
   )
   HIT=$(git ls-files -- "${STRIPPED[@]}")
   test -z "$HIT" || { printf '%s\n' "$HIT"; exit 1; }
   ```
2. **Classify, then resolve by fork ownership** (this is what makes a 200+
   conflict surface tractable; the "~13 files" table below is the normal
   surface WITHOUT a lineage re-hash — after one, every fork-touched file
   upstream churned since the rolled-back base conflicts, and the pure
   noise dwarfs the real work):
   - First find the TREE-MATCH commit (from "Import verification") — the new
     lineage's content-equivalent of the old split head. Call it `TM`.
   - For each `UU`/`AA` file:
     ```bash
     if git diff --quiet TM HEAD -- "$f"; then
       # Fork never modified it → pure upstream content, take theirs.
       git checkout --theirs -- "$f" && git add -- "$f"
     else
       # Fork-modified → upstream's latest shape + re-apply the fork delta.
       git checkout --theirs -- "$f" && git add -- "$f"
       git diff TM HEAD -- "$f" | git apply --3way - && git add -- "$f"
       # apply failures → resolve manually (markers are INVERTED, see below).
     fi
     ```
   - `UD` (deleted by them + we modified): upstream moved/renamed/refactored —
     check the new path first (`chat-messages.ts` → `chat-messages/` dir,
     `gateway-event.ts` → dir on the third sync); if the fork's changes were
     consolidated upstream (e.g. our clarify helpers), accept the deletion
     and fix imports; otherwise port the change to the new shape.
   - **`git apply --3way` conflict markers are INVERTED vs `git merge`
     markers**: "ours" = the current worktree file (i.e. the THEIR content we
     checked out), "theirs" = the patch postimage (the fork's own version).
     Reading them with merge semantics backs you into reversed resolutions —
     verify against the true sides (`git show HEAD:<path>`,
     `git show upstream-desktop:<path>`) whenever the region matters.
   - After ANY manual marker resolution, verify no markers remain and the
     identifiers used in the merged regions actually resolve (the
     hybrid-file failure mode).
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
5. `cd apps/desktop && npm run check:lint && npm run build`
6. `npm run test` (vitest) — update tests whose signatures upstream moved
7. **Phone test** (the acceptance bar — headless hides touch regressions):
   sign-in, share-into-composer (stash repaint), attach incl. HEIC, narrow
   drawer reveal/close, command/model touch scroll, touch-primary Enter
   newline, media playback, remote Git review/ship actions, and confirmation
   that terminal/local-only surfaces do not reappear
8. Commit per stage, push, verify remote SHA (`git ls-remote origin main`)
9. Update the "Last sync" line below; delete the sync branch

## Historical conflict baseline (measured 2026-08-15, fork Aug 7 → Aug 15)

This is a historical watch list, not a current conflict forecast. The third and
fifth syncs showed much larger lineage-driven surfaces; derive the next surface
from current upstream paths and per-file churn before opening a merge.

| File | Upstream touches/8d | Resolution |
|---|---|---|
| `src/i18n/{en,zh,ja,ar,zh-hant,types}.ts` | ~124 | mechanical: script block-scoped inserts of our keys (`share`, `revealExplorer`, …) into the new structure; i18n types must match across all locales or tsc fails |
| `src/global.d.ts` | 14 | contract diff: new members → implement in `browser-bridge.ts` or leave `undefined` (feature-detect); removed members → no action (we ship our own snapshot) |
| `src/app/chat/composer/**` | 29 | our share/stash event logic (`COMPOSER_DRAFT_STASHED_EVENT`, lineage-root keys) must survive upstream composer changes — the delicate one |
| `src/app/contrib/wiring.tsx` | 17 | our boot wiring (share-inbox consume) vs upstream boot changes |
| `apps/desktop/package.json` | 13 | keep Electron-strip + heic2any; take upstream deps |
| `src/app/hooks/use-keybinds.ts`, `lib/keybinds/*`, `app/shell/titlebar-controls.tsx` | ~22 | keep our pointer-coarse/hotkey chrome removals in the new shape |
| `src/main.tsx` | 2 | keep prod-only SW registration |
| Stripped paths (electron/, e2e/, pr-assets/, packaging `.mjs`, …) | normally none | filtered out by pass 2; keep deleted any clean-add/`DU` hit. `stage-native-deps.test.mjs` is the explicit historical exception and is now listed in the filter command |

Currently fork-owned paths with no upstream equivalent: `src/bridge/*`,
`src/lib/device-tts.ts`, `src/lib/share-inbox.ts`,
`src/app/chat/share-intake-dialog.tsx`, `public/`, and `deploy/`. These are
not guaranteed conflict-free forever: an upstream add at the same path can
still conflict.

## Fork inventory (what the next sync must preserve)

**Ours — new files, no upstream equivalent (never take upstream's version):**
- `src/bridge/browser-bridge.ts`, `src/bridge/capabilities.ts` — the PWA shim
  and capability gates (the whole fork's reason to exist)
- `src/lib/share-inbox.ts`, `src/app/chat/share-intake-dialog.tsx` — Web Share
  Target intake (staging-only, user's explicit design)
- `src/lib/device-tts.ts` — on-device Android TTS first rung
- `public/` (manifest, `sw.js`, icons), `deploy/` — PWA shell + nginx site
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
- mobile shell and interaction: narrow reveal/backdrop, safe-area/dynamic
  viewport, terminal capability gates and stale-layout cleanup, Bot Mode
  routines gating, command-list touch wake, touch-primary composer newline,
  focus-follow guards, and timeline suppression where it overlaps pane edges
- gateway-backed media/device TTS in `src/lib/media.ts`,
  `src/lib/voice-playback.ts`, and `src/lib/device-tts.ts`
- remote Git facade and review UX in `src/lib/desktop-git.ts`,
  `src/lib/desktop-fs.ts`, `src/store/review.ts`,
  `src/app/right-sidebar/review/*`, and `src/components/chat/diff-lines.tsx`
- subagent resume reconciliation in `src/store/subagents.ts`
- `src/app/chat/hooks/use-composer-actions.ts` — browser file picker + HEIC
  decode ladder; upstream refactored the preview path once already, re-add
  after any refactor
- `src/global.d.ts` (fork-note header), `.npmrc` (age-gate excludes)

**Removed from upstream — 201 files (measured 2026-08-15). Pass 2 removes
these paths from future split rebuilds. `stage-native-deps.test.mjs` was the
one missed test in the 2026-08-16 transition and remained an explicit
keep-deleted conflict through the fifth sync; the command above now lists it
too. The fork-side deletions below are historical. The post-sync assertion is
still the tripwire:**
- `apps/desktop/electron/**` — the entire Electron main-process surface
  (~170 files incl. tests)
- `apps/desktop/e2e/**`, `playwright.config.ts` — Playwright UI tests
- electron packaging: `scripts/{after-pack,before-build,before-pack,bundle-electron-main,dev-mock,dev-no-hmr,eval,notarize,notarize-artifact,patch-electron-builder-mac-binary,rebuild-native,run-electron-builder,set-exe-identity,stage-native-deps,test-desktop,assert-dist-built}.mjs` and `scripts/stage-native-deps.test.mjs`
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

## Long-term exit ramp

The browser bridge is a genuine contribution: a web/PWA target for the desktop
renderer. If upstream ever accepts it (MIT, community PRs), that part of our
delta disappears and the fork shrinks toward "deploy config + PWA shell".

## First-parent fork commit inventory (2026-08-07 through 2026-09-24)

This is the complete meaningful fork line from the current split parent
`2f11039f` to `48aa0742`: **78 first-parent commits**, including the fork-root
commit `fd25c86`. Merge commits and the 11 first-parent commits after the fifth
sync are included. Raw ancestry counts are misleading because the local
re-root graft preserves upstream split history.

- **PWA foundation, auth, deployment, and fork root (15):**
  `fd25c86dcf` `37b0db73d2` `bc99dd66fc` `206885330b` `9de6dcdd2d`
  `9e8d85d70a` `6650b1b4b6` `7854fa01ac` `123a7e5721` `1756830430`
  `80952a8a8d` `7e4ac0f81d` `2defcbe082` `ed1405b908` `be61adbd8d`
- **Files, attachments, share, media, and voice (12):**
  `8e9012d56f` `91f7791ec7` `358cd780c7` `aedabec41d` `9be78bc68b`
  `a77b08ad8d` `9f01a9d56e` `2406110925` `ef88ee1f60` `9426d83858`
  `9ad4066013` `864514961e`
- **Mobile shell, composer, review, and runtime reliability (18):**
  `3f327fa16e` `94feac93db` `0b7fdc32f2` `519eab3d8d` `7f0ed3e805`
  `a655324d49` `52c67f883d` `e8e45b24c0` `849cd6fe50` `3351190852`
  `d5db000965` `92e18af476` `ec1346fcc1` `f7061e36d1` `7f42634c60`
  `2647bd56c3` `89a9b94206` `3e6b32168a`
- **Renderer-split syncs and clean-up (6):**
  `78696bbe62` `532b994de7` `c4221ede88` `560754725f` `76f9818963`
  `3b27764413`
- **Documentation and repository hygiene (27):**
  `84d641f1c7` `6afffe65e8` `b2b896d8b4` `68faa551d8` `998e85bdbf`
  `177342a12b` `fb1444cd63` `8c3e66958c` `9ab54defad` `a2c7822eb0`
  `a4453ba95f` `274b1a5c2b` `709885e51d` `2fd79d03c8` `5097aa90a1`
  `4e166b83ca` `836af73480` `5c874418f0` `e1bbcb5cb1` `7f1e8fd6a5`
  `18d2e8fda9` `d35d93dbbb` `4b23f05d3e` `4248fe4f4f` `87b1ea26be`
  `531312566f` `48aa074294`

## Last sync

- Fork root: upstream `f15a38e` (2026-08-07); original split graft target
  `d77f5200` (last desktop-touching split commit before the root)
- Current synced renderer baseline: upstream-desktop `b5b8cad7` (2026-09-18)
- **First sync (2026-08-15, phone result recorded for that sync):** merged
  `upstream-desktop` at `385e3720`
  (505 desktop commits since fork). 52 conflicts: 41 scripted `DU` (stripped
  Electron files) + 11 `UU` (settings/index, vitest.config, assert-root-install
  → ours; narrow-overlays, titlebar-controls, controller, wiring, composer
  store → merged; use-composer-actions → theirs + re-added PWA picker/HEIC
  ladder; use-composer-draft → union imports; package.json → our scripts).
  Deps: ported 10 missing root overrides; `.npmrc` gained
  `min-release-age-exclude` for dompurify + mermaid (fresh security pins).
  Tests: 3 files adapted (capability-gate mocks — fork notes inline).
  Phone result recorded for this sync: PASSED (user deployed 2026-08-15,
  working on device).
- **2026-08-16 cleanup:** sync #1's merge silently leaked 45 files (42
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
  files / 4331 tests pass. Phone result recorded for this sync: PASSED
  (user, 2026-08-16 — PWA works on Android; the Skills hub mobile layout was
  flagged at that time).
- **Third sync (2026-08-27)**: upstream `0dfba37b` (v2026.8.27 — the Desktop
  reconnect family: #93361 resetTileRuntimeBindings + #95600 stale-transcript
  backstop + #95782). No filter change, BUT the split lineage re-hashed anyway:
  unpinned `uvx git-filter-repo` had drifted (the new version also breaks the
  `--path X` space form — see step 2 note). The deterministic-continuation
  check (`merge-base --is-ancestor`) failed; verified benign by TREE MATCH:
  `git rev-parse c1772812e^{tree}` found verbatim on the new lineage
  (`f04955bf`). Merge base `ee2b2d92` (08-12); merge inflation expected —
  every fork-touched file upstream churned since 08-12 conflicts. Resolved:
  2 `DU` (keep deleted) + 4 `UD` (upstream MOVED chat-messages.ts →
  `chat-messages/{index,hydration,parts,reconciliation,tool-parts,types}.ts`,
  gateway-event.ts → dir, lone-header deleted; our clarify helpers were
  consolidated into the new module — union imports) + 202 pure-upstream
  UU/AA → theirs + 37 fork-touched: 27 auto-reapplied via
  `git apply --3way` of the fork delta (`git diff f04955bf..HEAD`), 10 manual
  (package.json: +blobatar/driver.js, nanostores 1.4.2, +babel/compiler
  devDeps for the React Compiler build pipeline; controller: keep upstream
  preview/layout-reset palette entries, keep fork's keybinds door removal;
  wiring: union + petOverlay/terminal gates; settings: fork drops the keybinds
  page — enum/nav/render branch; gateway-settings: fork gates + upstream's
  simplified cards; tsconfig: keep exclude; main.tsx: union + upstream's
  selection-copy guard). Contract drift: bridge `profile.remember` implemented
  (localStorage); `selectPaths` fallback + HEIC ladder + draft-stash event +
  capability gates all survived. Root manifest: nanoid 3.3.18 + get-windows
  allowScripts; `.npmrc` excludes for blobatar + nanostores (fresh pins).
  Tests: 3 upstream-suite failures fixed — model-menu-panel.test.tsx gained
  an extra catalog mock in upstream's new reconcile tests (the fork's mount
  auto-refresh a655324 consumes an extra read); duplicate-stall-indicator.
  test.tsx REMOVED because upstream RENAMED it to duplicate-activity-
  indicator.test.tsx (stall → activity indicator; the old path survived the
  merge only because the re-hashed base lacked it — the renamed file came in
  as a clean add and passes). 618 test files / 6097 tests pass. Phone result
  recorded for this sync: PENDING (user deploy; not a current deployment claim).
- **Fourth sync (2026-09-05)**: split `f2e956ba` (322 desktop commits since
  v2026.8.27 — Bot Mode design system, owner-route threading, tips system,
  pool limits, `ru` locale). Lineage CONTINUOUS (no re-hash; merge base is the
  old split head `ed4fb0c01` itself) — only 5 `UU`: package.json (ours +
  widened engines), assert-root-install (upstream rewrite minus the Electron
  floor + fork Node gate), wiring `onResumeSession` (upstream's
  `sessionOwnerRouteFromRow` returns undefined for untagged rows — SUBSUMES
  the fork's untagged-row guard, so the guard was dropped), tooltip (upstream
  shape + fork `pointer-coarse:hidden`), vitest.config (ours). 0 `DU`/`UD`;
  stripped-paths assertion clean. Junk watch: upstream committed two stray
  macOS lockfiles (`apps/desktop/'/var/folders/...mutex`, menu-label PRs) —
  unreferenced, removed. Fork adaptations: `PoolLimits` inlined in global.d.ts
  (never the `../electron/pool-limits` import — file absent here); new
  `pool-limits-setting.tsx` leaf-gated on `getPoolLimits` + bounds inlined
  (it imports `../../../electron/pool-limits`, which would fail the fork
  build); model-menu effect threads `ownerConnectionId` (2-arg setQueryData
  misses the new owner-suffixed key); `ru.ts` gains the fork `share` block +
  `fileAttachFailed` (strict parity); shim `saveImageBuffer` takes upstream's
  `name`. Deps: no drift (root + desktop deps/overrides unchanged; engines
  widened both manifests). Tests: model-menu-panel count 2→3 (mount query +
 mount effect + manual refresh); relay-deliver-budget backend-mirror tests
 `runIf`'d (hermes_cli/tui_gateway absent here). 723 files / 7240 tests
 (2 skipped). Phone result recorded for this sync: PENDING (user deploy;
 not a current deployment claim).
- **Fifth sync (2026-09-18):** split `b5b8cad7` (the renderer split advanced
  from `f2e956ba` — v7 server→client approval bridge, model-menu controller
 extraction, screenshot bridge member, strip-visibility rework, hub-picker
 move, telegram QR setup). Split lineage RE-HASHED again (unpinned uvx
 filter-repo drifted, same as Aug 27) — verified benign by TREE MATCH
 (`f2e956ba` tree found verbatim at `e37edc11` = TM). Merge base rolled back
 to `3dfd530e`, so the surface inflated: 203 `UU` + 101 `AA` + 1 `DU`
 (`stage-native-deps.test.mjs`, keep deleted) + 3 `UD`. Resolved: 267
 pure-upstream via tree-match classify + take-theirs; ~20 fork files via
 `checkout --theirs` + `git apply --3way` of the `TM..HEAD` delta; 23 manual
 (package.json, model-menu controller port, wiring union, titlebar flip
 gate, narrow-overlays solo+revealable union, i18n unions, global.d.ts
 ScreenshotApi/HermesNotification snapshots, PWA profile-route trio,
 AppContextMenu migration, UD deletions accepted for plugins-settings +
 embedded-hub-picker (superseded, zero refs), keybind late-actions test
 removed (page is stripped)). Fixes found by verification, not the merge:
 `qrcode` re-added to deps (upstream's new telegram QR setup needs it —
 blanket-drop was wrong), three both-sides-added dup blocks deduped
 (statusbar labels, windows popout, config record), hideOnly rung
 re-added to reworked `stranded()`, model-menu test counts 2→3 (mount now
 reads query + auto-refresh), sidebar test 4th arg, relay settlement test
 `runIf`'d. Deps: overrides identical to upstream tip; only expected
 `file:../shared`. Stripped-paths assertion clean, no junk. Typecheck clean;
 build green (~39 s); 896 files / 8292 tests pass (3 skipped). Phone result
 recorded for this sync: PENDING (user deploy; not a current deployment claim).
- **Post-sync fork work (2026-09-06 through 2026-09-24):** touch-primary
  composer newline and focus-follow guard; unavailable-terminal layout cleanup;
  Bot Mode narrow-viewport gating; same-origin media playback/download and
  on-device TTS; touch-friendly Git review, explicit overlay reveal, timeline
  edge protection, untracked-directory rendering, and root/literal Git paths;
  repository-wide lint cleanup. Repository-wide lint was not part of the
  historical sync procedure; it is now required and the current baseline is
  0 errors (warnings remain).
- **Current upstream supersession check (2026-09-24):** `upstream/main` is newer
  than the fifth-sync baseline. Its pointerdown-owned focus-follow and
  always-external-link setting should be evaluated during the next split sync;
  they do not make the current PWA fixes obsolete before that sync lands.
  Upstream's timeline-hide preference is user-controlled and is not equivalent
  to this fork's automatic coarse-pointer edge-overlap suppression.
