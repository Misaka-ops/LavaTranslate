import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { DEFAULT_SETTINGS, type Settings as S } from '../src/shared/types'

export async function checkSettingsHotkey(platform: 'Win32' | 'MacIntel') {
  Object.defineProperty(navigator, 'platform', { value: platform, configurable: true })
  let saved: S = structuredClone(DEFAULT_SETTINGS)
  saved.hotkey = platform === 'MacIntel' ? 'Alt+Space' : 'Super+Space'
  const listeners = new Set<(s: S) => void>()
  const off = () => () => {}
  let rejectNext = false
  let updateOpens = 0
  Object.assign(window, { lens: {
    uiLang: () => 'zh-Hans', onUiLang: off,
    getSettings: async () => saved, onSettings: (cb: (s: S) => void) => { listeners.add(cb); return () => listeners.delete(cb) },
    appInfo: async () => ({ version: 'test' }), updateState: async () => ({ state: 'ready', version: '1.4.8', next: '1.4.9', manualInstall: platform === 'MacIntel' }), onUpdate: off,
    updateInstall: () => { updateOpens++ },
    engineStatus: async () => ({ provider: 'deepseek', ok: true, detail: 'deepseek-flash · DeepSeek' }), ocrInfo: async () => 'CPU',
    suspendHotkey: async () => {}, onHotkeyRecorded: off,
    macSettingsStatus: async () => ({}),
    setHotkey: async (hotkey: string) => {
      if (rejectNext) return { ok: false, message: 'hotkey.taken' }
      saved = { ...saved, hotkey }
      for (const cb of listeners) cb(saved)
      return { ok: true }
    }
  } })
  const { Settings } = await import('../src/renderer/src/settings/Settings')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const pause = () => new Promise((resolve) => setTimeout(resolve, 20))
  const wait = async (f: () => boolean) => {
    for (let n = 0; n < 100; n++) { if (f()) return; await pause() }
    throw new Error(`Settings check timed out: ${host.textContent?.slice(0, 300)}`)
  }
  const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message) }
  const click = (selector: string) => { const el = host.querySelector<HTMLButtonElement>(selector); assert(el, selector); el!.click() }
  try {
    flushSync(() => root.render(<Settings />))
    await wait(() => !!host.querySelector('.nav-item[data-page="translate"]'))
    assert(host.querySelectorAll('.nav-item').length === 3, 'settings must have exactly three pages')
    assert(host.querySelector('.conn')?.textContent?.includes('DeepSeek'), 'translate page must show the DeepSeek card')
    assert(!host.querySelector('.offline-survey'), 'offline survey is removed')
    click('[data-page="general"]')
    await wait(() => !!host.querySelector('.hotkey'))
    click('.hotkey')
    await wait(() => !!host.querySelector('.hotkey.rec'))
    await pause()
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyK', key: 'K', ctrlKey: true, shiftKey: true, bubbles: true }))
    await wait(() => saved.hotkey === 'Ctrl+Shift+K' && !host.querySelector('.hotkey.rec'))
    rejectNext = true
    click('.hotkey')
    await wait(() => !!host.querySelector('.hotkey.rec'))
    await pause()
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ', key: 'J', ctrlKey: true, bubbles: true }))
    await wait(() => !!host.querySelector('.hk-hint.err'))
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true }))
    assert(saved.hotkey === 'Ctrl+Shift+K', 'failed shortcut must not change the saved hotkey')
    click('[data-page="about"]')
    await wait(() => !!host.querySelector('.update-card.ready button'))
    const button = host.querySelector('.update-card.ready button')!
    assert(button.textContent?.includes(platform === 'MacIntel' ? '查看更新包' : '重启'), 'update action must match install mode')
    assert(!host.textContent?.includes('Mac 预览版'), 'packaged Mac is not unconditionally labeled a preview')
    if (platform === 'MacIntel') assert(host.querySelector('.update-card')?.textContent?.includes('Finder'), 'Mac must explain the installation step')
    click('.update-card.ready button')
    assert(updateOpens === 1, 'update action must reach the main process')
    return `${platform}: three-page settings, shortcut synchronization and update install mode`
  } finally { root.unmount(); host.remove() }
}

Object.assign(window, { checkSettingsHotkey })
