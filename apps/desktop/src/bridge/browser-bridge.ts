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
  DesktopAuthProvider,
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
  HermesNotification,
  HermesReadDirResult
} from '@/global'
import { readJson, writeJson } from '@/lib/storage'

const CONFIG_KEY = 'hermes-mobile.connection.v1'

interface StoredConnection {
  mode: 'remote'
  remoteAuthMode?: 'oauth' | 'token'
  remoteOauthConnected?: boolean
  remoteUrl: string
  remoteToken: string
}

// ── Config persistence ───────────────────────────────────────────────────────

function readStoredConnection(): StoredConnection | null {
  const saved = readJson<StoredConnection>(CONFIG_KEY)

  if (!saved || saved.mode !== 'remote') {
    return null
  }

  return {
    mode: 'remote',
    remoteAuthMode: saved.remoteAuthMode === 'oauth' ? 'oauth' : 'token',
    remoteOauthConnected: Boolean(saved.remoteOauthConnected),
    remoteToken: saved.remoteToken || '',
    remoteUrl: saved.remoteUrl || ''
  }
}

function writeStoredConnection(
  url: string,
  token: string,
  authMode: 'oauth' | 'token' = 'token',
  oauthConnected = false
): StoredConnection {
  const next: StoredConnection = {
    mode: 'remote',
    remoteAuthMode: authMode,
    remoteOauthConnected: oauthConnected,
    remoteUrl: url,
    remoteToken: token
  }

  writeJson(CONFIG_KEY, next)

  return next
}

/** Persist the real session state so the settings badge reflects reality. */
function updateStoredOauthConnected(connected: boolean): void {
  const stored = readStoredConnection()

  if (!stored) {
    return
  }

  writeStoredConnection(
    stored.remoteUrl,
    stored.remoteToken,
    stored.remoteAuthMode === 'oauth' ? 'oauth' : 'token',
    connected
  )
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

// ── Cookie-session auth (gateways with auth_required: true) ─────────────────
// Gated gateways (username/password OR OAuth provider — the /login page adapts)
// authenticate REST with an HttpOnly session cookie and WS upgrades with a
// single-use ticket minted at POST /api/auth/ws-ticket. The desktop app drives
// this through a login window; in the browser build the gateway's /login page
// opens in a new tab and the cookie lands in the same browser profile.
//
// CRITICAL deployment constraint: cookie auth requires SAME-ORIGIN hosting.
// From a cross-origin dev server (http://localhost:5174) the browser will not
// send the gateway's cookies (SameSite/CORS), so a gated gateway must serve
// this app from its own origin (e.g. reverse-proxied under the gateway domain).

function buildGatewayWsUrlWithTicket(baseUrl: string, ticket: string): string {
  const parsed = new URL(baseUrl)
  const wsScheme = parsed.protocol === 'https:' ? 'wss' : 'ws'
  const prefix = parsed.pathname.replace(/\/+$/, '')

  return `${wsScheme}://${parsed.host}${prefix}/api/ws?ticket=${encodeURIComponent(ticket)}`
}

/** Cookie-authed public GET (mirror of main's fetchPublicJson). */
async function fetchPublicJson<T>(baseUrl: string, path: string, timeoutMs = 8_000): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, { credentials: 'include', signal: AbortSignal.timeout(timeoutMs) })
  const text = await response.text()

  if (!response.ok) {
    const error = new Error(`${response.status}: ${text || response.statusText}`) as Error & { statusCode?: number }

    error.statusCode = response.status
    throw error
  }

  return JSON.parse(text) as T
}

/** True only when the gateway explicitly rejected the current session. */
function isGatewayAuthRejection(error: unknown): boolean {
  const statusCode = Number(error && typeof error === 'object' ? (error as { statusCode?: unknown }).statusCode : NaN)

  return statusCode === 401 || statusCode === 403
}

/** POST /api/auth/ws-ticket — single-use WS ticket from the session cookie. */
async function mintGatewayWsTicket(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/ws-ticket`, {
    credentials: 'include',
    method: 'POST',
    signal: AbortSignal.timeout(8_000)
  })
  const text = await response.text()

  // 401/403 → session missing/expired; callers treat that as "sign in again".
  if (!response.ok) {
    const error = new Error(`${response.status}: ${text || response.statusText}`) as Error & { statusCode?: number }

    error.statusCode = response.status
    throw error
  }

  const body = JSON.parse(text) as { ticket?: unknown }

  if (typeof body?.ticket !== 'string') {
    throw new Error('Gateway did not return a WS ticket.')
  }

  return body.ticket
}

/** GET /api/auth/me — true session liveness (cookie-authed, no false AT expiry). */
async function hasLiveSession(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/auth/me`, { credentials: 'include', signal: AbortSignal.timeout(6_000) })

    return response.ok
  } catch {
    return false
  }
}

