/**
 * 只做一件事：根据 PTY session 生命周期改 telegram topic 标题前缀。
 *
 *   running  → 🔄 <name>      （新 session / 用户发新消息时；boot resume 跳过避免 flood）
 *   idle     → 💤 <name>      （Stop hook —— Claude 完成一轮回复，等下一条输入）
 *   done     → ✅ <name>      （PTY exit 0）
 *   failed   → ❌ <name>      （PTY exit ≠ 0）
 *   stopped  → ⏹ <name>      （用户主动 stop）
 *
 * 限速防御：
 *   - 全局 backoff：任何调用撞 429 → 全员憋到 retry_after 过期（仅作用于非终态）
 *   - per-chat 节流：同 supergroup 30s 一次 rename（仅作用于非终态）
 *   - skipTitleRename: boot resume kick 走这条，不改 running 名字（避免 flood）
 *
 * 终态（done/failed/stopped）始终不受任何限制 —— 用户最在意的状态切换。
 */

const TITLE_PREFIX_BY_PHASE = {
  running: '🔄 ',
  idle:    '💤 ',
  done:    '✅ ',
  failed:  '❌ ',
  stopped: '⏹ ',
}

const TERMINAL_PHASES = new Set(['done', 'failed', 'stopped'])

const MIN_RENAME_INTERVAL_MS = 30_000

/**
 * @param {object} opts
 * @param opts.telegramBot { editForumTopic({chatId,threadId,name}) }
 * @param opts.openclaw    { resolveRoute(sessionId) → {targetUserId, threadId, topicName} | null }
 * @param opts.logger
 * @param opts.now         可注入时钟（测试用）
 */
export function createLoadingTracker({
  telegramBot,
  openclaw,
  logger = console,
  now = () => Date.now(),
  getConfig = null,
} = {}) {
  if (!telegramBot) throw new Error('telegramBot_required')

  // sessionId → { chatId, threadId, originalTopicName, skipTitleRename }
  // stop 时 route 可能已被 clearSessionRoute 清掉，所以这里自留一份
  const sessions = new Map()

  // 全局 backoff（429 触发 → 所有 rename 一起憋）
  let globalBackoffUntil = 0
  function isBackingOff() { return now() < globalBackoffUntil }
  function setBackoff(retryAfterSec) {
    const ms = Math.max(1, Number(retryAfterSec) || 1) * 1000
    globalBackoffUntil = Math.max(globalBackoffUntil, now() + ms)
    logger.warn?.(`[loading-status] global backoff for ${ms}ms (telegram 429)`)
  }
  function parseRetryAfter(desc) {
    const m = String(desc || '').match(/retry after (\d+)/i)
    return m ? Number(m[1]) : 0
  }

  // per-chat rename 节流
  const lastRenameAtByChat = new Map()
  function canRenameNow(chatId) {
    const last = lastRenameAtByChat.get(chatId) || 0
    const cfg = getConfig?.()?.telegram || {}
    const minInterval = cfg.minRenameIntervalMs || MIN_RENAME_INTERVAL_MS
    return (now() - last) >= minInterval
  }
  function markRenamed(chatId) { lastRenameAtByChat.set(chatId, now()) }

  async function renameTopic(state, phase) {
    if (!telegramBot.editForumTopic || !state.originalTopicName) return
    const isTerminal = TERMINAL_PHASES.has(phase)
    // 终态（✅/❌/⏹）：硬上，不受任何限制
    // 非终态（running / idle）：受 backoff + 节流约束。skipTitleRename 只挡首次启动的 🔄
    if (!isTerminal) {
      if (isBackingOff()) return
      if (!canRenameNow(state.chatId)) return
    }

    const prefix = TITLE_PREFIX_BY_PHASE[phase]
    if (!prefix) return
    const newName = (prefix + state.originalTopicName).slice(0, 128)
    try {
      await telegramBot.editForumTopic({
        chatId: state.chatId,
        threadId: state.threadId,
        name: newName,
      })
      markRenamed(state.chatId)
    } catch (e) {
      const desc = e?.description || e?.message || ''
      const retryAfter = parseRetryAfter(desc) || (e?.parameters?.retry_after) || 0
      if (/too many requests|429/i.test(desc) || retryAfter > 0) {
        setBackoff(retryAfter || 5)
        return
      }
      // Telegram 报错有 "Bad Request: message is not modified" 也有 "TOPIC_NOT_MODIFIED"
      if (!/not[ _]modified/i.test(desc)) {
        logger.warn?.(`[loading-status] editForumTopic phase=${phase} failed sid=${state.sessionId}: ${desc}`)
      }
    }
  }

  async function start({ sessionId, skipTitleRename = false } = {}) {
    if (!sessionId || sessions.has(sessionId)) return
    const route = openclaw?.resolveRoute?.(sessionId)
    if (!route?.threadId) return                  // 无 telegram 路由 → 不跟踪
    if (!route.topicName) return                  // 没原 topic 名 → 不能改名
    const state = {
      sessionId,
      chatId: String(route.targetUserId),
      threadId: route.threadId,
      originalTopicName: route.topicName,
    }
    sessions.set(sessionId, state)
    logger.info?.(`[loading-status] started sid=${sessionId} threadId=${route.threadId}${skipTitleRename ? ' (skip-rename)' : ''}`)
    // skipTitleRename 只挡这次启动的 🔄；之后的 markIdle/markRunning/stop 不受影响
    if (!skipTitleRename) {
      await renameTopic(state, 'running')
    }
  }

  /**
   * Claude 完成一轮回复（Stop hook 触发）→ 标题切到 💤。
   * 已结束的 session 调用是 no-op。
   */
  async function markIdle(sessionId) {
    const state = sessions.get(sessionId)
    if (!state) return
    await renameTopic(state, 'idle')
  }

  /**
   * 用户发新输入到正在 idle 的 session（wizard stdin proxy）→ 标题切回 🔄。
   * 已结束的 session 调用是 no-op。
   */
  async function markRunning(sessionId) {
    const state = sessions.get(sessionId)
    if (!state) return
    await renameTopic(state, 'running')
  }

  async function stop({ sessionId, finalStatus = 'done' } = {}) {
    const state = sessions.get(sessionId)
    if (!state) return
    sessions.delete(sessionId)
    await renameTopic(state, finalStatus)
  }

  function has(sessionId) { return sessions.has(sessionId) }
  function size() { return sessions.size }

  return { start, stop, markIdle, markRunning, has, size, __test__: { sessions } }
}
