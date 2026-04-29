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

function stripAnsi(s) {
  return String(s || '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()#][A-Za-z0-9]/g, '')
    .replace(/\x1b[>=<cDEHMNOPZ78]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
}

// Unicode box-drawing chars: 把 ╭ ╮ ╰ ╯ ├ ┤ │ ─ 等替成简洁字符
const BOX_HORIZONTAL = /[─━┄┅┈┉═]/g
const BOX_VERTICAL = /[│┃┆┇┊┋║]/g
const BOX_CORNERS = /[┌┍┎┏┐┑┒┓└┕┖┗┘┙┚┛┌┐└┘╭╮╯╰╓╒╕╖╙╘╛╜╔╗╚╝]/g
const BOX_TEES = /[├┝┞┟┠┡┢┣┤┥┦┧┨┩┪┫┬┭┮┯┰┱┲┳┴┵┶┷┸┹┺┻┼┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋╠╣╦╩╬]/g

function cleanBoxDrawing(s) {
  return String(s || '')
    .replace(BOX_HORIZONTAL, '-')   // 横线 → -
    .replace(BOX_VERTICAL, '|')     // 竖线 → |
    .replace(BOX_CORNERS, '+')      // 角 → +
    .replace(BOX_TEES, '+')         // 三叉 → +
}

function compactBlankLines(s) {
  // 多个空行收成一个
  return String(s || '').replace(/\n[ \t]*\n+/g, '\n\n')
}

function trimTrailingSpaces(s) {
  return String(s || '').split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n')
}

/**
 * 取 PTY recentOutput 的"有意义"末尾。
 * 多步清洗：strip ANSI → strip box-drawing → 折叠空行 → 截尾。
 */
function extractTailSnippet(recentOutput, maxChars = 800) {
  let s = stripAnsi(recentOutput || '')
  s = cleanBoxDrawing(s)
  s = trimTrailingSpaces(s)
  s = compactBlankLines(s)
  s = s.trim()
  if (!s) return ''
  if (s.length <= maxChars) return s
  // 从尾部截，但尽量从最近的换行开始（避免半截行）
  const cut = s.slice(-maxChars)
  const nl = cut.indexOf('\n')
  return '…' + (nl > 0 && nl < 200 ? cut.slice(nl + 1) : cut)
}

function buildMessage({ event, todoId, todoTitle, snippet }) {
  const code = shortTodoId(todoId)
  const tag = code ? `[#t${code}]` : '[#hook]'
  const title = todoTitle ? `任务「${todoTitle}」` : '当前任务'
  const cleanSnippet = snippet ? extractTailSnippet(snippet, 800) : ''
  const snippetBlock = cleanSnippet ? `\n\n${cleanSnippet}\n\n（直接在这里回我，会转给 AI）` : ''
  switch (event) {
    case 'stop':
      return `🤖 ${tag} ${title} AI 一轮结束${snippetBlock || ' — 去 quadtodo Web UI 看，或回我下一步'}`
    case 'notification':
      return `⚠️ ${tag} ${title} AI 卡住等输入${snippetBlock || ''}`
    case 'session-end':
      return `✅ ${tag} ${title} AI session 已结束${snippetBlock || ''}`
    default:
      return `🦞 ${tag} ${title} hook event: ${event}${snippetBlock || ''}`
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
export function createOpenClawHookHandler({ db, openclaw, aiTerminal = null, cooldownMs = DEFAULT_COOLDOWN_MS } = {}) {
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
    // 优先：从 aiTerminal 拿这个 sessionId 的 recentOutput
    if (sessionId && aiTerminal?.sessions) {
      const sess = aiTerminal.sessions.get(sessionId)
      if (sess && (sess.recentOutput || sess.fullLog)) {
        snippet = sess.recentOutput || (Array.isArray(sess.fullLog) ? sess.fullLog.join('') : sess.fullLog)
      }
    }
    // 兜底：hook payload 里的字段（Claude Code 后续可能会传）
    if (!snippet && hookPayload && typeof hookPayload === 'object') {
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
      // SessionEnd 表示 PTY 已结束 → 清 last-push 防止下条用户消息误投
      if (evt === 'session-end' && openclaw.clearLastPushForSession) {
        openclaw.clearLastPushForSession(sessionId)
      }
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
