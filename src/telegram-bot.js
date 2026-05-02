/**
 * quadtodo 自己跑的 Telegram bot：
 *   - 长轮询 getUpdates 拿入站消息（含 message_thread_id 用于 Topic 路由）
 *   - 出站 sendMessage / sendDocument / createForumTopic / closeForumTopic / editForumTopic
 *
 * 设计原则：
 *   - 全 fetch 走 ProxyAgent（HTTPS_PROXY env），与 openclaw-bridge 一致
 *   - 入站派发到 wizard.handleInbound({ chatId, threadId, text, fromUserId })
 *   - wizard 返回 reply 时，自动 sendMessage 回去（保持 thread）
 *   - 安全：白名单 allowedChatIds（空 = 拒所有）；不在白名单的消息只 log + drop
 *   - offset 持久化到 ~/.quadtodo/telegram-offset.json，重启不丢
 *   - 失败一律不阻塞主循环，5s 退避
 *
 * 不在 v1：
 *   - 媒体（图片/语音/文件）入站
 *   - inline keyboard 按钮
 *   - 多 bot 多 supergroup
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { Blob } from 'node:buffer'
import { toTelegramV2, toPlainText } from './telegram-markdown.js'

const TELEGRAM_API = 'https://api.telegram.org'
const DEFAULT_LONG_POLL_TIMEOUT_SEC = 30
const DEFAULT_OFFSET_FILE = join(homedir(), '.quadtodo', 'telegram-offset.json')
const POLL_RETRY_DELAY_MS = 5_000

/** 走 HTTPS_PROXY 的 fetch（懒加载，避免无 proxy 环境失败）。 */
let _proxyFetch = null
async function getProxyFetch() {
  if (_proxyFetch) return _proxyFetch
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy
                || process.env.HTTP_PROXY  || process.env.http_proxy
  if (!proxyUrl) {
    _proxyFetch = (url, opts) => fetch(url, opts)
    return _proxyFetch
  }
  try {
    const { ProxyAgent, fetch: undiciFetch } = await import('undici')
    const dispatcher = new ProxyAgent(proxyUrl)
    _proxyFetch = (url, opts = {}) => undiciFetch(url, { ...opts, dispatcher })
    return _proxyFetch
  } catch {
    _proxyFetch = (url, opts) => fetch(url, opts)
    return _proxyFetch
  }
}

function readJsonFile(path, fallback) {
  if (!existsSync(path)) return fallback
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
}

function writeJsonFile(path, data) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(data, null, 2))
  } catch { /* 持久化失败不阻塞 */ }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

/**
 * 创建一个 Telegram bot 实例。
 *
 * 依赖：
 *   - getConfig: () => 配置（拿 telegram.* + 读 OpenClaw token）
 *   - wizard:    { handleInbound({chatId, threadId, text, fromUserId}) }
 *   - logger
 *   - fetchFn:   测试用替身；默认 lazy 加载 undici proxy fetch
 *   - offsetFile 测试用
 */
