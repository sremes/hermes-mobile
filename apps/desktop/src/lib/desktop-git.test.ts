import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setApiRequestConnection } from '@/hermes'
import { $connection } from '@/store/session'

import { desktopGit } from './desktop-git'

const repoStatus = vi.fn(async () => ({ branch: 'main' }))
const worktreeList = vi.fn(async () => [{ branch: 'main', detached: false, isMain: true, locked: false, path: '/r' }])
const localGit = { repoStatus, review: { stage: vi.fn() }, worktreeList }

const api = vi.fn(async ({ path }: { path: string }) => {
  if (path.startsWith('/api/fs/git-root?')) {
    return { root: '/srv/repo-root' }
  }

  if (path.startsWith('/api/git/status')) {
    return { branch: 'remote-main' }
  }

  if (path.startsWith('/api/git/worktrees')) {
    return { worktrees: [{ branch: 'main', detached: false, isMain: true, locked: false, path: '/srv/r' }] }
  }

  if (path.startsWith('/api/git/review/diff')) {
    return { diff: 'remote-diff' }
  }

  if (path.startsWith('/api/git/branches')) {
    return {
      branches: [{ checkedOut: false, isDefault: false, isRemote: true, name: 'origin/feature', worktreePath: null }]
    }
  }

  return { ok: true }
})

