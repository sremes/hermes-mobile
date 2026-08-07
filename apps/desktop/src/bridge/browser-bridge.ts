// ── Browser bridge: window.hermesDesktop without Electron ───────────────────
// hermes-mobile is the Hermes Desktop renderer running in a plain browser.
// The renderer's only route to native power is the typed window.hermesDesktop
// bridge. This module implements that bridge against web standards + the
// gateway's own REST surface, so the app boots and runs with zero Electron.
//
// Design rules (mirroring the desktop engineering guide):
//   · The renderer is ALWAYS in remote mode here — the gateway is the machine.
//     File/git operations therefore ride the backend REST (/api/fs, /api/git)
//     exactly like desktop remote mode; the shim never re-implements them.
//   · Capabilities with no browser equivalent are OMITTED (not stubbed):
//     the renderer feature-detects via `?.` and hides the UI (terminal,
//     pet overlay, quick entry, updater, bootstrap, find-in-page, …).
//   · Only the two unconditionally-subscribed callbacks must exist:
//     onBootProgress and onBackendExit.
//   · Connection config lives in localStorage (v1). The token is stored
//     in plaintext — acceptable for a personal PWA; revisit if this grows.

import type {
  DesktopBootProgress,
  DesktopBootstrapState,
  DesktopConnectionConfig,
  DesktopConnectionConfigInput,
  DesktopConnectionProbeResult,
  DesktopConnectionTestResult,
  DesktopOauthLoginResult,
  DesktopOauthLogoutResult,
  DesktopVersionInfo,
  HermesApiRequest,
  HermesConnection,
  HermesNotification
} from '@/global'
import { readJson, writeJson } from '@/lib/storage'

const CONFIG_KEY = 'hermes-mobile.connection.v1'

interface StoredConnection {
  mode: 'remote'
  remoteUrl: string
  remoteToken: string
}

// ── Config persistence ───────────────────────────────────────────────────────

function readStoredConnection(): StoredConnection | null {
  const saved = readJson<StoredConnection>(CONFIG_KEY)

  if (!saved || saved.mode !== 'remote') {
    return null
  }

  return { mode: 'remote', remoteUrl: saved.remoteUrl || '', remoteToken: saved.remoteToken || '' }
}

function writeStoredConnection(url: string, token: string): StoredConnection {
  const next: StoredConnection = { mode: 'remote', remoteUrl: url, remoteToken: token }

  writeJson(CONFIG_KEY, next)

  return next
}

// ── URL helpers (mirror of the desktop connection-config behavior) ───────────

function normalizeRemoteBaseUrl(raw: string): string {
  let value = String(raw || '').trim()

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    value = `http://${value}`
  }

  let parsed: URL

  try {
    parsed = new URL(value)
  } catch (error) {
    throw new Error(`Remote gateway URL is not valid: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Remote gateway URL must be http:// or https://, got ${parsed.protocol}`)
  }

  parsed.hash = ''
  parsed.search = ''

  return parsed.toString().replace(/\/+$/, '')
}

function buildGatewayWsUrl(baseUrl: string, token: string): string {
  const parsed = new URL(baseUrl)
  const wsScheme = parsed.protocol === 'https:' ? 'wss' : 'ws'
  const prefix = parsed.pathname.replace(/\/+$/, '')

  return `${wsScheme}://${parsed.host}${prefix}/api/ws?token=${encodeURIComponent(token)}`
}

function tokenPreview(token: string): string | null {
  if (!token) {
    return null
  }

  return token.length <= 8 ? 'set' : `...${token.slice(-6)}`
}

// ── Tiny emitter (soft gateway switch after applyConnectionConfig) ──────────

type Listener = () => void

const connectionAppliedListeners = new Set<Listener>()

function emitConnectionApplied() {
  for (const listener of [...connectionAppliedListeners]) {
    try {
      listener()
    } catch {
      // A listener must never break the switch.
    }
  }
}

// ── Connection resolution ────────────────────────────────────────────────────

