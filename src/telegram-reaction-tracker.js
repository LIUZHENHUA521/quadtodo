/**
 * Telegram message reaction 跟踪器：
 *   - 用户每发一条触发 PTY 的消息，加 ✍ reaction
 *   - PTY Stop hook（一轮回复完成）→ 清掉这个 session 期间所有 ✍
 *
 * 跟 lark-bot.pendingReactions 对称；Telegram 这边 setMessageReaction 是覆盖式
 * （传空数组 = 清除），不需要存 reaction_id，只记 (chatId, messageId)。
 */

const DEFAULT_RUNNING_EMOJI = '✍'

export function createReactionTracker({
  telegramBot,
  getConfig = () => ({}),
  logger = console,
} = {}) {
  if (!telegramBot) throw new Error('telegramBot_required')

  // sessionId → [{ chatId, messageId }]
  const sessions = new Map()

  function getCfg() {
    return getConfig()?.telegram || {}
  }

  function isEnabled() {
    const v = getCfg().reactionEnabled
    return v !== false
  }

  function runningEmoji() {
    return getCfg().reactionRunningEmoji || DEFAULT_RUNNING_EMOJI
  }

  async function noteUserMessage({ sessionId, chatId, messageId } = {}) {
    if (!sessionId || !chatId || !messageId) return
    if (!isEnabled()) return
    const list = sessions.get(sessionId) || []
    list.push({ chatId: String(chatId), messageId })
    sessions.set(sessionId, list)
    try {
      await telegramBot.setMessageReaction({ chatId, messageId, emoji: runningEmoji() })
    } catch (e) {
      logger.warn?.(`[reaction-tracker] note failed sid=${sessionId} msg=${messageId}: ${e.message}`)
    }
  }

  async function clearReactionsForSession(sessionId) {
    if (!sessionId) return { ok: true, removed: 0 }
    const list = sessions.get(sessionId)
    sessions.delete(sessionId)
    if (!list || list.length === 0) return { ok: true, removed: 0 }
    let removed = 0
    for (const { chatId, messageId } of list) {
      try {
        await telegramBot.setMessageReaction({ chatId, messageId, emoji: null })
        removed++
      } catch (e) {
        logger.warn?.(`[reaction-tracker] clear failed sid=${sessionId} msg=${messageId}: ${e.message}`)
      }
    }
    return { ok: true, removed, total: list.length }
  }

  function has(sessionId) { return sessions.has(sessionId) }
  function size() { return sessions.size }

  return { noteUserMessage, clearReactionsForSession, has, size, __test__: { sessions } }
}