export function createTelegramBot({
  getConfig,
  wizard,
  logger = console,
  fetchFn,
  offsetFile = DEFAULT_OFFSET_FILE,
} = {}) {
  if (typeof getConfig !== 'function') throw new Error('getConfig_required')
  if (!wizard || typeof wizard.handleInbound !== 'function') throw new Error('wizard_required')

  let running = false
  let pollPromise = null
  let offset = readJsonFile(offsetFile, { offset: 0 }).offset || 0
  let lastSeenChatId = null
  let consecutiveErrors = 0

  function getTgConfig() { return getConfig()?.telegram || {} }

  async function callApi(method, params = {}, opts = {}) {
    const tg = getTgConfig()
    const token = readBotToken(getConfig)
    if (!token) throw new Error('telegram_token_missing')
    const url = `${TELEGRAM_API}/bot${token}/${method}`
    const f = fetchFn || (await getProxyFetch())
    const ctrl = new AbortController()
    const timeoutMs = opts.timeoutMs || (tg.longPollTimeoutSec || DEFAULT_LONG_POLL_TIMEOUT_SEC) * 1000 + 5000
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    timer.unref?.()
    try {
      const res = await f(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: ctrl.signal,
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.ok) {
        const desc = data?.description || `HTTP ${res.status}`
        const err = new Error(`telegram_${method}_failed: ${desc}`)
        err.code = data?.error_code
        err.description = desc
        throw err
      }
      return data.result
    } finally {
      clearTimeout(timer)
    }
  }

  /** 上传文件 multipart/form-data —— sendDocument 用。 */
  async function callApiUpload(method, fields = {}, fileField, filePath, fileName) {
    const tg = getTgConfig()
    const token = readBotToken(getConfig)
    if (!token) throw new Error('telegram_token_missing')
    const url = `${TELEGRAM_API}/bot${token}/${method}`
    const f = fetchFn || (await getProxyFetch())

    const form = new FormData()
    for (const [k, v] of Object.entries(fields)) {
      if (v == null || v === '') continue
      form.append(k, String(v))
    }
    if (fileField && filePath) {
      const buf = readFileSync(filePath)
      const blob = new Blob([buf])
      form.append(fileField, blob, fileName || 'file.txt')
    }

    const res = await f(url, { method: 'POST', body: form })
    const data = await res.json().catch(() => null)
    if (!res.ok || !data?.ok) {
      throw new Error(`telegram_${method}_failed: ${data?.description || res.status}`)
    }
    return data.result
  }

  // ─── 出站 API ─────────────────────────────────────────

  async function sendMessage({ chatId, threadId, text, parseMode = 'MarkdownV2', disableNotification = false } = {}) {
    if (!chatId || !text) throw new Error('chatId_and_text_required')
    // V2 默认对所有 caller 透明：内部跑 telegramify 转换；caller 想发 raw 可显式传 parseMode=null
    const safeText = parseMode === 'MarkdownV2' ? toTelegramV2(text) : text
    const params = { chat_id: chatId, text: safeText, disable_notification: !!disableNotification }
    if (parseMode) params.parse_mode = parseMode
    if (threadId) params.message_thread_id = threadId
    try {
      return await callApi('sendMessage', params)
    } catch (e) {
      // V2 / Markdown 解析错（极少 — telegramify 兜过一道 — 但库 bug / 极端 input 仍可能）→ 降级纯文本
      // 用 toPlainText 剥 markdown 标记，避免字面 #### / ** / > 出现在用户面前
      if (parseMode && /parse|entities/i.test(e.description || '')) {
        logger.warn?.(`[telegram-bot] V2 parse failed (${e.description}); retrying as plain text on threadId=${threadId || 'none'}`)
        return await callApi('sendMessage', { ...params, text: toPlainText(text), parse_mode: undefined })
      }
      throw e
    }
  }

  async function sendDocument({ chatId, threadId, filePath, fileName, caption, parseMode = 'MarkdownV2' } = {}) {
    if (!chatId || !filePath) throw new Error('chatId_and_filePath_required')
    if (!existsSync(filePath)) throw new Error(`file_not_found: ${filePath}`)
    const fields = { chat_id: chatId }
    if (threadId) fields.message_thread_id = threadId
    if (caption) {
      fields.caption = parseMode === 'MarkdownV2' ? toTelegramV2(caption) : caption
      if (parseMode) fields.parse_mode = parseMode
    }
    return await callApiUpload('sendDocument', fields, 'document', filePath, fileName)
  }

  async function createForumTopic({ chatId, name, iconColor, iconCustomEmojiId } = {}) {
    if (!chatId || !name) throw new Error('chatId_and_name_required')
    const params = { chat_id: chatId, name: String(name).slice(0, 128) }
    if (iconColor != null) params.icon_color = iconColor
    if (iconCustomEmojiId) params.icon_custom_emoji_id = iconCustomEmojiId
    return await callApi('createForumTopic', params, { timeoutMs: 15000 })
  }

  async function closeForumTopic({ chatId, threadId } = {}) {
    if (!chatId || !threadId) throw new Error('chatId_and_threadId_required')
    return await callApi('closeForumTopic', { chat_id: chatId, message_thread_id: threadId }, { timeoutMs: 15000 })
  }

  async function reopenForumTopic({ chatId, threadId } = {}) {
    if (!chatId || !threadId) throw new Error('chatId_and_threadId_required')
    return await callApi('reopenForumTopic', { chat_id: chatId, message_thread_id: threadId }, { timeoutMs: 15000 })
  }

  /**
   * 编辑已有消息（用于 loading 状态条等自更新场景）。
   * 失败种类（caller 可据 detail 判断是否清掉本地 messageId 重新发送）：
   *   - "message to edit not found" / "MESSAGE_ID_INVALID" → 消息已删 / 太老
   *   - "message is not modified" → 内容相同（safely ignore）
   */
  async function editMessageText({ chatId, messageId, text, parseMode = 'MarkdownV2', disableNotification = true } = {}) {
    if (!chatId || !messageId || !text) throw new Error('chatId_messageId_text_required')
    const safeText = parseMode === 'MarkdownV2' ? toTelegramV2(text) : text
    const params = { chat_id: chatId, message_id: messageId, text: safeText, disable_notification: !!disableNotification }
    if (parseMode) params.parse_mode = parseMode
    try {
      return await callApi('editMessageText', params, { timeoutMs: 10000 })
    } catch (e) {
      // 内容未变 → 静默成功语义
      if (/not modified/i.test(e.description || '')) return { ok: true, unchanged: true }
      // V2 解析失败 → 降级到 plain text 重试一次（剥 markdown 标记，跟 sendMessage 一致）
      if (parseMode && /parse|entities/i.test(e.description || '')) {
        logger.warn?.(`[telegram-bot] editMessageText V2 parse failed (${e.description}); retrying as plain text mid=${messageId}`)
        return await callApi('editMessageText', { ...params, text: toPlainText(text), parse_mode: undefined })
      }
      throw e
    }
  }

  async function editForumTopic({ chatId, threadId, name, iconCustomEmojiId } = {}) {
    if (!chatId || !threadId) throw new Error('chatId_and_threadId_required')
    const params = { chat_id: chatId, message_thread_id: threadId }
    if (name) params.name = String(name).slice(0, 128)
    if (iconCustomEmojiId !== undefined) params.icon_custom_emoji_id = iconCustomEmojiId
    return await callApi('editForumTopic', params, { timeoutMs: 15000 })
  }

  async function getMe() {
    return await callApi('getMe', {}, { timeoutMs: 10000 })
  }

  /**
   * 给消息加 emoji reaction（D 方案：在用户触发消息上显示状态）。
   * emoji=null/空数组 → 清除所有 reaction。
   * 仅支持标准 emoji（不支持 custom_emoji_id），且必须在 Telegram 默认列表内
   * （👀 🎉 💔 🤷 等都在；⏹ 这种"控制字符"不在）。
   */
  async function setMessageReaction({ chatId, messageId, emoji = null, isBig = false } = {}) {
    if (!chatId || !messageId) throw new Error('chatId_and_messageId_required')
    const reaction = emoji
      ? (Array.isArray(emoji) ? emoji : [emoji]).map((e) => ({ type: 'emoji', emoji: e }))
      : []
    return await callApi('setMessageReaction', {
      chat_id: chatId,
      message_id: messageId,
      reaction,
      is_big: !!isBig,
    }, { timeoutMs: 10000 })
  }

  /**
   * 注册 bot 的 slash 命令菜单。
   * @param {object} opts
   * @param {Array<{command:string,description:string}>} opts.commands
   * @param {string} [opts.scope] - 'default' | 'all_private_chats' | 'all_group_chats' | 'chat'
   * @param {string|number} [opts.chatId] - 当 scope='chat' 时必填（限定到这个 supergroup）
   * @param {string} [opts.languageCode] - 可选，按语言注册（'en' / 'zh' 等）
   */
  async function setMyCommands({ commands, scope = 'default', chatId, languageCode } = {}) {
    if (!Array.isArray(commands)) throw new Error('commands_array_required')
    const params = { commands }
    if (scope === 'chat') {
      if (!chatId) throw new Error('chatId_required_for_scope_chat')
      params.scope = { type: 'chat', chat_id: Number(chatId) || chatId }
    } else if (scope && scope !== 'default') {
      params.scope = { type: scope }
    }
    if (languageCode) params.language_code = languageCode
    return await callApi('setMyCommands', params, { timeoutMs: 15000 })
  }

  /**
   * 清空 slash 命令菜单（同 scope）。
   */
  async function deleteMyCommands({ scope = 'default', chatId, languageCode } = {}) {
    const params = {}
    if (scope === 'chat') {
      if (!chatId) throw new Error('chatId_required_for_scope_chat')
      params.scope = { type: 'chat', chat_id: Number(chatId) || chatId }
    } else if (scope && scope !== 'default') {
      params.scope = { type: scope }
    }
    if (languageCode) params.language_code = languageCode
    return await callApi('deleteMyCommands', params, { timeoutMs: 15000 })
  }

  // ─── 入站长轮询 ───────────────────────────────────────

  function isAuthorizedChat(chatId) {
    const tg = getTgConfig()
    const allow = Array.isArray(tg.allowedChatIds) ? tg.allowedChatIds.map(String) : []
    if (allow.length === 0) return false   // 空 = 拒所有
    return allow.includes(String(chatId))
  }

  async function dispatch(update) {
    const msg = update.message
    if (!msg) return
    const chatId = String(msg.chat.id)
    const threadId = msg.message_thread_id || null
    lastSeenChatId = chatId
    if (!isAuthorizedChat(chatId)) {
      logger.warn?.(`[telegram-bot] dropped message from unauthorized chat=${chatId} (allowedChatIds 未配置或不含此 chat)`)
      return
    }

    // ─── 话题生命周期事件（service messages，无 text） ────────────
    if (msg.forum_topic_closed && wizard.handleTopicEvent) {
      try {
        await wizard.handleTopicEvent({ type: 'closed', chatId, threadId })
      } catch (e) {
        logger.warn?.(`[telegram-bot] handleTopicEvent(closed) threw: ${e.message}`)
      }
      return
    }
    if (msg.forum_topic_reopened && wizard.handleTopicEvent) {
      try {
        await wizard.handleTopicEvent({ type: 'reopened', chatId, threadId })
      } catch (e) {
        logger.warn?.(`[telegram-bot] handleTopicEvent(reopened) threw: ${e.message}`)
      }
      return
    }

    if (!msg.text || typeof msg.text !== 'string') {
      // 其他非文本（图片/sticker/系统消息）暂不处理
      return
    }
    const fromUserId = msg.from ? String(msg.from.id) : null
    // Group 里点 slash 命令时 Telegram 自动加 @botUsername 做消歧
    // （`/review` → `/review@lzhtestBot`），这里剥掉，让 PTY / wizard 收到干净的 `/review`
    // 只剥**消息开头**首词的 @xxx，正文中的 @ 不动
    const text = msg.text.replace(/^(\/[A-Za-z0-9_]+)@\w+/, '$1')

    let result
    try {
      result = await wizard.handleInbound({ chatId, threadId, text, fromUserId, messageId: msg.message_id })
    } catch (e) {
      logger.warn?.(`[telegram-bot] wizard.handleInbound threw: ${e.message}`)
      return
    }
    if (result && typeof result.reply === 'string' && result.reply !== '') {
      try {
        await sendMessage({ chatId, threadId, text: result.reply })
      } catch (e) {
        logger.warn?.(`[telegram-bot] sendMessage reply failed: ${e.message}`)
      }
    }
  }

  function persistOffset() {
    writeJsonFile(offsetFile, { offset, savedAt: Date.now(), lastSeenChatId })
  }

  async function pollOnce() {
    const tg = getTgConfig()
    const timeoutSec = tg.longPollTimeoutSec || DEFAULT_LONG_POLL_TIMEOUT_SEC
    const updates = await callApi('getUpdates', {
      offset,
      timeout: timeoutSec,
      allowed_updates: ['message', 'forum_topic_created', 'forum_topic_closed', 'forum_topic_reopened'],
    })
    if (!Array.isArray(updates) || updates.length === 0) return 0
    for (const u of updates) {
      offset = (u.update_id || offset) + 1
      try {
        await dispatch(u)
      } catch (e) {
        logger.warn?.(`[telegram-bot] dispatch error: ${e.message}`)
      }
    }
    persistOffset()
    return updates.length
  }

  async function pollLoop() {
    consecutiveErrors = 0
    while (running) {
      try {
        await pollOnce()
        consecutiveErrors = 0
      } catch (e) {
        consecutiveErrors++
        const baseDelayMs = getTgConfig().pollRetryDelayMs || POLL_RETRY_DELAY_MS
        const backoff = Math.min(60_000, baseDelayMs * consecutiveErrors)
        logger.warn?.(`[telegram-bot] poll error (${consecutiveErrors}): ${e.message}; retry in ${backoff}ms`)
        if (running) await sleep(backoff)
      }
    }
  }

  function start() {
    if (running) return
    running = true
    pollPromise = pollLoop().catch((e) => logger.warn?.(`[telegram-bot] loop crashed: ${e.message}`))
    logger.info?.(`[telegram-bot] started; offset=${offset}`)
  }

  async function stop() {
    if (!running) return
    running = false
    persistOffset()
    // 不强中断 inflight long-poll；它会在下一次 timeout 时自然返回
  }

  function describe() {
    const tg = getTgConfig()
    return {
      enabled: !!tg.enabled,
      running,
      offset,
      lastSeenChatId,
      allowedChatIds: tg.allowedChatIds || [],
      consecutiveErrors,
      hasToken: !!readBotToken(getConfig),
    }
  }

  return {
    start,
    stop,
    sendMessage,
    sendDocument,
    editMessageText,
    setMessageReaction,
    createForumTopic,
    closeForumTopic,
    reopenForumTopic,
    editForumTopic,
    setMyCommands,
    deleteMyCommands,
    getMe,
    pollOnce,           // 测试用：触发一次拉取
    isAuthorizedChat,   // 测试用
    describe,
    __getPollRetryDelayMs: () => getTgConfig().pollRetryDelayMs || POLL_RETRY_DELAY_MS,
  }
}

/**
 * 读 bot token，并返回来源标记。
 *  - source: "quadtodo" | "openclaw" | "missing"
 *  - fallbackPath 测试用：默认 ~/.openclaw/openclaw.json
 */
export function readBotTokenWithSource(getConfig, { fallbackPath = join(homedir(), '.openclaw', 'openclaw.json') } = {}) {
  const tg = getConfig?.()?.telegram || {}
  if (tg.botToken && typeof tg.botToken === 'string') {
    return { token: tg.botToken, source: 'quadtodo' }
  }
  try {
    if (!existsSync(fallbackPath)) return { token: null, source: 'missing' }
    const cfg = JSON.parse(readFileSync(fallbackPath, 'utf8'))
    const tok = cfg?.channels?.telegram?.botToken || null
    return tok ? { token: tok, source: 'openclaw' } : { token: null, source: 'missing' }
  } catch {
    return { token: null, source: 'missing' }
  }
}

/** 兼容旧调用方：只返回 token 字符串。新代码请用 readBotTokenWithSource。 */
export function readBotToken(getConfig) {
  return readBotTokenWithSource(getConfig).token
}

export const __test__ = { readJsonFile, writeJsonFile }
