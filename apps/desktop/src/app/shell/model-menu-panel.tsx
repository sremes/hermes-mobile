import type { ModelOptionsResult } from '@hermes/shared'
import { useStore } from '@nanostores/react'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { Codicon } from '@/components/ui/codicon'
import { DropdownMenuItem, dropdownMenuRow } from '@/components/ui/dropdown-menu'
import { useI18n } from '@/i18n'
import { modelOptionsQueryKey, requestModelOptions } from '@/lib/model-options'
import { cn } from '@/lib/utils'
import { $currentModelSource } from '@/store/session'

import { ModelCatalogMenu } from './model-catalog-menu'
import { type ModelMenuHostProps, useModelMenuController } from './use-model-menu-controller'

export { ModelMenuCloseContext } from './model-catalog-menu'
export type { ModelSelection } from './use-model-menu-controller'

interface ModelMenuPanelProps extends ModelMenuHostProps {
  /** Drop the sticky composer pick so new chats follow Settings → Model. */
  onFollowDefaultModel?: () => void
}

/**
 * The composer's model menu: `ModelCatalogMenu` (the shared renderer) plus the
 * controller that gives a selection its meaning HERE (`useModelMenuController`).
 */
export function ModelMenuPanel({ onFollowDefaultModel, ...props }: ModelMenuPanelProps) {
  const { gateway, ownerConnectionId, profile = 'default', requestGateway } = props
  const { t } = useI18n()
  const copy = t.shell.modelMenu
  const [refreshing, setRefreshing] = useState(false)
  const queryClient = useQueryClient()
  const view = useSessionView()
  const modelSource = useStore($currentModelSource)
  const { activeSessionId, controller } = useModelMenuController(props)
  // Same condition as the pill's pin dot: a draft whose next session.create
  // ships the manual pick instead of the Settings default (#107410).
  const pinnedDraft = view.kind === 'primary' && !activeSessionId && modelSource === 'manual'

  // The backend caches provider model lists (~1h); a plain refetch returns
  // that cache, so models added elsewhere don't show up. Bust it in the
  // background on EVERY open (this panel remounts per dropdown open): the
  // catalog stays interactive on the cached data and repaints when the live
  // list lands — the same call the manual "Refresh Models" button makes, just
  // silent and automatic. `active` guards against setQueryData after close.
  // The key MUST carry ownerConnectionId (same 3-arg shape as the subscribed
  // query above): with an owner set, a 2-arg key writes a cache entry the
  // menu never reads and the repaint silently misses.
  useEffect(() => {
    let active = true

    void requestModelOptions({ gateway, refresh: true, sessionId: activeSessionId })
      .then(next => {
        if (active) {
          queryClient.setQueryData<ModelOptionsResult>(
            modelOptionsQueryKey(profile, activeSessionId, ownerConnectionId),
            next
          )
        }
      })
      .catch(() => {
        if (active) {
          void queryClient.invalidateQueries({ queryKey: ['model-options'] })
        }
      })

    return () => {
      active = false
    }
  }, [activeSessionId, gateway, ownerConnectionId, profile, queryClient])

  // Explicit "Refresh Models": re-fetch the catalog with refresh:true so the
  // backend busts its 1h provider-model disk cache and re-pulls each provider's
  // live list. Fixes live-only models (e.g. OpenCode Zen free tier) vanishing
  // when the cache expires and falls back to the curated static list.
  const refreshModels = async () => {
    if (refreshing) {
      return
    }

    setRefreshing(true)

    try {
      const queryKey = modelOptionsQueryKey(profile, activeSessionId, ownerConnectionId)

      const next = await requestModelOptions({
        gateway,
        profile,
        refresh: true,
        request: requestGateway,
        sessionId: activeSessionId
      })

      // The refreshed catalog is a hint list, never a reason to move the pick:
      // a custom slug the row lacks is still what the user selected.
      queryClient.setQueryData<ModelOptionsResult>(queryKey, next)
    } catch {
      // Network/backend hiccup — fall back to a plain invalidate so the next
      // open re-fetches (still cached, but no worse than before).
      void queryClient.invalidateQueries({ queryKey: ['model-options'] })
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <ModelCatalogMenu
      controller={controller}
      footer={
        <>
          {pinnedDraft && onFollowDefaultModel && (
            <DropdownMenuItem
              className={cn(dropdownMenuRow, 'text-(--ui-text-tertiary)')}
              onSelect={onFollowDefaultModel}
            >
              <Codicon name="discard" size="0.75rem" />
              {copy.followDefault}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            className={cn(dropdownMenuRow, 'text-(--ui-text-tertiary)')}
            disabled={refreshing}
            onSelect={event => {
              event.preventDefault()
              void refreshModels()
            }}
          >
            <Codicon className={cn(refreshing && 'animate-spin')} name="sync" size="0.75rem" />
            {copy.refreshModels}
          </DropdownMenuItem>
        </>
      }
      gateway={gateway}
      includeMoa
      ownerConnectionId={ownerConnectionId}
      profile={profile}
      request={requestGateway}
      sessionId={activeSessionId}
    />
  )
}
