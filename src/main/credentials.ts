// 凭据：DeepSeek 的官方接口地址、解密后的 Key、模型
import { DEEPSEEK, type Settings } from '../shared/types'
import { decryptSecret } from './secrets'

export interface ResolvedProvider {
  baseURL: string
  apiKey: string
  model: string
}

/** 当前配置的可用凭据；没填 Key 时返回 null。模型留空时用默认的 deepseek-flash */
export function resolveProvider(s: Settings): ResolvedProvider | null {
  const c = s.providers.deepseek
  const apiKey = decryptSecret(c?.key ?? '').trim()
  if (!apiKey) return null
  return {
    baseURL: DEEPSEEK.baseUrl,
    apiKey,
    model: c?.model || 'deepseek-flash'
  }
}
