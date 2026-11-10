// 开发自测：LENS_AUTOTEST=1 时用测试图伪造截屏，离屏渲染遮罩并模拟鼠标操作，逐步截图到 .scratch/shots
// LENS_MOCK=1 时使用模拟翻译引擎（不消耗额度）
import { app, BrowserWindow, clipboard, globalShortcut, nativeImage, nativeTheme, screen } from 'electron'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { load } from 'koffi'
import { forceForeground } from './winapi'
import { Window as ScreenshotWindow } from 'node-screenshots'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type OcrLine, type SettingsPatch, type TranslatedBlock } from '../shared/types'
import type { DisplayCapture } from './capture'
import { settings } from './settings'
import { langFor } from '../core/lang'
import { type Emit, type Engine, type ReplyRequest, type TranslateRequest, type TranslateResult } from '../core/translator'

/** 自测用的回复：逐字流式输出，模拟模型的节奏 */
async function mockReply(req: ReplyRequest, onText: (d: string) => void, signal: AbortSignal) {
  const samples: Record<string, [string, string]> = {
    en: ['Thanks! Tomorrow works for me — see you at 3 😊', '谢谢！明天可以——下午三点见 😊'],
    ja: ['ありがとう！明日なら大丈夫です。3時に会いましょう 😊', '谢谢！明天的话没问题。三点见吧 😊']
  }
  console.log('[mock] reply', JSON.stringify({ to: req.to.code, from: req.from.code, both: !!req.both, quick: !!req.quick }))
  const [t, back] = samples[req.to.code] ?? [`(${req.to.native}) ${req.text}`, req.text]
  const out = `${t}
⟲
${back}`
  await sleep(350)
  for (const ch of out) {
    if (signal.aborted) throw new Error('aborted')
    onText(ch)
    await sleep(14)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 把测试图贴到一张"桌面"上，当作整屏截图 */
export function fakeCapture(display: Electron.Display, imagePath: string, at: { x: number; y: number }): DisplayCapture {
  const W = Math.round(display.bounds.width * display.scaleFactor)
  const H = Math.round(display.bounds.height * display.scaleFactor)
  const rgba = Buffer.alloc(W * H * 4)
  for (let i = 0; i < rgba.length; i += 4) {
    const y = Math.floor(i / 4 / W)
    rgba[i] = 38 + (y * 20) / H
    rgba[i + 1] = 40 + (y * 16) / H
    rgba[i + 2] = 52 + (y * 30) / H
    rgba[i + 3] = 255
  }
  const img = nativeImage.createFromPath(imagePath)
  const { width: iw, height: ih } = img.getSize()
  const bgra = img.toBitmap()
  for (let y = 0; y < ih; y++) {
    for (let x = 0; x < iw; x++) {
      const s = (y * iw + x) * 4
      const d = ((at.y + y) * W + at.x + x) * 4
      rgba[d] = bgra[s + 2]
      rgba[d + 1] = bgra[s + 1]
      rgba[d + 2] = bgra[s]
      rgba[d + 3] = 255
    }
  }
  return { display, width: W, height: H, scale: display.scaleFactor, rgba }
}

const MOCK: Record<string, { ids: string[]; dst: string; role?: string; keep?: boolean }[]> = {
  test1: [
    { ids: ['GitHub'], dst: 'GitHub  拉取请求  议题  市场  探索', role: 'ui' },
    { ids: ['Getting'], dst: '设置面板入门', role: 'title' },
    { ids: ['Configure', 'these', 'organization'], dst: '配置新成员加入时工作区的行为方式。你可以随时更改这些偏好设置，下次同步完成后，更改将应用到组织中的所有人。', role: 'paragraph' },
    { ids: ['Save'], dst: '保存更改', role: 'ui' },
    { ids: ['Cancel'], dst: '取消', role: 'ui' },
    { ids: ['設定'], dst: '设置将在下次同步后应用到整个组织。', role: 'paragraph' },
    { ids: ['Last'], dst: '最近由 @octocat 于 3 分钟前更新 · 12 条评论', role: 'caption' },
    { ids: ['npm'], dst: 'npm install --save-dev @types/node  # 安装类型定义', role: 'code' },
    { ids: ['Warning'], dst: '警告：此操作无法撤销。', role: 'paragraph' },
    { ids: ['Learn'], dst: '了解有关权限的更多信息', role: 'ui' }
  ],
  test2: [
    { ids: ['Episode'], dst: '第 12 集 —— 最后的信号', role: 'title' },
    { ids: ['When', 'to trust'], dst: '殖民地与地球失去联系后，玛拉必须决定是否相信那段来自星环之外的神秘信号。', role: 'paragraph' },
    { ids: ['Play', '□'], dst: '▶  播放', role: 'ui' },
    { ids: ['More'], dst: '更多信息', role: 'ui' },
    { ids: ['Season'], dst: '第 2 季 · 45 分钟 · 科幻剧情', role: 'caption' }
  ],
  chat: [
    { ids: ['Emma'], dst: 'Emma Clarke', role: 'ui', keep: true },
    { ids: ['online'], dst: '在线', role: 'caption' },
    { ids: ['Hey', 'workshop'], dst: '嘿！你明天还来参加研讨会吗？', role: 'paragraph' },
    { ids: ['可能'], dst: '可能会晚一点到', role: 'paragraph', keep: true },
    { ids: ['No worries', 'interesting'], dst: '没关系。我们 10 点开始，不过精彩的部分在午饭后。', role: 'paragraph' },
    { ids: ['Could', 'week'], dst: '你能把上周的幻灯片带来吗？我的文件坏了 :(', role: 'paragraph' },
    { ids: ['Write'], dst: '输入消息…', role: 'ui' }
  ]
}

export class MockEngine implements Engine {
  translateCalls = 0
  readonly name = '模拟'
  scenario = 'test1'
  warm() {}
  dispose() {}
  reply = mockReply
  async translate(req: TranslateRequest, emit: Emit, signal: AbortSignal): Promise<TranslateResult> {
    this.translateCalls++
    await sleep(700)
    emit({ type: 'lang', code: 'en', name: '英语', chat: this.scenario === 'chat' })
    const used = new Set<number>()
    let n = 0
    for (const m of MOCK[this.scenario] ?? []) {
      if (signal.aborted) throw new Error('aborted')
      const ids: number[] = []
      for (const prefix of m.ids) {
        const l = req.lines.find((x: OcrLine) => !used.has(x.id) && x.text.includes(prefix))
        if (l) {
          ids.push(l.id)
          used.add(l.id)
        }
      }
      if (!ids.length) continue
      await sleep(140)
      const block: TranslatedBlock = { key: `b${++n}`, lineIds: ids, source: m.ids.join(' '), translation: m.dst, role: m.role as TranslatedBlock['role'], keep: m.keep }
      emit({ type: 'block', block })
    }
    // 没匹配上的行（如韩文）原样保留
    return { firstTokenMs: 700, usage: { input: 0, output: 0 } }
  }
}

interface Hooks {
  openSettings: () => BrowserWindow
  overlayWin: () => BrowserWindow
  /** refresh：模拟按住空格操作完软件、松开后重新截的图 */
  inject: (cap: DisplayCapture, refresh?: boolean) => Promise<void>
  waitDone: () => Promise<void>
  display: Electron.Display
  mock: MockEngine | null
  setSettings: (p: SettingsPatch) => void
  /** 连按两次快捷键：进入输入翻译 */
  quick?: () => void
  /** 托盘菜单的内容 */
  trayMenu?: () => Electron.MenuItemConstructorOptions[]
}

export async function runAutotest(h: Hooks) {
  // 截图里需要可读的浅色背景（capturePage 不包含 Mica）
  nativeTheme.themeSource = 'light'
  const root = process.env.LENS_AUTOTEST_ROOT || app.getAppPath()
  const dir = join(root, '.scratch', 'shots')
  mkdirSync(dir, { recursive: true })
  const shot = async (name: string) => {
    const img = await h.overlayWin().webContents.capturePage()
    writeFileSync(join(dir, `${name}.png`), img.toPNG())
    console.log('[autotest] shot', name)
  }
  const wc = () => h.overlayWin().webContents
  const mouse = (type: 'mouseMove' | 'mouseDown' | 'mouseUp', x: number, y: number) =>
    wc().sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
  const key = (keyCode: string, mods: ('control' | 'shift')[] = []) => {
    wc().sendInputEvent({ type: 'keyDown', keyCode, modifiers: mods })
    wc().sendInputEvent({ type: 'keyUp', keyCode, modifiers: mods })
  }
  const drag = async (x0: number, y0: number, x1: number, y1: number) => {
    mouse('mouseMove', x0, y0)
    mouse('mouseDown', x0, y0)
    for (let i = 1; i <= 12; i++) {
      mouse('mouseMove', x0 + ((x1 - x0) * i) / 12, y0 + ((y1 - y0) * i) / 12)
      await sleep(16)
    }
    mouse('mouseUp', x1, y1)
  }

  const scenarios = [
    { name: 'test1', file: join(root, '.scratch', 'test1.png'), at: { x: 420, y: 220 }, size: { w: 900, h: 560 } },
    { name: 'test2', file: join(root, '.scratch', 'test2.png'), at: { x: 600, y: 300 }, size: { w: 720, h: 300 } }
  ]
  const s = h.display.scaleFactor

  // LENS_AUTOTEST=keys：只测「按住 Alt 看原文 / 暂停翻译」和「双击、Alt+双击复制图片」
  if (process.env.LENS_AUTOTEST === 'keys') {
    const sc = scenarios[0]
    const js = <T>(code: string) => wc().executeJavaScript(code) as Promise<T>
    const blocks = () => js<number>(`document.querySelectorAll('[data-block]').length`)
    const alt = (type: 'keyDown' | 'keyUp') => wc().sendInputEvent({ type, keyCode: 'Alt', modifiers: type === 'keyDown' ? ['alt'] : [] })
    const select = async () => {
      if (h.mock) h.mock.scenario = sc.name
      await h.inject(fakeCapture(h.display, sc.file, sc.at))
      await sleep(600)
      await drag(sc.at.x / s - 6, sc.at.y / s - 6, (sc.at.x + sc.size.w) / s + 6, (sc.at.y + sc.size.h) / s + 6)
    }
    const dblclick = async (mods: 'alt'[] = []) => {
      const x = Math.round((sc.at.x + sc.size.w / 2) / s)
      const y = Math.round((sc.at.y + sc.size.h / 2) / s)
      for (const clickCount of [1, 2]) {
        wc().sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount, modifiers: mods })
        wc().sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount, modifiers: mods })
        await sleep(40)
      }
    }
    const clip = async (name: string) => {
      const item = (await clipboard.read()).find((x) => x.types.includes('image/png'))
      if (!item) return console.log('[keys]', name, 'clipboard has no image')
      const png = Buffer.from(await ((await item.getType('image/png')) as Blob).arrayBuffer())
      writeFileSync(join(dir, `${name}.png`), png)
      console.log('[keys]', name, 'clipboard image', JSON.stringify(nativeImage.createFromBuffer(png).getSize()))
    }

    // 1. 翻译中按住 Alt：显示原文、暂停；结果攒着，松开后才出来
    await select()
    const done = h.waitDone()
    await sleep(250)
    alt('keyDown')
    await sleep(300)
    console.log('[keys] paused: chip', JSON.stringify(await js(`document.querySelector('.alt-chip')?.textContent`)), 'blocks', await blocks())
    await shot('keys-1-paused')
    await done
    await sleep(400)
    console.log('[keys] translation finished while held: blocks', await blocks(), 'phase-icon', await js(`!!document.querySelector('.tb-paused')`))
    await shot('keys-1b-paused-done')
    alt('keyUp')
    await sleep(700)
    console.log('[keys] released: blocks', await blocks(), 'chip', await js(`!!document.querySelector('.alt-chip')`))
    await shot('keys-2-released')

    // 2. 翻译完成后按住 Alt 看原文；连拍几帧看切换动画（按下约 150ms 后才开始切换）
    const frames = async (tag: string) => {
      const t0 = Date.now()
      for (let i = 0; i < 8; i++) {
        const img = await h.overlayWin().webContents.capturePage()
        writeFileSync(join(dir, `keys-anim-${tag}-${i}-${Date.now() - t0}ms.png`), img.toPNG())
        await sleep(30)
      }
    }
    alt('keyDown')
    await sleep(150)
    await frames('down')
    await sleep(200)
    await shot('keys-3-alt-original')
    alt('keyUp')
    await frames('up')
    await sleep(400)

    // 3. 双击选区：复制当前看到的（译文）图片并退出
    clipboard.clear()
    await dblclick()
    await sleep(800)
    await clip('keys-4-dbl')
    console.log('[keys] overlay visible after dblclick', h.overlayWin().isVisible())

    // 4. 按着 Alt 双击：复制原图
    await select()
    await h.waitDone()
    await sleep(700)
    clipboard.clear()
    alt('keyDown')
    await sleep(300)
    await dblclick(['alt'])
    await sleep(800)
    alt('keyUp')
    await clip('keys-5-altdbl')

    // 5. 还没翻译完就双击：复制原图（没有译文）
    await select()
    await sleep(200)
    clipboard.clear()
    await dblclick()
    await sleep(800)
    await clip('keys-6-dbl-early')
    console.log('[keys] done')
    app.quit()
    return
  }
  for (const sc of scenarios) {
    if (h.mock) h.mock.scenario = sc.name
    await h.inject(fakeCapture(h.display, sc.file, sc.at))
    await sleep(700)
    mouse('mouseMove', (sc.at.x + 100) / s, (sc.at.y + 100) / s)
    await sleep(400)
    await shot(`${sc.name}-1-idle`)
    const x0 = sc.at.x / s - 6
    const y0 = sc.at.y / s - 6
    const x1 = (sc.at.x + sc.size.w) / s + 6
    const y1 = (sc.at.y + sc.size.h) / s + 6
    await drag(x0, y0, x1, y1)
    await sleep(450)
    await shot(`${sc.name}-2-working`)
    await h.waitDone()
    await sleep(900)
    await shot(`${sc.name}-3-done`)
    // 悬停一个译文块看原文提示
    mouse('mouseMove', x0 + 120, y0 + (sc.name === 'test1' ? 150 : 90))
    await sleep(900)
    await shot(`${sc.name}-4-hover`)
    mouse('mouseMove', x1 - 40, y1 + 140)
    // 并排模式
    key('Tab')
    await sleep(900)
    await shot(`${sc.name}-5-side`)
    key('Tab')
    await sleep(500)
  }
  // 按住空格操作完回来：选区里画面没变 → 译文原样保留；变了 → 同一块重新翻译
  {
    const sc = scenarios[0]
    if (h.mock) h.mock.scenario = sc.name
    await h.inject(fakeCapture(h.display, sc.file, sc.at))
    await sleep(600)
    await drag(sc.at.x / s - 6, sc.at.y / s - 6, (sc.at.x + sc.size.w) / s + 6, (sc.at.y + sc.size.h) / s + 6)
    await h.waitDone()
    await sleep(700)
    const blocks = () => wc().executeJavaScript(`document.querySelectorAll('[data-block]').length`) as Promise<number>
    console.log('[autotest] alt before', await blocks())
    const again = h.waitDone().then(() => true)
    await h.inject(fakeCapture(h.display, sc.file, sc.at), true)
    console.log('[autotest] alt same: retranslated', await Promise.race([again, sleep(1800).then(() => false)]), 'blocks', await blocks())
    await shot('alt-1-same')
    if (h.mock) h.mock.scenario = 'test2'
    await h.inject(fakeCapture(h.display, scenarios[1].file, sc.at), true)
    await again
    await sleep(900)
    console.log('[autotest] alt changed: blocks', await blocks())
    await shot('alt-2-changed')
  }

  // 钉图：重新框选 test1，完成后按 F3
  if (h.mock) h.mock.scenario = 'test1'
  await h.inject(fakeCapture(h.display, scenarios[0].file, scenarios[0].at))
  await sleep(600)
  await drag(scenarios[0].at.x / s - 6, scenarios[0].at.y / s - 6, (scenarios[0].at.x + 900) / s + 6, (scenarios[0].at.y + 560) / s + 6)
  await h.waitDone()
  await sleep(700)
  const f3 = Date.now()
  key('F3')
  const pinWins = () => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes('pin.html'))
  // 等钉图显示、飞到左上角落位（落位后不再强制置顶）
  const settled = async (w: BrowserWindow) => {
    for (let i = 0; i < 100 && (!w.isVisible() || w.isAlwaysOnTop()); i++) await sleep(50)
  }
  for (let i = 0; i < 60 && !pinWins().length; i++) await sleep(50)
  const pinWin = pinWins()[0]
  if (pinWin) {
    for (let i = 0; i < 100 && !pinWin.isVisible(); i++) await sleep(20)
    console.log('[autotest] pin shown after', Date.now() - f3, 'ms at', JSON.stringify(pinWin.getBounds()))
    await settled(pinWin)
    console.log('[autotest] pin settled after', Date.now() - f3, 'ms')
    await sleep(1000)
    const img = await pinWin.webContents.capturePage()
    writeFileSync(join(dir, 'pin.png'), img.toPNG())
    console.log('[autotest] shot pin', JSON.stringify(pinWin.getBounds()), 'visible', pinWin.isVisible(), 'onTop', pinWin.isAlwaysOnTop(), 'workArea', JSON.stringify(h.display.workArea))
    // 按着 Alt 钉原图
    await h.inject(fakeCapture(h.display, scenarios[0].file, scenarios[0].at))
    await sleep(600)
    await drag(scenarios[0].at.x / s - 6, scenarios[0].at.y / s - 6, (scenarios[0].at.x + 900) / s + 6, (scenarios[0].at.y + 560) / s + 6)
    await h.waitDone()
    await sleep(700)
    // 合成的 Alt+F3 会变成系统键，不进网页；直接派发键盘事件
    await wc().executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F3', altKey: true }))`)
    for (let i = 0; i < 60 && pinWins().length < 2; i++) await sleep(50)
    const second = pinWins().find((w) => w !== pinWin)
    if (second) {
      await settled(second)
      await sleep(1000)
      const img2 = await second.webContents.capturePage()
      writeFileSync(join(dir, 'pin-original.png'), img2.toPNG())
      const info = await second.webContents.executeJavaScript(
        `({ layer: !!document.querySelector('[data-block]'), tools: document.querySelectorAll('.pin-tools button').length })`
      )
      console.log('[autotest] pin2', JSON.stringify(second.getBounds()), 'onTop', second.isAlwaysOnTop(), JSON.stringify(info))
      second.close()
    } else console.log('[autotest] pin2 missing')
    pinWin.close()
    console.log('[autotest] pin closed')
  } else console.log('[autotest] pin window missing')

  // 回复助手：英文聊天截图 → 自动弹出回复框 → 输入中文 → 实时译成英语
  {
    const at = { x: 380, y: 160 }
    h.setSettings({ targetLang: 'en' })
    await sleep(200)
    if (h.mock) h.mock.scenario = 'chat'
    await h.inject(fakeCapture(h.display, join(root, '.scratch', 'chat.png'), at))
    await sleep(600)
    await drag(at.x / s - 4, at.y / s - 4, (at.x + 560) / s + 4, (at.y + 640) / s + 4)
    await h.waitDone()
    await sleep(900)
    // 截图本身就是目标语言时不会自动弹出回复框，按 R 打开
    if (!(await wc().executeJavaScript(`!!document.querySelector('.reply')`))) {
      key('R')
      await sleep(700)
    }
    await shot('reply-1-open')
    wc().insertText('好的，我明天带上。下午三点见')
    await sleep(300)
    await shot('reply-2-typing')
    await sleep(1600)
    await shot('reply-3-result')
    const route = () => wc().executeJavaScript(`document.querySelector('.rp-route')?.innerText.replace(/\\s+/g, ' ')`)
    console.log('[autotest] reply route (screenshot target en):', await route())
    // 语言菜单
    await wc().executeJavaScript(`document.querySelector('.rp-to')?.click()`)
    await sleep(500)
    await shot('reply-4-langs')
    console.log(
      '[autotest] reply menu:',
      await wc().executeJavaScript(`[document.querySelector('.rp-auto')?.innerText.replace(/\\s+/g, ' '), document.querySelectorAll('.rp-lang').length].join(' | ')`)
    )
    // 手动选日语，再切回自动
    await wc().executeJavaScript(`[...document.querySelectorAll('.rp-lang')].find((b) => b.textContent.includes('日'))?.click()`)
    await sleep(900)
    console.log('[autotest] reply route after pick:', await route())
    await wc().executeJavaScript(`document.querySelector('.rp-to')?.click()`)
    await sleep(400)
    await wc().executeJavaScript(`document.querySelector('.rp-auto')?.click()`)
    await sleep(900)
    console.log('[autotest] reply route back to auto:', await route())
    h.setSettings({ targetLang: 'zh-Hans' })
    // 选区贴着屏幕底部、整屏高：回复框应放到侧边
    await h.inject(fakeCapture(h.display, join(root, '.scratch', 'chat.png'), { x: 300, y: Math.round(h.display.bounds.height * s) - 640 }))
    await sleep(600)
    await drag(300 / s - 4, 20 / s, (300 + 560) / s + 4, h.display.bounds.height - 2)
    await h.waitDone()
    await sleep(900)
    await shot('reply-5-tall')
  }

  // 输入翻译：连按两次快捷键，不框选，直接输入（停顿约 1.4 秒后才翻译）
  if (h.quick) {
    await h.inject(fakeCapture(h.display, join(root, '.scratch', 'chat.png'), { x: 380, y: 160 }))
    await sleep(500)
    h.quick()
    await sleep(700)
    await shot('quick-1-open')
    wc().insertText('谢谢！明天可以，下午三点见')
    await sleep(600)
    await shot('quick-2-typing')
    await sleep(3600)
    await shot('quick-3-result')
    const route = () => wc().executeJavaScript(`document.querySelector('.rp-route')?.innerText.replace(/\\s+/g, ' ')`)
    console.log('[autotest] quick route (auto):', await route())
    await wc().executeJavaScript(`document.querySelector('.rp-to')?.click()`)
    await sleep(500)
    await shot('quick-4-langs')
    await wc().executeJavaScript(`[...document.querySelectorAll('.rp-lang')].find((b) => b.textContent.includes('英'))?.click()`)
    await sleep(3200)
    await shot('quick-5-manual')
    console.log('[autotest] quick route (picked):', await route())
    // 关掉再连按两次：手动选的语言还在
    key('Escape')
    await sleep(400)
    key('Escape')
    await sleep(600)
    await h.inject(fakeCapture(h.display, join(root, '.scratch', 'chat.png'), { x: 380, y: 160 }))
    await sleep(500)
    h.quick()
    await sleep(700)
    console.log('[autotest] quick route (reopened):', await route())
    await wc().executeJavaScript(`document.querySelector('.rp-to')?.click()`)
    await sleep(400)
    await wc().executeJavaScript(`document.querySelector('.rp-auto')?.click()`)
    await sleep(400)
    console.log('[autotest] quick route (auto again):', await route())
  }

  // 设置窗口各页
  console.log('[autotest] open settings')
  const sw = h.openSettings()
  sw.setBackgroundColor('#f3f3f6')
  console.log('[autotest] settings loading', sw.webContents.isLoading())
  if (sw.webContents.isLoading())
    await Promise.race([new Promise<void>((r) => sw.webContents.once('did-finish-load', () => r())), sleep(6000).then(() => console.log('[autotest] load timeout', sw.webContents.getURL(), sw.isVisible()))])
  await sleep(1200)
  const pages = ['translate', 'general', 'about']
  const sshot = async (name: string) => {
    const img = await sw.webContents.capturePage()
    writeFileSync(join(dir, `${name}.png`), img.toPNG())
    console.log('[autotest] shot', name)
  }
  for (let i = 0; i < pages.length; i++) {
    await sw.webContents.executeJavaScript(`document.querySelector('.nav-item[data-page=${pages[i]}]')?.click()`)
    await sleep(700)
    await sshot(`settings-${i + 1}`)
  }
  console.log('[autotest] done')
  app.quit()
}