async function resolveConnection(profile?: string | null): Promise<HermesConnection> {
  const stored = readStoredConnection()

  if (!stored || !stored.remoteUrl.trim()) {
    throw new Error('No remote gateway configured. Open Settings → Gateway to connect.')
  }

  if (!stored.remoteToken.trim()) {
    throw new Error('No session token saved. Open Settings → Gateway and save a token.')
  }

  const baseUrl = normalizeRemoteBaseUrl(stored.remoteUrl)
  const token = stored.remoteToken.trim()

  return {
    authMode: 'token',
    baseUrl,
    isFullscreen: false,
    logs: [],
    mode: 'remote',
    nativeOverlayWidth: 0,
    profile: profile || undefined,
    remoteHost: new URL(baseUrl).host,
    remoteKind: 'url',
    source: 'settings',
    token,
    windowButtonPosition: null,
    wsUrl: buildGatewayWsUrl(baseUrl, token)
  }
}

// ── REST (mirror of the desktop main fetchJson: header + error shape) ────────

async function api<T>(request: HermesApiRequest): Promise<T> {
  const connection = await resolveConnection(request.profile)
  const url = `${connection.baseUrl}${request.path}`
  const controller = new AbortController()
  const timeoutMs = request.timeoutMs ?? 30_000
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const headers = new Headers({ 'X-Hermes-Session-Token': connection.token })
    const init: RequestInit = {
      headers,
      method: request.method || 'GET',
      signal: controller.signal
    }

    if (request.upload) {
      const form = new FormData()
      form.append(
        'file',
        new Blob([request.upload.bytes], { type: request.upload.contentType || 'application/octet-stream' }),
        request.upload.filename
      )
      init.body = form
    } else if (request.body !== undefined) {
      headers.set('Content-Type', 'application/json')
      init.body = JSON.stringify(request.body)
    }

    const response = await fetch(url, init)
    const text = await response.text()

    if (response.status >= 400) {
      const error = new Error(`${response.status}: ${text || response.statusText}`) as Error & { statusCode?: number }

      error.statusCode = response.status
      throw error
    }

    if (!text) {
      return null as T
    }

    // A 2xx whose body is HTML means the request fell through to the SPA index
    // (same diagnostic Electron surfaces).
    if (/^\s*<(?:!doctype|html)/i.test(text)) {
      throw new Error(
        `Expected JSON from ${url} but got HTML (status ${response.status}). ` +
          'The endpoint is likely missing on the Hermes backend.'
      )
    }

    return JSON.parse(text) as T
  } finally {
    clearTimeout(timer)
  }
}

// ── Gateway probes (public /api/status; auth_required ⇒ OAuth gate) ──────────

async function statusProbe(baseUrl: string): Promise<{ authRequired: boolean; version: string | null; raw: unknown }> {
  const response = await fetch(`${baseUrl}/api/status`, { signal: AbortSignal.timeout(8_000) })
  const text = await response.text()
  let body: Record<string, unknown> | null = null

  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    body = null
  }

  return {
    authRequired: Boolean(body && body.auth_required),
    raw: body,
    version: body && typeof body.version === 'string' ? body.version : null
  }
}

async function probeConnectionConfig(rawUrl: string): Promise<DesktopConnectionProbeResult> {
  let baseUrl: string

  try {
    baseUrl = normalizeRemoteBaseUrl(rawUrl)
  } catch (error) {
    return {
      authMode: 'unknown',
      baseUrl: String(rawUrl || ''),
      error: error instanceof Error ? error.message : String(error),
      providers: [],
      reachable: false,
      version: null
    }
  }

  try {
    const status = await statusProbe(baseUrl)

    return {
      authMode: status.authRequired ? 'oauth' : 'token',
      baseUrl,
      error: null,
      providers: [],
      reachable: true,
      version: status.version
    }
  } catch (error) {
    return {
      authMode: 'unknown',
      baseUrl,
      error: error instanceof Error ? error.message : String(error),
      providers: [],
      reachable: false,
      version: null
    }
  }
}

