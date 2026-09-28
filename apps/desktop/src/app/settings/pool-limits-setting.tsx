import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { ListRow } from '@/app/settings/primitives'
import { SETTING_IDS, settingElementId } from '@/app/settings/settings-manifest'
import { hasDesktopFeature } from '@/bridge/capabilities'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { $poolLimits, loadPoolLimits, savePoolLimits } from '@/store/pool-limits'

// Fork note: upstream imports these bounds from '../../../electron/pool-limits'
// so the advertised ranges can never drift from what main clamps to. The
// Electron shell is stripped from this fork (and this whole setting is gated
// off in the browser build below), so the two numbers are inlined — keep them
// in sync with electron/pool-limits.ts POOL_LIMITS_BOUNDS by hand.
const MAX_BACKENDS_MAX = 64
const IDLE_MS_MAX = 7 * 24 * 60 * 60_000

/** Settings → Advanced: warm-bot-backends count + backend idle timeout.
 *  Device-local (not profile-scoped): the pool is sized once per machine and
 *  changes apply live — main evicts/reaps to converge without a restart. */
export function PoolLimitsSetting() {
  // Pool sizing is device-local Electron main-process state (it owns the pool
  // and the persisted copy). The browser build has no pool — render nothing
  // instead of rows whose save would silently no-op. Fork gate; upstream
  // renders unconditionally.
  if (!hasDesktopFeature('getPoolLimits')) {
    return null
  }

  return <PoolLimitsSettingRows />
}

function PoolLimitsSettingRows() {
  const { t } = useI18n()
  const limits = useStore($poolLimits)
  const [maxDraft, setMaxDraft] = useState(String(limits.maxBackends))
  const [idleDraft, setIdleDraft] = useState(String(limits.idleMs))

  useEffect(() => {
    void loadPoolLimits()
  }, [])

  useEffect(() => {
    setMaxDraft(String(limits.maxBackends))
    setIdleDraft(String(limits.idleMs))
  }, [limits])

  const commitMax = () => {
    const parsed = Number(maxDraft)

    if (!Number.isFinite(parsed) || parsed === limits.maxBackends) {
      setMaxDraft(String(limits.maxBackends))

      return
    }

    void savePoolLimits({ maxBackends: parsed })
      .then(() => undefined)
      .catch(() => setMaxDraft(String($poolLimits.get().maxBackends)))
  }

  const commitIdle = () => {
    const parsed = Number(idleDraft)

    if (!Number.isFinite(parsed) || parsed === limits.idleMs) {
      setIdleDraft(String(limits.idleMs))

      return
    }

    void savePoolLimits({ idleMs: parsed })
      .then(() => undefined)
      .catch(() => setIdleDraft(String($poolLimits.get().idleMs)))
  }

  return (
    <>
      <ListRow
        action={
          <div className="flex items-center gap-2">
            <Input
              aria-label={t.settings.poolLimits.warmBotBackendsAria}
              className="w-20"
              inputMode="numeric"
              max={MAX_BACKENDS_MAX}
              min={1}
              onBlur={commitMax}
              onChange={event => setMaxDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.currentTarget.blur()
                }
              }}
              type="number"
              value={maxDraft}
            />
          </div>
        }
        description="How many bot backends stay running for instant switching. Higher = faster switches, more memory (~60MB per backend). Applies immediately."
        id={settingElementId(SETTING_IDS.advanced.warmBotBackends)}
        title={t.settings.poolLimits.warmBotBackendsTitle}
      />
      <ListRow
        action={
          <div className="flex items-center gap-2">
            <Input
              aria-label={t.settings.poolLimits.backendIdleTimeoutAria}
              className="w-28"
              inputMode="numeric"
              max={IDLE_MS_MAX}
              min={60_000}
              onBlur={commitIdle}
              onChange={event => setIdleDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.currentTarget.blur()
                }
              }}
              type="number"
              value={idleDraft}
            />
            <span className="text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">ms</span>
          </div>
        }
        description="How long an unused bot backend stays warm before it is shut down. Raise this so bots you revisit every few minutes never pay a cold start."
        id={settingElementId(SETTING_IDS.advanced.backendIdleTimeout)}
        title={t.settings.poolLimits.backendIdleTimeoutTitle}
      />
    </>
  )
}
