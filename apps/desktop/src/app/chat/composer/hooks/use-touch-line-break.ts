import { type RefObject, useLayoutEffect } from 'react'

import { insertComposerLineBreak } from '../insert-line-break'

/** Use native beforeinput: React's synthetic onBeforeInput is a polyfill and
 * does not reliably expose inputType. This also covers software keyboards
 * that never emit an identifiable Enter keydown.
 */
export function useTouchLineBreak({
  enabled,
  editorRef,
  composingRef,
  recordUndoPoint,
  flushEditorToDraft
}: {
  enabled: boolean
  editorRef: RefObject<HTMLDivElement | null>
  composingRef: RefObject<boolean>
  recordUndoPoint: () => void
  flushEditorToDraft: (editor: HTMLDivElement) => void
}): void {
  useLayoutEffect(() => {
    const editor = editorRef.current

    if (!enabled || !editor) {
      return
    }

    const beforeInput = (event: InputEvent) => {
      if (
        event.defaultPrevented ||
        !event.cancelable ||
        event.isComposing ||
        composingRef.current ||
        (event.inputType !== 'insertParagraph' && event.inputType !== 'insertLineBreak')
      ) {
        return
      }

      event.preventDefault()
      recordUndoPoint()
      insertComposerLineBreak(editor)
      flushEditorToDraft(editor)
    }

    editor.addEventListener('beforeinput', beforeInput)

    return () => editor.removeEventListener('beforeinput', beforeInput)
  }, [enabled, editorRef, composingRef, recordUndoPoint, flushEditorToDraft])
}
