/**
 * Session Input Dispatcher
 *
 * 所有 "把用户文本投递到一个 Claude Code session" 的路径都走这里。
 * 三档语义：
 *   - queue_or_send  ：普通文本，busy 时入队，idle 时直发
 *   - soft_interrupt ：`!` 前缀，busy 时 Esc → 250ms 后投递新文本，丢弃旧队列
 *   - hard_cancel    ：`!!` 前缀 或精确 `/stop`，busy 时 Ctrl+C，不投递文本
 */

const QUEUE_LIMIT = 20
const STALE_MS = 5 * 60 * 1000
const SOFT_INTERRUPT_DELAY_MS = 250

export function parseTrigger(rawText) {
  const text = String(rawText || '').trim()
  if (text === '/stop') return { mode: 'hard_cancel', stripped: '' }
  if (text.startsWith('!!')) return { mode: 'hard_cancel', stripped: '' }
  if (text.startsWith('!')) return { mode: 'soft_interrupt', stripped: text.slice(1).trim() }
  return { mode: 'queue_or_send', stripped: text }
}

function buildPayload(text, imagePaths) {
  if (!imagePaths || imagePaths.length === 0) return text
  const ats = imagePaths.map((p) => `@${p}`).join(' ')
  return text ? `${ats} ${text}` : ats
}

function writeToPty(pty, sessionId, payload, logger) {
  pty.write(sessionId, payload)
  setTimeout(() => {
    try { pty.write(sessionId, '\r') } catch (e) {
      logger?.warn?.(`[dispatcher] submit \\r failed sid=${sessionId}: ${e.message}`)
    }
  }, 80)
}