/**
 * LENS_I18N=all|<语言,…>（配合 LENS_AUTOTEST=1 LENS_MOCK=1）：逐个界面语言截设置页各页、截图界面（提示条、工具条、回复框），
 * 存到 .scratch/i18n/<语言>-<名称>.png，检查翻译后的文字有没有挤爆、截断
 */
export async function runI18nShots(h: Hooks, langs: string[]) {
  // capturePage 拿不到 Mica 背景，透明窗口会拍成白底；强制浅色让截图里的文字可读
  nativeTheme.themeSource = 'light'
  const root = process.env.LENS_AUTOTEST_ROOT || app.getAppPath()
  const dir = join(root, '.scratch', 'i18n')
  mkdirSync(dir, { recursive: true })
  const s = h.display.scaleFactor
  const wc = () => h.overlayWin().webContents
  const mouse = (type: 'mouseMove' | 'mouseDown' | 'mouseUp', x: number, y: number) =>
    wc().sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
  const save = async (win: BrowserWindow, name: string) => {
    writeFileSync(join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG())
    console.log('[i18n] shot', name)
  }
  const sw = h.openSettings()
  sw.setBackgroundColor('#f3f3f6')
  if (sw.webContents.isLoading()) await new Promise<void>((r) => sw.webContents.once('did-finish-load', () => r()))
  await sleep(1200)
  for (const lang of langs) {
    h.setSettings({ uiLang: lang })
    await sleep(500)
    const labels = (items: Electron.MenuItemConstructorOptions[]): unknown[] =>
      items.filter((m) => m.type !== 'separator').map((m) => (m.submenu ? { [m.label!]: labels(m.submenu as Electron.MenuItemConstructorOptions[]) } : m.checked ? `(*) ${m.label}` : m.label))
    if (h.trayMenu) console.log('[i18n] tray', lang, JSON.stringify(labels(h.trayMenu())))
    for (const page of ['translate', 'general', 'about']) {
      await sw.webContents.executeJavaScript(`document.querySelector('.nav-item[data-page=${page}]')?.click()`)
      await sleep(100)
      await sw.webContents.executeJavaScript(`document.querySelector('.content').scrollTop = 0`)
      await sleep(600)
      await save(sw, `${lang}-settings-${page}`)
    }
    // 截图界面：提示条 → 框选翻译后的工具条 → 回复框
    const at = { x: 380, y: 160 }
    if (h.mock) h.mock.scenario = 'chat'
    await h.inject(fakeCapture(h.display, join(root, '.scratch', 'chat.png'), at))
    await sleep(700)
    mouse('mouseMove', (at.x + 100) / s, (at.y + 100) / s)
    await sleep(300)
    await save(h.overlayWin(), `${lang}-overlay-hint`)
    const [x0, y0, x1, y1] = [at.x / s - 4, at.y / s - 4, (at.x + 560) / s + 4, (at.y + 640) / s + 4]
    mouse('mouseMove', x0, y0)
    mouse('mouseDown', x0, y0)
    for (let i = 1; i <= 12; i++) {
      mouse('mouseMove', x0 + ((x1 - x0) * i) / 12, y0 + ((y1 - y0) * i) / 12)
      await sleep(16)
    }
    mouse('mouseUp', x1, y1)
    await h.waitDone()
    await sleep(900)
    wc().insertText('OK')
    await sleep(2600)
    await save(h.overlayWin(), `${lang}-overlay-reply`)
    await wc().executeJavaScript(`document.querySelector('.rp-to')?.click()`)
    await sleep(500)
    await save(h.overlayWin(), `${lang}-overlay-reply-langs`)
    await wc().executeJavaScript(`document.querySelector('.rp-to')?.click()`)
    await sleep(300)
  }
  console.log('[i18n] done')
  app.quit()
}

