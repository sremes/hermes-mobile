import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { LayoutNode } from '@/components/pane-shell/tree/model'

// Keep the real controller, registry, capability detection and persisted layout
// lifecycle. Only unrelated UI surfaces and background synchronisation are inert.
vi.mock('@/app/chat/session-draft-title', () => ({ SessionDraftTitle: () => null }))
vi.mock('@/app/chat/session-status-dot', () => ({ SessionStatusDot: () => null }))
vi.mock('@/components/assistant-ui/inline-preview-directive', () => ({ InlinePreviewDirective: () => null }))
vi.mock('@/components/pane-shell/tree/renderer', () => ({ LayoutTreeRoot: () => null }))
vi.mock('@/contrib/plugins', () => ({ discoverBundledPlugins: vi.fn() }))
vi.mock('@/contrib/runtime-loader', () => ({ discoverRuntimePlugins: vi.fn() }))
vi.mock('@/store/profile-share', () => ({ runExportProfileFlow: vi.fn(), runImportProfileFlow: vi.fn() }))
vi.mock('@/store/session-pin-sync', () => ({ watchSessionPins: vi.fn() }))
vi.mock('@/store/session-unread-remote', () => ({ watchUnreadWriteGuard: vi.fn() }))
vi.mock('../chat/browser-popout-shell', () => ({ BrowserPopoutShell: () => null }))
vi.mock('../chat/preview-tile', () => ({ watchPreviewTiles: vi.fn() }))
vi.mock('../chat/route-tile', () => ({ watchRouteTiles: vi.fn() }))
vi.mock('../chat/session-drag', () => ({ startSessionDrag: vi.fn() }))
vi.mock('../chat/session-tile', () => ({
  SessionTileCloseConfirm: () => null,
  stackSessionTilesIntoMain: vi.fn(),
  startUnrestoredTileTitleBackfill: vi.fn(),
  watchSessionTiles: vi.fn(),
  WorkspaceTabMenu: () => null
}))
vi.mock('../context-menu/app-context-menu', () => ({ AppContextMenu: () => null }))
vi.mock('../hud/hud-shell', () => ({ HudShell: () => null }))
vi.mock('./panes', () => ({ FilesPane: () => null, LogsPane: () => null, ReviewPaneContent: () => null }))
vi.mock('@/app/shell/shell-context-menu', () => ({ ShellContextMenu: () => null }))
vi.mock('./wiring', () => ({ ContribWiring: () => null, WiredPane: () => null }))

const storageKey = 'hermes.desktop.layoutTree.v2'

async function boot(terminal = false) {
  vi.resetModules()
  // Capability is detected from the bridge before the controller is imported,
  // just as browser-bridge installation precedes application startup.
  window.hermesDesktop = { terminal: terminal ? {} : undefined } as Window['hermesDesktop']
  const presets = await import('@/components/pane-shell/tree/presets')
  await import('./controller')
  const store = await import('@/components/pane-shell/tree/store')
  const model = await import('@/components/pane-shell/tree/model')
  const { registry } = await import('@/contrib/registry')

  return { ...store, ...model, ...presets, registry }
}

beforeEach(() => {
  window.localStorage.clear()
})