describe('desktop git facade', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { hermesDesktop: { api, git: localGit } })
    $connection.set(null)
  })

  afterEach(() => {
    setApiRequestConnection(null)
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    $connection.set(null)
  })

  it('returns undefined after the renderer global is torn down', () => {
    vi.stubGlobal('window', undefined)

    expect(desktopGit()).toBeUndefined()
  })

  it('uses Electron git locally', async () => {
    $connection.set({ mode: 'local' } as never)

    await expect(desktopGit()?.repoStatus('/work')).resolves.toEqual({ branch: 'main' })
    expect(repoStatus).toHaveBeenCalledWith('/work')
    expect(api).not.toHaveBeenCalled()
  })

  it('routes reads through the backend REST mirror on a remote gateway', async () => {
    $connection.set({ mode: 'remote' } as never)

    await expect(desktopGit()?.repoStatus('/srv/work')).resolves.toEqual({ branch: 'remote-main' })
    expect(api).toHaveBeenCalledWith({ path: '/api/git/status?path=%2Fsrv%2Fwork' })

    // List endpoints unwrap their envelope to the bare array the bridge returns.
    await expect(desktopGit()?.worktreeList('/srv/work')).resolves.toEqual([
      { branch: 'main', detached: false, isMain: true, locked: false, path: '/srv/r' }
    ])

    // review.diff unwraps { diff } to a string.
    await expect(desktopGit()?.review.diff('/srv/work', 'a.txt', 'uncommitted', null, false)).resolves.toBe(
      'remote-diff'
    )

    expect(repoStatus).not.toHaveBeenCalled()
  })

  it('targets the active profile backend so a remote profile never touches the local repo', async () => {
    $connection.set({ mode: 'remote', profile: 'remote-docker' } as never)

    await desktopGit()?.repoStatus('/srv/work')
    await desktopGit()?.review.stage('/srv/work', 'a.txt')

    expect(api).toHaveBeenCalledWith({ path: '/api/git/status?path=%2Fsrv%2Fwork', profile: 'remote-docker' })
    expect(api).toHaveBeenCalledWith({
      body: { file: ':(literal)a.txt', path: '/srv/repo-root' },
      method: 'POST',
      path: '/api/git/review/stage',
      profile: 'remote-docker'
    })
  })

  it('routes remote git reads and writes through the active registered gateway', async () => {
    setApiRequestConnection('remote-user')
    $connection.set({ mode: 'remote', profile: 'default' } as never)

    await desktopGit()?.repoStatus('/srv/work')
    await desktopGit()?.review.stage('/srv/work', 'a.txt')

    expect(api).toHaveBeenCalledWith({
      connectionId: 'remote-user',
      path: '/api/git/status?path=%2Fsrv%2Fwork',
      profile: 'default'
    })
    expect(api).toHaveBeenCalledWith({
      body: { file: ':(literal)a.txt', path: '/srv/repo-root' },
      connectionId: 'remote-user',
      method: 'POST',
      path: '/api/git/review/stage',
      profile: 'default'
    })
  })

  it('resolves a nested session cwd to the repository root before review calls', async () => {
    $connection.set({ mode: 'remote' } as never)

    const result = await desktopGit()?.review?.list('/srv/repo/apps/desktop', 'uncommitted', null)

    expect(result).toBeDefined()
    expect(api).toHaveBeenCalledWith({
      path: '/api/fs/git-root?path=%2Fsrv%2Frepo%2Fapps%2Fdesktop',
      profile: undefined
    })
    expect(api).toHaveBeenCalledWith({
      path: '/api/git/review/list?path=%2Fsrv%2Frepo-root&scope=uncommitted',
      profile: undefined
    })
  })

  it('sends root-relative review paths as literal Git pathspecs', async () => {
    $connection.set({ mode: 'remote' } as never)

    await desktopGit()?.review.diff('/srv/repo', 'weird[1].txt', 'uncommitted', null, false)
    await desktopGit()?.review.stage('/srv/repo', 'weird[1].txt')

    expect(api).toHaveBeenCalledWith({
      path: '/api/git/review/diff?file=%3A%28literal%29weird%5B1%5D.txt&path=%2Fsrv%2Frepo-root&scope=uncommitted&staged=false',
      profile: undefined
    })
    expect(api).toHaveBeenCalledWith({
      body: { file: ':(literal)weird[1].txt', path: '/srv/repo-root' },
      method: 'POST',
      path: '/api/git/review/stage',
      profile: undefined
    })
  })

  it('uses the gateway no-index fallback for an untracked file without literal pathspec magic', async () => {
    $connection.set({ mode: 'remote' } as never)

    await expect(
      desktopGit()?.review.diff('/srv/repo', 'weird[1].txt', 'uncommitted', null, false, true)
    ).resolves.toBe('remote-diff')

    expect(api).toHaveBeenCalledWith({
      path: '/api/git/review/diff?file=weird%5B1%5D.txt&path=%2Fsrv%2Frepo-root&scope=uncommitted&staged=false',
      profile: undefined
    })
    expect(api).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: expect.stringContaining('/api/fs/read-text?') })
    )
  })

  it('keys repository-root cache by the active connection and profile', async () => {
    const scopedApi = vi.fn(async ({ path, profile }: { path: string; profile?: string }) => {
      if (path.startsWith('/api/fs/git-root?')) {
        return { root: profile === 'profile-a' ? '/srv/repo-a' : '/srv/repo-b' }
      }

      return { files: [] }
    })

    vi.stubGlobal('window', { hermesDesktop: { api: scopedApi, git: localGit } })

    $connection.set({ mode: 'remote', profile: 'profile-a' } as never)
    await desktopGit()?.review.list('/srv/repo', 'uncommitted', null)
    $connection.set({ mode: 'remote', profile: 'profile-b' } as never)
    await desktopGit()?.review.list('/srv/repo', 'uncommitted', null)

    expect(scopedApi).toHaveBeenCalledWith({
      path: '/api/fs/git-root?path=%2Fsrv%2Frepo',
      profile: 'profile-a'
    })
    expect(scopedApi).toHaveBeenCalledWith({
      path: '/api/fs/git-root?path=%2Fsrv%2Frepo',
      profile: 'profile-b'
    })
    expect(scopedApi).toHaveBeenCalledWith({
      path: '/api/git/review/list?path=%2Fsrv%2Frepo-a&scope=uncommitted',
      profile: 'profile-a'
    })
    expect(scopedApi).toHaveBeenCalledWith({
      path: '/api/git/review/list?path=%2Fsrv%2Frepo-b&scope=uncommitted',
      profile: 'profile-b'
    })
  })

  it('sends mutations as POST bodies on a remote gateway', async () => {
    $connection.set({ mode: 'remote' } as never)

    await desktopGit()?.review.stage('/srv/work', 'a.txt')

    expect(api).toHaveBeenCalledWith({
      body: { file: ':(literal)a.txt', path: '/srv/repo-root' },
      method: 'POST',
      path: '/api/git/review/stage',
      profile: undefined
    })
    expect(localGit.review.stage).not.toHaveBeenCalled()
  })

  // The ⌘⇧B "convert a branch into a worktree" flow (#81724): on a remote
  // gateway both halves must reach the backend mirror — the picker's branch
  // list (which now carries remote-tracking refs) and the worktree add that
  // receives the picked `origin/…` name.
  it('routes the convert-a-branch worktree flow through the backend on a remote gateway', async () => {
    $connection.set({ mode: 'remote' } as never)

    await expect(desktopGit()?.branchList('/srv/work')).resolves.toEqual([
      { checkedOut: false, isDefault: false, isRemote: true, name: 'origin/feature', worktreePath: null }
    ])
    expect(api).toHaveBeenCalledWith({ path: '/api/git/branches?path=%2Fsrv%2Fwork' })

    await desktopGit()?.worktreeAdd('/srv/work', { existingBranch: 'origin/feature' })

    expect(api).toHaveBeenCalledWith({
      body: { existingBranch: 'origin/feature', path: '/srv/work' },
      method: 'POST',
      path: '/api/git/worktree/add'
    })
  })
})
