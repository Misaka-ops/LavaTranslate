import { AnimatePresence, motion } from 'motion/react'
import {
  Check,
  ChevronDown,
  Columns2,
  Download,
  Globe,
  Info,
  KeyRound,
  Keyboard,
  Languages,
  Layers,
  Loader2,
  MessageSquareReply,
  Power,
  RefreshCw,
  Settings2,
  Zap
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  DEEPSEEK,
  DEEPSEEK_MODELS,
  LANGUAGES,
  type EngineStatus,
  type Settings as S,
  type SettingsPatch,
  type UpdateState
} from '@shared/types'
import { UI_LANGS, type MsgKey } from '@shared/i18n'
import { acceleratorLabel } from '@shared/hotkeys'
import { useI18n, type I18n } from '../lib/i18n'

type Page = 'translate' | 'general' | 'about'

const NAV: { id: Page; label: MsgKey; icon: ReactNode }[] = [
  { id: 'translate', label: 'nav.translate', icon: <Languages size={17} /> },
  { id: 'general', label: 'nav.general', icon: <Settings2 size={17} /> },
  { id: 'about', label: 'nav.about', icon: <Info size={17} /> }
]

export function Settings() {
  const i = useI18n()
  const { t } = i
  const [s, setS] = useState<S | null>(null)
  const [page, setPage] = useState<Page>('translate')
  const [status, setStatus] = useState<EngineStatus | null>(null)
  const [ocr, setOcr] = useState('')
  const [version, setVersion] = useState('')
  const [upd, setUpd] = useState<UpdateState | null>(null)

  const loadSettings = useCallback(() => {
    void window.lens.getSettings().then(setS)
  }, [])

  const refreshStatus = useCallback(() => {
    void window.lens.engineStatus().then(setStatus)
  }, [])

  useEffect(() => {
    loadSettings()
    void window.lens.appInfo().then((i) => setVersion(i.version))
    void window.lens.updateState().then(setUpd)
    const offUpd = window.lens.onUpdate(setUpd)
    refreshStatus()
    const off = window.lens.onSettings((n) => {
      setS(n)
      refreshStatus()
    })
    // 登录在外部终端完成，定期刷新状态
    const t = setInterval(refreshStatus, 2500)
    return () => {
      off()
      offUpd()
      clearInterval(t)
    }
  }, [refreshStatus, loadSettings])

  // 状态、OCR 说明由主进程按界面语言生成：换语言后重新取
  useEffect(() => {
    void window.lens.ocrInfo().then(setOcr)
    refreshStatus()
  }, [i.lang, refreshStatus])

  const update = useCallback(async (patch: SettingsPatch) => {
    setS(await window.lens.setSettings(patch))
  }, [])

  if (!s) return null
  return (
    <div className="app">
      <header className="titlebar">
        <img src="./icon.png" alt="" />
        <span>LavaTranslate</span>
      </header>
      <div className="body">
        <nav className="nav">
          {NAV.map((n) => (
            <button key={n.id} data-page={n.id} className={`nav-item${page === n.id ? ' on' : ''}`} onClick={() => setPage(n.id)}>
              {page === n.id && <motion.span layoutId="nav-pill" className="nav-pill" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
              <span className="nav-icon">{n.icon}</span>
              <span>{t(n.label)}</span>
            </button>
          ))}
          <div className="nav-foot">
            <button className="nav-status" onClick={() => setPage('translate')}>
              <span className={`dot ${status?.ok ? 'ok' : 'bad'}`} />
              {status?.ok ? t('nav.ready') : t('nav.needSetup')}
            </button>
            <button className={`nav-ver${upd?.state === 'ready' ? ' hot' : ''}`} onClick={() => setPage('about')}>
              v{version} · {updateShort(upd, i)}
            </button>
          </div>
        </nav>
        <main className="content">
          <AnimatePresence mode="wait">
            <motion.div
              key={page}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6, transition: { duration: 0.12 } }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            >
              {page === 'translate' && <TranslatePage s={s} update={update} status={status} refresh={refreshStatus} />}
              {page === 'general' && <GeneralPage s={s} update={update} />}
              {page === 'about' && <About s={s} update={update} version={version} ocr={ocr} />}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  )
}

