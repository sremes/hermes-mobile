/**
 * Share intake dialog — where a Web Share Target payload lands.
 *
 * The user picks WHERE the shared media/text goes: an existing session (the
 * composer draft is prefilled there) or a new session, optionally with a
 * message. Files are uploaded to the gateway host at Send time (same ladder as
 * the "+" attach menu: HEIC-safe transcode for images, then the host path is
 * attached as an @file/@image ref); the chosen session's draft is stashed and
 * the user hits Send in the normal composer — nothing about sending is
 * reimplemented here.
 *
 * Two identity/layout rules that bit on the phone:
 *  - Drafts must be stashed under the COMPOSER's key domain —
 *    `resolveComposerSessionKey` (the durable lineage root), not the raw
 *    stored session id; a compressed session's composer never looks up the tip
 *    id, so the share would silently vanish.
 *  - Image attachments must carry `previewUrl` (data:) like the "+" menu's
 *    `attachImagePath` does, or the send path has no inline image to carry.
 */

import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { formatRefValue } from '@/components/assistant-ui/directive-text'
import { useI18n } from '@/i18n'
import { attachmentId } from '@/lib/chat-runtime'
import type { SharedInboxItem } from '@/lib/share-inbox'
import { clearShareInbox } from '@/lib/share-inbox'
import { relativeTime } from '@/lib/time'
import { notify } from '@/store/notifications'
import { resolveComposerSessionKey, setSelectedStoredSessionId, $sessions } from '@/store/session'
import { stashSessionDraft, type ComposerAttachment } from '@/store/composer'

import { attachmentPreviewDataUrl, imageAsUploadable } from './hooks/use-composer-actions'

/** The payload waiting to be routed. Null = no pending share. */
export const $pendingShare = atom<SharedInboxItem[] | null>(null)
export const setPendingShare = (items: SharedInboxItem[] | null) => $pendingShare.set(items)

