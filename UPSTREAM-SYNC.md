# Upstream sync playbook

How this fork stays close to upstream Hermes Desktop **without** following every
commit. Model decision (2026-08-15): **throttled merges at release boundaries** —
a regular, small sync cost keeps divergence bounded, so porting an interesting
feature later never becomes a full re-port.

The alternative models were considered and rejected: continuous per-commit merge
(upstream moves ~38 desktop commits/day — pure churn), and watch-only selective
porting (divergence grows until a port IS a re-port). The watcher below decides
*when* a sync is due; the merge procedure is *how* it runs.

## Why merges work at all (the re-root)

This fork has **no shared ancestry** with upstream: it was imported as a
snapshot ("stage 1: fork Hermes Desktop renderer") and history was rewritten by
`git-filter-repo` (domain scrub). `git merge upstream/main` therefore sees
unrelated histories. Fix — one-time, per checkout:

```bash
git replace --graft fd25c86dcf6bdfc8e51f29bba7582d06681dc407 f15a38ee73631b3cd5f7d30765c37d5f0245d403
```

- `fd25c86` = this fork's root commit.
- `f15a38e` = the last upstream commit before the fork snapshot (2026-08-07) —
  the honest parent of our history.
- After this, `git merge upstream/main` is a real 3-way merge. The first merge
  carries our fork delta (strip edits + 35 commits) as one side and ~8 days of
  upstream churn as the other; conflicts appear only in the intersection.

Caveats:

- Replace refs are **local repo state** (`refs/replace/`), not pushed by
  default. Every fresh clone needs the graft re-applied before merging upstream.
  Keep the two SHAs above current in this file.
- The current `upstream` remote was fetched shallow (`--shallow-since`) with
  `--filter=blob:none` (promisor). Deepen before a sync: `git fetch upstream
  --shallow-since=<2 months back> --filter=blob:none`.
- Re-root verification: `git merge-base fd25c86 upstream/main` must print
  `f15a38e…` (i.e. the graft takes effect).

## When to sync (and when to skip)

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

## Sync procedure

```bash
git fetch upstream main
git fetch upstream --shallow-since=...            # deepen if needed
git checkout -b sync/upstream-<date> upstream/main
git merge main                                    # 3-way, real base after re-root
```

Resolve conflicts per the table below, then:

1. `npm install` (root workspace) — deps changed almost every cycle
2. `cd apps/desktop && npx tsc -p . --noEmit && npm run build`
3. `npm run test` (vitest) — update tests whose signatures upstream moved
4. **Phone test** (the acceptance bar — headless hides touch regressions):
   sign-in flow, share-into-composer (stash repaint), attach incl. HEIC, drawer
   rails <768px, model-menu touch scroll, composer send, review-pane diffs
5. Commit per stage, push, verify remote SHA (`git ls-remote origin main`)
6. Update the "Last sync" line below; delete the sync branch

## Expected conflict surface (measured 2026-08-15, fork Aug 7 → Aug 15)

Upstream desktop churn in 8 days: **305 commits**. Intersection with our
modified files: ~15 files, half mechanical:

| File | Upstream touches/8d | Resolution |
|---|---|---|
| `src/i18n/{en,zh,ja,ar,zh-hant,types}.ts` | ~124 | mechanical: script block-scoped inserts of our keys (`share`, `revealExplorer`, …) into the new structure; i18n types must match across all locales or tsc fails |
| `src/global.d.ts` | 14 | contract diff: new members → implement in `browser-bridge.ts` or leave `undefined` (feature-detect); removed members → no action (we ship our own snapshot) |
| `src/app/chat/composer/**` | 29 | our share/stash event logic (`COMPOSER_DRAFT_STASHED_EVENT`, lineage-root keys) must survive upstream composer changes — the delicate one |
| `src/app/contrib/wiring.tsx` | 17 | our boot wiring (share-inbox consume) vs upstream boot changes |
| `apps/desktop/package.json` | 13 | keep Electron-strip + heic2any; take upstream deps |
| `src/app/hooks/use-keybinds.ts`, `lib/keybinds/*`, `app/shell/titlebar-controls.tsx` | ~22 | keep our pointer-coarse/hotkey chrome removals in the new shape |
| `src/main.tsx` | 2 | keep prod-only SW registration |

Never-conflict (ours, new files): `src/bridge/*`, `src/lib/share-inbox.ts`,
`src/app/chat/share-intake-dialog.tsx`, `public/`, `deploy/`, `templates/`.

## Watcher (planned — cron, weekly)

Not yet created (2026-08-15). Spec:

1. `git fetch upstream` (deepen as needed), then report:
   - `git log --oneline <last-sync-sha>..upstream/main -- apps/desktop | wc -l` +
     touch counts per file in the conflict surface (the table above)
   - contract diff: `git diff <last-sync-sha> upstream/main -- apps/desktop/src/global.d.ts apps/shared` → list new/removed bridge members (the porting checklist)
2. Desktop releases scan (GitHub) for notable renderer features.
3. Agent releases scan for gateway REST endpoint changes (the urgent trigger).
4. Deliver a 30-second drift report → user decides sync / skip.

## Long-term exit ramp

The browser bridge is a genuine contribution: a web/PWA target for the desktop
renderer. If upstream ever accepts it (MIT, community PRs), that part of our
delta disappears and the fork shrinks toward "deploy config + PWA shell".

## Last sync

- Fork baseline: upstream `f15a38e` (2026-08-07)
- No syncs yet (2026-08-15)