// Mirrors Electron's test: HTTP status probe + a REAL WebSocket dial, so a
// proxy that passes HTTP but blocks /api/ws can't produce a false "reachable".
async function testConnectionConfig(input: DesktopConnectionConfigInput): Promise<DesktopConnectionTestResult> {
  if (input.mode !== 'remote') {
    throw new Error('Only remote connections are supported in the browser build.')
  }

  const baseUrl = normalizeRemoteBaseUrl(input.remoteUrl || '')
  const token = input.remoteToken || readStoredConnection()?.remoteToken || ''

  let status: { authRequired: boolean; version: string | null; raw: unknown }

  try {
    status = await statusProbe(baseUrl)
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error))
  }

  if (status.authRequired) {
    throw new Error('This gateway uses OAuth, which the browser build does not support yet. Use a token gateway.')
  }

  if (!token) {
    throw new Error('A session token is required to test the connection.')
  }

  // Real WS leg: same path the chat uses.
  const wsUrl = buildGatewayWsUrl(baseUrl, token)
  const wsProbe = await new Promise<boolean>(resolve => {
    let settled = false

    const done = (ok: boolean) => {
      if (!settled) {
        settled = true
        resolve(ok)
      }
    }

    try {
      const socket = new WebSocket(wsUrl)

      socket.onopen = () => {
        socket.close()
        done(true)
      }
      socket.onerror = () => done(false)
      socket.onclose = () => done(false)
      setTimeout(() => done(false), 8_000)
    } catch {
      done(false)
    }
  })

  if (!wsProbe) {
    throw new Error(
      'Reached the gateway over HTTP, but the live WebSocket (/api/ws) connection failed. ' +
        'The HTTP check can pass while the WebSocket is blocked by a proxy, firewall, or gateway auth/origin guard.'
    )
  }

  return { baseUrl, ok: true, version: status.version }
}

// ── Connection config surface (Settings → Gateway) ───────────────────────────

function connectionConfigFrom(stored: StoredConnection | null): DesktopConnectionConfig {
  return {
    cloudOrg: '',
    envOverride: false,
    mode: 'remote',
    profile: null,
    remoteAuthMode: 'token',
    remoteOauthConnected: false,
    remoteTokenPreview: stored?.remoteToken ? tokenPreview(stored.remoteToken) : null,
    remoteTokenSet: Boolean(stored?.remoteToken),
    remoteUrl: stored?.remoteUrl || '',
    sshHost: '',
    sshKeyPath: '',
    sshPort: null,
    sshRemoteHermesPath: '',
    sshRemoteProfile: '',
    sshUser: ''
  }
}

async function saveConnectionConfig(payload: DesktopConnectionConfigInput): Promise<DesktopConnectionConfig> {
  if (payload.mode !== 'remote') {
    throw new Error('Only remote connections are supported in the browser build.')
  }

  const url = normalizeRemoteBaseUrl(payload.remoteUrl || '')
  const stored = writeStoredConnection(url, payload.remoteToken || readStoredConnection()?.remoteToken || '')

  return connectionConfigFrom(stored)
}

async function applyConnectionConfig(payload: DesktopConnectionConfigInput): Promise<DesktopConnectionConfig> {
  const config = await saveConnectionConfig(payload)

  // Mirrors Electron: main applies the config, then fires onConnectionApplied
  // and the boot hook performs the soft switch (wipe + re-dial) in place.
  emitConnectionApplied()

  return config
}

// ── Web-standard capability buckets ──────────────────────────────────────────

async function notify(payload: HermesNotification): Promise<boolean> {
  if (typeof Notification === 'undefined') {
    return false
  }

  if (Notification.permission === 'denied') {
    return false
  }

  if (Notification.permission === 'default') {
    try {
      await Notification.requestPermission()
    } catch {
      return false
    }
  }

  if (Notification.permission !== 'granted') {
    return false
  }

  try {
    new Notification(payload.title || 'Hermes', {
      body: payload.body,
      silent: payload.silent,
      tag: payload.tag
    })

    return true
  } catch {
    return false
  }
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)

    return true
  } catch {
    return false
  }
}

async function readClipboard(): Promise<string> {
  try {
    return await navigator.clipboard.readText()
  } catch {
    return ''
  }
}

async function openExternal(url: string): Promise<void> {
  window.open(url, '_blank', 'noopener,noreferrer')
}

async function requestMicrophoneAccess(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })

    for (const track of stream.getTracks()) {
      track.stop()
    }

    return true
  } catch {
    return false
  }
}

let wakeLockSentinel: { release: () => Promise<void> } | null = null

async function setKeepAwake(on: boolean): Promise<void> {
  if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) {
    return
  }

  try {
    if (on && !wakeLockSentinel) {
      wakeLockSentinel = await (navigator as Navigator & { wakeLock: { request: (t: string) => Promise<{ release: () => Promise<void> }> } }).wakeLock.request('screen')
    } else if (!on && wakeLockSentinel) {
      await wakeLockSentinel.release()
      wakeLockSentinel = null
    }
  } catch {
    // Wake Lock is best-effort; the app works without it.
  }
}