/** LENS_ENGINE_TEST=1：用测试图走一遍真实引擎，打印事件与耗时 */
export async function runEngineTest(engine: Engine, ocrLines: OcrLine[], image: TranslateRequest['image']) {
  const t0 = Date.now()
  engine.warm()
  await sleep(Number(process.env.LENS_WARM_MS ?? 2500))
  const t1 = Date.now()
  const ctl = new AbortController()
  try {
    const res = await engine.translate(
      { image, lines: ocrLines, target: { code: 'zh-Hans', name: '简体中文', native: '简体中文' }, styleHint: '' },
      (e) => console.log(`[engine +${Date.now() - t1}ms]`, JSON.stringify(e)),
      ctl.signal
    )
    console.log('[engine] ok', JSON.stringify(res), 'total', Date.now() - t1, 'ms (warm', t1 - t0, 'ms)')
  } catch (e: any) {
    console.log('[engine] error', e?.code, e?.message, 'after', Date.now() - t1, 'ms')
  }
  // 回复助手：用截图里的文字做上下文
  if (process.env.LENS_REPLY_TEST) {
    const t2 = Date.now()
    let out = ''
    let first = 0
    try {
      await engine.reply(
        {
          text: process.env.LENS_REPLY_TEST,
          from: { code: 'zh-Hans', name: '简体中文', native: '简体中文' },
          to: langFor(process.env.LENS_REPLY_TO ?? 'en'),
          context: process.env.LENS_REPLY_BOTH ? '' : ocrLines.map((l) => l.text).join('\n'),
          tone: (process.env.LENS_REPLY_TONE as 'auto') ?? 'auto',
          // LENS_REPLY_BOTH=1：输入翻译的「自动」互译
          both: !!process.env.LENS_REPLY_BOTH,
          quick: !!process.env.LENS_REPLY_BOTH
        },
        (d) => {
          if (!first) first = Date.now() - t2
          out += d
        },
        ctl.signal
      )
      console.log('[reply] first token', first, 'ms, total', Date.now() - t2, 'ms')
      console.log('[reply]\n' + out)
    } catch (e: any) {
      console.log('[reply] error', e?.message)
    }
  }
  engine.dispose()
  app.quit()
}

