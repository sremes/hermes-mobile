import { act, cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { composerPlainText, normalizeComposerEditorDom, renderComposerContents, RICH_INPUT_SLOT } from '../rich-editor'

import { useTouchLineBreak } from './use-touch-line-break'

afterEach(cleanup)

function harness(enabled = true) {
  const undo = vi.fn(),
    flush = vi.fn()

  let composingRef: { current: boolean }

  function Harness({ enabled }: { enabled: boolean }) {
    const editorRef = useRef<HTMLDivElement>(null)
    composingRef = useRef(false)
    useTouchLineBreak({
      enabled,
      editorRef,
      composingRef,
      recordUndoPoint: () => undo(composerPlainText(editorRef.current!)),
      flushEditorToDraft: editor => {
        normalizeComposerEditorDom(editor)
        flush(composerPlainText(editor))
      }
    })

    return (
      <div contentEditable data-slot={RICH_INPUT_SLOT} ref={editorRef} role="textbox" suppressContentEditableWarning />
    )
  }

  const view = render(<Harness enabled={enabled} />)
  const editor = view.getByRole('textbox')
  renderComposerContents(editor, 'first')
  const range = editor.ownerDocument.createRange()
  range.selectNodeContents(editor)
  range.collapse(false)
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)

  const input = (inputType = 'insertParagraph', options: InputEventInit = {}) => {
    const event = new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true, ...options })
    act(() => {
      editor.dispatchEvent(event)
    })

    return event
  }

  return {
    ...view,
    editor,
    input,
    undo,
    flush,
    composing: (value: boolean) => {
      composingRef.current = value
    },
    enable: (value: boolean) => view.rerender(<Harness enabled={value} />)
  }
}

describe('native touch beforeinput', () => {
  it.each(['insertParagraph', 'insertLineBreak'])(
    'handles %s without keydown and records exactly one undo point',
    type => {
      const state = harness()
      expect(state.input(type).defaultPrevented).toBe(true)
      expect(state.undo.mock.calls).toEqual([['first']])
      expect(state.flush.mock.calls).toEqual([['first\n']])
      expect(state.editor.querySelector('div')).toBeNull()
      // A saved snapshot restores exactly the pre-newline draft.
      renderComposerContents(state.editor, state.undo.mock.calls[0][0])
      expect(composerPlainText(state.editor)).toBe('first')
    }
  )

  it('leaves desktop input untouched', () => {
    const state = harness(false)
    expect(state.input().defaultPrevented).toBe(false)
    expect(state.flush).not.toHaveBeenCalled()
    expect(state.undo).not.toHaveBeenCalled()
  })

  it('ignores text edits, composition, and uncancellable input', () => {
    const state = harness()
    expect(state.input('insertText').defaultPrevented).toBe(false)
    expect(state.input('insertParagraph', { isComposing: true }).defaultPrevented).toBe(false)
    expect(state.input('insertParagraph', { cancelable: false }).defaultPrevented).toBe(false)
    state.composing(true)
    expect(state.input().defaultPrevented).toBe(false)
    expect(state.flush).not.toHaveBeenCalled()
    expect(state.undo).not.toHaveBeenCalled()
  })

  it('switches policy without duplicate listeners and cleans up on unmount', () => {
    const state = harness()
    state.enable(false)
    expect(state.input().defaultPrevented).toBe(false)
    state.enable(true)
    state.input()
    expect(state.undo).toHaveBeenCalledOnce()
    state.unmount()
    expect(state.input().defaultPrevented).toBe(false)
    expect(state.undo).toHaveBeenCalledOnce()
  })
})