function TranslatePage({ s, update, status, refresh }: { s: S; update: Upd; status: EngineStatus | null; refresh: () => void }) {
  const i = useI18n()
  const { t } = i
  const [hint, setHint] = useState(s.styleHint)
  useEffect(() => setHint(s.styleHint), [s.styleHint])
  return (
    <>
      <h2>{t('tr.title')}</h2>
      <div className={`status-bar${status?.ok ? ' ok' : ''}`}>
        <span className={`dot big ${status?.ok ? 'ok' : 'bad'}`} />
        <span className="status-text">{status?.detail ?? t('nav.needSetup')}</span>
      </div>
      <DeepSeekCard s={s} update={update} status={status} refresh={refresh} />
      <Card title={t('tr.target')} desc={t('tr.targetDesc')}>
        <Select
          value={s.targetLang}
          options={LANGUAGES.map((l) => ({ value: l.code, label: i.langLabel(l.code, l.name), sub: l.native }))}
          onChange={(v) => update({ targetLang: v })}
        />
      </Card>
      <Card title={t('tr.autoTranslate')} desc={t('tr.autoTranslateDesc')}>
        <Toggle on={s.autoTranslate} onChange={(v) => update({ autoTranslate: v })} />
      </Card>
      <Card stack title={t('tr.display')} desc={t('tr.displayDesc')}>
        <div className="mode-cards">
          <ModeCard on={s.displayMode === 'overlay'} onClick={() => update({ displayMode: 'overlay' })} icon={<Layers size={16} />} title={t('tr.overlay')} desc={t('tr.overlayDesc')}>
            <div className="mini">
              <div className="mini-shot">
                <i className="t1 tr" />
                <i className="t2 tr" />
                <i className="t3 tr" />
              </div>
            </div>
          </ModeCard>
          <ModeCard on={s.displayMode === 'side'} onClick={() => update({ displayMode: 'side' })} icon={<Columns2 size={16} />} title={t('tr.side')} desc={t('tr.sideDesc')}>
            <div className="mini two">
              <div className="mini-shot">
                <i className="t1" />
                <i className="t2" />
                <i className="t3" />
              </div>
              <div className="mini-shot">
                <i className="t1 tr" />
                <i className="t2 tr" />
                <i className="t3 tr" />
              </div>
            </div>
          </ModeCard>
        </div>
      </Card>
      <Card title={t('tr.reply')} desc={t('tr.replyDesc')} icon={<MessageSquareReply size={18} />}>
        <Toggle on={s.replyAssist} onChange={(v) => update({ replyAssist: v })} />
      </Card>
      <Card stack title={t('tr.hint')} desc={t('tr.hintDesc')}>
        <textarea
          className="input area"
          value={hint}
          placeholder={t('tr.hintPlaceholder')}
          onChange={(e) => setHint(e.target.value)}
          onBlur={() => hint !== s.styleHint && update({ styleHint: hint })}
        />
      </Card>
    </>
  )
}