export function ShareIntakeDialog() {
  const { t } = useI18n()
  const items = useStore($pendingShare)
  const sessions = useStore($sessions)
  const [search, setSearch] = useState('')
  const [targetSessionId, setTargetSessionId] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const prefilledRef = useRef(false)
  const [sending, setSending] = useState(false)

  // Prefill with the share's own text/url so a "share a link" stays intact;
  // the user can edit or extend it. Done at render time (guarded) because the
  // component mounts while $pendingShare is still null (it renders null), so
  // a useState initializer would capture an empty payload.
  if (!prefilledRef.current && items) {
    prefilledRef.current = true
    const parts = items.filter(item => item.value).map(item => item.value)

    if (parts.length > 0) {
      setMessage(parts.join('\n'))
    }
  }

  const candidates = useMemo(() => {
    const query = search.trim().toLowerCase()
    const sorted = [...sessions].sort((a, b) => b.last_active - a.last_active).slice(0, 30)

    return query
      ? sorted.filter(session => (session.title || '').toLowerCase().includes(query))
      : sorted
  }, [search, sessions])

  const fileItems = (items ?? []).filter(item => item.blob)

  if (!items) {
    return null
  }

  const uploadOne = async (item: SharedInboxItem): Promise<ComposerAttachment | null> => {
    const blob = item.blob!

    if (item.type?.startsWith('image/')) {
      try {
        const { bytes, ext } = await imageAsUploadable(
          new File([blob], item.name || 'shared', { type: item.type || 'application/octet-stream' })
        )
        const hostPath = await window.hermesDesktop?.saveImageBuffer?.(new Uint8Array(bytes), ext)

        if (!hostPath) {
          throw new Error(item.name || 'image')
        }

        const base: ComposerAttachment = {
          id: attachmentId('image', hostPath),
          kind: 'image',
          label: item.name || 'shared',
          detail: hostPath,
          path: hostPath
        }

        // Same as the "+" menu: the preview data URL is what renders the
        // thumbnail chip AND is carried inline by the send path
        // (optimisticAttachmentRef) — without it the image never makes it
        // into the message.
        const previewUrl = await attachmentPreviewDataUrl(hostPath)

        return previewUrl ? { ...base, previewUrl } : base
      } catch (error) {
        notify({
          kind: 'error',
          title: t.share.title,
          message: `${t.share.failed} ${error instanceof Error ? error.message : ''}`.trim()
        })

        return null
      }
    }

    try {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const hostPath = await window.hermesDesktop?.uploadFile?.(bytes, item.name || 'shared', item.type || 'application/octet-stream')

      if (!hostPath) {
        throw new Error(item.name || 'file')
      }

      return {
        id: attachmentId('file', hostPath),
        kind: 'file',
        label: item.name || 'shared',
        detail: hostPath,
        path: hostPath,
        refText: `@file:${formatRefValue(hostPath)}`
      }
    } catch (error) {
      notify({
        kind: 'error',
        title: t.share.title,
        message: `${t.share.failed} ${error instanceof Error ? error.message : ''}`.trim()
      })

      return null
    }
  }

  const handleSend = async () => {
    if (sending) {
      return
    }

    setSending(true)

    try {
      const attachments: ComposerAttachment[] = []

      for (const item of fileItems) {
        const attachment = await uploadOne(item)

        if (attachment) {
          attachments.push(attachment)
        }
      }

      const text = message.trim()

      if (targetSessionId) {
        const targetTitle = candidates.find(session => session.id === targetSessionId)?.title || targetSessionId
        // Stash in the COMPOSER's key domain (lineage root) — the raw stored
        // id is the wrong key for any compressed session.
        const scope = resolveComposerSessionKey(targetSessionId, sessions)

        stashSessionDraft(scope, text, attachments)
        setSelectedStoredSessionId(targetSessionId)
        notify({ kind: 'success', message: targetTitle, title: t.share.sentTo })
      } else {
        stashSessionDraft(null, text, attachments)
        setSelectedStoredSessionId(null)
        notify({ kind: 'success', message: '', title: t.share.sentNew })
      }

      clearShareInbox()
      setPendingShare(null)
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog onOpenChange={open => !open && setPendingShare(null)} open>
      {/* No autofocus: Radix would focus the search input and pop the keyboard
          the moment a share lands — the picker list is the primary control. */}
      <DialogContent
        bodyClassName="flex flex-col gap-0 overflow-y-auto p-0"
        className="max-h-[85dvh] max-w-2xl"
        onOpenAutoFocus={event => event.preventDefault()}
      >
        <DialogHeader className="px-4 pb-3 pt-4">
          <DialogTitle>{t.share.title}</DialogTitle>
          <DialogDescription>
            {fileItems.length > 0
              ? fileItems.map(item => item.name).join(', ')
              : t.share.textShare}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
          <input
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-(--ui-accent)"
            onChange={event => setSearch(event.target.value)}
            placeholder={t.share.searchPlaceholder}
            value={search}
          />

          <div className="max-h-48 min-h-0 overflow-y-auto overscroll-contain rounded-md border border-border">
            <button
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-(--ui-row-hover-background) ${targetSessionId === null ? 'bg-(--ui-row-active-background)' : ''}`}
              onClick={() => setTargetSessionId(null)}
              type="button"
            >
              <span className="font-medium">{t.share.newSession}</span>
              <span className="ml-auto text-xs text-(--ui-text-tertiary)">+</span>
            </button>
            {candidates.map(session => (
              <button
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-(--ui-row-hover-background) ${targetSessionId === session.id ? 'bg-(--ui-row-active-background)' : ''}`}
                key={session.id}
                onClick={() => setTargetSessionId(session.id)}
                type="button"
              >
                <span className="min-w-0 flex-1 truncate">{session.title || t.share.untitled}</span>
                <span className="shrink-0 text-xs text-(--ui-text-tertiary)">
                  {relativeTime(session.last_active || session.started_at)}
                </span>
              </button>
            ))}
            {candidates.length === 0 && (
              <div className="px-3 py-2 text-xs text-(--ui-text-tertiary)">{t.share.noSessions}</div>
            )}
          </div>

          <textarea
            className="max-h-32 min-h-16 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-(--ui-accent)"
            onChange={event => setMessage(event.target.value)}
            placeholder={t.share.messagePlaceholder}
            value={message}
          />
        </div>

        <DialogFooter className="flex-row items-center justify-end gap-2 border-t px-4 py-3">
          <Button disabled={sending} onClick={() => setPendingShare(null)} variant="outline">
            {t.common.cancel}
          </Button>
          <Button disabled={sending} onClick={() => void handleSend()}>
            {t.share.send}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
