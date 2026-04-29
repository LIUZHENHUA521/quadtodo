/**
 * Pending-question 协调器：
 *   - ticket 生成（3 字符 base32, RFC 4648 字符集 a-z2-7，转小写）
 *   - DB 持久化（pending_questions 表）
 *   - Promise 池（ticket → resolveFn）让 ask_user MCP 工具能阻塞等待用户回复
 *   - 用户回复路由：解析 ticket prefix → fallback 最近一条 → 选项模糊匹配
 *   - 超时 sweeper：定期把过期 pending 标 timeout 并 reject 对应 promise
 */
import { randomInt } from 'node:crypto'

const TICKET_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567' // 32 字符
const TICKET_LENGTH = 3
const MAX_GENERATE_RETRIES = 16

const DEFAULT_SWEEP_INTERVAL_MS = 30_000

function generateTicket() {
  let out = ''
  for (let i = 0; i < TICKET_LENGTH; i++) {
    out += TICKET_ALPHABET[randomInt(0, TICKET_ALPHABET.length)]
  }
  return out
}

const EXPLICIT_TICKET_RE = new RegExp(`^#([${TICKET_ALPHABET}]{${TICKET_LENGTH}})\\b`, 'i')
const BARE_TICKET_RE = new RegExp(`^([${TICKET_ALPHABET}]{${TICKET_LENGTH}})\\b`, 'i')

