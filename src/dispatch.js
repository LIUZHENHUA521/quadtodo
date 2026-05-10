export function resolveTool({ channel, userId, chatId, override } = {}, config = {}) {
  if (override === 'claude' || override === 'codex') return override
  const ch = channel ? config?.dispatch?.[channel] : null
  if (ch) {
    if (userId && ch.perUser && ch.perUser[userId]) return ch.perUser[userId]
    if (chatId && ch.perChat && ch.perChat[chatId]) return ch.perChat[chatId]
    if (ch.default === 'claude' || ch.default === 'codex') return ch.default
  }
  if (config?.defaultTool === 'codex') return 'codex'
  if (config?.defaultTool === 'claude') return 'claude'
  return 'claude'
}