export function createSessionInputDispatcher({ pty, aiTerminal, callbacks = {}, logger = console } = {}) {
  if (!pty) throw new Error('pty_required')
  if (!aiTerminal) throw new Error('aiTerminal_required')

  // sessionId → QueueState { items, firstEchoMessageId, staleTimer }
  const queues = new Map()
  // sessionId set: 软中断 250ms 窗口内
  const softInterrupting = new Set()

  function getOrCreateQueue(sessionId) {
    let q = queues.get(sessionId)
    if (!q) {
      q = { items: [], staleTimer: null, firstEchoMessageId: null }
      queues.set(sessionId, q)
    }
    return q
  }

  async function enqueue({ sessionId, stripped, imagePaths, channel, echoTarget }) {
    const q = getOrCreateQueue(sessionId)
    if (q.items.length >= QUEUE_LIMIT) {
      return { full: true, queueSize: q.items.length }
    }
    q.items.push({ text: stripped, imagePaths, enqueuedAt: Date.now() })
    if (q.staleTimer) clearTimeout(q.staleTimer)
    q.staleTimer = setTimeout(() => {
      if (callbacks.onStale) {
        Promise.resolve(callbacks.onStale({ sessionId, channel, echoTarget, queueSize: q.items.length }))
          .catch((e) => logger?.warn?.(`[dispatcher] onStale failed: ${e.message}`))
      }
    }, STALE_MS)
    const isFirst = q.items.length === 1
    const cb = isFirst ? callbacks.onQueueFirstEnqueue : callbacks.onQueueAdditionalEnqueue
    if (cb) {
      try {
        const echo = await cb({ sessionId, channel, echoTarget, queueSize: q.items.length })
        if (isFirst && echo?.messageId) q.firstEchoMessageId = echo.messageId
      } catch (e) {
        logger?.warn?.(`[dispatcher] echo callback failed: ${e.message}`)
      }
    }
    return { full: false, queueSize: q.items.length }
  }

  async function send({ sessionId, text, imagePaths = [], channel, echoTarget } = {}) {
    if (!pty.has(sessionId)) {
      return { action: 'session_ended', sessionId }
    }
    const { mode, stripped } = parseTrigger(text)
    const idle = aiTerminal.isSessionAwaitingReply(sessionId)

    if (idle) {
      if (mode === 'hard_cancel') {
        return { action: 'noop_idle', sessionId }
      }
      // queue_or_send / soft_interrupt 在 idle 下都等同直发 stripped
      const payload = buildPayload(stripped, imagePaths)
      writeToPty(pty, sessionId, payload, logger)
      return { action: 'sent', sessionId }
    }

    if (mode === 'queue_or_send') {
      const r = await enqueue({ sessionId, stripped, imagePaths, channel, echoTarget })
      if (r.full) return { action: 'queue_full', queueSize: r.queueSize, sessionId }
      return { action: 'queued', queueSize: r.queueSize, sessionId }
    }

    if (mode === 'soft_interrupt') {
      if (softInterrupting.has(sessionId)) {
        // 250ms 窗口内的第 2 个 ! → 降级为入队
        const r = await enqueue({ sessionId, stripped, imagePaths, channel, echoTarget })
        if (r.full) return { action: 'queue_full', queueSize: r.queueSize, sessionId }
        return { action: 'queued', queueSize: r.queueSize, reason: 'soft_interrupt_in_progress', sessionId }
      }
      return await performSoftInterrupt({ sessionId, stripped, imagePaths })
    }

    if (mode === 'hard_cancel') {
      return await performHardCancel({ sessionId, channel, echoTarget })
    }

    return { action: 'noop', reason: 'unknown_mode', sessionId }
  }

  async function performHardCancel({ sessionId, channel, echoTarget }) {
    const q = queues.get(sessionId)
    if (q) {
      if (q.staleTimer) clearTimeout(q.staleTimer)
      queues.delete(sessionId)
    }
    pty.write(sessionId, '\x03')
    if (callbacks.onHardCancel) {
      try { await callbacks.onHardCancel({ sessionId, channel, echoTarget }) }
      catch (e) { logger?.warn?.(`[dispatcher] onHardCancel callback failed: ${e.message}`) }
    }
    return { action: 'hard_cancelled', sessionId }
  }

  async function performSoftInterrupt({ sessionId, stripped, imagePaths }) {
    // 丢弃旧队列
    const q = queues.get(sessionId)
    if (q) {
      if (q.staleTimer) clearTimeout(q.staleTimer)
      queues.delete(sessionId)
    }
    // 立刻发 Esc
    pty.write(sessionId, '\x1b')
    softInterrupting.add(sessionId)
    // 等 TUI 回到 prompt
    await new Promise((resolve) => setTimeout(resolve, SOFT_INTERRUPT_DELAY_MS))
    softInterrupting.delete(sessionId)
    // 投递新文本（如果有）
    if (stripped || (imagePaths && imagePaths.length)) {
      const payload = buildPayload(stripped, imagePaths)
      writeToPty(pty, sessionId, payload, logger)
    }
    return { action: 'soft_interrupted', sessionId }
  }

  async function flushQueue(sessionId) {
    const q = queues.get(sessionId)
    if (!q || q.items.length === 0) return { flushed: 0 }
    const allImages = []
    const texts = []
    for (const item of q.items) {
      if (item.imagePaths && item.imagePaths.length) allImages.push(...item.imagePaths)
      if (item.text) texts.push(item.text)
    }
    const count = q.items.length
    const combinedText = texts.join('\n')
    const payload = buildPayload(combinedText, allImages)
    if (q.staleTimer) { clearTimeout(q.staleTimer); q.staleTimer = null }
    queues.delete(sessionId)
    try {
      writeToPty(pty, sessionId, payload, logger)
    } catch (e) {
      logger?.warn?.(`[dispatcher] flush write failed sid=${sessionId}: ${e.message}`)
      return { flushed: 0, error: e.message }
    }
    if (callbacks.onFlush) {
      try { await callbacks.onFlush({ sessionId, count }) }
      catch (e) { logger?.warn?.(`[dispatcher] onFlush callback failed: ${e.message}`) }
    }
    return { flushed: count }
  }

  async function onSessionIdle(sessionId) {
    return flushQueue(sessionId)
  }

  async function onSessionEnd(sessionId) {
    const q = queues.get(sessionId)
    if (!q) return
    if (q.staleTimer) clearTimeout(q.staleTimer)
    const undelivered = q.items.slice()
    queues.delete(sessionId)
    if (callbacks.onSessionEnd) {
      try {
        await callbacks.onSessionEnd({
          sessionId,
          undeliveredCount: undelivered.length,
          undeliveredTexts: undelivered.map((it) => it.text),
        })
      } catch (e) {
        logger?.warn?.(`[dispatcher] onSessionEnd callback failed: ${e.message}`)
      }
    }
  }

  function describe() {
    const byId = {}
    for (const [sid, q] of queues.entries()) {
      byId[sid] = {
        queueSize: q.items.length,
        oldestEnqueuedAt: q.items[0]?.enqueuedAt ?? null,
      }
    }
    return { sessions: queues.size, byId }
  }

  return { send, onSessionIdle, onSessionEnd, describe, __test__: { queues, parseTrigger } }
}
