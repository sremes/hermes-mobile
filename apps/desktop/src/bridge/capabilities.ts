/**
 * Browser-build capability gates.
 *
 * The desktop bridge surface (`window.hermesDesktop`) is typed as if every
 * Electron capability existed; the browser shim implements a subset and omits
 * the rest. These helpers are the single source of truth for hiding
 * desktop-only surfaces (terminal rail, floating pet, updates overlay,
 * find-in-page, local/cloud/SSH connection modes, …) in the PWA build.
 *
 * A capability is present iff the shim actually implements the member —
 * feature-detect the member itself, never infer from the platform.
 */
export function hasDesktopFeature<const K extends keyof Window['hermesDesktop']>(key: K): boolean {
  return typeof window.hermesDesktop?.[key] !== 'undefined'
}

/** Browser build never has an Electron terminal (xterm + PTY bridge). */
export const hasTerminal = hasDesktopFeature('terminal')
/** Updates overlay / auto-update flow is Electron-only. */
export const hasUpdates = hasDesktopFeature('updates')
/** Find-in-page drives Electron webContents — no browser equivalent. */
export const hasFindInPage = hasDesktopFeature('findInPage')
/** The floating pet overlay can only exist as an OS-level window. */
export const hasPetOverlay = hasDesktopFeature('petOverlay')
/** Local/cloud/SSH connection modes need Electron-side backends. */
export const hasLocalBackend = hasDesktopFeature('continueBootstrapLocal')
export const hasCloud = hasDesktopFeature('cloud')
export const hasSsh = hasDesktopFeature('sshResolveHost')
