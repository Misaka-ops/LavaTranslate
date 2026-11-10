import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  Notification,
  powerMonitor,
  screen,
  session,
  shell,
  Tray,
  type Display,
  type WebContents
} from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEEPSEEK,
  LANGUAGES,
  type CaptureFrame,
  type EngineStatus,
  type OcrLine,
  type ReplyEvent,
  type ReplyStartMsg,
  type PinPayload,
  type Rect,
  type Settings,
  type SettingsPatch,
  type TranslateEvent,
  type TranslateRequestMsg
} from '../shared/types'
import { captureAll, cropRgba, rgbaToBgra, type DisplayCapture } from './capture'
import { resolveProvider } from './credentials'
import { langFor } from '../core/lang'
import { setPlatform } from '../core/platform'
import { PaddleOcr } from './ocr'
import { matchesTargetLanguage } from './ocr-language'
import { check as checkUpdate, initUpdater, installNow, setAutoUpdate, updateState } from './updater'
import { settings } from './settings'
import { errorText, t, uiLang } from './i18n'
import { langBase, UI_LANGS } from '../shared/i18n'
import { focusWindowAt, forceForeground, hwndOf, keyDown, VK_SPACE } from './winapi'
import { acceleratorLabel } from '../shared/hotkeys'
import { PIN_COMPACT_SIZE, PIN_MARGIN } from '../shared/pin'
import { WinSpaceHotkey } from './win-space'
import { OpenAIEngine, TranslateError, type Engine } from '../core/translator'
import { FixtureEngine, MockEngine, runAutotest, runEngineTest, runI18nShots, runPassTest, runReview } from './devtest'
import { EventEmitter } from 'node:events'
import { logError } from './diagnostics'

// 模型请求走 Chromium 网络栈（系统代理、HTTP/2）
setPlatform({
  fetch: ((input: any, init?: any) => net.fetch(input, init)) as typeof fetch,
  preconnect: (url) => session.defaultSession.preconnect({ url, numSockets: 2 })
})

const isDev = !app.isPackaged
const resources = isDev ? join(__dirname, '../../resources') : process.resourcesPath
const preload = join(__dirname, '../preload/index.js')
/** 窗口图标：.ico 含 16~256 多种尺寸，任务栏、Alt+Tab 都清晰 */
const appIcon = join(resources, 'icon.ico')
const AUTOTEST = !!process.env.LENS_AUTOTEST || !!process.env.LENS_REVIEW
const fixtureEngine = process.env.LENS_REVIEW ? new FixtureEngine() : null
const mockEngine = fixtureEngine ?? (process.env.LENS_MOCK || process.env.LENS_PASSTEST ? new MockEngine() : null)
const pipeline = new EventEmitter()

// 自测数据目录由 bootstrap 在导入原生模块前设置。
// LENS_AUTOTEST_SEED=<settings.json>：自测前放一份指定的设置（检查旧格式迁移等）
if (AUTOTEST && process.env.LENS_AUTOTEST_SEED) {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(join(app.getPath('userData'), 'settings.json'), readFileSync(process.env.LENS_AUTOTEST_SEED))
}
if (!app.requestSingleInstanceLock()) app.quit()

// 开发 / 测试运行用另一个 ID：同一个 ID 会和已安装的版本归成一组，任务栏就可能显示 electron.exe 的图标
if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? 'com.lavatranslate.app' : 'com.lavatranslate.app.dev')
// 隐藏的遮罩窗口也要及时绘制新截图
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

let tray: Tray | null = null
let settingsWin: BrowserWindow | null = null
let quitting = false
const ocr = new PaddleOcr(join(resources, 'models'))
let engine: Engine | null = null

