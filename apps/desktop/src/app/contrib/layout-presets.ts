import { hasTerminal } from '@/bridge/capabilities'
import { group, type LayoutNode, mirrorTreeHorizontal, removePane, split } from '@/components/pane-shell/tree/model'
import { registerBundledPresets } from '@/components/pane-shell/tree/presets'

// ---------------------------------------------------------------------------
// Layout presets — CHAT (main) always dominates.
// ---------------------------------------------------------------------------

// The REAL default: sessions left, chat main, and the right sidebars in column
// order main | … | review | file-browser (files outermost). Each is its OWN
// zone. Review collapses to nothing while its pane is hidden (⌘G off).
//
// Preview tiles are DYNAMIC panes (like session tiles), so no preset names one:
// they're registered by watchPreviewTiles as tabs open, and dockPaneBeside lands
// each one directly beside the file tree wherever that currently lives — so a
// file double-click still slides a preview open as its own pane next to the
// tree, never as a tab stacked into the files sidebar.
export const DEFAULT_TREE = split(
  'row',
  [
    group(['sessions'], { id: 'grp-sessions' }),
    group(['workspace'], { id: 'grp-main' }),
    split(
      'column',
      [
        split(
          'row',
          [group(['review'], { id: 'grp-review' }), group(['files'], { id: 'grp-files' })],
          [1, 1.2],
          'spl-rail'
        ),
        group(['terminal'], { id: 'grp-terminal' })
      ],
      [1.6, 1],
      'spl-right'
    )
  ],
  [1, 3.4, 1.25],
  'spl-root'
)

// Focus is one column of attention: files and review are tabs BEHIND the chat,
// the terminal a collapsed rail under it — opening the terminal must never
// cover the conversation, which a terminal tab did.
const FOCUS_TREE = split(
  'row',
  [group(['sessions']), split('column', [group(['workspace', 'files', 'review']), group(['terminal'])], [3, 1])],
  [1, 4.6]
)

// Basic is sessions and chat with the tooling RESTING in its own slots: the
// terminal a collapsed rail under the chat (its column carries the chat, so
// ⌘J folding the right side can never take the rail with it), review and
// files a right column that ⌘J / ⌘G open. A tree that simply omitted them was
// a lie — applying it adopts every missing pane back in as workspace tabs,
// which is Focus.
export const BASIC_TREE = split(
  'row',
  [
    group(['sessions']),
    split('column', [group(['workspace']), group(['terminal'])], [3, 1]),
    split('row', [group(['review']), group(['files'])], [1, 1.2])
  ],
  [1, 3.4, 1.25]
)

const BASIC_RESTING = ['terminal', 'files', 'review'] as const

const TERMINAL_TREE = split(
  'column',
  [
    split('row', [group(['sessions']), group(['workspace']), group(['files', 'review'])], [1, 3.2, 1.2]),
    group(['terminal'])
  ],
  [3, 1]
)

const QUAD_TREE = split(
  'column',
  [
    split('row', [group(['sessions', 'files']), group(['workspace'])], [1, 3]),
    split('row', [group(['terminal']), group(['review'])], [1.4, 1])
  ],
  [3, 1]
)

// Every core layout contains workspace, so removing terminal cannot empty it.
// Fork: the browser build has no terminal bridge — register the same specs
// upstream ships, minus the terminal pane and its resting entries, so reset
// and preset listings never offer a pane that cannot exist.
export const availableLayout = (tree: LayoutNode): LayoutNode =>
  (hasTerminal ? tree : removePane(tree, 'terminal')!)

export const availableResting = (resting: readonly string[]): readonly string[] =>
  (hasTerminal ? resting : resting.filter(pane => pane !== 'terminal'))

export function registerLayoutPresets() {
  // Simple is always the Basic arrangement; its one choice is which side the
  // sidebar sits. The decks are Advanced — arranging tooling is the point.
  return registerBundledPresets([
    { id: 'sidebar-left', title: 'Sidebar left', order: 0, tree: availableLayout(BASIC_TREE), resting: availableResting(BASIC_RESTING), tier: 'simple' },
    {
      id: 'sidebar-right',
      title: 'Sidebar right',
      order: 1,
      tree: availableLayout(mirrorTreeHorizontal(BASIC_TREE)),
      resting: availableResting(BASIC_RESTING),
      tier: 'simple'
    },
    { id: 'default', title: 'Default', order: 0, tree: availableLayout(DEFAULT_TREE), tier: 'advanced' },
    { id: 'basic', title: 'Basic', order: 5, tree: availableLayout(BASIC_TREE), resting: availableResting(BASIC_RESTING), tier: 'advanced' },
    { id: 'focus', title: 'Focus', order: 10, tree: availableLayout(FOCUS_TREE), resting: availableResting(['terminal']), tier: 'advanced' },
    { id: 'terminal-deck', title: 'Terminal deck', order: 20, tree: availableLayout(TERMINAL_TREE), tier: 'advanced' },
    { id: 'quad', title: 'Quad', order: 30, tree: availableLayout(QUAD_TREE), tier: 'advanced' }
  ])
}
