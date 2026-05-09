import { createLarkApiClient } from './lark-api-client.js'
import { createLarkEventClient } from './lark-event-client.js'

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

export function createLarkBot({
  getConfig,
  wizard,
  apiClientFactory = createLarkApiClient,
  eventClientFactory = createLarkEventClient,
  logger = console,
} = {}) {
  if (typeof getConfig !== 'function') throw new Error('getConfig_required')
  if (!wizard || typeof wizard.handleInbound !== 'function') throw new Error('wizard_required')

  const seenEvents = new Map()
  const pendingReplyRetries = new Map()
  let running = false
  let apiClient = null
  let eventClient = null

  function credentialsFromConfig() {
    const lark = getConfig()?.lark || {}
    return {
      appId: lark.appId || '',
      appSecret: lark.appSecret || '',
    }
  }

  function hasCredentials() {
    const { appId, appSecret } = credentialsFromConfig()
    return !isBlank(appId) && !isBlank(appSecret)
  }

  function getApiClient() {
    if (!apiClient) {
      apiClient = apiClientFactory({
        ...credentialsFromConfig(),
        logger,
      })
    }
    return apiClient
  }

  async function sendMessage({ chatId, text } = {}) {
    if (isBlank(chatId)) return { ok: false, reason: 'chatId_required' }
    if (isBlank(text)) return { ok: false, reason: 'text_required' }
    if (!hasCredentials()) return { ok: false, reason: 'lark_credentials_missing' }
    return getApiClient().sendMessage({ chatId, text })
  }

  async function replyInThread({ rootMessageId, text } = {}) {
    if (isBlank(rootMessageId)) return { ok: false, reason: 'rootMessageId_required' }
    if (isBlank(text)) return { ok: false, reason: 'text_required' }
    if (!hasCredentials()) return { ok: false, reason: 'lark_credentials_missing' }
    return getApiClient().replyInThread({ rootMessageId, text })
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
      detail: replyResult?.detail,
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

  async function start() {
    const cfg = getConfig()?.lark || {}
    if (!cfg.enabled || cfg.eventSubscribeEnabled === false) return { ok: false, reason: 'disabled' }
    if (isBlank(cfg.chatId)) return { ok: false, reason: 'chatId_missing' }
    if (!hasCredentials()) return { ok: false, reason: 'lark_credentials_missing' }
    if (running) return { ok: true, action: 'already_running' }

    eventClient = eventClientFactory({
      ...credentialsFromConfig(),
      onEvent: handleEvent,
      logger,
    })
    const result = await eventClient.start()
    if (!result?.ok) return result
    running = true
    return { ok: true, action: 'started' }
  }

  async function stop() {
    running = false
    const current = eventClient
    eventClient = null
    if (current?.stop) await current.stop()
    return { ok: true }
  }

  function describe() {
    const cfg = getConfig()?.lark || {}
    const eventStatus = eventClient?.describe?.() || null
    return {
      enabled: !!cfg.enabled,
      chatId: cfg.chatId || '',
      eventSubscribeEnabled: cfg.eventSubscribeEnabled !== false,
      running,
      eventStatus,
    }
  }

  return { start, stop, sendMessage, replyInThread, handleEvent, describe, __test__: { normalizeEvent } }
}