// ------------------------------------------------------------------ 排版审查（LENS_REVIEW=1）
// 场景：.scratch/review.json  [{ name, page, region:{x,y,w,h}, target }]
// 每个场景先输出模型将看到的 OCR 输入到 .scratch/fixtures/<name>.prompt.txt；
// 若存在 .scratch/fixtures/<name>.jsonl（模型输出），则以流式小块回放，渲染后截图并生成原图/译图对照
export class FixtureEngine implements Engine {
  readonly name = '回放'
  scenario = ''
  root = ''
  warm() {}
  dispose() {}
  reply = mockReply
  async translate(req: TranslateRequest, emit: Emit, signal: AbortSignal): Promise<TranslateResult> {
    const { BlockParser, userText } = await import('../core/translator')
    const fx = join(this.root, '.scratch', 'fixtures')
    mkdirSync(fx, { recursive: true })
    writeFileSync(join(fx, `${this.scenario}.prompt.txt`), userText(req))
    const file = join(fx, `${this.scenario}.jsonl`)
    if (!existsSync(file)) throw new Error('no fixture')
    const text = readFileSync(file, 'utf8')
    const parser = new BlockParser(req.lines, emit)
    await sleep(300)
    for (let i = 0; i < text.length; i += 40) {
      if (signal.aborted) throw new Error('aborted')
      parser.push(text.slice(i, i + 40))
      await sleep(8)
    }
    parser.end()
    return { firstTokenMs: 300 }
  }
}

