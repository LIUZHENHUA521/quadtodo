/**
 * Telegram 配置辅助：
 *  - maskBotToken / isMaskedToken：UI 上 token 的遮罩与回显检测
 *
 * 跟 telegram-bot.js 解耦，所有 IO 由 caller 注入。
 */

const MASK_PREFIX = 'tg_***'

/**
 * 把真实 token 转成展示串：tg_***末四位。null/空返回 null。
 */
export function maskBotToken(token) {
  if (!token || typeof token !== 'string') return null
  const tail = token.length >= 4 ? token.slice(-4) : token
  return MASK_PREFIX + tail
}

/**
 * 判断字符串是不是 mask 格式（用户在 UI 没改 token 时回传的就是 mask）。
 */
export function isMaskedToken(value) {
  if (!value || typeof value !== 'string') return false
  return value.startsWith(MASK_PREFIX)
}
