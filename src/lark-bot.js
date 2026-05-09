import { spawn } from 'node:child_process'

const DEFAULT_TIMEOUT_MS = 60_000

function isBlank(value) {
  return value == null || String(value) === ''
}

export function extractText(message = {}) {
  let content = message.content
  if (typeof content === 'string') {
    try { content = JSON.parse(content) } catch { content = {} }
  }
  if (!content || typeof content !== 'object') return ''
  if (typeof content.text === 'string') return content.text
  if (typeof content.title === 'string') return content.title
  return ''
}

export function rememberSeen(seen, key, max = 500) {
  if (!key || seen.has(key)) return false
  seen.set(key, Date.now())
  while (seen.size > max) {
    let oldestKey
    let oldestTime = Infinity
    for (const [seenKey, timestamp] of seen.entries()) {
      if (timestamp < oldestTime) {
        oldestKey = seenKey
        oldestTime = timestamp
      }
    }
    if (oldestKey == null) break
    seen.delete(oldestKey)
  }
  return true
}

function stringOrNull(value) {
  return value == null ? null : String(value)
}

export function normalizeEvent(raw = {}) {
  const event = raw.event || raw
  const message = event.message || {}
  const sender = event.sender || {}
  const messageId = stringOrNull(message.message_id || message.messageId)
  return {
    eventId: stringOrNull(raw.event_id || raw.eventId || messageId),
    chatId: stringOrNull(message.chat_id || message.chatId),
    messageId,
    threadId: stringOrNull(message.thread_id || message.threadId),
    rootMessageId: stringOrNull(message.root_id || message.rootId || message.parent_id || message.parentId),
    text: extractText(message),
    fromUserId: stringOrNull(sender.sender_id?.open_id || sender.sender_id?.user_id || sender.open_id),
    senderType: sender.sender_type || sender.type || null,
  }
}

function runCli({ cliBin, args, spawnFn, logger }) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    let proc
    try {
      proc = spawnFn(cliBin, args, { env: process.env })
    } catch (e) {
      finish({ ok: false, reason: 'cli_spawn_failed', detail: e.message })
      return
    }

    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM') } catch {}
      finish({ ok: false, reason: 'timeout', stderr })
    }, DEFAULT_TIMEOUT_MS)
    timer.unref?.()

    proc.stdout?.on('data', (d) => { stdout += d.toString() })
    proc.stderr?.on('data', (d) => { stderr += d.toString() })
    proc.on('error', (e) => {
      clearTimeout(timer)
      finish({ ok: false, reason: 'cli_error', detail: e.message })
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        logger.warn?.(`[lark-bot] cli exit ${code}: ${stderr.trim().slice(0, 240)}`)
        finish({ ok: false, reason: 'cli_failed', exitCode: code, stderr })
        return
      }
      let payload = null
      try { payload = JSON.parse(stdout) } catch {}
      finish({ ok: true, payload, stdout })
    })
  })
}