export async function runReview(h: Hooks & { engine: FixtureEngine; setTarget: (code: string) => void; scenarios?: string[] }) {
  const root = process.env.LENS_AUTOTEST_ROOT || app.getAppPath()
  h.engine.root = root
  const dir = join(root, '.scratch', 'review')
  mkdirSync(dir, { recursive: true })
  const all = JSON.parse(readFileSync(join(root, '.scratch', 'review.json'), 'utf8')) as {
    name: string
    page: string
    region: { x: number; y: number; w: number; h: number }
    target: string
    at?: { x: number; y: number }
  }[]
  const list = all.filter((s) => !h.scenarios?.length || h.scenarios.includes(s.name))
  const wc = () => h.overlayWin().webContents
  const mouse = (type: 'mouseMove' | 'mouseDown' | 'mouseUp', x: number, y: number) =>
    wc().sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
  const key = (keyCode: string) => {
    wc().sendInputEvent({ type: 'keyDown', keyCode })
    wc().sendInputEvent({ type: 'keyUp', keyCode })
  }
  const s = h.display.scaleFactor
  for (const sc of list) {
    const at = sc.at ?? { x: 240, y: 150 }
    h.engine.scenario = sc.name
    h.setTarget(sc.target)
    await h.inject(fakeCapture(h.display, join(root, '.scratch', 'pages', `${sc.page}.png`), at))
    await sleep(600)
    const x0 = (at.x + sc.region.x) / s
    const y0 = (at.y + sc.region.y) / s
    const x1 = (at.x + sc.region.x + sc.region.w) / s
    const y1 = (at.y + sc.region.y + sc.region.h) / s
    mouse('mouseMove', x0, y0)
    mouse('mouseDown', x0, y0)
    for (let i = 1; i <= 10; i++) {
      mouse('mouseMove', x0 + ((x1 - x0) * i) / 10, y0 + ((y1 - y0) * i) / 10)
      await sleep(12)
    }
    mouse('mouseUp', x1, y1)
    await h.waitDone()
    await sleep(900)
    // 把鼠标移出选区，避免悬停高亮
    mouse('mouseMove', 5, 5)
    await sleep(300)
    const rect = { x: Math.round(x0), y: Math.round(y0), width: Math.round(x1 - x0), height: Math.round(y1 - y0) }
    const full = await wc().capturePage()
    writeFileSync(join(dir, `${sc.name}-full.png`), full.toPNG())
    const tr = await wc().capturePage(rect)
    writeFileSync(join(dir, `${sc.name}-tr.png`), tr.toPNG())
    key('Tab')
    await sleep(900)
    writeFileSync(join(dir, `${sc.name}-side.png`), (await wc().capturePage()).toPNG())
    key('Tab')
    await sleep(400)
    console.log('[review] shot', sc.name)
  }
  console.log('[review] done')
  app.quit()
}

