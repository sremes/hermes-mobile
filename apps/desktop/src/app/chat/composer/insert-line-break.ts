/** Insert an inline newline, not Chromium's paragraph wrapper. The composer
 * normaliser treats blank blocks as chip-editing debris, so insertParagraph
 * cannot safely be left native. A text node also preserves empty/chip-only lines.
 * The caller records undo and flushes the draft through the existing pipeline.
 */
export function insertComposerLineBreak(editor: HTMLElement): void {
  editor.querySelectorAll('[data-composer-caret]').forEach(node => node.remove())
  const selection = window.getSelection()
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null
  const newline = document.createTextNode('\n')

  if (range && editor.contains(range.commonAncestorContainer)) {
    range.deleteContents()
    range.insertNode(newline)
  } else {
    editor.append(newline)
  }

  const caret = document.createRange()
  caret.setStart(newline, 1)
  caret.collapse(true)
  selection?.removeAllRanges()
  selection?.addRange(caret)

  // Chromium otherwise consumes the final newline as caret scaffolding when
  // the next character is typed. This trailing BR is layout-only; the draft
  // serializer ignores its marker. Native typing may remove it automatically.
  const placeholder = document.createElement('br')
  placeholder.dataset.composerCaret = ''
  editor.append(placeholder)
}
