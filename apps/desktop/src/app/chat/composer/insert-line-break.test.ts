import { afterEach, describe, expect, it } from 'vitest'

import { insertComposerLineBreak } from './insert-line-break'
import { composerPlainText, normalizeComposerEditorDom, renderComposerContents, RICH_INPUT_SLOT } from './rich-editor'

afterEach(() => {
  document.body.replaceChildren()
  window.getSelection()?.removeAllRanges()
})

describe('touch line breaks survive the real draft pipeline', () => {
  it.each(['first', '', 'first\n', '@file:`a.txt` '])(
    'preserves a newline after %j through normalisation and restore',
    text => {
      const editor = document.createElement('div')
      editor.dataset.slot = RICH_INPUT_SLOT
      editor.style.whiteSpace = 'pre-wrap'
      editor.contentEditable = 'true'
      document.body.append(editor)
      renderComposerContents(editor, text)
      const range = document.createRange()
      range.selectNodeContents(editor)
      range.collapse(false)
      window.getSelection()!.addRange(range)
      insertComposerLineBreak(editor)
      normalizeComposerEditorDom(editor)
      const draft = composerPlainText(editor)
      expect(draft).toBe(`${text}\n`)
      // Type at the restored caret, proving the next text lands after the break.
      window.getSelection()!.getRangeAt(0).insertNode(document.createTextNode('second'))
      normalizeComposerEditorDom(editor)
      expect(composerPlainText(editor)).toBe(`${text}\nsecond`)
      renderComposerContents(editor, `${text}\nsecond`)
      expect(composerPlainText(editor)).toBe(`${text}\nsecond`)
    }
  )

  it('replaces a selection without losing surrounding text', () => {
    const editor = document.createElement('div')
    editor.dataset.slot = RICH_INPUT_SLOT
    editor.textContent = 'before SELECT after'
    document.body.append(editor)
    const range = document.createRange()
    range.setStart(editor.firstChild!, 7)
    range.setEnd(editor.firstChild!, 13)
    window.getSelection()!.addRange(range)
    insertComposerLineBreak(editor)
    normalizeComposerEditorDom(editor)
    expect(composerPlainText(editor)).toBe('before \n after')
  })
})