/** GET /api/auth/providers — advertised providers for the login button copy. */
async function fetchAuthProviders(baseUrl: string): Promise<DesktopAuthProvider[]> {
  try {
    const body = await fetchPublicJson<{ providers?: unknown }>(baseUrl, '/api/auth/providers')

    if (!Array.isArray(body?.providers)) {
      return []
    }

    return body.providers
      .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === 'object')
      .map(p => ({
        displayName: String(p.display_name || p.name || ''),
        name: String(p.name || ''),
        supportsPassword: Boolean(p.supports_password)
      }))
      .filter(p => p.name)
  } catch {
    // Provider listing is optional metadata; the auth mode is already known.
    return []
  }
}

/** Read a Blob as a base64 data URL (FileReader — no fetch round-trip). */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()

    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read blob'))
    reader.readAsDataURL(blob)
  })
}

/** POST /api/chat/image-upload — persist browser image bytes on the gateway
 *  host and return the path the renderer attaches to chat messages (the agent
 *  reads images from ITS filesystem, which is exactly where this lands). */
async function uploadChatImage(blob: Blob, filename: string): Promise<string> {
  const dataUrl = await blobToDataUrl(blob)
  const result = await api<{ ok?: boolean; path?: string }>({
    body: { data_url: dataUrl, filename },
    method: 'POST',
    path: '/api/chat/image-upload'
  })

  return result?.path || ''
}

/** POST /api/files/upload — persist arbitrary browser bytes under the gateway
 *  host's managed uploads dir and return the host path. The renderer attaches
 *  that path to messages (kind 'file'); the agent reads it from its own fs. */
async function uploadManagedFile(blob: Blob, filename: string): Promise<string> {
  const dataUrl = await blobToDataUrl(blob)
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'file'
  const result = await api<{ ok?: boolean; path?: string }>({
    body: { data_url: dataUrl, overwrite: true, path: `uploads/${Date.now()}-${safeName}` },
    method: 'POST',
    path: '/api/files/upload'
  })

  return result?.path || ''
}

