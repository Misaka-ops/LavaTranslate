// 翻译服务目录：这一版只支持 DeepSeek，固定走官方 OpenAI 兼容接口。
// 桌面与手机共用；桌面 UI 的文案在 shared/i18n 的 prov.deepseek.* 词条。

export type ProviderId = 'deepseek'

export interface ProviderInfo {
  id: ProviderId
  name: string
  /** 卡片上的一句话 */
  blurb: string
  api: 'chat'
  /** 官方接口地址（不可修改） */
  baseUrl: string
  /** 获取 API Key 的网页 */
  keyUrl: string
  keyUrlLabel: string
  /** 获取 Key 的步骤（简短） */
  steps: string[]
  /** 计费、额度、网络等提示 */
  tip?: string
  /** Key 的常见前缀，用于输入时提示是否填错 */
  keyHint?: string
  /** 推荐模型（顺序即优先级） */
  suggest: string[]
  /** Chat Completions 里关掉"思考"的参数 */
  chatExtra?: Record<string, unknown>
  tags: ('免费额度' | '国内直连' | '需要代理' | '聚合')[]
  /** 卡片上的品牌色 */
  color: string
}

/** 设置页里的三档模型；第一项是新用户默认值 */
export const DEEPSEEK_MODELS = ['deepseek-flash', 'deepseek-chat', 'deepseek-reasoner'] as const

export const DEEPSEEK: ProviderInfo = {
  id: 'deepseek',
  name: 'DeepSeek',
  blurb: '深度求索 · 便宜，国内直连',
  api: 'chat',
  baseUrl: 'https://api.deepseek.com',
  keyUrl: 'https://platform.deepseek.com/api_keys',
  keyUrlLabel: '打开 DeepSeek 开放平台',
  steps: ['登录 DeepSeek 开放平台并充值', '在 API keys 页面点「创建 API key」', '复制以 sk- 开头的 Key'],
  tip: 'deepseek-flash 能看图、首字约 1 秒；工作日北京时间 9–12、14–18 点以外半价。',
  keyHint: 'sk-',
  suggest: [...DEEPSEEK_MODELS],
  chatExtra: { thinking: { type: 'disabled' } },
  tags: ['国内直连'],
  color: '#4d6bfe'
}

/** 兼容手机设置页里按列表渲染的写法；现在只有一家 */
export const PROVIDERS: ProviderInfo[] = [DEEPSEEK]

export const providerInfo = (_id?: string) => DEEPSEEK

/** 只认 DeepSeek 的 Key 格式（中转站等已移除） */
export function providerByKeyFormat(key: string): ProviderId | null {
  return /^sk-[0-9A-Za-z_-]{8,}$/.test(key.trim()) ? 'deepseek' : null
}
