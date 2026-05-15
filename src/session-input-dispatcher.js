/**
 * Session Input Dispatcher
 *
 * 所有 "把用户文本投递到一个 Claude Code session" 的路径都走这里。
 * 三档语义：
 *   - queue_or_send  ：普通文本，busy 时入队，idle 时直发
 *   - soft_interrupt ：`!` 前缀，busy 时 Esc → 250ms 后投递新文本，丢弃旧队列
 *   - hard_cancel    ：`!!` 前缀 或精确 `/stop`，busy 时 Ctrl+C，不投递文本
 */

import { createHash } from 'node:crypto'

const QUEUE_LIMIT = 20
const STALE_MS = 5 * 60 * 1000
const SOFT_INTERRUPT_DELAY_MS = 250
// 安全网：awaitingReply=false 但 PTY 已经 N 毫秒没 output → 视为 idle，直接写。
// 历史 bug：浏览器 / REST 上无关的 input 把 awaitingReply 推回 false 后，dispatcher
// 把 IM 消息全部 queue，必须等下次 Stop hook 才会 flush；如果 Claude 没新输入就一直卡。
// 这里给 dispatcher 一个 "Claude 大概率在 idle prompt" 的兜底判断（PTY busy 时是连续
// 输出 spinner / token，3s 静默基本不可能是真 busy）。
const IDLE_GRACE_MS = 3000

const ORIGIN_TTL_MS = 30_000
const ORIGIN_LIMIT = 16

function normalizeAndHash(text) {
  const normalized = String(text || '').trim().replace(/\s+/g, ' ')
  return createHash('sha1').update(normalized).digest('hex')
}

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

// 写真实文本到 PTY 后，更新 ai-terminal awaitingReply=false（"已经把输入交给 Claude，现在它在干活"）。
// 写 Esc / Ctrl+C 这类控制字符不调用此函数，因为它们让 Claude 回到 idle prompt 而不是开始新 turn。
function markBusyAfterWrite(aiTerminal, sessionId) {
  try { aiTerminal.markSessionAwaitingReply?.(sessionId, false) } catch { /* ignore */ }
}

export function createSessionInputDispatcher({ pty, aiTerminal, callbacks = {}, logger = console } = {}) {
  if (!pty) throw new Error('pty_required')
  if (!aiTerminal) throw new Error('aiTerminal_required')

  // sessionId → QueueState { items, firstEchoMessageId, staleTimer }
  const queues = new Map()
  // sessionId set: 软中断 250ms 窗口内
  const softInterrupting = new Set()

  // sessionId → Array<{ hash, channel, ts }>。30s TTL，FIFO 上限 ORIGIN_LIMIT。
  // 用于让 UserPromptSubmit hook 区分"这条 prompt 来自 telegram / lark / PC"。
  const lastOrigins = new Map()

  function recordOrigin(sessionId, text, channel) {
    if (!sessionId || !text || !channel) return
    const now = Date.now()
    const prior = (lastOrigins.get(sessionId) || []).filter(e => now - e.ts < ORIGIN_TTL_MS)
    const trimmed = prior.slice(-(ORIGIN_LIMIT - 1))
    trimmed.push({ hash: normalizeAndHash(text), channel, ts: now })
    lastOrigins.set(sessionId, trimmed)
  }

  function consumeOrigin(sessionId, text) {
    if (!sessionId || !text) return null
    const arr = lastOrigins.get(sessionId)
    if (!arr || !arr.length) return null
    const h = normalizeAndHash(text)
    const now = Date.now()
    const idx = arr.findIndex(e => e.hash === h && now - e.ts < ORIGIN_TTL_MS)
    if (idx < 0) return null
    const { channel } = arr[idx]
    arr.splice(idx, 1)
    if (!arr.length) lastOrigins.delete(sessionId)
    return channel
  }

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
    q.items.push({ text: stripped, imagePaths, channel, enqueuedAt: Date.now() })
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
    let idle = aiTerminal.isSessionAwaitingReply(sessionId)

    // 兜底：awaitingReply=false 但 PTY 已经静默 ≥ IDLE_GRACE_MS → 视为 idle 直发。
    // 不动 hard_cancel —— 那一档不依赖 idle 状态（无条件发 \x03 中断），
    // 这里加 grace 反而会让 idle 走 noop_idle 分支吞掉用户的 /stop。
    if (!idle && mode !== 'hard_cancel') {
      try {
        const sess = aiTerminal?.sessions?.get?.(sessionId)
        const lastOut = sess?.lastOutputAt || 0
        if (lastOut > 0 && (Date.now() - lastOut) >= IDLE_GRACE_MS) {
          logger?.info?.(`[dispatcher] idle-grace promote sid=${sessionId} silent_for_ms=${Date.now() - lastOut} (awaitingReply=${sess?.awaitingReply})`)
          idle = true
        }
      } catch { /* ignore */ }
    }

    if (idle) {
      if (mode === 'hard_cancel') {
        return { action: 'noop_idle', sessionId }
      }
      // queue_or_send / soft_interrupt 在 idle 下都等同直发 stripped
      const payload = buildPayload(stripped, imagePaths)
      writeToPty(pty, sessionId, payload, logger)
      markBusyAfterWrite(aiTerminal, sessionId)
      if (channel && stripped) recordOrigin(sessionId, stripped, channel)
      return { action: 'sent', sessionId }
    }

    if (mode === 'queue_or_send') {
      // 诊断：busy 判定 = aiTerminal.isSessionAwaitingReply(sid) 返回 false。Stop hook
      // 应该已经把 awaitingReply 置 true 了，跑到这里说明 (a) hook 没 fire (b) markS... no-op
      // (c) 中间被 web UI / REST input / PTY exit 重置回去了。把当前快照打出来，便于排查
      // "飞书发消息一直被排队"这类卡死。
      try {
        const sess = aiTerminal?.sessions?.get?.(sessionId)
        logger?.warn?.(`[dispatcher] queueing (idle=false) sid=${sessionId} sessionExists=${!!sess} status=${sess?.status || 'null'} awaitingReply=${sess?.awaitingReply} text=${String(stripped || '').slice(0, 40)}`)
      } catch { /* ignore diag */ }
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
      return await performSoftInterrupt({ sessionId, stripped, imagePaths, channel })
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

  async function performSoftInterrupt({ sessionId, stripped, imagePaths, channel }) {
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
      markBusyAfterWrite(aiTerminal, sessionId)
      if (channel && stripped) recordOrigin(sessionId, stripped, channel)
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
      markBusyAfterWrite(aiTerminal, sessionId)
    } catch (e) {
      logger?.warn?.(`[dispatcher] flush write failed sid=${sessionId}: ${e.message}`)
      return { flushed: 0, error: e.message }
    }
    // 写入成功才记 origin —— 跟 idle / soft-interrupt 两条路径保持一致（recordOrigin 不抛错，所以放 try 外）
    // 取队列里最新的 channel；混合 channel 场景极少见，echo 会跳过那一个 channel
    const lastChan = q.items[q.items.length - 1]?.channel
    if (lastChan && combinedText) recordOrigin(sessionId, combinedText, lastChan)
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
    lastOrigins.delete(sessionId)
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

  return { send, onSessionIdle, onSessionEnd, describe, recordOrigin, consumeOrigin, __test__: { queues, parseTrigger } }
}
