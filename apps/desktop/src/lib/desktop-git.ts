import type {
  HermesGitBaseBranch,
  HermesGitBranch,
  HermesGitWorktree,
  HermesRepoPullRequests,
  HermesRepoStatus,
  HermesReviewList,
  HermesReviewShipInfo
} from '@/global'
import { hermesApi } from '@/hermes'

import { desktopFsCacheKey, desktopFsProfile, desktopGitRoot, isDesktopFsRemoteMode } from './desktop-fs'

// Remote-aware git facade. Locally the desktop runs git through Electron
// (window.hermesDesktop.git); on a remote gateway that's the wrong filesystem,
// so we mirror the same surface over the dashboard REST API (/api/git/*) — the
// coding rail, worktree lanes, review pane, and branch ops then act on the
// BACKEND repo where sessions actually run. Mirrors desktop-fs.ts.

type GitBridge = NonNullable<NonNullable<Window['hermesDesktop']>['git']>

function desktopApi<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const desktop = window.hermesDesktop

  if (!desktop) {
    throw new Error('Hermes Desktop bridge is unavailable')
  }

  return hermesApi<T>(
    body ? { body, method: 'POST', path, profile: desktopFsProfile() } : { path, profile: desktopFsProfile() }
  )
}

function gitGet<T>(route: string, params: Record<string, boolean | null | string | undefined>): Promise<T> {
  const query = new URLSearchParams()

  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) {
      query.set(key, String(value))
    }
  }

  return desktopApi<T>(`/api/git/${route}?${query.toString()}`)
}

function gitPost<T>(route: string, body: Record<string, unknown>): Promise<T> {
  return desktopApi<T>(`/api/git/${route}`, body)
}

type ReviewPathOptions = {
  // The gateway's untracked fallback passes this value directly to
  // `git diff --no-index /dev/null <file>`, where Git treats it as a filesystem
  // path, not a pathspec. Sending `:(literal)` there turns a valid untracked
  // file into "Could not access". The review store knows the row status.
  untracked?: boolean
}

function reviewPath(filePath: null | string | undefined, options?: ReviewPathOptions): null | string {
  if (filePath == null || options?.untracked) {
    return filePath ?? null
  }

  // Review rows come from git status, so their names are data rather than
  // user-entered patterns. Prefix the per-path magic so brackets, globs and a
  // leading colon cannot broaden reads or destructive mutations in gateways
  // that do not globally enable --literal-pathspecs.
  return `:(literal)${filePath}`
}

const repoRootByCwd = new Map<string, Promise<string | null>>()

function reviewRepoCacheKey(repoPath: string): string {
  return `${desktopFsCacheKey()}\0${repoPath}`
}

async function reviewRepoPath(repoPath: string): Promise<string> {
  if (!isDesktopFsRemoteMode()) {
    return repoPath
  }

  // Review paths come from git status and are repository-root-relative even
  // when a session starts in a subdirectory. Resolve the root once per cwd so
  // every review request uses the same base and never prefixes the path twice.
  const key = reviewRepoCacheKey(repoPath)
  let pending = repoRootByCwd.get(key)

  if (!pending) {
    pending = desktopGitRoot(repoPath).catch(() => null)
    repoRootByCwd.set(key, pending)
  }

  return (await pending) ?? repoPath
}

const remoteGit: GitBridge = {
  worktreeList: async repoPath =>
    (await gitGet<{ worktrees: HermesGitWorktree[] }>('worktrees', { path: repoPath })).worktrees,

  worktreeAdd: (repoPath, options) => gitPost('worktree/add', { path: repoPath, ...options }),

  worktreeRemove: (repoPath, worktreePath, options) =>
    gitPost('worktree/remove', { force: options?.force ?? false, path: repoPath, worktreePath }),

  branchSwitch: (repoPath, branch) => gitPost('branch/switch', { branch, path: repoPath }),

  branchList: async repoPath => (await gitGet<{ branches: HermesGitBranch[] }>('branches', { path: repoPath })).branches,

  baseBranchList: async repoPath =>
    (await gitGet<{ branches: HermesGitBaseBranch[] }>('base-branches', { path: repoPath })).branches,

  repoStatus: repoPath => gitGet<HermesRepoStatus | null>('status', { path: repoPath }),

  fileDiff: async (repoPath, filePath) =>
    (await gitGet<{ diff: string }>('file-diff', { file: filePath, path: repoPath })).diff,

  review: {
    list: async (repoPath, scope, baseRef) => {
      const root = await reviewRepoPath(repoPath)

      return gitGet<HermesReviewList>('review/list', { base: baseRef, path: root, scope })
    },

    diff: async (repoPath, filePath, scope, baseRef, staged, untracked) => {
      const root = await reviewRepoPath(repoPath)

      const response = await gitGet<{ diff: string }>('review/diff', {
        base: baseRef,
        file: reviewPath(filePath, { untracked }),
        path: root,
        scope,
        staged
      })

      return response.diff
    },

    stage: async (repoPath, filePath) => {
      const root = await reviewRepoPath(repoPath)

      return gitPost('review/stage', { file: reviewPath(filePath), path: root })
    },

    unstage: async (repoPath, filePath) => {
      const root = await reviewRepoPath(repoPath)

      return gitPost('review/unstage', { file: reviewPath(filePath), path: root })
    },

    revert: async (repoPath, filePath) => {
      const root = await reviewRepoPath(repoPath)

      return gitPost('review/revert', { file: reviewPath(filePath), path: root })
    },

    revParse: async (repoPath, ref) =>
      (await gitGet<{ sha: null | string }>('review/rev-parse', { path: repoPath, ref })).sha,

    commit: (repoPath, message, push) => gitPost('review/commit', { message, path: repoPath, push }),

    commitContext: repoPath => gitGet('review/commit-context', { path: repoPath }),

    push: repoPath => gitPost('review/push', { path: repoPath }),

    shipInfo: repoPath => gitGet<HermesReviewShipInfo>('review/ship-info', { path: repoPath }),

    prList: (repoPath, branches, numbers) =>
      gitPost<HermesRepoPullRequests>('review/pr-list', { branches, numbers: numbers ?? [], path: repoPath }),

    createPr: repoPath => gitPost('review/create-pr', { path: repoPath })
  },

  // Repo discovery is a local-disk crawl; on a remote gateway the backend
  // already merges session-derived repos, so this is a no-op.
  scanRepos: async () => []
}

export function desktopGit(): GitBridge | undefined {
  if (typeof window === 'undefined') {
    return undefined
  }

  return isDesktopFsRemoteMode() ? remoteGit : window.hermesDesktop?.git
}