describe('terminal capability at layout startup', () => {
  it('does not register or place an unavailable terminal on a fresh browser load', async () => {
    const app = await boot()
    expect(app.registry.getArea('panes').map(p => p.id)).not.toContain('terminal')
    expect(app.allPaneIds(app.$layoutTree.get()!)).not.toContain('terminal')
    expect(app.registry.getArea('palette').map(p => p.id)).not.toContain('view.showTerminal')
  })

  it('does not adopt a dismissed terminal into the sessions sidebar on refresh', async () => {
    const { group, split } = await import('@/components/pane-shell/tree/model')
    window.localStorage.setItem(
      storageKey,
      JSON.stringify(
        split('row', [
          group(['sessions'], { id: 'left' }),
          group(['workspace'], { id: 'main' }),
          group(['files', 'review'], { id: 'right' })
        ])
      )
    )
    const app = await boot()
    expect(app.findGroupOfPane(app.$layoutTree.get()!, 'sessions')?.panes).toEqual(['sessions'])
    expect(app.allPaneIds(app.$layoutTree.get()!)).not.toContain('terminal')
  })

  it.each(['sessions', 'workspace', 'standalone'])(
    'removes a stale terminal from %s without losing other panes, including a second refresh',
    async location => {
      const { group, split } = await import('@/components/pane-shell/tree/model')

      const tree = split('row', [
        group(location === 'sessions' ? ['sessions', 'terminal'] : ['sessions'], { id: 'left', active: 'sessions' }),
        group(location === 'workspace' ? ['workspace', 'terminal'] : ['workspace'], {
          id: 'main',
          active: 'workspace'
        }),
        group(['files', 'review', 'plugin:notes'], { id: 'right', active: 'plugin:notes', tabStrip: 'never' }),
        ...(location === 'standalone' ? [group(['terminal'], { id: 'old-terminal' })] : [])
      ])

      window.localStorage.setItem(storageKey, JSON.stringify(tree))
      const first = await boot()
      expect(first.allPaneIds(first.$layoutTree.get()!)).not.toContain('terminal')
      expect(first.findGroupOfPane(first.$layoutTree.get()!, 'plugin:notes')).toMatchObject({
        id: 'right',
        active: 'plugin:notes',
        tabStrip: 'never',
        panes: ['files', 'review', 'plugin:notes']
      })
      expect(first.allPaneIds(JSON.parse(window.localStorage.getItem(storageKey)!))).not.toContain('terminal')
      const second = await boot()
      expect(second.allPaneIds(second.$layoutTree.get()!)).not.toContain('terminal')
      expect(second.allPaneIds(second.$layoutTree.get()!)).toContain('plugin:notes')
    }
  )

  it('keeps the terminal out of every core preset and reset in a browser', async () => {
    const app = await boot()

    for (const preset of app.registry.getArea('layouts')) {
      expect(app.allPaneIds(preset.data as LayoutNode)).not.toContain('terminal')
      app.applyTree(preset.data as LayoutNode, preset.id)
      expect(app.allPaneIds(app.$layoutTree.get()!)).not.toContain('terminal')
    }

    app.resetLayoutTree()
    expect(app.allPaneIds(app.$layoutTree.get()!)).not.toContain('terminal')
    app.registry.register({ id: 'plugin:later', area: 'panes', data: { placement: 'right' }, render: () => null })
    expect(app.allPaneIds(app.$layoutTree.get()!)).toContain('plugin:later')
    expect(app.allPaneIds(app.$layoutTree.get()!)).not.toContain('terminal')
  })

  it.each([false, true])('applies saved and plugin presets according to terminal capability (%s)', async terminal => {
    const { group, split } = await import('@/components/pane-shell/tree/model')
    const tree = split('row', [group(['sessions', 'terminal']), group(['workspace', 'plugin:notes'])])
    window.localStorage.setItem(
      'hermes.desktop.layoutPresets.v2',
      JSON.stringify({
        'user-old': { name: 'Old layout', tree }
      })
    )
    const app = await boot(terminal)
    app.registry.register({ id: 'plugin:layout', area: 'layouts', source: 'plugin', data: tree })

    for (const id of ['user-old', 'plugin:layout']) {
      const preset = app.registry.getArea('layouts').find(p => p.id === id)!
      app.applyLayoutPreset(id, preset.data as LayoutNode)
      const panes = app.allPaneIds(app.$layoutTree.get()!)
      expect(panes.includes('terminal')).toBe(terminal)
      expect(panes).toContain('plugin:notes')
      expect(app.allPaneIds(JSON.parse(window.localStorage.getItem(storageKey)!)).includes('terminal')).toBe(terminal)
      // Applying a browser-filtered copy must not destroy the saved preset.
      expect(app.allPaneIds(preset.data as LayoutNode)).toContain('terminal')
    }
  })

  it('ignores an unavailable terminal-only preset without losing the current layout', async () => {
    const app = await boot()
    const before = app.$layoutTree.get()
    app.applyLayoutPreset('old-terminal-only', app.group(['terminal']))
    expect(app.$layoutTree.get()).toBe(before)
  })

  it('preserves terminal registration, presets and toggling when the bridge supports it', async () => {
    const app = await boot(true)
    expect(app.registry.getArea('panes').map(p => p.id)).toContain('terminal')
    expect(app.registry.getArea('palette').map(p => p.id)).toContain('view.showTerminal')
    expect(app.allPaneIds(app.$layoutTree.get()!)).toContain('terminal')

    for (const preset of app.registry.getArea('layouts')) {
      expect(app.allPaneIds(preset.data as LayoutNode)).toContain('terminal')
    }

    app.togglePaneVisible('terminal')
    expect(app.isPaneVisible('terminal')).toBe(true)
    app.togglePaneVisible('terminal')
    expect(app.isPaneVisible('terminal')).toBe(false)
  })
})
