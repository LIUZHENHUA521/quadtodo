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
import { downloadTelegramFile, pickLargestPhoto } from './telegram-image.js'

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

  async function sendMessage({ chatId, threadId, text, parseMode = 'MarkdownV2', disableNotification = false, replyMarkup = null } = {}) {
    if (!chatId || !text) throw new Error('chatId_and_text_required')
    // V2 默认对所有 caller 透明：内部跑 telegramify 转换；caller 想发 raw 可显式传 parseMode=null
    const safeText = parseMode === 'MarkdownV2' ? toTelegramV2(text) : text
    const params = { chat_id: chatId, text: safeText, disable_notification: !!disableNotification }
    if (parseMode) params.parse_mode = parseMode
    if (threadId) params.message_thread_id = threadId
    if (replyMarkup) params.reply_markup = replyMarkup
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
  async function editMessageText({ chatId, messageId, text, parseMode = 'MarkdownV2', disableNotification = true, replyMarkup = null } = {}) {
    if (!chatId || !messageId || !text) throw new Error('chatId_messageId_text_required')
    const safeText = parseMode === 'MarkdownV2' ? toTelegramV2(text) : text
    const params = { chat_id: chatId, message_id: messageId, text: safeText, disable_notification: !!disableNotification }
    if (parseMode) params.parse_mode = parseMode
    if (replyMarkup) params.reply_markup = replyMarkup
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

  /**
   * 移除（或替换）已发出消息上的 inline keyboard。
   * 用 reply_markup={inline_keyboard: []} 等价于"清空按钮"。
   * 错误处理跟 editMessageText 一致：not modified → 静默成功；其它错误抛出。
   */
  async function editMessageReplyMarkup({ chatId, messageId, replyMarkup = null } = {}) {
    if (!chatId || !messageId) throw new Error('chatId_and_messageId_required')
    const params = {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup || { inline_keyboard: [] },
    }
    try {
      return await callApi('editMessageReplyMarkup', params, { timeoutMs: 10000 })
    } catch (e) {
      if (/not modified/i.test(e.description || '')) return { ok: true, unchanged: true }
      throw e
    }
  }

  /**
   * 关闭 callback_query 的 loading 转圈；可选弹 toast / alert。
   * 必须在 ~3s 内回，否则 Telegram 客户端会一直转圈。
   */
  async function answerCallbackQuery({ callbackQueryId, text = '', showAlert = false, cacheTimeSec = 0 } = {}) {
    if (!callbackQueryId) throw new Error('callbackQueryId_required')
    const params = {
      callback_query_id: callbackQueryId,
      show_alert: !!showAlert,
    }
    if (text) params.text = String(text).slice(0, 200)
    if (cacheTimeSec > 0) params.cache_time = cacheTimeSec
    return await callApi('answerCallbackQuery', params, { timeoutMs: 5000 })
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

  let probeListener = null
  function setProbeListener(fn) {
    probeListener = (typeof fn === 'function') ? fn : null
  }

  /**
   * 处理 inline keyboard 按钮点击。
   *
   * 流程：
   *   1. 鉴权（白名单 chatId）
   *   2. 调 wizard.handleCallback({chatId, threadId, callbackData, callbackMessageId, fromUserId})
   *      —— 由 wizard 决定怎么处理（推进状态 / 触发 finalize / 等待自定义文本输入）
   *   3. 不论 wizard 返回什么，先 answerCallbackQuery 关 loading
   *   4. wizard 返回 editOriginal=true → editMessageReplyMarkup 把按钮去掉 + editMessageText
   *      在原文末尾追加 "✓ 已选: …"，避免历史滚屏看不出选了什么
   *   5. wizard 返回 reply 字符串 → sendMessage 发新一步 prompt（带新 reply_markup）
   *
   * 安全：wizard 没实现 handleCallback 时也得 answerCallbackQuery，否则用户客户端一直转圈
   */
  async function dispatchCallbackQuery(cq) {
    const callbackQueryId = cq.id
    const msg = cq.message || {}
    const chatId = String(msg.chat?.id || '')
    const threadId = msg.message_thread_id || null
    const fromUserId = cq.from ? String(cq.from.id) : null
    const callbackMessageId = msg.message_id || null
    const data = String(cq.data || '')

    // 鉴权失败 → answer 一下避免转圈，不回任何业务消息
    if (!isAuthorizedChat(chatId)) {
      logger.warn?.(`[telegram-bot] dropped callback_query from unauthorized chat=${chatId}`)
      try { await answerCallbackQuery({ callbackQueryId }) } catch {}
      return
    }

    // wizard 没实现 handleCallback → 当作 noop，至少 answer 掉 loading
    if (typeof wizard.handleCallback !== 'function') {
      logger.warn?.(`[telegram-bot] callback_query received but wizard has no handleCallback; data=${data}`)
      try { await answerCallbackQuery({ callbackQueryId, text: '该功能未启用' }) } catch {}
      return
    }

    let result
    try {
      result = await wizard.handleCallback({
        chatId,
        threadId,
        callbackData: data,
        callbackMessageId,
        fromUserId,
      })
    } catch (e) {
      logger.warn?.(`[telegram-bot] wizard.handleCallback threw: ${e.message}`)
      try { await answerCallbackQuery({ callbackQueryId, text: '处理失败' }) } catch {}
      return
    }

    // 1) answer，关 loading（带可选 toast）
    try {
      await answerCallbackQuery({
        callbackQueryId,
        text: result?.toast || '',
        showAlert: !!result?.showAlert,
      })
    } catch (e) {
      logger.warn?.(`[telegram-bot] answerCallbackQuery failed: ${e.message}`)
    }

    // 2) 编辑原消息：去按钮 + 在末尾标记 "✓ 已选: …"
    //    editOriginal=false 时跳过（譬如 wizard 想保留按钮让用户多选）
    //    chosenLabel 缺省时只去按钮，不改文本
    if (result?.editOriginal !== false && callbackMessageId) {
      const originalText = msg.text || ''
      try {
        if (result?.chosenLabel && originalText) {
          await editMessageText({
            chatId,
            messageId: callbackMessageId,
            text: `${originalText}\n\n✓ 已选: ${result.chosenLabel}`,
            replyMarkup: { inline_keyboard: [] },
          })
        } else {
          await editMessageReplyMarkup({
            chatId,
            messageId: callbackMessageId,
            replyMarkup: { inline_keyboard: [] },
          })
        }
      } catch (e) {
        // 消息太老 / 已删 → 不阻塞主流程
        logger.warn?.(`[telegram-bot] edit original after callback failed: ${e.message}`)
      }
    }

    // 3) 发下一步 prompt（可能带新按钮 / force_reply）
    if (result && typeof result.reply === 'string' && result.reply !== '') {
      try {
        const sent = await sendMessage({
          chatId,
          threadId,
          text: result.reply,
          replyMarkup: result.replyMarkup || null,
        })
        // ask_user 的 ✏️ 补充流：把"刚发出的 force_reply 消息 id"回灌到 wizard，
        // 这样用户回复时 wizard 能用 reply_to_message_id 反查上下文
        if (result.forceReplyContext && sent?.message_id && typeof wizard.registerForceReplyContext === 'function') {
          try {
            wizard.registerForceReplyContext({
              ...result.forceReplyContext,
              chatId,
              messageId: sent.message_id,
            })
          } catch (e) {
            logger.warn?.(`[telegram-bot] registerForceReplyContext failed: ${e.message}`)
          }
        }
      } catch (e) {
        logger.warn?.(`[telegram-bot] sendMessage after callback failed: ${e.message}`)
      }
    }
  }

  async function dispatch(update) {
    // ─── callback_query：inline keyboard 按钮点击 ────────────────
    // 单独走，不跟 message 路径混；有自己的鉴权 + 路由 + answerCallbackQuery 兜底
    if (update.callback_query) {
      await dispatchCallbackQuery(update.callback_query)
      return
    }
    const msg = update.message
    if (!msg) return
    const chatId = String(msg.chat.id)
    const threadId = msg.message_thread_id || null
    lastSeenChatId = chatId
    // Probe listener：在白名单检查前 fork 一份给订阅者（拿 chatId 用）
    if (probeListener) {
      try {
        probeListener({
          chatId: String(msg.chat.id),
          chatTitle: msg.chat.title || msg.chat.username || null,
          chatType: msg.chat.type || null,
          fromUserId: msg.from ? String(msg.from.id) : null,
          fromUsername: msg.from?.username || null,
          textPreview: typeof msg.text === 'string' ? msg.text.slice(0, 80) : null,
          at: Date.now(),
        })
      } catch (e) {
        logger.warn?.(`[telegram-bot] probeListener threw: ${e.message}`)
      }
    }
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

    // ─── 图片处理：下载到本地，把 @path 喂给 PTY 当 attach ────
    // photo 是 array of PhotoSize，挑最大那张。下载失败 → imagePaths=null + 警告，
    // 但**不能丢消息**：caption 是用户的文字，也得继续走 wizard。
    let imagePaths = null
    let photoDownloadFailed = false
    const hasPhoto = Array.isArray(msg.photo) && msg.photo.length > 0
    if (hasPhoto) {
      const largest = pickLargestPhoto(msg.photo)
      if (largest?.file_id) {
        const token = readBotToken(getConfig)
        if (token) {
          const fetcher = fetchFn || (await getProxyFetch())
          // 网络抖动重试 1 次，跟 bridge 的策略一致
          const tryDownload = () => downloadTelegramFile({
            token, fetchFn: fetcher,
            fileId: largest.file_id, fileSize: largest.file_size,
          })
          try {
            let r
            try { r = await tryDownload() }
            catch (e1) {
              if (/fetch failed|fetch_error|aborted|timeout/i.test(e1.message)) {
                logger.warn?.(`[telegram-bot] photo download transient error (${e1.message}); retrying once in 1s`)
                await new Promise((res) => setTimeout(res, 1000))
                r = await tryDownload()
              } else {
                throw e1
              }
            }
            imagePaths = [r.localPath]
            logger.info?.(`[telegram-bot] downloaded photo file_id=${largest.file_id.slice(0, 12)}… → ${r.localPath} (${(r.fileSize / 1024).toFixed(1)}kB)`)
          } catch (e) {
            photoDownloadFailed = true
            logger.warn?.(`[telegram-bot] photo download failed: ${e.message}`)
          }
        } else {
          photoDownloadFailed = true
          logger.warn?.(`[telegram-bot] photo received but no bot token to download with`)
        }
      }
    }

    // 既无文本（含 caption）也无图片 → drop
    const hasText = (msg.text && typeof msg.text === 'string') || (msg.caption && typeof msg.caption === 'string')
    if (!imagePaths && !hasText) {
      // 其他非文本/非图（sticker/system msg）暂不处理
      return
    }

    const fromUserId = msg.from ? String(msg.from.id) : null
    // text：图片消息时优先用 caption；纯文本消息用 text
    const rawText = msg.text || msg.caption || ''
    // Group 里点 slash 命令时 Telegram 自动加 @botUsername 做消歧
    // （`/review` → `/review@lzhtestBot`），这里剥掉，让 PTY / wizard 收到干净的 `/review`
    // 只剥**消息开头**首词的 @xxx，正文中的 @ 不动
    const text = rawText.replace(/^(\/[A-Za-z0-9_]+)@\w+/, '$1')

    let result
    try {
      result = await wizard.handleInbound({
        chatId, threadId, text, fromUserId,
        messageId: msg.message_id,
        // 用户 reply 我们之前发的消息时带这个；wizard 用它匹配 force_reply 上下文
        replyToMessageId: msg.reply_to_message?.message_id || null,
        imagePaths,
      })
    } catch (e) {
      logger.warn?.(`[telegram-bot] wizard.handleInbound threw: ${e.message}`)
      return
    }
    // 图片下载失败时给用户提个示：我们用 caption 当文本送了，但图丢了
    if (photoDownloadFailed && result?.action === 'stdin_proxy') {
      try {
        await sendMessage({
          chatId, threadId,
          text: '⚠️ 图片下载失败（网络问题），仅文本部分已转给 AI。要让 AI 看图请重发一次。',
        })
      } catch {}
    }
    if (result && typeof result.reply === 'string' && result.reply !== '') {
      try {
        await sendMessage({
          chatId, threadId, text: result.reply,
          replyMarkup: result.replyMarkup || null,
        })
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
      allowed_updates: ['message', 'callback_query', 'forum_topic_created', 'forum_topic_closed', 'forum_topic_reopened'],
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
    editMessageReplyMarkup,
    answerCallbackQuery,
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
    setProbeListener,
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