async function getOnBattery(): Promise<boolean> {
  if (!('getBattery' in navigator)) {
    return false
  }

  try {
    const battery = await (navigator as Navigator & { getBattery: () => Promise<{ charging: boolean }> }).getBattery()

    return !battery.charging
  } catch {
    return false
  }
}

function onBatteryChanged(callback: (onBattery: boolean) => void): () => void {
  if (!('getBattery' in navigator)) {
    return () => {}
  }

  let disposed = false
  let battery: (BatteryManager | null) = null

  const sync = () => {
    if (!disposed && battery) {
      try {
        callback(!battery.charging)
      } catch {
        // ignore
      }
    }
  }

  void (navigator as Navigator & { getBattery: () => Promise<BatteryManager> })
    .getBattery()
    .then(instance => {
      if (disposed) {
        return
      }

      battery = instance
      instance.addEventListener('chargingchange', sync)
      sync()
    })
    .catch(() => {})

  return () => {
    disposed = true
  }
}

interface BatteryManager {
  addEventListener: (type: string, listener: () => void) => void
  charging: boolean
}

// ── Boot/bootstrap state (skip the desktop install + CONNECTING overlays) ────

const READY_BOOT_PROGRESS: DesktopBootProgress = {
  error: null,
  fakeMode: false,
  message: 'Browser mode ready',
  phase: 'browser.ready',
  progress: 100,
  running: false,
  timestamp: Date.now()
}

const INACTIVE_BOOTSTRAP: DesktopBootstrapState = {
  active: false,
  completedAt: null,
  error: null,
  log: [],
  manifest: null,
  setupChoice: null,
  stages: {},
  startedAt: null,
  unsupportedPlatform: null
}

const VERSION_INFO: DesktopVersionInfo = {
  appVersion: '0.1.0-web',
  electronVersion: '—',
  hermesRoot: '',
  nodeVersion: '—',
  platform: 'web'
}

// ── Install ──────────────────────────────────────────────────────────────────

