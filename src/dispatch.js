import { SUPPORTED_TOOLS } from './config.js'

export function resolveTool({ channel, userId, chatId, override } = {}, config = {}) {
  if (override && SUPPORTED_TOOLS.includes(override)) return override
  const ch = channel ? config?.dispatch?.[channel] : null
  if (ch) {
    if (userId && ch.perUser && SUPPORTED_TOOLS.includes(ch.perUser[userId])) return ch.perUser[userId]
    if (chatId && ch.perChat && SUPPORTED_TOOLS.includes(ch.perChat[chatId])) return ch.perChat[chatId]
    if (SUPPORTED_TOOLS.includes(ch.default)) return ch.default
  }
  return 'claude'
}
