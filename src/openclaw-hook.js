/**
 * Claude Code Hook 主动推送处理器。
 *
 * 接收 hook 脚本（~/.quadtodo/claude-hooks/notify.js）发来的事件，
 * 应用节流规则，调 openclaw-bridge 推送微信。
 *
 * 节流规则（按设计稿 §4）：
 *   - ask_user pending 时 Stop 静默：DB 查 pending_questions 匹配 sessionId → 跳过 Stop
 *   - 同 (sessionId × event) 30s cooldown
 *   - Notification 优先级最高，无视 cooldown
 *   - SessionEnd 不节流，必送达
 *   - 整体出站沿用 openclaw-bridge 的 6/min 限流
 */

const DEFAULT_COOLDOWN_MS = 30_000

// 把 todoId 字符串收成 3 字符短码（去除连字符后取末 3 位，转小写）
function shortTodoId(todoId) {
  if (!todoId) return null
  const cleaned = String(todoId).replace(/[^a-z0-9]/gi, '')
  if (cleaned.length === 0) return null
  return cleaned.slice(-3).toLowerCase()
}

function buildMessage({ event, todoId, todoTitle, snippet }) {
  const code = shortTodoId(todoId)
  const tag = code ? `[#t${code}]` : '[#hook]'
  const title = todoTitle ? `任务「${todoTitle}」` : '当前任务'
  switch (event) {
    case 'stop':
      return `🤖 ${tag} ${title} AI 一轮回答结束 — 去 quadtodo Web UI 看看，或回我下一步`
    case 'notification':
      return `⚠️ ${tag} ${title} AI 卡住等输入${snippet ? `\n${snippet.slice(0, 240)}` : ''}`
    case 'session-end':
      return `✅ ${tag} ${title} AI session 已结束`
    default:
      return `🦞 ${tag} ${title} hook event: ${event}`
  }
}

/**
 * 创建 hook 处理器。
 *
 * 依赖：
 *   - db: 用于查 pending_questions（ask_user pending 静默用）
 *   - openclaw: openclaw-bridge 实例
 *   - cooldownMs: 同 (sessionId × event) 内的最小间隔
 *
 * 并发安全：所有状态都在单实例内部 Map 里；同进程多 hook 调用顺序处理。
 */
export function createOpenClawHookHandler({ db, openclaw, cooldownMs = DEFAULT_COOLDOWN_MS } = {}) {
  if (!db) throw new Error('db_required')
  if (!openclaw) throw new Error('openclaw_required')

  // dedupKey → lastSentAt
  const lastSentAt = new Map()

  function dedupKey(sessionId, event) {
    return `${sessionId || 'global'}:${event}`
  }

  function isOnCooldown(sessionId, event) {
    const key = dedupKey(sessionId, event)
    const last = lastSentAt.get(key) || 0
    return (Date.now() - last) < cooldownMs
  }

  function recordSent(sessionId, event) {
    lastSentAt.set(dedupKey(sessionId, event), Date.now())
  }

  function hasPendingAskUser(sessionId) {
    if (!sessionId) return false
    try {
      // 通过 listPendingQuestions 拿全部，过滤 sessionId 匹配
      const list = db.listPendingQuestions()
      return list.some((p) => p.sessionId === sessionId && p.status === 'pending')
    } catch {
      return false
    }
  }

  /**
   * 处理一条 hook 事件。
   * 返回 { ok, action: 'sent'|'skipped'|'failed', reason? }
   */
  async function handle({ event, sessionId, todoId, todoTitle, hookPayload } = {}) {
    if (!event) return { ok: false, action: 'failed', reason: 'event_required' }
    const evt = String(event).toLowerCase()

    // 1) ask_user pending 时 Stop 静默
    if (evt === 'stop' && hasPendingAskUser(sessionId)) {
      return { ok: true, action: 'skipped', reason: 'ask_user_pending' }
    }

    // 2) cooldown：Notification / SessionEnd 例外
    const enforceable = evt !== 'notification' && evt !== 'session-end'
    if (enforceable && isOnCooldown(sessionId, evt)) {
      return { ok: true, action: 'skipped', reason: 'cooldown' }
    }

    // 3) 拼消息文本
    let snippet = null
    if (hookPayload && typeof hookPayload === 'object') {
      // hook payload 里可能带 transcript_path / message / 等字段；尽力提取一段摘要
      const hint = hookPayload.message || hookPayload.summary || null
      if (hint && typeof hint === 'string') snippet = hint.trim()
    }
    const message = buildMessage({ event: evt, todoId, todoTitle, snippet })

    // 4) 推送
    const result = await openclaw.postText({
      sessionId,
      message,
    })
    if (result.ok) {
      recordSent(sessionId, evt)
      return { ok: true, action: 'sent', message }
    }
    return { ok: false, action: 'failed', reason: result.reason || 'unknown', detail: result }
  }

  function describe() {
    return {
      cooldownMs,
      activeDedups: lastSentAt.size,
    }
  }

  // 测试 / 调试钩子
  function _reset() { lastSentAt.clear() }

  return {
    handle,
    describe,
    _reset,
  }
}

export const __test__ = { buildMessage, shortTodoId }
