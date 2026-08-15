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
# 1. Scratch clone of upstream, history only (no checkout, no blobs yet)
git clone --no-checkout --filter=blob:none \
  --shallow-since=2026-07-25 https://github.com/NousResearch/hermes-agent.git \
  /opt/data/cache/upstream-split

# 2. Keep only the renderer subtree (rewrites the scratch clone in place)
cd /opt/data/cache/upstream-split
uvx git-filter-repo --path apps/desktop --path apps/shared --force

# 3. Import the split into the fork as a tracking branch
cd /opt/data/hermes-mobile
git fetch /opt/data/cache/upstream-split main:refs/heads/upstream-desktop

# 4. Re-root the fork onto the SPLIT of the fork-time upstream commit.
#    split-of-f15a38e = `git log --format=%H --until='2026-08-07 15:29' upstream-desktop | tail -1`
#    (the oldest commit of the split branch; deterministic, compute it once)
git replace --graft fd25c86dcf6bdfc8e51f29bba7582d06681dc407 <split-of-f15a38e>
```

After the graft, `git merge upstream-desktop` is a real 3-way merge whose base
contains **only** the renderer subtree. Verify: `git merge-base fd25c86
upstream-desktop` prints the split-of-f15a38e SHA.

Caveats:

- Replace refs are **local repo state** (`refs/replace/`), not pushed by
  default. Every fresh clone needs the graft re-applied (keep the SHAs above
  current in this file).
- The scratch clone is disposable — recreate it per sync. Deepen the
  `--shallow-since` as the fork ages (e.g. 2 months back) so the split covers
  everything since the last sync.
- `git filter-repo` strips remotes after the rewrite — irrelevant for a scratch
  clone fetched by path.

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
# 1. Refresh the split (repeat setup steps 1–3; the fetch fast-forwards upstream-desktop)
cd /opt/data/cache/upstream-split && git fetch --shallow-since=<2 months back> origin main && uvx git-filter-repo --path apps/desktop --path apps/shared --force
cd /opt/data/hermes-mobile && git fetch /opt/data/cache/upstream-split main:refs/heads/upstream-desktop

# 2. Merge
git checkout -b sync/upstream-<date> main
git merge upstream-desktop
```

Resolve, in order:

1. **Scripted first**: `modify/delete` (`DU`) conflicts — the stripped Electron
   files upstream keeps touching. Keep deleted:
   `git status --porcelain | grep '^DU' | cut -c4- | xargs git rm`
   (expect ~39; same fixed set every cycle)
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
split: ~13 files, half mechanical:

| File | Upstream touches/8d | Resolution |
|---|---|---|
| `src/i18n/{en,zh,ja,ar,zh-hant,types}.ts` | ~124 | mechanical: script block-scoped inserts of our keys (`share`, `revealExplorer`, …) into the new structure; i18n types must match across all locales or tsc fails |
| `src/global.d.ts` | 14 | contract diff: new members → implement in `browser-bridge.ts` or leave `undefined` (feature-detect); removed members → no action (we ship our own snapshot) |
| `src/app/chat/composer/**` | 29 | our share/stash event logic (`COMPOSER_DRAFT_STASHED_EVENT`, lineage-root keys) must survive upstream composer changes — the delicate one |
| `src/app/contrib/wiring.tsx` | 17 | our boot wiring (share-inbox consume) vs upstream boot changes |
| `apps/desktop/package.json` | 13 | keep Electron-strip + heic2any; take upstream deps |
| `src/app/hooks/use-keybinds.ts`, `lib/keybinds/*`, `app/shell/titlebar-controls.tsx` | ~22 | keep our pointer-coarse/hotkey chrome removals in the new shape |
| `src/main.tsx` | 2 | keep prod-only SW registration |
| Stripped Electron files (electron-main, `scripts/*`, `tsconfig.electron.json`, …) | recurring | scripted `DU` resolution: keep deleted |

Never-conflict (ours, new files): `src/bridge/*`, `src/lib/share-inbox.ts`,
`src/app/chat/share-intake-dialog.tsx`, `public/`, `deploy/`, `templates/`.

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
  Phone test PENDING (user).
