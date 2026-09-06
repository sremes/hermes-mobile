import { readFileSync } from 'node:fs'

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createElement } from 'react'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { liveComposerDraft } from './composer-utils'
import { useEnterNewline } from './hooks/use-enter-newline'

// Execute the actual production handler, not a handwritten mirror. The full
// ChatBar requires a live assistant runtime; inject only its closure dependencies.
// AST extraction also checks the visible editor is wired to this handler.
const source = readFileSync('src/app/chat/composer/index.tsx', 'utf8')
const file = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

function findNode(predicate: (node: ts.Node) => boolean): ts.Node {
  let result: ts.Node | undefined

  function visit(node: ts.Node) {
    if (!result && predicate(node)) {result = node}

    if (!result) {ts.forEachChild(node, visit)}
  }

  visit(file)

  if (!result) {throw new Error('Production composer seam not found')}

  return result
}

const declaration = findNode(
  node => ts.isVariableDeclaration(node) && node.name.getText(file) === 'handleEditorKeyDown'
) as ts.VariableDeclaration

const handler = ts.transpileModule(`const handler = ${declaration.initializer!.getText(file)}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText

const editor = findNode(
  node =>
    ts.isJsxSelfClosingElement(node) &&
    node.tagName.getText(file) === 'div' &&
    node.attributes.properties.some(attr => ts.isJsxAttribute(attr) && attr.name.getText(file) === 'onKeyDown')
) as ts.JsxSelfClosingElement

const submitAttribute = findNode(
  node =>
    ts.isJsxAttribute(node) &&
    node.name.getText(file) === 'onSubmit' &&
    ts.isJsxOpeningElement(node.parent.parent) &&
    node.parent.parent.tagName.getText(file) === 'ComposerPrimitive.Root'
) as ts.JsxAttribute

const submitExpression = (submitAttribute.initializer as ts.JsxExpression).expression!

const formHandler = ts.transpileModule(`const handler = ${submitExpression.getText(file)}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText

function setup({
  touch = true,
  busy = false,
  queued = false,
  text = 'hello',
  attachment = false,
  queueEdit = false,
  completion = false,
  disabled = false
} = {}) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(pointer: coarse)' ? touch : false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }))

  const submit = vi.fn(),
    queue = vi.fn(),
    drain = vi.fn(),
    promote = vi.fn(),
    pick = vi.fn()

  const composingRef = { current: false }
  const editorRef = { current: null as HTMLDivElement | null }

  const deps = {
    composingRef,
    editorRef,
    busy,
    disabled,
    draftRef: { current: '' },
    attachments: attachment ? [{}] : [],
    queuedPrompts: queued ? [{ id: 'queued' }] : [],
    queueEdit: queueEdit ? { entryId: 'edit' } : undefined,
    isUndoShortcut: () => false,
    isRedoShortcut: () => false,
    withUndoPoint: (run: () => boolean) => run(),
    chipTypedUrlOnSpace: () => false,
    chipTypedPathOnSpace: () => false,
    trigger: completion ? { kind: '@', query: 'file' } : null,
    triggerLoading: false,
    triggerItems: completion ? [{ label: 'file' }] : [],
    triggerActiveExplicit: true,
    triggerActive: 0,
    slashFreeTextArgStage: false,
    triggerKeyConsumedRef: { current: false },
    acceptsTriggerCompletion: () => completion,
    replaceTriggerWithChip: pick,
    composerPlainText: (node: HTMLElement) => node.textContent ?? '',
    liveComposerDraft,
    setComposerText: vi.fn(),
    submitDraft: submit,
    queueDraft: queue,
    drainNextQueued: drain,
    sendQueuedNow: promote
  }

  const compile = (code: string, values: Record<string, unknown>) =>
    new Function(...Object.keys(values), `${code}; return handler`)(...Object.values(values))

  function Harness() {
    const enterNewline = useEnterNewline()

    return createElement(
      'form',
      { onSubmit: compile(formHandler, deps) },
      createElement(
        'div',
        {
          contentEditable: true,
          suppressContentEditableWarning: true,
          role: 'textbox',
          ref: (el: HTMLDivElement | null) => {
            editorRef.current = el
          },
          onKeyDown: compile(handler, { ...deps, enterNewline })
        },
        text
      ),
      createElement('button', { type: 'submit' }, 'Send')
    )
  }

  const view = render(createElement(Harness))
  const input = view.getByRole('textbox')

  const press = (extra: Record<string, unknown> = {}) => {
    const native = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...extra })
    act(() => {
      input.dispatchEvent(native)
    })

    return native
  }

  return { ...view, input, press, submit, queue, drain, promote, pick, composingRef }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('production composer Enter handler', () => {
  it.each([
    {},
    { busy: true },
    { queued: true, text: '' },
    { busy: true, queued: true, text: '' },
    { attachment: true, text: '' },
    { queueEdit: true, queued: true },
    { disabled: true }
  ])('leaves touch Enter native without sending or manipulating work: %j', options => {
    const state = setup(options)
    expect(state.press().defaultPrevented).toBe(false)

    for (const action of [state.submit, state.queue, state.drain, state.promote]) {expect(action).not.toHaveBeenCalled()}
  })

  it('keeps desktop Enter submit and Shift+Enter native', () => {
    const state = setup({ touch: false })
    expect(state.press().defaultPrevented).toBe(true)
    expect(state.submit).toHaveBeenCalledOnce()
    expect(state.press({ shiftKey: true }).defaultPrevented).toBe(false)
    expect(state.submit).toHaveBeenCalledOnce()
  })

  it.each(['ctrlKey', 'metaKey'])('keeps busy modified Enter queueing: %s', modifier => {
    const state = setup({ busy: true })
    expect(state.press({ [modifier]: true }).defaultPrevented).toBe(true)
    expect(state.queue).toHaveBeenCalledOnce()
  })

  it('lets completion acceptance own Enter before the newline policy', () => {
    const state = setup({ completion: true })
    expect(state.press().defaultPrevented).toBe(true)
    expect(state.pick).toHaveBeenCalledOnce()
    expect(state.submit).not.toHaveBeenCalled()
  })

  it('preserves IME confirmation and stale composition recovery', () => {
    const state = setup({ touch: false })
    state.press({ isComposing: true })
    state.press({ keyCode: 229 })
    expect(state.submit).not.toHaveBeenCalled()
    state.composingRef.current = true
    state.press()
    expect(state.submit).toHaveBeenCalledOnce()
  })

  it('keeps explicit form submission available for multiline drafts', () => {
    const state = setup({ text: 'first\nsecond' })
    fireEvent.click(state.getByRole('button', { name: 'Send' }))
    expect(state.submit).toHaveBeenCalledOnce()
    expect(state.input.textContent).toBe('first\nsecond')
  })

  it('wires the policy and return-key hint to the visible production editor', () => {
    const attrs = editor.attributes.properties.map(attr => attr.getText(file)).join('\n')
    expect(attrs).toContain('onKeyDown={handleEditorKeyDown}')
    expect(attrs).toContain("enterKeyHint={enterNewline ? 'enter' : undefined}")
    expect(source).toContain('const enterNewline = useEnterNewline()')
  })
})