function ModeCard(p: { on: boolean; onClick: () => void; icon: ReactNode; title: string; desc: string; children: ReactNode }) {
  return (
    <button className={`mode-card${p.on ? ' on' : ''}`} onClick={p.onClick}>
      {p.children}
      <div className="mode-meta">
        <span className="mode-title">
          {p.icon}
          {p.title}
        </span>
        <span className="mode-desc">{p.desc}</span>
      </div>
      <AnimatePresence>
        {p.on && (
          <motion.span className="mode-check" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={{ type: 'spring', stiffness: 600, damping: 25 }}>
            <Check size={12} strokeWidth={3} />
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  )
}

/** 下拉选择；sub 是灰色的第二个名字（语言的本地写法） */
function Select({ value, options, onChange }: { value: string; options: { value: string; label: string; sub?: string }[]; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const cur = options.find((o) => o.value === value)
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', away)
    return () => window.removeEventListener('mousedown', away)
  }, [])
  const sub = (o?: { label: string; sub?: string }) => o?.sub && o.sub !== o.label && <span className="muted">{o.sub}</span>
  return (
    <div className="select" ref={ref}>
      <button className={`select-btn${open ? ' open' : ''}`} onClick={() => setOpen((v) => !v)}>
        <span>{cur?.label}</span>
        {sub(cur)}
        <ChevronDown size={15} className="chev" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="select-pop"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, transition: { duration: 0.1 } }}
            transition={{ type: 'spring', stiffness: 560, damping: 36 }}
          >
            {options.map((o) => (
              <button
                key={o.value}
                className={`select-item${o.value === value ? ' on' : ''}`}
                onClick={() => {
                  onChange(o.value)
                  setOpen(false)
                }}
              >
                <span>{o.label}</span>
                {sub(o)}
                {o.value === value && <Check size={14} />}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ------------------------------------------------------------------ 翻译服务（DeepSeek）
type Upd = (p: SettingsPatch) => Promise<void> | void

function DeepSeekCard({ s, update, status, refresh }: { s: S; update: Upd; status: EngineStatus | null; refresh: () => void }) {
  const { t, lang } = useI18n()
  const zh = lang.startsWith('zh')
  const conf = s.providers.deepseek
  const model = conf?.model || DEEPSEEK_MODELS[0]
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState('')
  const [test, setTest] = useState<{ state: 'idle' | 'run' | 'ok' | 'fail'; msg?: string }>({ state: 'idle' })

  const save = async () => {
    const k = key.trim()
    if (!k) return
    setBusy(true)
    setSaved(false)
    setErr('')
    try {
      await update({ providers: { deepseek: { key: k } } })
      setKey('')
      setSaved(true)
      setTest({ state: 'idle' })
      refresh()
    } catch {
      setErr(zh ? '未能保存 Key，请检查本机存储空间与配置目录的写入权限。' : 'Could not save the key. Check disk space and access to the settings folder.')
    } finally {
      setBusy(false)
    }
  }

  const runTest = async () => {
    setTest({ state: 'run' })
    const r = await window.lens.testEngine()
    setTest({ state: r.ok ? 'ok' : 'fail', msg: r.message })
    refresh()
  }

  return (
    <div className="card stack conn">
      <div className="card-text">
        <div className="card-title">DeepSeek</div>
        <div className="card-desc">{t('svc.keyDesc')}</div>
      </div>
      <div className="conn-fields">
        {conf?.key && (
          <div className="key-current">
            <span className="prov-mark sm" style={{ background: DEEPSEEK.color }}>D</span>
            <span className="key-saved">
              <Check size={12} strokeWidth={3} /> {conf.key}
            </span>
            <button
              className="link danger"
              onClick={() => {
                setSaved(false)
                setTest({ state: 'idle' })
                void update({ providers: { deepseek: { key: '' } } })
              }}
            >
              {t('common.clear')}
            </button>
          </div>
        )}
        <div className="conn-actions">
          <input
            className="input mono"
            type="password"
            placeholder={conf?.key ? t('key.placeholderMore') : t('key.placeholder')}
            value={key}
            spellCheck={false}
            onChange={(e) => {
              setKey(e.target.value)
              setSaved(false)
              setErr('')
            }}
            onKeyDown={(e) => e.key === 'Enter' && void save()}
          />
          <button className="btn primary" disabled={!key.trim() || busy} onClick={() => void save()}>
            {busy ? <Loader2 size={15} className="spin" /> : <KeyRound size={15} />}
            {t('common.save')}
          </button>
        </div>
        {err && <div className="note err" role="alert">{err}</div>}
        <AnimatePresence>
          {saved && (
            <motion.div className="detect" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
              <span className="detect-ok">
                <Check size={13} strokeWidth={3} /> {t('key.savedAs', { name: 'DeepSeek' })}
              </span>
            </motion.div>
          )}
        </AnimatePresence>
        <label className="field">
          <span className="field-label">{t('models.title')}</span>
          <Select
            value={model}
            options={DEEPSEEK_MODELS.map((m) => ({ value: m, label: m }))}
            onChange={(v) => void update({ providers: { deepseek: { model: v } } })}
          />
        </label>
        <div className="conn-actions">
          <button className="btn" disabled={!status?.ok || test.state === 'run'} onClick={() => void runTest()}>
            {test.state === 'run' ? <Loader2 size={15} className="spin" /> : <Zap size={15} />}
            {t('svc.test')}
          </button>
          <button className="link" onClick={() => window.lens.openExternal(DEEPSEEK.keyUrl)}>
            {t('prov.deepseek.link')}
          </button>
        </div>
        <AnimatePresence>
          {(test.state === 'ok' || test.state === 'fail') && (
            <motion.div className={`test-result ${test.state}`} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
              {test.state === 'ok' ? <Check size={15} /> : <Info size={15} />}
              {test.msg}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

function GeneralPage({ s, update }: { s: S; update: Upd }) {
  const { t, lang } = useI18n()
  const known = UI_LANGS.some((l) => l.code === s.uiLang)
  return (
    <>
      <h2>{t('gen.title')}</h2>
      <Card title={t('gen.hotkey')} desc={t('gen.hotkeyDesc', { key: acceleratorLabel(s.hotkey, lang) })} icon={<Keyboard size={18} />}>
        <HotkeyInput value={s.hotkey} />
      </Card>
      {s.hotkey === 'Super+Space' && <div className="note hotkey-note">{t('gen.winSpace')}</div>}
      <Card title={t('gen.uiLang')} desc={t('gen.uiLang') === 'Language' ? undefined : 'Language'} icon={<Globe size={18} />}>
        <Select
          value={known ? s.uiLang : 'auto'}
          options={[{ value: 'auto', label: t('tray.langSystem') }, ...UI_LANGS.map((l) => ({ value: l.code, label: l.native }))]}
          onChange={(v) => update({ uiLang: v })}
        />
      </Card>
      <Card title={t('gen.launch', { system: 'Windows' })} desc={t('gen.launchDesc', { system: 'Windows' })} icon={<Power size={18} />}>
        <Toggle on={s.launchAtLogin} onChange={(v) => update({ launchAtLogin: v })} />
      </Card>
    </>
  )
}

function HotkeyInput({ value }: { value: string }) {
  const { t, lang } = useI18n()
  const [rec, setRec] = useState(false)
  const [draft, setDraft] = useState<string[]>([])
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!rec) return
    void window.lens.suspendHotkey(true)
    const save = async (acc: string) => {
      const r = await window.lens.setHotkey(acc)
      setErr(r.ok ? '' : (r.message ?? 'hotkey.failed'))
      if (r.ok) setRec(false)
    }
    const offRecorded = window.lens.onHotkeyRecorded((acc) => {
      setDraft(acc.split('+'))
      void save(acc)
    })
    const down = async (e: KeyboardEvent) => {
      e.preventDefault()
      if (e.repeat) return
      if (e.key === 'Escape') {
        setRec(false)
        return
      }
      const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean) as string[]
      const key = keyName(e.code)
      setDraft(key ? [...mods, key] : mods)
      if (!key) return
      if (!mods.length && !/^F\d+$/.test(key)) {
        setErr('hotkey.needMod')
        return
      }
      const acc = [...mods, key].join('+')
      await save(acc)
    }
    const blur = () => setRec(false)
    window.addEventListener('keydown', down)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('blur', blur)
      offRecorded()
      void window.lens.suspendHotkey(false)
    }
  }, [rec])

  const keys = rec ? draft : value.split('+')
  return (
    <div className="hotkey-wrap">
      <button
        className={`hotkey${rec ? ' rec' : ''}`}
        onClick={() => {
          setDraft([])
          setErr('')
          setRec((v) => !v)
        }}
      >
        {keys.length ? (
          keys.map((k, n) => (
            <motion.span key={k + n} className="keycap sm" initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
              {acceleratorLabel(k, lang)}
            </motion.span>
          ))
        ) : (
          <span className="muted">{t('hotkey.press')}</span>
        )}
      </button>
      <span className={`hk-hint${err ? ' err' : ''}`}>{err ? (err.startsWith('hotkey.') ? t(err as MsgKey) : err) : rec ? t('hotkey.escCancel') : t('hotkey.clickToRecord')}</span>
    </div>
  )
}

function keyName(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit\d$/.test(code)) return code.slice(5)
  if (/^F\d{1,2}$/.test(code)) return code
  const map: Record<string, string> = {
    Space: 'Space',
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    PrintScreen: 'PrintScreen',
    Insert: 'Insert',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown'
  }
  return map[code] ?? null
}

// ------------------------------------------------------------------ 关于
function About({ s, update, version, ocr }: { s: S; update: (p: SettingsPatch) => void; version: string; ocr: string }) {
  const i = useI18n()
  const { t } = i
  const [u, setU] = useState<UpdateState | null>(null)
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    void window.lens.updateState().then(setU)
    return window.lens.onUpdate(setU)
  }, [])
  const check = async () => {
    setChecking(true)
    setU(await window.lens.updateCheck())
    setChecking(false)
  }
  const busy = checking || u?.state === 'checking'
  return (
    <>
      <h2>{t('about.title')}</h2>
      <section className="about">
        <img src="./icon.png" alt="" />
        <div>
          <div className="about-name">LavaTranslate</div>
          <div className="muted">{t('about.version', { v: version })}</div>
        </div>
      </section>

      <div className={`update-card ${u?.state ?? 'idle'}`}>
        <span className="update-icon">
          {u?.state === 'ready' ? <Check size={18} strokeWidth={2.6} /> : u?.state === 'downloading' || u?.state === 'available' || busy ? <Loader2 size={18} className="spin" /> : <RefreshCw size={17} />}
        </span>
        <div className="card-text">
          <div className="card-title">{updateTitle(u, busy, i)}</div>
          <div className="card-desc">{updateDesc(u, i)}</div>
          <AnimatePresence>
            {(u?.state === 'downloading' || u?.state === 'available') && (
              <motion.div className="update-bar" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <motion.div className="update-fill" animate={{ width: `${Math.max(3, u.percent)}%` }} transition={{ type: 'spring', stiffness: 120, damping: 24 }} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        {u?.state === 'ready' ? (
          <button className="btn primary" onClick={() => window.lens.updateInstall()}>
            {t('about.restart')}
          </button>
        ) : (
          <button className="btn" disabled={busy || u?.state === 'disabled' || u?.state === 'downloading'} onClick={() => void check()}>
            {t('about.check')}
          </button>
        )}
      </div>
      {u?.state !== 'disabled' && <Card title={t('about.autoUpdate')} desc={t('about.autoUpdateDesc')} icon={<Download size={18} />}>
        <Toggle on={s.autoUpdate} onChange={(v) => update({ autoUpdate: v })} />
      </Card>}

      <h3 className="h3">{t('about.tech')}</h3>
      <Card title={t('about.translate')} desc={t('about.translateDesc')} />
      <Card title={t('about.ocr')} desc={t('about.ocrDesc', { ocr: ocr || 'ONNX Runtime' })} />
      <Card title={t('about.privacy')} desc={t('about.privacyDesc')} />
    </>
  )
}

function updateShort(u: UpdateState | null, { t }: I18n) {
  switch (u?.state) {
    case 'ready':
      return t('upd.short.ready', { v: u.next })
    case 'available':
    case 'downloading':
      return t('upd.short.downloading', { p: u.percent })
    case 'checking':
      return t('upd.short.checking')
    case 'latest':
      return t('upd.short.latest')
    case 'error':
      return t('upd.short.error')
    case 'disabled':
      return t('upd.short.dev')
    default:
      return t('upd.short.idle')
  }
}

function updateTitle(u: UpdateState | null, busy: boolean, { t }: I18n) {
  if (busy) return t('upd.title.checking')
  switch (u?.state) {
    case 'latest':
      return t('upd.title.latest')
    case 'available':
    case 'downloading':
      return t('upd.title.downloading', { v: u.next })
    case 'ready':
      return t('upd.title.ready', { v: u.next })
    case 'error':
      return t('upd.title.error')
    case 'disabled':
      return t('upd.title.disabled')
    default:
      return t('upd.title.idle')
  }
}

function updateDesc(u: UpdateState | null, { t }: I18n) {
  switch (u?.state) {
    case 'available':
    case 'downloading':
      return t('upd.desc.downloading', { p: u.percent })
    case 'ready':
      return t('upd.desc.ready')
    case 'error':
    case 'disabled':
      return u.message
    case 'latest':
      return u.message ?? t('upd.desc.latest')
    default:
      return t('upd.desc.idle')
  }
}

// ------------------------------------------------------------------ 组件
function Card({ title, desc, icon, children, stack }: { title: string; desc?: string; icon?: ReactNode; children?: ReactNode; stack?: boolean }) {
  return (
    <div className={`card${stack ? ' stack' : ''}`}>
      {icon && <span className="card-icon">{icon}</span>}
      <div className="card-text">
        <div className="card-title">{title}</div>
        {desc && <div className="card-desc">{desc}</div>}
      </div>
      {children && <div className="card-ctl">{children}</div>}
    </div>
  )
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className={`toggle${on ? ' on' : ''}`} onClick={() => onChange(!on)}>
      <motion.span className="knob" layout transition={{ type: 'spring', stiffness: 700, damping: 35 }} />
    </button>
  )
}
