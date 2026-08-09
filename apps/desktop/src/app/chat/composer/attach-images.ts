/**
 * Browser/mobile image attach for the composer.
 *
 * The Electron build picks images through native dialogs (selectPaths); the
 * PWA cannot, so this micro-action opens a file input instead — on Android
 * that surfaces the photo picker (and the camera option). Selected files are
 * persisted on the GATEWAY host via /api/chat/image-upload (saveImageBuffer)
 * and attached as host paths: the agent reads images from ITS filesystem,
 * which is exactly where the upload lands.
 *
 * Registered unconditionally — in this fork there is no other attach
 * affordance (paste/drag are desktop-only input paths).
 */
import { registry } from '@/contrib/registry'
import { attachmentId, pathLabel } from '@/lib/chat-runtime'
import type { ComposerAttachment } from '@/store/composer'
import { mainComposerScope } from '@/store/composer'

import { attachmentPreviewDataUrl } from '../hooks/use-composer-actions'
import { COMPOSER_AREAS, type ComposerMicroActionProvider } from './contrib'
import { requestComposerFocus } from './focus'

async function attachImageFile(file: File): Promise<void> {
  try {
    const ext = (file.name.split('.').pop() || file.type.split('/')[1] || 'png').toLowerCase()
    const data = new Uint8Array(await file.arrayBuffer())
    const savedPath = await window.hermesDesktop?.saveImageBuffer?.(data, ext)

    if (!savedPath) {
      return
    }

    const base: ComposerAttachment = {
      detail: savedPath,
      id: attachmentId('image', savedPath),
      kind: 'image',
      label: pathLabel(savedPath),
      path: savedPath
    }

    mainComposerScope.add(base)
    requestComposerFocus()

    const previewUrl = await attachmentPreviewDataUrl(savedPath)

    if (previewUrl) {
      mainComposerScope.add({ ...base, previewUrl })
    }
  } catch {
    // Swallow per-file failures so one bad image doesn't drop the rest.
  }
}

async function attachImagesFromInput(): Promise<void> {
  const input = document.createElement('input')

  input.accept = 'image/*'
  input.multiple = true
  input.type = 'file'
  input.onchange = () => {
    const files = Array.from(input.files ?? [])

    input.remove()

    for (const file of files) {
      void attachImageFile(file)
    }
  }

  // Must stay inside the user-gesture call stack for the picker to open.
  input.click()
}

registry.register({
  area: COMPOSER_AREAS.microActions,
  data: {
    resolve: () => [
      {
        icon: 'image',
        id: 'attach-images',
        label: 'Attach images',
        run: attachImagesFromInput
      }
    ]
  } satisfies ComposerMicroActionProvider,
  id: 'composer.attach-images'
})