// The shim lives at MODULE scope on purpose. We hit a TS checker quirk with
// guards on window.hermesDesktop: with the type queries inside the same
// function, `if (window.hermesDesktop)` made the checker resolve
// `typeof window.hermesDesktop` as `never` (empirically reproduced here;
// minimal repros compile clean, so the mechanism is layout-dependent and not
// fully characterized), and `'hermesDesktop' in window` narrows `window` to
// `never` in the false branch because hermesDesktop is a REQUIRED Window
// property (intended TS control-flow behavior). At module scope neither
// effect applies.
const shim = {
  api: api as <T>(request: HermesApiRequest) => Promise<T>,
  applyConnectionConfig,
  claimAmbientCue: async () => true,
  getBootProgress: async () => READY_BOOT_PROGRESS,
  getBootstrapState: async () => INACTIVE_BOOTSTRAP,
  // Browser build has no installer/bootstrap latch — resolve so the boot
  // failure overlay's Retry/Repair buttons proceed to reload instead of
  // throwing on a missing member.
  repairBootstrap: async () => ({ ok: true }),
  resetBootstrap: async () => ({ ok: true }),
  getConnection: resolveConnection,
  getConnectionConfig: async () => connectionConfigFrom(readStoredConnection()),
  getGatewayWsUrl: async (profile?: string | null) => {
    const connection = await resolveConnection(profile)

    return { ok: true, wsUrl: connection.wsUrl }
  },
  getOnBattery,
  getRecentLogs: async () => ({ lines: [], path: '' }),
  getRemoteDisplayReason: async () => null,
  getVersion: async () => VERSION_INFO,
  notify,
  oauthLoginConnectionConfig: async (rawUrl: string): Promise<DesktopOauthLoginResult> => ({
    baseUrl: rawUrl,
    connected: false,
    ok: false
  }),
  oauthLogoutConnectionConfig: async (): Promise<DesktopOauthLogoutResult> => ({ connected: false, ok: true }),
  onBackendExit: () => () => {},
  onBatteryChanged,
  onBootProgress: () => () => {},
  onConnectionApplied: callback => {
    connectionAppliedListeners.add(callback)

    return () => void connectionAppliedListeners.delete(callback)
  },
  onWindowStateChanged: () => () => {},
  openExternal,
  openSessionWindow: async () => ({ error: 'Session windows are not available in the browser build.', ok: false }),
  openWindow: async () => ({ error: 'Multiple windows are not available in the browser build.', ok: false }),
  probeConnectionConfig,
  profile: {
    get: async () => ({ profile: null }),
    set: async () => ({ profile: null })
  },
  readClipboard,
  readFileDataUrl: async filePath => {
    const result = await api<string | { dataUrl?: string }>({
      path: `/api/fs/read-data-url?path=${encodeURIComponent(filePath)}`
    })

    return typeof result === 'string' ? result : result?.dataUrl || ''
  },
  readFileText: async filePath =>
    api<{ binary?: boolean; byteSize?: number; language?: string; mimeType?: string; path: string; text: string; truncated?: boolean }>({
      path: `/api/fs/read-text?path=${encodeURIComponent(filePath)}`
    }),
  revalidateConnection: async () => {
    try {
      const connection = await resolveConnection()

      await statusProbe(connection.baseUrl)

      return { ok: true, rebuilt: false }
    } catch {
      return { ok: false, rebuilt: false }
    }
  },
  requestMicrophoneAccess,
  revealLogs: async () => ({ error: 'Not available in the browser build.', ok: false, path: '' }),
  saveConnectionConfig,
  selectPaths: async () => [],
  setKeepAwake,
  settings: {
    getDefaultProjectDir: async () => ({ defaultLabel: 'Browser', dir: null, resolvedCwd: '' }),
    pickDefaultProjectDir: async () => ({ canceled: true, dir: null }),
    setDefaultProjectDir: async () => ({ dir: null })
  },
  testConnectionConfig,
  touchBackend: async () => ({ ok: true }),
  writeClipboard,
  // Deliberately OMITTED (renderer feature-detects and hides the UI):
  // terminal, git, readDir, wakeIndicator, petOverlay, quickEntry, updates,
  // uninstall, bootstrap actions, themes, findInPage, zoom, dataUrlReadMax,
  // openPreviewInBrowser, selectSavePath, saveImage*, watchPreviewFile,
  // onPowerResume, onFocusSession, onNotificationAction, onDeepLink,
  // signalDeepLinkReady, onPreviewFileChanged, ssh*, cloud*, fetchLinkTitle,
  // sanitizeWorkspaceCwd, desktopPluginsRoot, renamePath, writeTextFile,
  // trashPath, revealPath, openDir, gitRoot, setActiveWork, setTitleBarTheme,
  // setNativeTheme, setTranslucency, setPreviewShortcutActive
} satisfies Partial<typeof window.hermesDesktop>

// Compile-time guard: if a boot-critical member is dropped from the shim,
// this file stops compiling. (The cast below still hides OTHER omitted
// members from tsc, so every optional member must stay feature-detected by
// callers — see the OMITTED list above and the note in global.d.ts.)
const REQUIRED_BRIDGE_MEMBERS = [
  'api',
  'applyConnectionConfig',
  'getBootProgress',
  'getBootstrapState',
  'getConnection',
  'getConnectionConfig',
  'getGatewayWsUrl',
  'getVersion',
  'onBackendExit',
  'onBootProgress',
  'onConnectionApplied',
  'probeConnectionConfig',
  'saveConnectionConfig',
  'testConnectionConfig'
] as const
type MissingRequiredBridgeMember = Exclude<(typeof REQUIRED_BRIDGE_MEMBERS)[number], keyof typeof shim>
const bridgeMembersComplete: MissingRequiredBridgeMember extends never ? true : never = true

void bridgeMembersComplete

// Deliberate widening: the shim is a Partial of the full bridge type; the
// renderer feature-detects the omitted members at runtime.
const installedBridge = shim as unknown as typeof window.hermesDesktop

// Module-level flag instead of a window feature-detect (see the note above:
// property guards misbehave next to the type queries, and the browser build
// can never have a real Electron preload, so the flag is equivalent).
let bridgeInstalled = false

export function installBrowserBridge(): void {
  if (bridgeInstalled) {
    return
  }

  bridgeInstalled = true
  window.hermesDesktop = installedBridge
}