// ------------------------------------------------------------------ 页面加载
function loadPage(win: BrowserWindow, page: 'overlay' | 'settings' | 'pin') {
  win.webContents.on('did-fail-load', (_event, code, description) => logError(`${page} load`, `${code}: ${description}`))
  win.webContents.on('preload-error', (_event, _path, error) => logError(`${page} preload`, error))
  win.webContents.on('render-process-gone', (_event, details) => {
    logError(`${page} renderer`, details.reason)
    if (page === 'overlay') void hideOverlays(true)
    if (page === 'settings') void registerHotkey(settings.get().hotkey)
  })
  win.on('unresponsive', () => {
    if (page === 'overlay') void hideOverlays(true)
    if (page === 'settings') void registerHotkey(settings.get().hotkey)
  })
  if (process.env.LENS_DIAGNOSTIC) {
    win.webContents.on('did-finish-load', () => console.log('[page loaded]', page))
    win.webContents.on('console-message', (event) => diag('renderer', page, event.message))
  }
  if (isDev && process.env.ELECTRON_RENDERER_URL) win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/${page}.html`)
  else win.loadFile(join(__dirname, `../renderer/${page}.html`))
}

// ------------------------------------------------------------------ 引擎
function buildEngine(s: Settings): Engine | null {
  engine?.dispose()
  if (mockEngine) return (engine = mockEngine)
  engine = engineFor(s)
  return engine
}

/** 按当前配置创建 DeepSeek 引擎；没填 Key 时返回 null */
function engineFor(s: Settings): Engine | null {
  const r = resolveProvider(s)
  if (!r) return null
  return new OpenAIEngine({ baseURL: r.baseURL, apiKey: r.apiKey }, r.model, { chatExtra: DEEPSEEK.chatExtra })
}

function engineStatus(): EngineStatus {
  const s = settings.get()
  const r = resolveProvider(s)
  if (!r) return { provider: 'deepseek', ok: false, detail: t('status.noKey') }
  return { provider: 'deepseek', ok: true, detail: `${r.model} · DeepSeek` }
}

// ------------------------------------------------------------------ 遮罩窗口
interface Overlay {
  win: BrowserWindow
  displayId: number
}
const overlays = new Map<number, Overlay>()
let captures = new Map<number, DisplayCapture>()
let overlayActive = false
/** 每次开始 / 取消都换代，防止权限框或截图返回后重新打开已经取消的界面。 */
let captureGeneration = 0
let releaseTimer: NodeJS.Timeout | null = null

function createOverlay(display: Display): Overlay {
  const { x, y, width, height } = display.bounds
  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    icon: appIcon,
    alwaysOnTop: true,
    hasShadow: false,
    enableLargerThanScreen: true,
    roundedCorners: false,
    thickFrame: false,
    webPreferences: { preload, sandbox: false, backgroundThrottling: false, spellcheck: false, offscreen: AUTOTEST }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setMenu(null)
  // 窗口只在启动时显示一次并保持常驻；后续只切换透明度，避免 Win11 每次 show 都播放打开动画。
  win.setOpacity(0)
  win.setIgnoreMouseEvents(true)
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      hideOverlays()
    }
  })
  loadPage(win, 'overlay')
  if (!AUTOTEST) win.showInactive()
  return { win, displayId: display.id }
}

function syncOverlays() {
  const displays = screen.getAllDisplays()
  const ids = new Set(displays.map((d) => d.id))
  for (const [id, o] of overlays) {
    if (!ids.has(id)) {
      o.win.destroy()
      overlays.delete(id)
    }
  }
  for (const d of displays) {
    const o = overlays.get(d.id)
    if (!o) overlays.set(d.id, createOverlay(d))
    else {
      const b = o.win.getBounds()
      if (b.x !== d.bounds.x || b.y !== d.bounds.y || b.width !== d.bounds.width || b.height !== d.bounds.height) o.win.setBounds(d.bounds)
    }
  }
}

function overlayOf(wc: WebContents): Overlay | undefined {
  for (const o of overlays.values()) if (o.win.webContents === wc) return o
  return undefined
}

let tHotkey = 0
/** 连按两次快捷键的间隔上限；比键盘自动重复的延迟（约 500ms）短，按住不放不会误触发 */
const DOUBLE_PRESS_MS = 400
let lastHotkey = 0
/** 截图还没显示出来时就连按了第二次：显示时直接进入输入翻译 */
let quickPending = false
let framesShown = false
let hiding: Promise<void> | null = null
/** 当前截图的各显示器都画好后才一起显现，避免多屏窗口分别播放显示过程。 */
const readyOverlays = new Set<number>()

function onHotkey() {
  const now = Date.now()
  const double = now - lastHotkey < DOUBLE_PRESS_MS
  lastHotkey = double ? 0 : now
  if (double) startQuick()
  else void startCapture()
}

/** 直接输入一句话翻译（不框选） */
function startQuick() {
  if (overlayActive && framesShown) {
    // 输入框显示在鼠标所在的屏；那块屏没有截图时用第一块
    const cursor = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id
    const here = captures.has(cursor) ? cursor : [...captures.keys()][0]
    for (const o of overlays.values()) {
      if (!captures.has(o.displayId)) continue
      o.win.webContents.send('overlay:quick', o.displayId === here)
      if (o.displayId === here && o.win.isVisible()) {
        o.win.focus()
        o.win.webContents.focus()
      }
    }
    return
  }
  quickPending = true
  if (!overlayActive) void startCapture()
}

function diag(...args: unknown[]) {
  if (!process.env.LENS_DIAGNOSTIC) return
  const line = `${new Date().toISOString()} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`
  console.log('[diag]', line)
  try {
    appendFileSync(join(app.getPath('temp'), 'lava-diag.log'), line + '\n')
  } catch {
    /* 忽略 */
  }
}

async function startCapture() {
  diag('startCapture', { overlayActive, hiding: !!hiding })
  tHotkey = Date.now()
  if (overlayActive) {
    hideOverlays()
    return
  }
  const generation = ++captureGeneration
  if (hiding) await hiding
  if (generation !== captureGeneration) return
  overlayActive = true
  // The native worker owns this short lease, even if capture blocks the main loop.
  if (process.platform === 'win32' && !AUTOTEST) {
    await winSpace.setCaptureSpace(true, 10_000)
    if (generation !== captureGeneration || !overlayActive) return
  }
  if (releaseTimer) clearTimeout(releaseTimer)
  try {
    syncOverlays()
    const caps = await captureAll()
    if (generation !== captureGeneration || !overlayActive) return
    if (process.env.LENS_SHOWTEST) console.log('[show] captured', Date.now() - tHotkey, 'ms')
    presentCaptures(caps)
  } catch (e) {
    if (generation !== captureGeneration || !overlayActive) return
    // 出错一定要复位，否则之后每次按快捷键都只会在"关闭"分支里空转
    void winSpace.setCaptureSpace(false)
    overlayActive = false
    quickPending = false
    logError('capture', e)
    notify(t('notify.captureFailed'), e instanceof Error ? e.message : String(e))
  }
}

function presentCaptures(caps: DisplayCapture[], refresh = false) {
  const s = settings.get()
  overlayActive = true
  captures = new Map(caps.map((c) => [c.display.id, c]))
  readyOverlays.clear()
  ocrCache.clear()
  const cursor = screen.getCursorScreenPoint()
  const cursorDisplay = screen.getDisplayNearestPoint(cursor)
  for (const cap of caps) {
    const o = overlays.get(cap.display.id)
    if (!o) continue
    const b = cap.display.bounds
    const frame: CaptureFrame = {
      displayId: cap.display.id,
      width: cap.width,
      height: cap.height,
      scale: cap.scale,
      pixels: cap.rgba,
      cursor: cap.display.id === cursorDisplay.id ? { x: cursor.x - b.x, y: cursor.y - b.y } : null,
      targetLang: s.targetLang,
      autoTranslate: s.autoTranslate,
      displayMode: s.displayMode,
      hotkey: s.hotkey,
      replyAssist: s.replyAssist,
      replyTone: s.replyTone,
      quick: quickPending,
      refresh
    }
    o.win.webContents.send('overlay:frame', frame)
  }
  quickPending = false
  framesShown = true
}

/** 渲染进程画好截图后才显示窗口，避免闪出上一帧 */
ipcMain.on('overlay:frame-ready', (e) => {
  const o = overlayOf(e.sender)
  diag('frame-ready', { display: o?.displayId, overlayActive, framesShown, passthrough: !!passthrough })
  if (process.env.LENS_SHOWTEST && o) console.log('[show] frame-ready display', o.displayId, Date.now() - tHotkey, 'ms')
  if (!o || !overlayActive || passthrough) return
  if (AUTOTEST) return o.win.webContents.send('overlay:shown')
  readyOverlays.add(o.displayId)
  const displayIds = [...captures.keys()].filter((id) => overlays.has(id))
  if (displayIds.some((id) => !readyOverlays.has(id))) return

  for (const id of displayIds) {
    const target = overlays.get(id)
    if (!target) continue
    target.win.setOpacity(1)
    target.win.setIgnoreMouseEvents(false)
    target.win.setAlwaysOnTop(true, 'screen-saver')
  }
  const cursor = screen.getCursorScreenPoint()
  const cursorDisplay = screen.getDisplayNearestPoint(cursor).id
  const activeId = displayIds.includes(cursorDisplay) ? cursorDisplay : displayIds[0]
  const active = activeId === undefined ? undefined : overlays.get(activeId)
  if (active) {
    forceForeground(hwndOf(active.win.getNativeWindowHandle()))
    active.win.focus()
    active.win.webContents.focus()
  }
  // The first plain Space can go down before the overlay takes keyboard focus.
  const spaceHeld = activeId === o.displayId && process.platform === 'win32' && plainSpaceHeld()
  for (const id of displayIds) overlays.get(id)?.win.webContents.send('overlay:shown')
  if (spaceHeld) requestScrollAtCursor()
})

ipcMain.on('overlay:visible', (e) => {
  const o = overlayOf(e.sender)
  diag('visible', { display: o?.displayId, focused: o?.win.isFocused(), bounds: o && JSON.stringify(o.win.getBounds()) })
  if (o && overlayActive && !passthrough) o.win.setOpacity(1)
  if (process.env.LENS_SHOWTEST && o) console.log('[show] visible display', o.displayId, Date.now() - tHotkey, 'ms', 'focused', o.win.isFocused(), 'bounds', JSON.stringify(o.win.getBounds()))
})

ipcMain.on('overlay:focus', (e) => {
  const o = overlayOf(e.sender)
  if (o) {
    o.win.focus()
    o.win.webContents.focus()
  }
})

function fadeOut(win: BrowserWindow, ms: number) {
  return new Promise<void>((resolve) => {
    const start = Date.now()
    const from = win.getOpacity()
    const tick = () => {
      if (win.isDestroyed()) return resolve()
      const t = Math.min(1, (Date.now() - start) / ms)
      win.setOpacity(from * (1 - t * t))
      if (t < 1) setTimeout(tick, 8)
      else resolve()
    }
    tick()
  })
}

function hideOverlays(immediate = false) {
  diag('hideOverlays', { immediate, active: overlayActive, stack: new Error().stack?.split('\n')[2]?.trim() })
  captureGeneration++
  quickPending = false
  if (process.platform === 'win32') void winSpace.setCaptureSpace(false)
  if (!overlayActive) return hiding ?? Promise.resolve()
  overlayActive = false
  framesShown = false
  editingOverlays.clear()
  overlayHeartbeats.clear()
  if (passthrough?.timer) clearTimeout(passthrough.timer)
  passthrough = null
  hiding = doHide(immediate).finally(() => (hiding = null))
  return hiding
}

async function doHide(immediate: boolean) {
  for (const ctl of translations.values()) ctl.abort()
  translations.clear()
  const visible = [...overlays.values()].filter((o) => o.win.isVisible() && o.win.getOpacity() > 0)
  await Promise.all(visible.map((o) => (immediate ? Promise.resolve() : fadeOut(o.win, 140))))
  readyOverlays.clear()
  for (const o of overlays.values()) {
    if (o.win.isDestroyed()) continue
    o.win.setOpacity(0)
    o.win.setIgnoreMouseEvents(true)
    o.win.webContents.send('overlay:reset')
  }
  // 截图数据保留片刻，便于连续操作；之后释放内存
  releaseTimer = setTimeout(() => {
    captures.clear()
    ocrCache.clear()
  }, 30_000)
}

ipcMain.on('overlay:close', () => hideOverlays())

// ------------------------------------------------------------------ 按住空格：遮罩暂时让开
// 只显示选区边框、鼠标穿透。松开空格时，先隐藏边框再重新截图。
// Windows 上键盘钩子跨焦点监听空格，滚动期间把焦点还给鼠标下方的应用。
let passthrough: { timer: NodeJS.Timeout | null } | null = null

const spaceDown = () => winSpace.scrollHeld || keyDown(VK_SPACE)
const plainSpaceHeld = () => spaceDown() === true && ![0x10, 0x11, 0x12, 0x5b, 0x5c].some((vk) => keyDown(vk))
const editingOverlays = new Set<number>()
const overlayHeartbeats = new Map<number, number>()
let captureLeaseEnabled: boolean | null = null

ipcMain.on('overlay:space-editing', (e, editing: boolean) => {
  if (process.platform !== 'win32' || !overlayActive || !framesShown || !overlayOf(e.sender)) return
  if (editing) editingOverlays.add(e.sender.id)
  else editingOverlays.delete(e.sender.id)
  const now = Date.now()
  overlayHeartbeats.set(e.sender.id, now)
  // Another healthy monitor must not renew input ownership for a frozen renderer.
  const participants = [...overlays.values()].filter((o) => captures.has(o.displayId))
  // Preserve the initial hold while monitors deliver their first frame. The
  // independent startup lease still expires if a monitor never responds.
  if (!editingOverlays.size && participants.some((o) => !overlayHeartbeats.has(o.win.webContents.id))) return
  const responsive = participants.every((o) => now - (overlayHeartbeats.get(o.win.webContents.id) ?? 0) < 1000)
  const enabled = responsive && !editingOverlays.size
  if (enabled !== captureLeaseEnabled) {
    captureLeaseEnabled = enabled
    diag('capture lease', { enabled, editing, editingCount: editingOverlays.size, responsive })
  }
  void winSpace.setCaptureSpace(enabled)
})

function requestScrollAtCursor() {
  diag('requestScrollAtCursor', { overlayActive, framesShown, passthrough: !!passthrough, editing: editingOverlays.size })
  if (!overlayActive || !framesShown || passthrough || editingOverlays.size) return
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const o = overlays.get(display.id)
  if (o?.win.isVisible()) o.win.webContents.send('overlay:space-hold', { x: cursor.x - display.bounds.x, y: cursor.y - display.bounds.y })
}

ipcMain.on('overlay:passthrough', async (e, rect: Rect) => {
  const owner = overlayOf(e.sender)
  diag('passthrough request', { owner: owner?.displayId, rect, space: plainSpaceHeld(), overlayActive, framesShown, passthrough: !!passthrough })
  if (!owner || !overlayActive || !framesShown || passthrough || hiding) return
  // 只认此刻还按着的空格；读不到按键状态（没有 koffi）就不支持
  if (!plainSpaceHeld()) return
  const shown = [...overlays.values()].filter((o) => o.win.isVisible())
  const p = { timer: null as NodeJS.Timeout | null }
  passthrough = p
  for (const o of shown) {
    o.win.webContents.send('overlay:passing', o === owner ? rect : null)
    o.win.setIgnoreMouseEvents(true)
  }
  if (process.platform === 'win32') {
    const pt = screen.dipToScreenPoint(screen.getCursorScreenPoint())
    focusWindowAt(pt.x, pt.y, shown.map((o) => hwndOf(o.win.getNativeWindowHandle())))
  }
  const poll = () => {
    if (passthrough !== p) return
    if (spaceDown()) p.timer = setTimeout(poll, 16)
    else {
      void endPassthrough(p)
    }
  }
  p.timer = setTimeout(poll, 16)
})

async function endPassthrough(p: NonNullable<typeof passthrough>) {
  // Let the desktop compositor remove the outline before sampling the live screen.
  for (const o of overlays.values()) if (o.win.isVisible()) o.win.setOpacity(0)
  await new Promise((resolve) => setTimeout(resolve, 50))
  if (passthrough !== p) return
  try {
    const caps = await captureAll()
    if (passthrough !== p) return
    passthrough = null
    presentCaptures(caps, true)
  } catch (e) {
    if (passthrough !== p) return
    logError('capture', e)
    passthrough = null
    void hideOverlays(true)
  }
}

// ------------------------------------------------------------------ 翻译流程
const translations = new Map<number, AbortController>()
const ocrCache = new Map<string, OcrLine[]>()

ipcMain.on('translate:start', async (e, msg: TranslateRequestMsg) => {
  diag('translate:start', { id: msg.requestId, rect: msg.rect, reuseOcr: msg.reuseOcr, manual: msg.manual })
  const sender = e.sender
  const send = (event: TranslateEvent) => {
    diag('translate event', { id: msg.requestId, type: event.type })
    if (!ctl.signal.aborted && !sender.isDestroyed()) sender.send('translate:event', { requestId: msg.requestId, event })
  }
  translations.get(sender.id)?.abort()
  const ctl = new AbortController()
  translations.set(sender.id, ctl)

  const t0 = Date.now()
  try {
    const cap = captures.get(msg.displayId)
    if (!cap) return send({ type: 'error', message: t('err.captureExpired'), code: 'unknown' })
    const rect = clampRect(msg.rect, cap.width, cap.height)
    if (rect.w < 4 || rect.h < 4) return send({ type: 'error', message: t('err.tooSmall'), code: 'no-text' })
    const crop = cropRgba(cap.rgba, cap.width, rect)

    // 1. OCR（GPU）
    const key = `${msg.displayId}:${rect.x},${rect.y},${rect.w},${rect.h}`
    let lines = msg.reuseOcr ? ocrCache.get(key) : undefined
    if (!lines) {
      try {
        // 首次识别会加载 OCR 模型，可能阻塞主线程数秒；别让键盘看门狗把这当成卡死
        if (process.platform === 'win32' && !AUTOTEST) winSpace.protect(15_000)
        const ocrStart = Date.now()
        lines = await ocr.recognize({ data: crop, width: rect.w, height: rect.h })
        diag('ocr done', { ms: Date.now() - ocrStart, lines: lines.length, provider: ocr.provider })
      } catch (err) {
        return send({ type: 'error', message: t('err.ocr', { msg: String(err) }), code: 'unknown' })
      }
      if (ctl.signal.aborted) return
      if (captures.get(msg.displayId) === cap) ocrCache.set(key, lines)
    }
    if (ctl.signal.aborted) return
    send({ type: 'ocr', lines, ms: Date.now() - t0 })
    if (!lines.length) return send({ type: 'error', message: t('err.noText'), code: 'no-text' })

    // 2. 模型
    const s = settings.get()
    const target = LANGUAGES.find((l) => l.code === msg.targetLang) ?? LANGUAGES[0]
    const ocrOnly = !s.autoTranslate && !msg.manual
    if (ocrOnly || await matchesTargetLanguage(lines, target.code)) {
      if (ctl.signal.aborted) return
      if (!ocrOnly) send({ type: 'lang', code: target.code, name: target.name })
      send({ type: 'recognized', reason: ocrOnly ? 'ocr-only' : 'same-language' })
      pipeline.emit('end', { ok: true, ms: Date.now() - t0, ocrMs: ocr.timing })
      return
    }
    if (ctl.signal.aborted) return
    const eng = engine ?? buildEngine(s)
    if (!eng) return send({ type: 'error', message: engineStatus().detail, code: 'config' })
    diag('engine', { model: eng.name, status: engineStatus().detail, lines: lines.length })
    const { image, factor } = encodeForModel(crop, rect.w, rect.h)
    const promptLines = factor === 1 ? lines : lines.map((l) => ({ ...l, box: scaleRect(l.box, factor) }))
    send({ type: 'translating' })
    const res = await eng.translate(
      { image, lines: promptLines, target, styleHint: s.styleHint },
      send,
      ctl.signal
    )
    send({ type: 'done', ms: Date.now() - t0, firstTokenMs: res.firstTokenMs, engine: eng.name, usage: res.usage })
    diag('translate done', { ms: Date.now() - t0, firstTokenMs: res.firstTokenMs, usage: res.usage })
    pipeline.emit('end', { ok: true, ms: Date.now() - t0, ocrMs: ocr.timing, firstTokenMs: res.firstTokenMs, usage: res.usage })
  } catch (err) {
    if (ctl.signal.aborted) return
    const te = err instanceof TranslateError ? err : new TranslateError(String(err), 'unknown')
    const message = errorText(te)
    diag('translate error', { code: te.code, message })
    if (ctl.signal.aborted) return
    send({ type: 'error', message, code: te.code })
    pipeline.emit('end', { ok: false, error: message })
  } finally {
    if (translations.get(sender.id) === ctl) translations.delete(sender.id)
  }
})

// ------------------------------------------------------------------ 回复助手
const replies = new Map<number, AbortController>()

ipcMain.on('reply:start', async (e, msg: ReplyStartMsg) => {
  const sender = e.sender
  const send = (event: ReplyEvent) => {
    if (!sender.isDestroyed()) sender.send('reply:event', { requestId: msg.requestId, event })
  }
  replies.get(sender.id)?.abort()
  const ctl = new AbortController()
  replies.set(sender.id, ctl)
  const s = settings.get()
  const eng = engine ?? buildEngine(s)
  if (!eng) return send({ type: 'error', message: engineStatus().detail })
  const t0 = Date.now()
  try {
    await eng.reply(
      {
        text: msg.text,
        from: langFor(msg.from ?? s.targetLang),
        to: langFor(msg.to, msg.toName),
        context: msg.context,
        tone: msg.tone,
        both: msg.both,
        quick: msg.quick
      },
      (d) => send({ type: 'delta', text: d }),
      ctl.signal
    )
    if (!ctl.signal.aborted) send({ type: 'done', ms: Date.now() - t0 })
  } catch (err) {
    if (ctl.signal.aborted) return
    const message = errorText(err)
    if (ctl.signal.aborted) return
    send({ type: 'error', message })
  } finally {
    if (replies.get(sender.id) === ctl) replies.delete(sender.id)
  }
})

ipcMain.on('reply:cancel', (e) => {
  replies.get(e.sender.id)?.abort()
  replies.delete(e.sender.id)
})

ipcMain.on('translate:cancel', (e) => {
  translations.get(e.sender.id)?.abort()
  translations.delete(e.sender.id)
})

function clampRect(r: Rect, W: number, H: number): Rect {
  const x = Math.max(0, Math.min(W - 1, Math.round(r.x)))
  const y = Math.max(0, Math.min(H - 1, Math.round(r.y)))
  return { x, y, w: Math.max(1, Math.min(W - x, Math.round(r.w))), h: Math.max(1, Math.min(H - y, Math.round(r.h))) }
}

function scaleRect(r: Rect, f: number): Rect {
  return { x: r.x * f, y: r.y * f, w: r.w * f, h: r.h * f }
}

/** 给模型的图片：太大则缩到长边 1568，太小则放大 2 倍；大图用 JPEG 减少上传体积 */
function encodeForModel(rgba: Uint8Array, w: number, h: number) {
  let img = nativeImage.createFromBitmap(rgbaToBgra(rgba), { width: w, height: h })
  const long = Math.max(w, h)
  let factor = 1
  if (long > 1568) factor = 1568 / long
  else if (long < 400) factor = 2
  if (factor !== 1) img = img.resize({ width: Math.round(w * factor), height: Math.round(h * factor), quality: 'best' })
  const size = img.getSize()
  const big = size.width * size.height > 700_000
  const buf = big ? img.toJPEG(90) : img.toPNG()
  return {
    image: { base64: buf.toString('base64'), mediaType: (big ? 'image/jpeg' : 'image/png') as 'image/jpeg' | 'image/png', width: size.width, height: size.height },
    factor
  }
}

// ------------------------------------------------------------------ 其他操作
ipcMain.on('clipboard:text', (_e, text: string) => void clipboard.writeText(text))

ipcMain.handle('image:copy', async (e, rect: Rect) => {
  const o = overlayOf(e.sender)
  if (!o) return false
  const img = await o.win.webContents.capturePage(roundRect(rect))
  await copyPng(img.toPNG())
  return true
})

/** 选区的原始截图（物理像素，不含译文），直接从截图数据里裁 */
ipcMain.handle('image:copy-raw', async (e, rect: Rect) => {
  const o = overlayOf(e.sender)
  const cap = o && captures.get(o.displayId)
  if (!cap) return false
  const r = clampRect(rect, cap.width, cap.height)
  const img = nativeImage.createFromBitmap(rgbaToBgra(cropRgba(cap.rgba, cap.width, r)), { width: r.w, height: r.h })
  await copyPng(img.toPNG())
  return true
})

function copyPng(png: Buffer) {
  return clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
}

ipcMain.handle('image:save', async (e, rect: Rect) => {
  const o = overlayOf(e.sender)
  if (!o) return false
  const img = await o.win.webContents.capturePage(roundRect(rect))
  o.win.setAlwaysOnTop(false)
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const res = await dialog.showSaveDialog(o.win, {
    title: t('save.title'),
    defaultPath: join(app.getPath('pictures'), `LavaTranslate_${stamp}.png`),
    filters: [{ name: t('save.png'), extensions: ['png'] }]
  })
  if (!o.win.isDestroyed()) o.win.setAlwaysOnTop(true, 'screen-saver')
  if (res.canceled || !res.filePath) return false
  writeFileSync(res.filePath, img.toPNG())
  return true
})

function roundRect(r: Rect) {
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.w), height: Math.round(r.h) }
}

// ------------------------------------------------------------------ 钉图窗口
// 钉好后从选区飞到这块屏幕的左上角，一张张错开排；落位后是普通窗口：显示在最上面，
// 点了别的窗口就会被盖住（钉图上可以打开「始终在最上层」）
const PIN_INSET = 20
const PIN_STEP = 32
const PIN_FLY_MS = 460
interface PinWin {
  win: BrowserWindow
  payload: PinPayload
  displayId: number
  slot: number
  /** 排好的位置（窗口坐标）；拖走后这个位置就空出来给下一张 */
  home: { x: number; y: number }
  fly: NodeJS.Timeout | null
  top: boolean
  /** 收起前的窗口尺寸，包含阴影留白；收起后拖动不改变它。 */
  expandedSize: { width: number; height: number } | null
}
const pins = new Map<number, PinWin>()

/** 左上角往右下错开的第一个空位 */
function pinSlot(area: Electron.Rectangle, displayId: number, w: number, h: number) {
  const pos = (k: number) => ({ x: area.x + PIN_INSET + k * PIN_STEP - PIN_MARGIN, y: area.y + PIN_INSET + k * PIN_STEP - PIN_MARGIN })
  const fit = Math.max(0, Math.floor(Math.min((area.width - w - PIN_INSET * 2) / PIN_STEP, (area.height - h - PIN_INSET * 2) / PIN_STEP)))
  const taken = new Set<number>()
  for (const p of pins.values()) {
    if (p.displayId !== displayId || p.win.isDestroyed()) continue
    const [x, y] = p.win.getPosition()
    // 缩放比例不是整数的屏幕上，位置换算会差一两个像素
    if (p.fly || (Math.abs(x - p.home.x) <= 2 && Math.abs(y - p.home.y) <= 2)) taken.add(p.slot)
  }
  let k = 0
  while (k <= fit && taken.has(k)) k++
  if (k > fit) k = taken.size % (fit + 1)
  return { slot: k, ...pos(k) }
}

/** 落位：不再强制置顶，停在普通窗口的最上面 */
function settlePin(p: PinWin) {
  if (p.fly) clearInterval(p.fly)
  p.fly = null
  if (p.win.isDestroyed() || p.top) return
  p.win.setAlwaysOnTop(false)
  p.win.moveTop()
}

function flyPin(p: PinWin) {
  const b = p.win.getBounds()
  const dx = p.home.x - b.x
  const dy = p.home.y - b.y
  if (Math.hypot(dx, dy) < 4) {
    p.win.setBounds({ ...b, ...p.home })
    return settlePin(p)
  }
  const t0 = Date.now()
  // 快起慢停（ease-out quint），和界面里的动画一个手感
  const ease = (t: number) => 1 - Math.pow(1 - t, 5)
  p.fly = setInterval(() => {
    if (p.win.isDestroyed()) return settlePin(p)
    const t = Math.min(1, (Date.now() - t0) / PIN_FLY_MS)
    const e = ease(t)
    p.win.setBounds({ x: Math.round(b.x + dx * e), y: Math.round(b.y + dy * e), width: b.width, height: b.height })
    if (t >= 1) settlePin(p)
  }, 8)
}

ipcMain.on('pin:create', (e, payload: PinPayload) => {
  const o = overlayOf(e.sender)
  const display = (o && screen.getAllDisplays().find((d) => d.id === o.displayId)) ?? screen.getPrimaryDisplay()
  const ox = display.bounds.x
  const oy = display.bounds.y
  const r = payload.screenRect
  const slot = pinSlot(display.workArea, display.id, r.w, r.h)
  const win = new BrowserWindow({
    x: Math.round(ox + r.x - PIN_MARGIN),
    y: Math.round(oy + r.y - PIN_MARGIN),
    width: Math.round(r.w + PIN_MARGIN * 2),
    height: Math.round(r.h + PIN_MARGIN * 2),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    icon: appIcon,
    alwaysOnTop: true,
    hasShadow: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: { preload, sandbox: false, spellcheck: false }
  })
  win.setAlwaysOnTop(true, 'floating')
  // 窗口销毁后不能再访问 webContents，先记下 id
  const id = win.webContents.id
  const pin: PinWin = { win, payload, displayId: display.id, slot: slot.slot, home: { x: slot.x, y: slot.y }, fly: null, top: false, expandedSize: null }
  pins.set(id, pin)
  win.on('closed', () => {
    if (pin.fly) clearInterval(pin.fly)
    pins.delete(id)
    clearInterval(drags.get(id))
    drags.delete(id)
  })
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('pin:data', payload)
  })
  loadPage(win, 'pin')
  ipcMain.once(`pin:ready:${id}`, () => {
    if (win.isDestroyed()) return
    win.showInactive()
    hideOverlays(true)
    // 先在原处停一拍，再飞去左上角
    setTimeout(() => !win.isDestroyed() && !pin.expandedSize && flyPin(pin), 90)
  })
})

ipcMain.on('pin:top', (e, on: boolean) => {
  const pin = pins.get(e.sender.id)
  if (!pin || pin.win.isDestroyed()) return
  pin.top = on
  if (pin.fly) return
  if (on) pin.win.setAlwaysOnTop(true, 'floating')
  else settlePin(pin)
})

ipcMain.on('pin:ready', (e) => ipcMain.emit(`pin:ready:${e.sender.id}`))
ipcMain.on('pin:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())

// 拖动：主进程以 60fps 跟随鼠标，比 -webkit-app-region 更跟手且不吞掉鼠标事件
const drags = new Map<number, NodeJS.Timeout>()
ipcMain.on('pin:drag', (e, on: boolean) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win) return
  const id = e.sender.id
  clearInterval(drags.get(id))
  drags.delete(id)
  if (!on) return
  const pin = pins.get(id)
  if (pin?.fly) settlePin(pin)
  const start = screen.getCursorScreenPoint()
  const [wx, wy] = win.getPosition()
  drags.set(
    id,
    setInterval(() => {
      if (win.isDestroyed()) return clearInterval(drags.get(id))
      const p = screen.getCursorScreenPoint()
      win.setPosition(wx + p.x - start.x, wy + p.y - start.y)
    }, 8)
  )
})

ipcMain.on('pin:compact', (e, on: boolean) => {
  const pin = pins.get(e.sender.id)
  if (!pin || pin.win.isDestroyed() || !!pin.expandedSize === on) return
  clearInterval(drags.get(e.sender.id))
  drags.delete(e.sender.id)
  settlePin(pin)
  const bounds = pin.win.getBounds()
  if (on) {
    pin.expandedSize = { width: bounds.width, height: bounds.height }
    pin.win.setBounds({ ...bounds, width: PIN_COMPACT_SIZE + PIN_MARGIN * 2, height: PIN_COMPACT_SIZE + PIN_MARGIN * 2 })
  } else {
    const size = pin.expandedSize!
    const area = screen.getDisplayMatching(bounds).workArea
    // 小方块可以拖动；在当前位置展开，靠近屏幕边缘时移回可见区域。
    const x = Math.max(area.x, Math.min(bounds.x, area.x + area.width - size.width))
    const y = Math.max(area.y, Math.min(bounds.y, area.y + area.height - size.height))
    pin.expandedSize = null
    pin.win.setBounds({ x, y, ...size })
  }
})

ipcMain.on('pin:zoom', (e, factor: number) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  const pin = pins.get(e.sender.id)
  if (!win || !pin || pin.expandedSize || !Number.isFinite(factor)) return
  if (pin.fly) settlePin(pin)
  const r = pin.payload.screenRect
  const b = win.getBounds()
  const w = Math.round(r.w * factor + PIN_MARGIN * 2)
  const h = Math.round(r.h * factor + PIN_MARGIN * 2)
  const cursor = screen.getCursorScreenPoint()
  // 以鼠标为中心缩放
  const fx = (cursor.x - b.x) / b.width
  const fy = (cursor.y - b.y) / b.height
  win.setBounds({ x: Math.round(cursor.x - fx * w), y: Math.round(cursor.y - fy * h), width: w, height: h })
})

// ------------------------------------------------------------------ 设置窗口
function openSettings() {
  void hideOverlays(true)
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show()
    settingsWin.focus()
    return
  }
  settingsWin = new BrowserWindow({
    width: 820,
    height: 620,
    minWidth: 720,
    minHeight: 540,
    show: false,
    title: 'LavaTranslate',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#e8e8ee' : '#3a3a44', height: 48 },
    backgroundMaterial: 'mica',
    backgroundColor: '#00000000',
    icon: appIcon,
    webPreferences: { preload, sandbox: false, spellcheck: false }
  })
  settingsWin.setMenu(null)
  settingsWin.once('ready-to-show', () => settingsWin?.show())
  settingsWin.on('closed', () => {
    settingsWin = null
    if (!quitting) void registerHotkey(settings.get().hotkey)
  })
  loadPage(settingsWin, 'settings')
}

nativeTheme.on('updated', () => {
  settingsWin?.setTitleBarOverlay({ color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#e8e8ee' : '#3a3a44', height: 48 })
})

ipcMain.handle('settings:get', () => settings.public())
// 界面语言：各窗口加载时同步取一次（首帧就是对的语言），之后有变化再推送
ipcMain.on('ui:lang', (e) => (e.returnValue = uiLang()))
let sentLang = ''
function broadcastUiLang() {
  const lang = uiLang()
  if (lang === sentLang) return
  sentLang = lang
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('ui:lang', lang)
  // 更新状态里的提示语也换成新语言
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('update:state', updateState())
}
ipcMain.handle('settings:set', (_e, patch: SettingsPatch) => {
  settings.update(patch)
  return settings.public()
})
ipcMain.handle('engine:status', () => engineStatus())
/** 打开 DeepSeek 的网页（获取 Key、文档）；只允许 https */
ipcMain.on('shell:open', (_e, url: string) => {
  if (/^https:[/][/]/.test(url)) void shell.openExternal(url)
})

ipcMain.handle('app:info', () => ({ version: app.getVersion() }))
ipcMain.handle('update:state', () => updateState())
ipcMain.handle('update:check', () => checkUpdate())
ipcMain.on('update:install', () => {
  quitting = true
  installNow()
})
ipcMain.handle('ocr:info', async () => {
  await ocr.init().catch(() => {})
  return ocr.provider === 'dml' ? t('ocr.gpu') : t('ocr.cpu')
})
ipcMain.on('capture:start', () => void startCapture())
ipcMain.on('settings:open', () => {
  hideOverlays(true)
  openSettings()
})

ipcMain.handle('engine:test', async () => {
  const s = settings.get()
  const eng = engine ?? buildEngine(s)
  if (!eng) return { ok: false, message: engineStatus().detail }
  const t0 = Date.now()
  const ctl = new AbortController()
  // 一张写着 "Good morning!" 的小图走一遍完整流程（不用 Hello, world：模型常把它当成代码里的固定写法原样保留）
  const img = nativeImage.createFromPath(join(resources, 'test.png'))
  const size = img.getSize()
  try {
    let got = ''
    await eng.translate(
      {
        image: { base64: img.toPNG().toString('base64'), mediaType: 'image/png', width: size.width, height: size.height },
        lines: [{ id: 1, text: 'Good morning!', score: 1, box: { x: 8, y: 8, w: size.width - 16, h: size.height - 16 } }],
        target: LANGUAGES.find((l) => l.code === s.targetLang) ?? LANGUAGES[0],
        styleHint: ''
      },
      (ev) => {
        if (ev.type === 'block') got = ev.block.translation
      },
      ctl.signal
    )
    return { ok: true, message: t('test.result', { got, s: ((Date.now() - t0) / 1000).toFixed(1) }) }
  } catch (err) {
    return { ok: false, message: errorText(err) }
  }
})

// ------------------------------------------------------------------ 快捷键 / 托盘
let registeredHotkey = ''
const winSpace = new WinSpaceHotkey()
const hotkeyLabel = (value: string) => acceleratorLabel(value, uiLang())
async function registerHotkey(hotkey: string): Promise<boolean> {
  if (registeredHotkey) globalShortcut.unregister(registeredHotkey)
  registeredHotkey = ''
  void winSpace.setMode(0)
  if (process.platform === 'win32' && hotkey === 'Super+Space') return winSpace.setMode(1)
  try {
    if (globalShortcut.register(hotkey, onHotkey)) {
      registeredHotkey = hotkey
      return true
    }
  } catch {
    /* 非法组合 */
  }
  return false
}

ipcMain.handle('hotkey:set', async (_e, hotkey: string) => {
  const prev = settings.get().hotkey
  if (await registerHotkey(hotkey)) {
    settings.update({ hotkey })
    updateTray()
    return { ok: true }
  }
  await registerHotkey(prev)
  return { ok: false, message: t('hotkey.taken') }
})

ipcMain.handle('hotkey:suspend', (_e, on: boolean) => {
  // 录制快捷键时暂停全局热键
  if (on) {
    globalShortcut.unregisterAll()
    return winSpace.setMode(2)
  } else return registerHotkey(settings.get().hotkey)
})

function updateTray() {
  if (!tray) return
  tray.setToolTip(`LavaTranslate · ${hotkeyLabel(settings.get().hotkey)}`)
  tray.setContextMenu(Menu.buildFromTemplate(trayMenu()))
}

function trayMenu(): Electron.MenuItemConstructorOptions[] {
  const s = settings.get()
  const u = updateState()
  const upd: Electron.MenuItemConstructorOptions =
    u.state === 'ready'
      ? { label: t('tray.updateReady', { v: u.next }), click: () => { quitting = true; installNow() } }
      : u.state === 'downloading' || u.state === 'available'
        ? { label: t('tray.updateDownloading', { v: u.next, p: u.percent }), enabled: false }
        : {
            label: u.state === 'checking' ? t('tray.updateChecking') : t('tray.updateCheck', { v: u.version }),
            enabled: u.state !== 'checking' && u.state !== 'disabled',
            click: () => void checkUpdate()
          }
  // 子菜单标题带上英文：误选了看不懂的语言也找得回来
  const langLabel = uiLang() === 'en' ? t('tray.language') : `${t('tray.language')} · Language`
  const pick = (code: string) => () => void settings.update({ uiLang: code })
  return [
    // 快捷键用 accelerator 显示（右对齐）；不在这里注册，全局热键另有 globalShortcut。
    // 这一层不放勾选项：有勾选项时 Windows 会在左侧预留一整列空白（语言的单选在子菜单里，不影响这一层）
    { label: t('tray.capture'), accelerator: s.hotkey, registerAccelerator: false, click: () => void startCapture() },
    { label: t('tray.quick'), click: () => startQuick() },
    { type: 'separator' },
    { label: t('tray.settings'), click: openSettings },
    {
      label: langLabel,
      submenu: [
        { label: t('tray.langSystem'), type: 'radio', checked: !UI_LANGS.some((l) => l.code === s.uiLang), click: pick('auto') },
        { type: 'separator' },
        ...UI_LANGS.map((l): Electron.MenuItemConstructorOptions => ({ label: l.native, type: 'radio', checked: s.uiLang === l.code, click: pick(l.code) }))
      ]
    },
    upd,
    { type: 'separator' },
    { label: t('tray.quit'), click: () => app.quit() }
  ]
}

function notify(title: string, body: string) {
  // 未打包时 Electron 发通知会在开始菜单自动建一个指向 electron.exe 的 Electron.lnk，测试时不发
  if (!app.isPackaged) return console.log('[notify]', title, body)
  if (Notification.isSupported()) new Notification({ title, body, icon: join(resources, 'icon.png') }).show()
}

// ------------------------------------------------------------------ 启动
/** 系统显示语言里第一个能当目标语言的 */
function systemTarget() {
  for (const l of app.getPreferredSystemLanguages()) {
    const hit = LANGUAGES.find((x) => langBase(x.code) === langBase(l))
    if (hit) return hit.code
  }
  return settings.get().targetLang
}

app.on('second-instance', () => openSettings())

/**
 * 旧名称「Lens 截图翻译」的配置搬到新目录。
 * Key 不搬：safeStorage 的密钥存在各自数据目录的 Local State 里，换了目录就解不开，需要重新填写。
 * 旧版字段由 settings.load() 统一转换，只保留 DeepSeek。
 */
function migrateLegacy() {
  if (AUTOTEST || process.env.LENS_ENGINE_TEST) return
  const dir = app.getPath('userData')
  const legacy = join(app.getPath('appData'), 'Lens 截图翻译', 'settings.json')
  if (existsSync(join(dir, 'settings.json')) || !existsSync(legacy)) return
  try {
    const old = JSON.parse(readFileSync(legacy, 'utf8')) as Record<string, unknown>
    for (const k of ['apiKey', 'openaiKey']) if (String(old[k] ?? '').startsWith('enc:')) old[k] = ''
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(old, null, 2))
  } catch (e) {
    logError('migrate', e)
  }
}

export const startup = app.whenReady().then(async () => {
  migrateLegacy()
  const s = settings.load()
  sentLang = uiLang()
  buildEngine(s)
  // OCR loads on the first capture/settings request, not during Windows sign-in.
  syncOverlays()
  screen.on('display-added', syncOverlays)
  screen.on('display-removed', syncOverlays)
  screen.on('display-metrics-changed', syncOverlays)

  const trayImage = nativeImage.createFromPath(join(resources, 'tray.png'))
  tray = new Tray(trayImage)
  // 单击截图、双击打开设置：单击要等过双击间隔才动作，否则双击会先触发一次截图
  let clickTimer: NodeJS.Timeout | null = null
  let lastDouble = 0
  tray.on('click', () => {
    if (Date.now() - lastDouble < 600) return
    if (clickTimer) clearTimeout(clickTimer)
    clickTimer = setTimeout(() => {
      clickTimer = null
      void startCapture()
    }, 280)
  })
  tray.on('double-click', () => {
    lastDouble = Date.now()
    if (clickTimer) clearTimeout(clickTimer)
    clickTimer = null
    void hideOverlays(true)
    openSettings()
  })
  updateTray()

  initUpdater({
    enabled: () => settings.get().autoUpdate,
    onChange: (st) => {
      if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('update:state', st)
      updateTray()
      if (st.state === 'ready') {
        notify(t('notify.updateReadyTitle'), t('notify.updateReadyBody', { v: st.next }))
      }
    }
  })

  await winSpace.start((recording) => {
    diag('winSpace press', { recording })
    if (recording) settingsWin?.webContents.send('hotkey:recorded', 'Super+Space')
    else onHotkey()
  }, requestScrollAtCursor, () => {
    // 看门狗只负责把键盘输入还给系统，不能关掉截图界面：
    // 首次加载 OCR 模型、整屏截图都可能让主线程短暂停顿，关掉会让用户以为框选没反应。
    diag('winSpace expired')
  })
  const ok = await registerHotkey(s.hotkey)
  if (process.platform === 'win32') {
    const releaseInput = () => { void hideOverlays(true); void winSpace.setMode(0) }
    powerMonitor.on('lock-screen', releaseInput)
    powerMonitor.on('suspend', releaseInput)
    powerMonitor.on('unlock-screen', () => { void registerHotkey(settings.get().hotkey) })
    powerMonitor.on('resume', () => { void registerHotkey(settings.get().hotkey) })
  }
  settings.onChange((next, prev) => {
    if (JSON.stringify(next.providers.deepseek) !== JSON.stringify(prev.providers.deepseek)) buildEngine(next)
    if (next.launchAtLogin !== prev.launchAtLogin) app.setLoginItemSettings({ openAtLogin: next.launchAtLogin })
    if (next.autoUpdate !== prev.autoUpdate) setAutoUpdate(next.autoUpdate)
    if (next.uiLang !== prev.uiLang) broadcastUiLang()
    updateTray()
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('settings:changed', settings.public())
    if (next.autoTranslate !== prev.autoTranslate) {
      for (const o of overlays.values()) if (!o.win.isDestroyed()) o.win.webContents.send('settings:changed', settings.public())
    }
  })

  if (process.env.LENS_SHOWTEST) {
    for (const [at, fn] of [
      [2500, () => void startCapture()],
      [4000, () => void hideOverlays()],
      [5000, () => void startCapture()],
      [6500, () => void hideOverlays()],
      [7500, () => void startCapture()],
      [9000, () => void hideOverlays().then(() => app.quit())]
    ] as [number, () => void][])
      setTimeout(fn, at)
    return
  }

  if (process.env.LENS_PASSTEST) {
    setTimeout(() => void runPassTest({ hide: () => hideOverlays(), overlays: () => [...overlays.values()].map((o) => o.win), modelCalls: () => (mockEngine as MockEngine).translateCalls }), 1500)
    return
  }

  // LENS_ENGINE_TEST：用真实 DeepSeek Key 跑一遍 OCR + 模型
  if (process.env.LENS_ENGINE_TEST) {
    const img = nativeImage.createFromPath(join(process.env.LENS_AUTOTEST_ROOT || app.getAppPath(), '.scratch', process.env.LENS_ENGINE_IMAGE ?? 'test1.png'))
    const size = img.getSize()
    const bgra = img.toBitmap()
    const rgba = new Uint8Array(bgra.length)
    for (let i = 0; i < bgra.length; i += 4) {
      rgba[i] = bgra[i + 2]
      rgba[i + 1] = bgra[i + 1]
      rgba[i + 2] = bgra[i]
      rgba[i + 3] = 255
    }
    const lines = await ocr.recognize({ data: rgba, width: size.width, height: size.height })
    const enc = encodeForModel(rgba, size.width, size.height)
    const key = process.env.LENS_PROVIDER_KEY ?? ''
    const model = process.env.LENS_OPENAI_MODEL ?? s.providers.deepseek?.model ?? 'deepseek-flash'
    const eng = engineFor({ ...s, providers: { deepseek: { key, model } } })
    if (!eng) {
      console.log('[engine] no api credentials')
      return app.quit()
    }
    void runEngineTest(eng, lines, enc.image)
    return
  }

  if (process.env.LENS_REVIEW) {
    await ocr.init()
    const display = screen.getPrimaryDisplay()
    setTimeout(() => {
      void runReview({
        display,
        mock: null,
        engine: fixtureEngine!,
        scenarios: process.env.LENS_REVIEW === '1' ? [] : process.env.LENS_REVIEW!.split(','),
        setTarget: (code) => settings.update({ targetLang: code }),
        setSettings: (p) => {
          settings.update(p)
        },
        openSettings: () => {
          openSettings()
          return settingsWin!
        },
        overlayWin: () => overlays.get(display.id)!.win,
        inject: async (cap, refresh) => {
          syncOverlays()
          presentCaptures([cap], refresh)
        },
        waitDone: () => new Promise((resolve) => pipeline.once('end', () => resolve()))
      })
    }, 1500)
    return
  }

  if (AUTOTEST) {
    await ocr.init()
    const display = screen.getPrimaryDisplay()
    if (process.env.LENS_I18N) {
      const langs = process.env.LENS_I18N === 'all' ? UI_LANGS.map((l) => l.code) : process.env.LENS_I18N.split(',')
      setTimeout(
        () =>
          void runI18nShots(
            {
              display,
              openSettings: () => {
                openSettings()
                return settingsWin!
              },
              mock: mockEngine instanceof MockEngine ? mockEngine : null,
              setSettings: (p) => {
                settings.update(p)
              },
              overlayWin: () => overlays.get(display.id)!.win,
              inject: async (cap, refresh) => {
                syncOverlays()
                presentCaptures([cap], refresh)
              },
              waitDone: () => new Promise((resolve) => pipeline.once('end', () => resolve())),
              trayMenu
            },
            langs
          ),
        1500
      )
      return
    }
    setTimeout(() => {
      void runAutotest({
        display,
        openSettings: () => {
          openSettings()
          return settingsWin!
        },
        mock: mockEngine instanceof MockEngine ? mockEngine : null,
        setSettings: (p) => {
          settings.update(p)
        },
        quick: () => startQuick(),
        overlayWin: () => overlays.get(display.id)!.win,
        inject: async (cap, refresh) => {
          syncOverlays()
          presentCaptures([cap], refresh)
        },
        waitDone: () =>
          new Promise((resolve) =>
            pipeline.once('end', (r) => {
              console.log('[autotest] pipeline', JSON.stringify(r))
              resolve()
            })
          )
      })
    }, 1500)
    return
  }

  if (!s.firstRunDone) {
    // 第一次运行：默认译成系统语言
    settings.update({ firstRunDone: true, targetLang: systemTarget() })
    openSettings()
  } else if (!ok) {
    notify(t('notify.hotkeyFailedTitle'), t('notify.hotkeyFailedBody', { key: hotkeyLabel(s.hotkey) }))
    openSettings()
  } else {
    notify(t('notify.runningTitle'), t('notify.runningBody', { key: hotkeyLabel(s.hotkey) }))
  }
})

app.on('window-all-closed', () => {
  /* 常驻托盘 */
})

app.on('before-quit', () => {
  quitting = true
  engine?.dispose()
  globalShortcut.unregisterAll()
  winSpace.stop()
})

