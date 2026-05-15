import { createLarkApiClient } from './lark-api-client.js'
import { createLarkEventClient } from './lark-event-client.js'
import { downloadLarkImage, extractImageKeys } from './lark-image.js'
import { downloadLarkVideo, extractVideoFileKey } from './lark-video.js'

// 飞书内置 emoji_type 枚举里挑出一组"在思考 / 在干活"语义的值。
// 飞书的 emoji_type 是固定枚举（不是任意 unicode），不少看着合理的值（EYES / CLOCK /
// WOWFACE 等）都被服务端拒为 'reaction type is invalid'（code 231001）。
// 这里只保留实际验证过、飞书会接受的 emoji_type。
const BUSY_REACTION_EMOJIS = [
  'THINKING',    // 🤔 思考中
  'OK',          // 👌 已收到，正在做
]

function pickBusyReactionEmoji(rng = Math.random) {
  const i = Math.floor(rng() * BUSY_REACTION_EMOJIS.length)
  return BUSY_REACTION_EMOJIS[Math.min(i, BUSY_REACTION_EMOJIS.length - 1)]
}

function isBlank(value) {
  return value == null || String(value) === ''
}

function stripMentionKeys(text, mentions) {
  if (!text || typeof text !== 'string') return text || ''
  if (!Array.isArray(mentions) || mentions.length === 0) return text
  let out = text
  for (const m of mentions) {
    const key = m?.key
    if (!key || typeof key !== 'string') continue
    // 例如 "@_user_1"。占位符通常前后有空格，这里把 "<key> " / " <key>" / "<key>" 都替成空。
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(escaped + '\\s*', 'g'), '')
  }
  return out
}

// 飞书 post 富文本：content.content 是 [[node, node, ...], [node, ...], ...]，
// node.tag 可能是 'text' / 'at' / 'a'(超链接) / 'img' / 'emotion' 等。
// 提取所有可见文字节点（text / a 的 text / md 的 text），跳过 at(就是要剥的 @ 占位)。
function extractPostText(post) {
  if (!post || typeof post !== 'object') return ''
  const lines = Array.isArray(post.content) ? post.content : []
  const out = []
  for (const line of lines) {
    if (!Array.isArray(line)) continue
    let buf = ''
    for (const node of line) {
      if (!node || typeof node !== 'object') continue
      const tag = node.tag
      if (tag === 'text' || tag === 'a' || tag === 'md') {
        if (typeof node.text === 'string') buf += node.text
      }
    }
    if (buf) out.push(buf)
  }
  const body = out.join('\n').trim()
  if (body) return body
  if (typeof post.title === 'string' && post.title.trim()) return post.title.trim()
  return ''
}