/** Real WebSocket dial with a settled-once guard (mirrors the desktop probe). */
async function dialWebSocket(wsUrl: string): Promise<boolean> {
  return new Promise<boolean>(resolve => {
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
    // PWA same-origin default: the app is served by a proxy that fronts the
    // gateway (dev vite proxy / production nginx), so the gateway IS this
    // origin. Skip the gateway-setup pass entirely — the boot probes
    // /api/status and runs the login pass only when the session cookie is
    // missing. A stored connection still wins when the user configured one.
    return buildRemoteConnection(window.location.origin, 'oauth', '', profile)
  }

  const authMode = stored.remoteAuthMode === 'oauth' ? 'oauth' : 'token'

  if (authMode === 'token' && !stored.remoteToken.trim()) {
    throw new Error('No session token saved. Open Settings → Gateway and save a token.')
  }

  return buildRemoteConnection(normalizeRemoteBaseUrl(stored.remoteUrl), authMode, stored.remoteToken.trim(), profile)
}

function buildRemoteConnection(
  baseUrl: string,
  authMode: 'oauth' | 'token',
  token: string,
  profile?: string | null
): HermesConnection {
  return {
    authMode,
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
    // Cookie-gated gateways mint a fresh single-use ticket per connect (the
    // renderer calls getGatewayWsUrl when authMode === 'oauth'); this value is
    // only used by the legacy token path.
    wsUrl: authMode === 'oauth' ? `${baseUrl}/api/ws` : buildGatewayWsUrl(baseUrl, token),
    windowButtonPosition: null
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
      credentials: 'include',
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

  let status: { authRequired: boolean; version: string | null; raw: unknown }

  try {
    status = await statusProbe(baseUrl)
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

  const authRequired = Boolean(status.authRequired)
  // Mirror of the desktop main: auth_required means the cookie gate is engaged
  // (username/password OR OAuth — the /login page adapts, and the providers
  // list drives the button copy); otherwise it's legacy token auth.
  const providers = authRequired ? await fetchAuthProviders(baseUrl) : []

  return {
    authMode: authRequired ? 'oauth' : 'token',
    baseUrl,
    error: null,
    providers,
    reachable: true,
    version: status.version
  }
}

// Mirrors the desktop test: HTTP status probe + the SAME transport the app
// actually uses — legacy token ?token= for token gateways, a freshly minted
// single-use ?ticket= for cookie-gated ones — so a proxy that passes HTTP but
// blocks /api/ws can't produce a false "reachable".
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
    // Cookie-session gateway: the test mints a real single-use WS ticket and
    // dials the same socket the chat uses. A 401/403 mint means the session
    // is missing/expired — sign in first.
    let ticket: string

    try {
      ticket = await mintGatewayWsTicket(baseUrl)
    } catch (error) {
      if (isGatewayAuthRejection(error)) {
        throw new Error(
          'Reached the gateway, but the session was rejected while minting a WebSocket ticket. ' +
            'Sign in first (Settings → Gateway → Sign in).'
        )
      }

      throw new Error(
        'Reached the gateway over HTTP, but could not mint a WebSocket ticket. Check the remote gateway connection and try again.'
      )
    }

    if (!(await dialWebSocket(buildGatewayWsUrlWithTicket(baseUrl, ticket)))) {
      throw new Error(
        'Reached the gateway and minted a WebSocket ticket, but the live /api/ws connection failed. ' +
          'The HTTP check can pass while the WebSocket is blocked by a proxy, firewall, or origin guard.'
      )
    }

    return { baseUrl, ok: true, version: status.version }
  }

  if (!token) {
    throw new Error('A session token is required to test the connection.')
  }

  if (!(await dialWebSocket(buildGatewayWsUrl(baseUrl, token)))) {
    throw new Error(
      'Reached the gateway over HTTP, but the live WebSocket (/api/ws) connection failed. ' +
        'The HTTP check can pass while the WebSocket is blocked by a proxy, firewall, or gateway auth/origin guard.'
    )
  }

  return { baseUrl, ok: true, version: status.version }
}

// ── Connection config surface (Settings → Gateway) ───────────────────────────

function connectionConfigFrom(stored: StoredConnection | null, fallbackUrl?: string): DesktopConnectionConfig {
  const authMode = stored?.remoteAuthMode === 'oauth' ? 'oauth' : 'token'

  return {
    cloudOrg: '',
    envOverride: false,
    mode: 'remote',
    profile: null,
    remoteAuthMode: authMode,
    remoteOauthConnected: authMode === 'oauth' && Boolean(stored?.remoteOauthConnected),
    remoteTokenPreview: stored?.remoteToken ? tokenPreview(stored.remoteToken) : null,
    remoteTokenSet: Boolean(stored?.remoteToken),
    remoteUrl: stored?.remoteUrl || fallbackUrl || '',
    // PWA: no Electron safeStorage — persisted tokens live in localStorage
    // (plain text), and any persisted token IS plain by construction.
    secureTokenStorage: false,
    remoteTokenPlainText: Boolean(stored?.remoteToken),
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
  const authMode = payload.remoteAuthMode === 'oauth' ? 'oauth' : 'token'
  const previous = readStoredConnection()
  const stored = writeStoredConnection(
    url,
    payload.remoteToken || previous?.remoteToken || '',
    authMode,
    previous?.remoteOauthConnected ?? false
  )

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
  getConnectionConfig: async () => connectionConfigFrom(readStoredConnection(), window.location.origin),
  getGatewayWsUrl: async (profile?: string | null) => {
    const connection = await resolveConnection(profile)

    if (connection.authMode === 'oauth') {
      // Single-use ticket, minted right before connect (the renderer calls
      // this per gateway.connect(); tickets are single-use with a short TTL).
      try {
        const ticket = await mintGatewayWsTicket(connection.baseUrl)

        return { ok: true, wsUrl: buildGatewayWsUrlWithTicket(connection.baseUrl, ticket) }
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
          needsOauthLogin: isGatewayAuthRejection(error),
          ok: false
        }
      }
    }

    return { ok: true, wsUrl: connection.wsUrl }
  },
  getOnBattery,
  getRecentLogs: async () => ({ lines: [], path: '' }),
  getRemoteDisplayReason: async () => null,
  getVersion: async () => VERSION_INFO,
  notify,
  oauthLoginConnectionConfig: async (rawUrl: string): Promise<DesktopOauthLoginResult> => {
    const baseUrl = normalizeRemoteBaseUrl(rawUrl)

    // The gateway's /login renders a credential form for username/password
    // providers and the provider redirect for OAuth ones. Opening it in a new
    // tab (the browser equivalent of Electron's login window) lets the user
    // authenticate; the session cookie lands in the same browser profile.
    window.open(`${baseUrl}/login`, '_blank', 'noopener,noreferrer')

    // The session cookie is only visible to same-origin pages — the gateway's
    // CORS never allows credentialed cross-origin reads, so a gateway on a
    // DIFFERENT origin than this app (e.g. the dev server with the real
    // gateway URL in the Remote URL field) can never be detected. Fail fast
    // instead of spinning for two minutes. Same-origin setups (production
    // reverse proxy, or the dev proxy with Remote URL = the dev origin) poll
    // normally.
    const crossOrigin = new URL(baseUrl).origin !== window.location.origin
    const deadline = Date.now() + (crossOrigin ? 8_000 : 120_000)

    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, crossOrigin ? 1_000 : 2_000))

      if (await hasLiveSession(baseUrl)) {
        updateStoredOauthConnected(true)

        return { baseUrl, connected: true, ok: true }
      }

      if (crossOrigin) {
        // One probe is enough to know the session cannot be seen from here.
        break
      }
    }

    return { baseUrl, connected: false, ok: true }
  },
  oauthLogoutConnectionConfig: async (): Promise<DesktopOauthLogoutResult> => {
    const stored = readStoredConnection()

    if (!stored?.remoteUrl) {
      return { connected: false, ok: true }
    }

    const baseUrl = normalizeRemoteBaseUrl(stored.remoteUrl)

    // POST /api/auth/logout clears the session cookie server-side; the
    // browser stores the expired-cookie response like any Set-Cookie.
    try {
      await fetch(`${baseUrl}/api/auth/logout`, {
        credentials: 'include',
        method: 'POST',
        signal: AbortSignal.timeout(8_000)
      })
    } catch {
      // Ignore — liveness below reports the truth.
    }

    const connected = await hasLiveSession(baseUrl)

    updateStoredOauthConnected(connected)

    return { connected, ok: true }
  },
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
  readDir: async path => {
    // The gateway's /api/fs/list mirrors the Electron readDir contract
    // ({entries:[{name,path,isDirectory}], error?}) against the HOST
    // filesystem — the right semantics for the PWA: there is no local fs in
    // the browser; the agent's machine is the one the tree must browse.
    try {
      return await api<HermesReadDirResult>({ path: `/api/fs/list?path=${encodeURIComponent(path)}` })
    } catch (error) {
      return { entries: [], error: error instanceof Error ? error.message : String(error) }
    }
  },
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
  sanitizeWorkspaceCwd: async (cwd?: string | null) => {
    // The gateway resolves the canonical default workspace on the HOST. A
    // session cwd is already host-valid, so only fill in the default when
    // none was provided.
    const result = await api<{ cwd?: string }>({ path: '/api/fs/default-cwd' })

    return { cwd: cwd || result.cwd || '', sanitized: !cwd && Boolean(result.cwd) }
  },
  saveConnectionConfig,
  saveImageBuffer: async (data: ArrayBuffer | Uint8Array, ext: string) => {
    const buffer = data instanceof Uint8Array ? data.buffer : data
    const mime = ext === 'jpg' ? 'image/jpeg' : ext === 'svg' ? 'image/svg+xml' : `image/${ext}`

    return uploadChatImage(new Blob([buffer as ArrayBuffer], { type: mime }), `pasted-image.${ext}`)
  },
  saveClipboardImage: async () => {
    // Browser clipboard read (Chromium): the gateway's /login flow already
    // required a user gesture, and clipboard.read() needs the same.
    try {
      const items = await navigator.clipboard.read()

      for (const item of items) {
        const type = item.types.find(t => t.startsWith('image/'))

        if (type) {
          const blob = await item.getType(type)

          return uploadChatImage(blob, `pasted-image.${blob.type.split('/')[1] || 'png'}`)
        }
      }
    } catch {
      // Clipboard read denied or unavailable — the paste path reports no image.
    }

    return ''
  },
  saveImageFromUrl: async url => {
    // Fetching an arbitrary URL from the browser is CORS-restricted; when it
    // works (same-origin gateway assets, permissive CDNs) the image lands in
    // the gateway's images dir and the renderer attaches the host path.
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })

      if (!response.ok) {
        return false
      }

      const blob = await response.blob()

      return Boolean(await uploadChatImage(blob, `pasted-image.${blob.type.split('/')[1] || 'png'}`))
    } catch {
      return false
    }
  },
  selectPaths: undefined,
  uploadFile: async (data: ArrayBuffer | Uint8Array, filename: string, mimeType: string) => {
    const buffer = data instanceof Uint8Array ? data.buffer : data

    return uploadManagedFile(
      new Blob([buffer as ArrayBuffer], { type: mimeType || 'application/octet-stream' }),
      filename
    )
  },
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
