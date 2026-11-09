/** Windows 快捷键显示：Super/Meta 显示成 Win，Space 按界面语言显示 */
export function acceleratorLabel(value: string, lang: string): string {
  const space = lang === 'zh-Hant' ? '空白鍵' : lang.startsWith('zh') ? '空格' : 'Space'
  const keys: Record<string, string> = { Super: 'Win', Meta: 'Win', Space: space, CommandOrControl: 'Ctrl' }
  return value.split('+').map((key) => keys[key] ?? key).join(' + ')
}