export function createLarkBot({
  getConfig,
  wizard,
  cliBin = 'lark-cli',
  spawnFn = spawn,
  logger = console,
} = {}) {
  if (typeof getConfig !== 'function') throw new Error('getConfig_required')
  if (!wizard || typeof wizard.handleInbound !== 'function') throw new Error('wizard_required')

  const seenEvents = new Map()
  const pendingReplyRetries = new Map()
  let running = false
  let proc = null
  let buffer = ''
  let restartTimer = null

  async function sendMessage({ chatId, text } = {}) {
    if (isBlank(chatId)) return { ok: false, reason: 'chatId_required' }
    if (isBlank(text)) return { ok: false, reason: 'text_required' }
    return runCli({
      cliBin,
      spawnFn,
      logger,
      args: [
        'im', '+messages-send',
        '--chat-id', String(chatId),
        '--text', String(text),
        '--as', 'bot',
      ],
    })
  }

  async function replyInThread({ rootMessageId, text } = {}) {
    if (isBlank(rootMessageId)) return { ok: false, reason: 'rootMessageId_required' }
    if (isBlank(text)) return { ok: false, reason: 'text_required' }
    return runCli({
      cliBin,
      spawnFn,
      logger,
      args: [
        'im', '+messages-reply',
        '--message-id', String(rootMessageId),
        '--text', String(text),
        '--reply-in-thread',
        '--as', 'bot',
      ],
    })
  }

  async function deliverReply({ chatId, rootMessageId, text } = {}) {
    return rootMessageId
      ? replyInThread({ rootMessageId, text })
      : sendMessage({ chatId, text })
  }

  function clearPendingReplyRetry(replyContext, ev) {
    const keys = new Set([
      ...(replyContext?.retryKeys || []),
      ev.eventId,
      ev.messageId,
    ].filter(Boolean))
    for (const key of keys) pendingReplyRetries.delete(key)
  }

  function replyFailureResult(replyResult, reason = null) {
    return {
      ok: false,
      reason: reason || replyResult?.reason || 'reply_failed',
      detail: replyResult?.detail || replyResult?.stderr,
    }
  }

  async function handleEvent(raw) {
    const ev = normalizeEvent(raw)
    if (!ev.eventId) {
      return { ok: true, action: 'duplicate' }
    }

    const pendingReplyRetry = pendingReplyRetries.get(ev.eventId) || (ev.messageId ? pendingReplyRetries.get(ev.messageId) : null)
    if (pendingReplyRetry) {
      const retryResult = await deliverReply(pendingReplyRetry)
      if (!retryResult?.ok) {
        return replyFailureResult(retryResult, 'reply_retry_failed')
      }
      clearPendingReplyRetry(pendingReplyRetry, ev)
      return { ok: true, action: pendingReplyRetry.action || 'handled' }
    }

    if (seenEvents.has(ev.eventId) || (ev.messageId && seenEvents.has(ev.messageId))) {
      return { ok: true, action: 'duplicate' }
    }
    rememberSeen(seenEvents, ev.eventId)
    if (ev.messageId && ev.messageId !== ev.eventId) rememberSeen(seenEvents, ev.messageId)
    const forgetEvent = () => {
      seenEvents.delete(ev.eventId)
      if (ev.messageId && ev.messageId !== ev.eventId) seenEvents.delete(ev.messageId)
    }

    const configuredChatId = getConfig()?.lark?.chatId
    if (configuredChatId && ev.chatId !== String(configuredChatId)) return { ok: true, action: 'ignored_chat' }
    if (ev.senderType === 'app' || ev.senderType === 'bot') return { ok: true, action: 'ignored_self' }
    if (isBlank(ev.text)) return { ok: true, action: 'ignored_empty' }

    let result
    try {
      result = await wizard.handleInbound({
        channel: 'lark',
        chatId: ev.chatId,
        threadId: ev.threadId,
        rootMessageId: ev.rootMessageId,
        messageId: ev.messageId,
        text: ev.text,
        fromUserId: ev.fromUserId,
      })
    } catch (e) {
      forgetEvent()
      return { ok: false, reason: 'wizard_failed', detail: e.message }
    }

    const action = result?.action || 'handled'
    if (result?.reply) {
      const replyContext = {
        chatId: ev.chatId,
        rootMessageId: ev.rootMessageId,
        text: result.reply,
        action,
        retryKeys: [ev.eventId, ev.messageId].filter(Boolean),
      }
      const replyResult = await deliverReply(replyContext)
      if (!replyResult?.ok) {
        pendingReplyRetries.set(ev.eventId, replyContext)
        if (ev.messageId && ev.messageId !== ev.eventId) pendingReplyRetries.set(ev.messageId, replyContext)
        return replyFailureResult(replyResult)
      }
    }

    return { ok: true, action }
  }

  function scheduleRestart() {
    if (!running || restartTimer) return
    restartTimer = setTimeout(() => {
      restartTimer = null
      if (running) start()
    }, 5000)
    restartTimer.unref?.()
  }

  function attachSubscriber(subscriber) {
    subscriber.stdout?.on('data', (chunk) => {
      buffer += chunk.toString()
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)
        if (line) {
          try {
            handleEvent(JSON.parse(line)).catch((e) => logger.warn?.(`[lark-bot] event handler failed: ${e.message}`))
          } catch (e) {
            logger.warn?.(`[lark-bot] non-json event: ${line.slice(0, 240)}`)
          }
        }
        newlineIndex = buffer.indexOf('\n')
      }
    })
    subscriber.stderr?.on('data', (chunk) => {
      const text = chunk.toString().trim()
      if (text) logger.warn?.(`[lark-bot] subscriber stderr: ${text.slice(0, 240)}`)
    })
    subscriber.on('error', (e) => {
      logger.warn?.(`[lark-bot] subscriber error: ${e.message}`)
      proc = null
      scheduleRestart()
    })
    subscriber.on('close', (code) => {
      logger.warn?.(`[lark-bot] subscriber closed: ${code}`)
      proc = null
      scheduleRestart()
    })
  }

  async function start() {
    const cfg = getConfig()?.lark || {}
    if (!cfg.enabled || cfg.eventSubscribeEnabled === false) return { ok: false, reason: 'disabled' }
    if (isBlank(cfg.chatId)) return { ok: false, reason: 'chatId_missing' }
    if (proc) return { ok: true, action: 'already_running' }

    running = true
    buffer = ''
    try {
      proc = spawnFn(cliBin, ['event', '+subscribe', '--event-types', 'im.message.receive_v1', '--compact', '--as', 'bot'], { env: process.env })
    } catch (e) {
      proc = null
      logger.warn?.(`[lark-bot] subscriber spawn failed: ${e.message}`)
      scheduleRestart()
      return { ok: false, reason: 'cli_spawn_failed', detail: e.message }
    }
    attachSubscriber(proc)
    return { ok: true, action: 'started' }
  }

  async function stop() {
    running = false
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    if (proc) {
      try { proc.kill('SIGTERM') } catch {}
      proc = null
    }
    return { ok: true }
  }

  function describe() {
    const cfg = getConfig()?.lark || {}
    return {
      enabled: !!cfg.enabled,
      chatId: cfg.chatId || '',
      eventSubscribeEnabled: cfg.eventSubscribeEnabled !== false,
      running,
    }
  }

  return { start, stop, sendMessage, replyInThread, handleEvent, describe, __test__: { normalizeEvent } }
}
