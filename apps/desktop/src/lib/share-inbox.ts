/**
 * Web Share Target intake — the app side of a share delivered by the OS.
 *
 * The service worker captures the POST navigation to /share, stashes the
 * payload (files + text fields) in the share cache, and redirects to
 * /?shared=1. This module reads that stash out of the SW cache and clears it
 * once the app has taken ownership.
 */

export interface SharedInboxItem {
  /** Cache key of a file payload (`/share/items/N`) — present for files. */
  key?: string
  name?: string
  type?: string
  size?: number
  /** Text field name (`title` / `text` / `url`) — present for text shares. */
  field?: string
  value?: string
  /** The file bytes, fetched from the SW cache. */
  blob?: Blob
}

export interface ShareInbox {
  items: SharedInboxItem[]
  ts: number
}

/** True when the app was launched/redirected with a pending share. */
export function hasPendingShare(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('shared')
}

/** Read the stashed share payload out of the service worker cache. */
export async function consumeShareInbox(): Promise<SharedInboxItem[] | null> {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    const response = await fetch('/share/meta', { cache: 'no-store' })
    const meta = (await response.json().catch(() => null)) as ShareInbox | null

    if (!meta?.items?.length) {
      return null
    }

    return Promise.all(
      meta.items.map(async item => {
        if (item.key) {
          const blob = await (await fetch(item.key, { cache: 'no-store' })).blob()

          return { ...item, blob }
        }

        return item
      })
    )
  } catch {
    return null
  }
}

/** Tell the service worker to drop the consumed payload. */
export function clearShareInbox(): void {
  navigator.serviceWorker?.controller?.postMessage({ type: 'clear-share' })
}