function stripPrefixSeparators(s) {
  return s.replace(/^[\s,:#]+/, '').trim()
}

/**
 * 纯选项匹配。不再尝试提取 ticket（ticket 提取改由 submitReply 配合 DB 判断）。
 *
 * 优先级：
 *   1) 整段 startswith 数字 1..N → options[index-1]
 *   2) startswith / contains 任一 option（大小写不敏感）
 *   3) 都不匹配 → free text，原文返回
 */
export function parseReply(rawText, options = []) {
  const text = String(rawText || '').trim()
  if (!text) return { freeText: '', raw: rawText, chosenIndex: null }

  // 1) 纯数字 1..N
  const numMatch = text.match(/^(\d+)\b/)
  if (numMatch) {
    const idx = parseInt(numMatch[1], 10) - 1
    if (idx >= 0 && idx < options.length) {
      return { chosenIndex: idx, freeText: text, raw: rawText }
    }
  }

  // 2) 选项文本匹配 — 先严格 startswith / 再宽松 contains
  const lower = text.toLowerCase()
  for (let i = 0; i < options.length; i++) {
    const opt = String(options[i] || '').toLowerCase()
    if (!opt) continue
    if (lower === opt || lower.startsWith(opt) || opt.startsWith(lower)) {
      return { chosenIndex: i, freeText: text, raw: rawText }
    }
  }
  for (let i = 0; i < options.length; i++) {
    const opt = String(options[i] || '').toLowerCase()
    if (opt && lower.includes(opt)) {
      return { chosenIndex: i, freeText: text, raw: rawText }
    }
  }

  return { chosenIndex: null, freeText: text, raw: rawText }
}

/**
 * 从用户回复中尝试提取 ticket 候选。
 *   - `#xxx ...` 显式 → 强制路由（即使 ticket 不存在也按 ticket 处理，让上层回 ticket_not_pending）
 *   - `xxx ...` 裸前缀 → 软路由（仅当上层确认 ticket 在 DB 里 pending 才采用）
 *
 * 返回 { explicit, candidate, body }。
 */
export function extractTicketCandidate(rawText) {
  const text = String(rawText || '').trim()
  const exp = text.match(EXPLICIT_TICKET_RE)
  if (exp) {
    return {
      explicit: exp[1].toLowerCase(),
      candidate: null,
      body: stripPrefixSeparators(text.slice(exp[0].length)),
    }
  }
  const bare = text.match(BARE_TICKET_RE)
  if (bare) {
    return {
      explicit: null,
      candidate: bare[1].toLowerCase(),
      body: stripPrefixSeparators(text.slice(bare[0].length)),
    }
  }
  return { explicit: null, candidate: null, body: text }
}

/**
 * 启动一个协调器实例。
 *
 * 依赖：
 *   - db: 暴露 createPendingQuestion / getPendingQuestion / answerPendingQuestion /
 *         setPendingStatus / getLatestPendingQuestion / sweepExpiredPendingQuestions
 */
export function createPendingQuestionCoordinator({ db, sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS, logger = console } = {}) {
  if (!db) throw new Error('db_required')

  // ticket → { resolve, reject, options, createdAt, expiresAt }
  const waiters = new Map()

  function makeFreshTicket() {
    for (let i = 0; i < MAX_GENERATE_RETRIES; i++) {
      const t = generateTicket()
      const existing = db.getPendingQuestion(t)
      if (!existing || existing.status !== 'pending') return t
    }
    throw new Error('ticket_generate_exhausted')
  }

  /**
   * 创建一条 pending question 并返回一个会 resolve 成 result 的 Promise。
   * 调用方（ask_user MCP）应 await 这个 Promise；
   * 若超时或被取消，会 resolve 成 { status: 'timeout' | 'cancelled' }（不 reject）。
   */
  function ask({ sessionId, todoId, question, options, timeoutMs = 600_000 }) {
    if (!sessionId) throw new Error('session_id_required')
    if (!question) throw new Error('question_required')
    if (!Array.isArray(options) || options.length === 0) throw new Error('options_required')

    const ticket = makeFreshTicket()
    db.createPendingQuestion({ ticket, sessionId, todoId, question, options, timeoutMs })

    const promise = new Promise((resolve) => {
      const startedAt = Date.now()
      const timer = setTimeout(() => {
        const w = waiters.get(ticket)
        if (!w) return
        waiters.delete(ticket)
        try { db.setPendingStatus(ticket, 'timeout') } catch {}
        resolve({
          ticket,
          status: 'timeout',
          chosen: null,
          chosenIndex: null,
          answerText: null,
          elapsedMs: Date.now() - startedAt,
        })
      }, timeoutMs)
      timer.unref?.()
      waiters.set(ticket, {
        resolve: (payload) => {
          clearTimeout(timer)
          waiters.delete(ticket)
          resolve({ ticket, ...payload, elapsedMs: Date.now() - startedAt })
        },
        options,
        startedAt,
      })
    })

    return { ticket, promise }
  }

  /**
   * 根据用户回复路由到一条 pending question。
   * 优先级：ticket prefix → 最近一条 pending。
   * 返回 { matched: true, ticket, chosen, chosenIndex, answerText } 或
   *      { matched: false, reason }
   */
  function submitReply(rawText) {
    const text = String(rawText || '').trim()
    if (!text) return { matched: false, reason: 'empty' }

    const { explicit, candidate, body: bodyAfterPrefix } = extractTicketCandidate(text)
    let target = null
    let matchBody = text

    if (explicit) {
      target = db.getPendingQuestion(explicit)
      if (!target || target.status !== 'pending') {
        return { matched: false, reason: 'ticket_not_pending', ticket: explicit }
      }
      matchBody = bodyAfterPrefix
    } else if (candidate) {
      const probe = db.getPendingQuestion(candidate)
      if (probe && probe.status === 'pending') {
        target = probe
        matchBody = bodyAfterPrefix
      }
    }
    if (!target) {
      target = db.getLatestPendingQuestion()
      if (!target) return { matched: false, reason: 'no_pending' }
      // bare-prefix 没命中真 ticket：用全文做选项匹配（不剥前缀）
      matchBody = text
    }

    const parsed = parseReply(matchBody, target.options)
    const answerText = parsed.freeText || matchBody || text

    db.answerPendingQuestion(target.ticket, {
      answerText,
      chosenIndex: parsed.chosenIndex,
    })

    const waiter = waiters.get(target.ticket)
    const chosen = parsed.chosenIndex != null
      ? target.options[parsed.chosenIndex]
      : null
    if (waiter) {
      waiter.resolve({
        status: 'answered',
        chosen,
        chosenIndex: parsed.chosenIndex,
        answerText,
      })
    }

    return {
      matched: true,
      ticket: target.ticket,
      todoId: target.todoId,
      sessionId: target.sessionId,
      chosen,
      chosenIndex: parsed.chosenIndex,
      answerText,
    }
  }

  function cancel(ticket, reason = 'user_cancelled') {
    const existing = db.getPendingQuestion(ticket)
    if (!existing) return { ok: false, reason: 'not_found' }
    if (existing.status !== 'pending') return { ok: false, reason: 'not_pending', status: existing.status }
    db.setPendingStatus(ticket, 'cancelled')
    const waiter = waiters.get(ticket)
    if (waiter) {
      waiter.resolve({
        status: 'cancelled',
        chosen: null,
        chosenIndex: null,
        answerText: reason || null,
      })
    }
    return { ok: true, ticket }
  }

  function listPending() {
    return db.listPendingQuestions().map((row) => ({
      ...row,
      ageSeconds: Math.floor((Date.now() - row.createdAt) / 1000),
      remainingSeconds: Math.max(0, Math.floor(((row.createdAt + row.timeoutMs) - Date.now()) / 1000)),
    }))
  }

  function sweep() {
    try {
      const changed = db.sweepExpiredPendingQuestions()
      if (changed > 0) logger.info?.(`[pending-questions] swept ${changed} expired`)
    } catch (e) {
      logger.warn?.(`[pending-questions] sweep failed: ${e.message}`)
    }
  }

  // 启动后台 sweeper
  let sweepTimer = null
  function start() {
    if (sweepTimer) return
    sweepTimer = setInterval(sweep, sweepIntervalMs)
    sweepTimer.unref?.()
  }
  function stop() {
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null }
  }

  return {
    ask,
    submitReply,
    cancel,
    listPending,
    sweep,
    start,
    stop,
    // 测试用
    _waiters: waiters,
    _generateTicket: generateTicket,
  }
}

export const __test__ = {
  generateTicket,
  parseReply,
  extractTicketCandidate,
  TICKET_ALPHABET,
  TICKET_LENGTH,
}
