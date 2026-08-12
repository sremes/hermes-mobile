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
import { notify } from '@/store/notifications'
import { setSelectedStoredSessionId, $sessions } from '@/store/session'
import { stashSessionDraft, type ComposerAttachment } from '@/store/composer'

import { imageAsUploadable } from './hooks/use-composer-actions'

/** The payload waiting to be routed. Null = no pending share. */
export const $pendingShare = atom<SharedInboxItem[] | null>(null)
export const setPendingShare = (items: SharedInboxItem[] | null) => $pendingShare.set(items)

function relativeTime(ts: number): string {
  const minutes = Math.max(1, Math.round((Date.now() - ts) / 60_000))

  if (minutes < 60) {
    return `${minutes}m`
  }

  const hours = Math.round(minutes / 60)

  if (hours < 24) {
    return `${hours}h`
  }

  return `${Math.round(hours / 24)}d`
}

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

        return {
          id: attachmentId('image', hostPath),
          kind: 'image',
          label: item.name || 'shared',
          detail: hostPath,
          path: hostPath
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

        stashSessionDraft(targetSessionId, text, attachments)
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
      <DialogContent className="max-h-[85vh] max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t.share.title}</DialogTitle>
          <DialogDescription>
            {fileItems.length > 0
              ? fileItems.map(item => item.name).join(', ')
              : t.share.textShare}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-col gap-3 px-4 py-3">
          <input
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-(--ui-accent)"
            onChange={event => setSearch(event.target.value)}
            placeholder={t.share.searchPlaceholder}
            value={search}
          />

          <div className="max-h-56 min-h-0 overflow-y-auto overscroll-contain rounded-md border border-border">
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
                  {relativeTime(session.last_active)}
                </span>
              </button>
            ))}
            {candidates.length === 0 && (
              <div className="px-3 py-2 text-xs text-(--ui-text-tertiary)">{t.share.noSessions}</div>
            )}
          </div>

          <textarea
            className="min-h-16 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-(--ui-accent)"
            onChange={event => setMessage(event.target.value)}
            placeholder={t.share.messagePlaceholder}
            value={message}
          />
        </div>

        <DialogFooter className="flex-row items-center justify-end gap-2 p-3">
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