export function extractText(message = {}) {
  let content = message.content
  if (typeof content === 'string') {
    try { content = JSON.parse(content) } catch { content = {} }
  }
  if (!content || typeof content !== 'object') return ''
  // 1. 普通 text 消息
  if (typeof content.text === 'string' && content.text) {
    return stripMentionKeys(content.text, message.mentions).replace(/^\s+/, '').trim()
  }
  // 2. post 富文本（@bot 的消息也是这种格式）
  if (Array.isArray(content.content)) {
    return extractPostText(content).trim()
  }
  // 3. 老的 title-only 兜底
  if (typeof content.title === 'string') {
    return stripMentionKeys(content.title, message.mentions).replace(/^\s+/, '').trim()
  }
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

/**
 * 把飞书 card.action.trigger event payload 拍平到 wizard.handleCallback 的参数：
 *   { channel: 'lark', chatId, threadId, callbackData, fromUserId }
 * action.value 是按钮的 value（构卡片时塞的 JSON），约定字段：
 *   { callback_data: 'qt:perm:abcd:allow' }   // 跟 telegram 的 callback_data 同字符串格式
 */
export function normalizeCardAction(raw = {}) {
  const event = raw.event || raw
  const action = event.action || {}
  const context = event.context || {}
  const operator = event.operator || {}
  const valueObj = action.value && typeof action.value === 'object' ? action.value : {}
  return {
    chatId: context.open_chat_id != null ? String(context.open_chat_id) : null,
    threadId: context.open_thread_id != null ? String(context.open_thread_id) : null,
    rootMessageId: context.open_message_id != null ? String(context.open_message_id) : null,
    callbackData: typeof valueObj.callback_data === 'string' ? valueObj.callback_data : '',
    fromUserId: operator.open_id != null ? String(operator.open_id) : (operator.user_id != null ? String(operator.user_id) : null),
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
  // sessionId → [{messageId, reactionId}]：跟踪每个 PTY session 期间 bot 加在用户消息上
  // 的 "在干活" reaction，等到 hook 报告 stop（Claude Code 完成一轮回复）时批量删掉。
  const pendingReactions = new Map()
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

  async function sendMessage({ chatId, text, format } = {}) {
    if (isBlank(chatId)) return { ok: false, reason: 'chatId_required' }
    if (isBlank(text)) return { ok: false, reason: 'text_required' }
    if (!hasCredentials()) return { ok: false, reason: 'lark_credentials_missing' }
    return getApiClient().sendMessage({ chatId, text, format })
  }

  async function replyInThread({ rootMessageId, text, format } = {}) {
    if (isBlank(rootMessageId)) return { ok: false, reason: 'rootMessageId_required' }
    if (isBlank(text)) return { ok: false, reason: 'text_required' }
    if (!hasCredentials()) return { ok: false, reason: 'lark_credentials_missing' }
    return getApiClient().replyInThread({ rootMessageId, text, format })
  }

  async function sendCard({ chatId, card } = {}) {
    if (isBlank(chatId)) return { ok: false, reason: 'chatId_required' }
    if (!card || typeof card !== 'object') return { ok: false, reason: 'card_required' }
    if (!hasCredentials()) return { ok: false, reason: 'lark_credentials_missing' }
    return getApiClient().sendCard({ chatId, card })
  }

  async function replyWithCard({ rootMessageId, card } = {}) {
    if (isBlank(rootMessageId)) return { ok: false, reason: 'rootMessageId_required' }
    if (!card || typeof card !== 'object') return { ok: false, reason: 'card_required' }
    if (!hasCredentials()) return { ok: false, reason: 'lark_credentials_missing' }
    return getApiClient().replyWithCard({ rootMessageId, card })
  }

  async function addReaction({ messageId, emojiType = 'THUMBSUP' } = {}) {
    if (isBlank(messageId)) return { ok: false, reason: 'messageId_required' }
    if (!hasCredentials()) return { ok: false, reason: 'lark_credentials_missing' }
    return getApiClient().addReaction({ messageId, emojiType })
  }

  // thread root 失效时（用户撤回 / 飞书 5xx）静默 drop。"撤回 root" = 用户明示
  // "不想看这个对话了"，把消息泼到群主消息流是污染。reply 失败就让它失败。
  async function deliverReply({ chatId, rootMessageId, text, format } = {}) {
    if (!rootMessageId) return sendMessage({ chatId, text, format })
    return replyInThread({ rootMessageId, text, format })
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
    if (configuredChatId && ev.chatId !== String(configuredChatId)) {
      logger.warn?.(`[lark-bot] ignored_chat: event chatId=${ev.chatId} != configured ${configuredChatId} (eventId=${ev.eventId})`)
      return { ok: true, action: 'ignored_chat' }
    }
    if (ev.senderType === 'app' || ev.senderType === 'bot') {
      logger.info?.(`[lark-bot] ignored_self: senderType=${ev.senderType} (eventId=${ev.eventId})`)
      return { ok: true, action: 'ignored_self' }
    }
    // 提取消息里的 image_key（普通 image 消息 + post 富文本里的 img 节点都能识别）
    const rawMsg = raw?.event?.message || raw?.message || {}
    const imageKeys = extractImageKeys(rawMsg)
    // msg_type === 'media' 时还会有视频；这里跟图片正交（不会误吃 image 消息的封面）
    const videoMeta = extractVideoFileKey(rawMsg)

    if (isBlank(ev.text) && imageKeys.length === 0 && !videoMeta) {
      const msgType = rawMsg.msg_type || rawMsg.message_type || '(unknown)'
      const contentRaw = typeof rawMsg.content === 'string' ? rawMsg.content : JSON.stringify(rawMsg.content || {})
      const mentions = JSON.stringify(rawMsg.mentions || [])
      // 附件类（media/file/video/audio）一旦走到 ignored_empty 一定是 extract 漏了，
      // 把完整 content dump 出来便于扩展 extractVideoFileKey 的识别规则
      const isAttachmentLike = /^(media|file|video|audio)$/i.test(String(msgType))
      if (isAttachmentLike) {
        logger.warn?.(`[lark-bot] ignored_empty (ATTACHMENT NOT RECOGNIZED): eventId=${ev.eventId} msg_type=${msgType} FULL_content=${contentRaw} mentions=${mentions}`)
      } else {
        logger.warn?.(`[lark-bot] ignored_empty: no text (eventId=${ev.eventId} msg_type=${msgType} content=${contentRaw.slice(0, 240)} mentions=${mentions.slice(0, 240)})`)
      }
      return { ok: true, action: 'ignored_empty' }
    }
    logger.info?.(`[lark-bot] dispatching to wizard: chatId=${ev.chatId} thread=${ev.threadId || '-'} root=${ev.rootMessageId || '-'} images=${imageKeys.length} video=${videoMeta ? '1' : '0'} text="${(ev.text || '').slice(0, 80)}"`)

    // 下载图片（顺序，简单点；并发收益不大）。失败的跳过，不阻塞 wizard。
    const imagePaths = []
    if (imageKeys.length > 0 && ev.messageId && hasCredentials()) {
      for (const key of imageKeys) {
        try {
          const dl = await downloadLarkImage({
            apiClient: getApiClient(),
            messageId: ev.messageId,
            imageKey: key,
          })
          if (dl?.ok && dl.localPath) {
            imagePaths.push(dl.localPath)
          } else {
            logger.warn?.(`[lark-bot] image download failed key=${key}: ${dl?.reason || 'unknown'} ${dl?.detail || ''}`)
          }
        } catch (e) {
          logger.warn?.(`[lark-bot] image download threw key=${key}: ${e.message}`)
        }
      }
      if (imagePaths.length > 0) {
        logger.info?.(`[lark-bot] downloaded ${imagePaths.length}/${imageKeys.length} image(s) for eventId=${ev.eventId}`)
      }
    }

    // 下载视频。跟图片走同款失败兜底：失败仅 warn，不阻塞 wizard；
    // 成功后路径塞进 imagePaths（CC 自己消化），并准备 caption 前缀给 wizard。
    let videoCaptionTag = null
    if (videoMeta && ev.messageId && hasCredentials()) {
      try {
        const dl = await downloadLarkVideo({
          apiClient: getApiClient(),
          messageId: ev.messageId,
          fileKey: videoMeta.fileKey,
          fileName: videoMeta.fileName,
        })
        if (dl?.ok && dl.localPath) {
          imagePaths.push(dl.localPath)
          const labelName = videoMeta.fileName || 'video.mp4'
          videoCaptionTag = `[用户发了视频：${labelName}]`
          logger.info?.(`[lark-bot] downloaded video → ${dl.localPath}`)
        } else {
          logger.warn?.(`[lark-bot] video download failed: ${dl?.reason || 'unknown'} ${dl?.detail || ''}`)
        }
      } catch (e) {
        logger.warn?.(`[lark-bot] video download threw: ${e.message}`)
      }
    }
    const wizardText = videoCaptionTag
      ? (ev.text ? `${videoCaptionTag}\n${ev.text}` : videoCaptionTag)
      : ev.text

    // 立即加 "在思考/在干活" reaction 让用户知道 bot 收到了；不 await，避免拖慢 wizard。
    // 拿到 reaction_id 后跟 wizard 返回的 sessionId 配对，等到 PTY 完成一轮回复时清掉。
    let reactionPromise = null
    if (ev.messageId && hasCredentials()) {
      reactionPromise = getApiClient()
        .addReaction({ messageId: ev.messageId, emojiType: pickBusyReactionEmoji() })
        .catch((e) => {
          logger.warn?.(`[lark-bot] reaction failed: ${e.message}`)
          return null
        })
    }

    let result
    try {
      result = await wizard.handleInbound({
        channel: 'lark',
        chatId: ev.chatId,
        threadId: ev.threadId,
        rootMessageId: ev.rootMessageId,
        messageId: ev.messageId,
        text: wizardText,
        fromUserId: ev.fromUserId,
        imagePaths: imagePaths.length > 0 ? imagePaths : undefined,
      })
    } catch (e) {
      forgetEvent()
      return { ok: false, reason: 'wizard_failed', detail: e.message }
    }

    // 关联 reaction 到 sessionId（如果 wizard 返回的是 stdin proxy 或 wizard_done 形态）。
    // 拿到 reaction_id 后存到 pendingReactions[sid]，等 PTY 完成时一次性删掉。
    const linkSid = result?.sessionId || null
    if (linkSid && reactionPromise && ev.messageId) {
      reactionPromise.then((r) => {
        const reactionId = r?.payload?.reaction_id || null
        if (!reactionId) return
        const list = pendingReactions.get(linkSid) || []
        list.push({ messageId: ev.messageId, reactionId })
        pendingReactions.set(linkSid, list)
      }).catch(() => {})
    }

    const action = result?.action || 'handled'
    if (result?.reply) {
      // 优先 reply 进用户当前所在的 thread：
      //   - rootMessageId（用户在已有 thread 里发的回复）
      //   - 退而求其次用 messageId（用户在新建话题里发第一条消息，没 root_id；
      //     用 reply API 直接回那条消息可让飞书把 reply 显示在同一个话题里）
      const replyTarget = ev.rootMessageId || ev.messageId || null
      const replyContext = {
        chatId: ev.chatId,
        rootMessageId: replyTarget,
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

  async function handleCardAction(raw) {
    const ev = normalizeCardAction(raw)
    if (!ev.chatId || !ev.callbackData) {
      return { ok: false, reason: 'invalid_card_action' }
    }
    const configuredChatId = getConfig()?.lark?.chatId
    if (configuredChatId && ev.chatId !== String(configuredChatId)) {
      logger.warn?.(`[lark-bot] ignored card_action from other chat: ${ev.chatId}`)
      return { ok: true, action: 'ignored_chat' }
    }
    if (typeof wizard.handleCallback !== 'function') {
      logger.warn?.(`[lark-bot] wizard.handleCallback unavailable; dropping lark card action`)
      return { ok: false, reason: 'no_handler' }
    }
    try {
      return await wizard.handleCallback({
        channel: 'lark',
        chatId: ev.chatId,
        threadId: ev.threadId,
        rootMessageId: ev.rootMessageId,
        callbackData: ev.callbackData,
        fromUserId: ev.fromUserId,
      })
    } catch (e) {
      logger.warn?.(`[lark-bot] card action handler failed: ${e.message}`)
      return { ok: false, reason: 'handler_failed', detail: e.message }
    }
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
      onCardAction: handleCardAction,
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

  /**
   * Claude Code 完成一轮回复后调用：把这个 session 期间加的 "在思考" reaction 全部删掉。
   * 调用方一般是 openclaw-hook 处理 stop / done event 时。失败 swallow，主流程不阻塞。
   */
  async function clearReactionsForSession(sessionId) {
    if (!sessionId) return { ok: true, removed: 0 }
    const list = pendingReactions.get(sessionId)
    pendingReactions.delete(sessionId)
    if (!list || list.length === 0) return { ok: true, removed: 0 }
    if (!hasCredentials()) return { ok: false, reason: 'lark_credentials_missing' }
    let removed = 0
    for (const { messageId, reactionId } of list) {
      const r = await getApiClient().deleteReaction({ messageId, reactionId }).catch((e) => ({ ok: false, detail: e.message }))
      if (r?.ok) removed++
      else logger.warn?.(`[lark-bot] reaction delete failed for sid=${sessionId} msg=${messageId} reaction=${reactionId}: ${r?.detail || r?.reason || 'unknown'}`)
    }
    return { ok: true, removed, total: list.length }
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
      pendingReactionSessions: pendingReactions.size,
    }
  }

  return { start, stop, sendMessage, replyInThread, sendCard, replyWithCard, handleEvent, handleCardAction, clearReactionsForSession, describe, __test__: { normalizeEvent, normalizeCardAction, _peekPendingReactions: () => new Map(pendingReactions) } }
}

export { BUSY_REACTION_EMOJIS, pickBusyReactionEmoji }