/** Windows smoke test for Space pressed before the first frame and again with a selection. */
export async function runPassTest(h: { hide: () => Promise<void>; overlays: () => BrowserWindow[]; modelCalls: () => number }) {
  const u = load('user32.dll')
  const key = u.func('void __stdcall keybd_event(uint8_t key, uint8_t scan, uint32_t flags, uintptr_t extra)')
  const mouse = u.func('void __stdcall mouse_event(uint32_t flags, uint32_t x, uint32_t y, int32_t data, uintptr_t extra)')
  const move = u.func('int __stdcall SetCursorPos(int x, int y)')
  const cursor = screen.getCursorScreenPoint()
  const display = process.env.LENS_PASS_SECONDARY ? screen.getAllDisplays().find((d) => d.id !== screen.getPrimaryDisplay().id) : screen.getPrimaryDisplay()
  assert.ok(display, 'requested test display is connected')
  const bounds = display.workArea
  // Window enumeration deliberately excludes the capturing process on Windows.
  const fixture = spawn('powershell', ['-NoProfile', '-STA', '-Command', `
    Add-Type -AssemblyName System.Windows.Forms
    $f = New-Object Windows.Forms.Form
    $f.Text = 'LavaTranslate scroll test'
    $f.TopMost = $true
    $f.StartPosition = 'Manual'
    $f.SetBounds(${bounds.x + 20}, ${bounds.y + 20}, 600, 460)
    $t = New-Object Windows.Forms.TextBox
    $t.Multiline = $true
    $t.ScrollBars = 'Vertical'
    $t.Dock = 'Fill'
    $t.Font = New-Object Drawing.Font('Arial', 18)
    $t.Lines = @(1..120 | ForEach-Object { "本地识别 OCR 文字，第 $_ 行。" })
    $f.Controls.Add($t)
    $t.Add_MouseWheel({ [Console]::WriteLine('wheel') })
    $f.Add_Shown({ $f.Activate(); $t.Focus() | Out-Null; [Console]::WriteLine(('{0},{1}' -f $f.Handle.ToInt64(),$t.Handle.ToInt64())) })
    [Windows.Forms.Application]::Run($f)
  `], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] })
  const output = createInterface({ input: fixture.stdout })
  const ready = new Promise<number[]>((resolve, reject) => {
    output.once('line', (line) => resolve(line.split(',').map(Number)))
    fixture.once('error', reject)
    fixture.once('exit', () => reject(new Error('Test window closed')))
  })
  const overlay = h.overlays().find((w) => w.getBounds().x === display.bounds.x && w.getBounds().y === display.bounds.y)!
  const read = (js: string) => overlay.webContents.executeJavaScript(js)
  const waitFor = async (js: string) => {
    for (let i = 0; i < 100; i++) {
      if (await read('!!(' + js + ')')) return
      await sleep(80)
    }
    throw new Error('Timed out waiting for ' + js)
  }
  const moveTo = (pt: Electron.Point) => {
    const p = screen.dipToScreenPoint(pt)
    move(p.x, p.y)
  }
  const newCapture = async () => {
    await h.hide()
    await sleep(450)
    key(0x5b, 0, 0, 0)
    key(0x20, 0, 0, 0)
    key(0x20, 0, 2, 0)
    key(0x5b, 0, 2, 0)
    await waitFor('document.querySelector(".stage-idle.is-shown")')
  }
  let failed = false
  const original = settings.get()
  const writeText = clipboard.writeText
  let copied = ''
  try {
    clipboard.writeText = async (text) => { copied = text }
    settings.update({ autoTranslate: true, targetLang: 'zh-Hans', uiLang: 'en', displayMode: 'overlay' })
    const [hwnd, edit] = await ready
    assert.ok(hwnd)
    const fixtureBounds = screen.dipToScreenRect(null, { x: bounds.x + 20, y: bounds.y + 20, width: 600, height: 460 })
    const place = u.func('int __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int w, int h, uint32_t flags)')
    assert.ok(place(hwnd, -1, fixtureBounds.x, fixtureBounds.y, fixtureBounds.width, fixtureBounds.height, 0x0040))
    forceForeground(hwnd)
    moveTo({ x: bounds.x + 160, y: bounds.y + 160 })
    await sleep(250)
    const window = ScreenshotWindow.all().find((w) => w.id() === hwnd)
    assert.ok(window, 'the scroll test window must be visible')
    const expected = screen.screenToDipRect(null, { x: window.x(), y: window.y(), width: window.width(), height: window.height() })
    await read('window.passEvents = []; void window.lens.onTranslate(({event}) => window.passEvents.push(event.type))')
    // Real shortcut with Win released first and Space still held. No overlay click.
    key(0x5b, 0, 0, 0)
    key(0x20, 0, 0, 0)
    await sleep(75)
    key(0x5b, 0, 2, 0)
    await waitFor('document.querySelector(".overlay.passing .scroll-outline")')
    const initialRect = await read('document.querySelector(".scroll-outline").getBoundingClientRect().toJSON()')
    assert.ok(Math.abs(initialRect.width - expected.width) <= 1 && Math.abs(initialRect.height - expected.height) <= 1, 'the hovered test window is the default OCR region: ' + JSON.stringify({ expected, initialRect, cursor: screen.getCursorScreenPoint() }))
    const foreground = u.func('intptr_t __stdcall GetForegroundWindow()')
    assert.equal(Number(foreground()), hwnd, 'the underlying window receives focus without a click')
    assert.equal(await read('getComputedStyle(document.querySelector(".bg")).visibility'), 'hidden')
    assert.equal(await read('getComputedStyle(document.querySelector(".scroll-outline")).visibility'), 'visible')
    let wheel = false
    output.on('line', (line) => { if (line === 'wheel') wheel = true })
    const send = u.func('intptr_t __stdcall SendMessageW(intptr_t hwnd, uint32_t msg, uintptr_t w, intptr_t l)')
    const firstVisibleLine = () => Number(send(edit, 0x00ce, 0, 0))
    const beforeScroll = firstVisibleLine()
    mouse(0x0800, 0, 0, -120, 0)
    await sleep(350)
    assert.ok(wheel, 'first hold routes the wheel to the test page')
    assert.ok(firstVisibleLine() > beforeScroll, 'the underlying document actually scrolls')
    key(0x20, 0, 2, 0)
    await waitFor(`document.querySelector('.stage-selected:not(.passing) button[aria-label="Copy recognized text"]:enabled')`)
    assert.equal(globalShortcut.isRegistered('Space'), false)
    assert.equal(overlay.isFocused(), true)
    const selectionRect = () => read('document.querySelector(".sel-frame").getBoundingClientRect().toJSON()')
    assert.deepEqual(await selectionRect(), initialRect, 'release recognizes the same window')
    await waitFor('document.querySelector(".tb-src")?.textContent === "Already in target language"')
    assert.equal(h.modelCalls(), 0, 'Chinese OCR must not call the model')
    assert.equal(await read('window.passEvents.includes("translating")'), false, 'skipped OCR must not start a translation animation')
    await read(`document.querySelector('button[aria-label="Copy recognized text"]').click()`)
    await waitFor('document.querySelector(".toast")')
    assert.match(copied, /文字[^\n]*\n[^\n]*文字/u, 'the copy action preserves Chinese OCR line breaks')

    // Selecting a different target in OCR-only mode must still wait for an explicit translation.
    settings.update({ autoTranslate: false })
    await read('document.querySelector(".tb-lang").click()')
    await waitFor('document.querySelector(".lp-item")')
    await waitFor('document.activeElement?.matches(".lp-search input")')
    key(0x20, 0, 0, 0)
    await sleep(220)
    key(0x20, 0, 2, 0)
    assert.equal(await read('document.querySelector(".lp-search input").value'), ' ', 'editing an input keeps normal Space')
    await read('Array.from(document.querySelectorAll(".lp-item")).find(b => b.textContent.includes("English")).click()')
    await waitFor('document.querySelector(".tb-src")?.textContent === "Text only"')
    await read(`document.querySelector('button[aria-label="Translate"]').click()`)
    await waitFor('document.querySelector(".tb-time")')
    assert.equal(h.modelCalls(), 1, 'explicit translation into English calls the model once')
    // Release the shortcut completely, then press Space without clicking anywhere.
    await newCapture()
    key(0x20, 0, 0, 0)
    await waitFor('document.querySelector(".overlay.passing .scroll-outline")')
    const beforePlainHold = firstVisibleLine()
    mouse(0x0800, 0, 0, -120, 0)
    await sleep(350)
    assert.ok(firstVisibleLine() > beforePlainHold, 'plain Space scrolls after a released shortcut without any click')
    key(0x20, 0, 2, 0)
    await waitFor('document.querySelector(".stage-selected:not(.passing) .sel-frame")')
    // Fresh capture with a real drag, then Space without a refocus click.
    await newCapture()
    moveTo({ x: expected.x + 15, y: expected.y + 20 })
    mouse(0x0002, 0, 0, 0, 0)
    await sleep(45)
    moveTo({ x: expected.x + expected.width - 30, y: expected.y + 180 })
    await sleep(45)
    mouse(0x0004, 0, 0, 0, 0)
    await waitFor('document.querySelector(".stage-selected .sel-frame")')
    const drawn = await selectionRect()
    assert.ok(drawn.height < initialRect.height, 'manual drag selected a subregion')
    key(0x20, 0, 0, 0)
    await waitFor('document.querySelector(".overlay.passing .scroll-outline")')
    assert.deepEqual(await read('document.querySelector(".scroll-outline").getBoundingClientRect().toJSON()'), drawn, 'existing selection stays visible')
    const beforeDragScroll = firstVisibleLine()
    mouse(0x0800, 0, 0, -120, 0)
    await sleep(350)
    assert.ok(firstVisibleLine() > beforeDragScroll, 'first hold after manual selection scrolls without a refocus click')
    key(0x20, 0, 2, 0)
    await waitFor('document.querySelector(".stage-selected:not(.passing) .sel-frame")')
    assert.deepEqual(await selectionRect(), drawn)
    forceForeground(hwnd) // Explicitly displace overlay focus, without any mouse click.
    key(0x20, 0, 0, 0)
    await waitFor('document.querySelector(".overlay.passing .scroll-outline")')
    const unfocusedLine = firstVisibleLine()
    mouse(0x0800, 0, 0, -120, 0)
    await sleep(350)
    assert.ok(firstVisibleLine() > unfocusedLine, 'Space still works when the overlay lacks keyboard focus')
    key(0x20, 0, 2, 0)
    await waitFor('document.querySelector(".stage-selected:not(.passing) .sel-frame")')
    console.log('[passtest] PASS: real Win+Space, held shortcut Space, manual drag with unfocused first hold, document scroll offsets, Chinese same-target zero model calls and zero translating events, OCR copy and manual translation')
  } catch (error) {
    failed = true
    console.error('[passtest] FAIL', error)
  } finally {
    clipboard.writeText = writeText
    settings.update({ autoTranslate: original.autoTranslate, targetLang: original.targetLang, uiLang: original.uiLang, displayMode: original.displayMode })
    key(0x20, 0, 2, 0)
    key(0x5b, 0, 2, 0)
    await h.hide()
    fixture.kill()
    moveTo(cursor)
    if (failed) app.once('will-quit', () => app.exit(1))
    app.quit()
  }
}
