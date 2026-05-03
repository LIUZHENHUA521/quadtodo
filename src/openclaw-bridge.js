/**
 * OpenClaw 出站桥：通过 `openclaw message send` CLI 把消息推到微信。
 *
 * 设计选型：
 * - 不直接说 OpenClaw gateway 的 WebSocket 协议（不稳定、版本会变）
 * - shell out CLI 走官方契约，--json 拿结构化结果
 *
 * 安全：
 * - 命令通过 args 数组传，绝不拼字符串（避免 shell 注入）
 * - 出站限流（rateLimitPerMin），防个人微信被风控
 * - sessionId → targetUserId 的路由内存表，沿配置 fallback
 */
import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { toTelegramV2, toPlainText } from './telegram-markdown.js'

const DEFAULT_CLI_BIN = 'openclaw'
// openclaw CLI 冷启动 ~17s + Telegram 网络 ~10s，给 60s 足够
const DEFAULT_TIMEOUT_MS = 60_000
const TELEGRAM_API_TIMEOUT_MS = 10_000

// channel → 期望的 target 后缀（OpenClaw CLI 要求 target 带 channel 后缀，
// 但 OpenClaw skill context 里拿到的 from_user_id 通常不带）
const CHANNEL_TARGET_SUFFIX = {
  'openclaw-weixin': '@im.wechat',
  // 其他渠道暂不强制；缺了的话 CLI 会自己报错让我们补
}

function normalizeTarget(target, channel) {
  if (!target || typeof target !== 'string') return target
  const suffix = CHANNEL_TARGET_SUFFIX[channel]
  if (!suffix) return target
  if (target.includes(suffix)) return target
  // 已经有别的 @ 后缀（如 @im.wechat、@example.com）— 保持原样
  if (target.includes('@')) return target
  return `${target}${suffix}`
}

function nowMs() { return Date.now() }

/**
 * 从 ~/.openclaw/openclaw.json 读 Telegram bot token。
 * Telegram 出站走 HTTPS Bot API 直连，比 shell out openclaw CLI 快 ~30s（避免 CLI 冷启动）
 * weixin 等其他 channel 没 public bot API，仍走 CLI 兜底。
 */
function loadTelegramTokenFromOpenClaw() {
  try {
    const path = join(homedir(), '.openclaw', 'openclaw.json')
    if (!existsSync(path)) return null
    const cfg = JSON.parse(readFileSync(path, 'utf8'))
    return cfg?.channels?.telegram?.botToken || null
  } catch {
    return null
  }
}

// 走系统 HTTPS_PROXY env 的 fetch（undici ProxyAgent）—— 国内连 Telegram 必备
let _undiciFetch = null
let _proxyDispatcher = null
async function getProxyFetch() {
  if (_undiciFetch) return _undiciFetch
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy
                || process.env.HTTP_PROXY  || process.env.http_proxy
  if (!proxyUrl) {
    _undiciFetch = (url, opts) => fetch(url, opts)  // 无 proxy，用 Node 内置 fetch
    return _undiciFetch
  }
  try {
    const { ProxyAgent, fetch: undiciFetch } = await import('undici')
    _proxyDispatcher = new ProxyAgent(proxyUrl)
    _undiciFetch = (url, opts = {}) => undiciFetch(url, { ...opts, dispatcher: _proxyDispatcher })
    return _undiciFetch
  } catch {
    _undiciFetch = (url, opts) => fetch(url, opts)  // undici 没装：fallback 直连
    return _undiciFetch
  }
}

async function sendViaTelegramAPI({ token, chatId, threadId, text, replyMarkup = null, logger = null }) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TELEGRAM_API_TIMEOUT_MS)
  timer.unref?.()
  try {
    const fetchFn = await getProxyFetch()
    const v2Text = toTelegramV2(text)
    // 诊断日志：dump V2 处理后的前 120 字，确认进程加载的是新代码（带 V2 转换）
    logger?.info?.(`[openclaw-bridge] V2 head: ${JSON.stringify(v2Text.slice(0, 120))} (rawLen=${text.length} v2Len=${v2Text.length})`)
    const body = { chat_id: chatId, text: v2Text, parse_mode: 'MarkdownV2' }
    if (threadId) body.message_thread_id = threadId
    if (replyMarkup) body.reply_markup = replyMarkup
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    const data = await res.json().catch(() => null)
    if (!res.ok || !data?.ok) {
      // Markdown 解析失败时降级为纯文本重发（保留 thread + 按钮，避免泄漏到 General / 丢按钮）
      if (data?.description?.includes('parse')) {
        logger?.warn?.(`[openclaw-bridge] V2 parse failed (${data.description}); retrying plain text on threadId=${threadId || 'none'}`)
        return await sendViaTelegramAPI_plain({ token, chatId, threadId, text, replyMarkup })
      }
      return { ok: false, reason: 'telegram_api_error', detail: data?.description || `${res.status}`, status: res.status }
    }
    return { ok: true, payload: data.result }
  } catch (e) {
    clearTimeout(timer)
    return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : 'fetch_error', detail: e.message }
  }
}

async function sendViaTelegramAPI_plain({ token, chatId, threadId, text, replyMarkup = null }) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`
  try {
    const fetchFn = await getProxyFetch()
    // 用 telegramify 'remove' 模式剥掉 markdown 标记，避免满屏 #### / ** / > 字面字符
    const body = { chat_id: chatId, text: toPlainText(text) }
    if (threadId) body.message_thread_id = threadId
    if (replyMarkup) body.reply_markup = replyMarkup
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => null)
    if (!res.ok || !data?.ok) return { ok: false, reason: 'telegram_api_error', detail: data?.description }
    return { ok: true, payload: data.result }
  } catch (e) {
    return { ok: false, reason: 'fetch_error', detail: e.message }
  }
}

export const __test__ = { sendViaTelegramAPI, sendViaTelegramAPI_plain }

export function createOpenClawBridge({
  getConfig,
  cliBin = DEFAULT_CLI_BIN,
  spawnFn = spawn,
  logger = console,
  loadTelegramToken = loadTelegramTokenFromOpenClaw,  // 测试用：可 mock null
  telegramSender = sendViaTelegramAPI,                // 测试用：可 mock fake fetch
  telegramBot: initialTelegramBot = null,              // 可选：用于 sendDocument 附件
} = {}) {
  let telegramBot = initialTelegramBot
  let topicGoneHandler = null   // ({chatId, threadId}) → void：sendMessage 拿到 topic 已删错时调用
  if (typeof getConfig !== 'function') throw new Error('getConfig_required')

  // 出站限流环形缓冲：每分钟 ≤ rateLimitPerMin 条
  const sendTimestamps = []
  // sessionId → { targetUserId, account, channel }
  const sessionRoutes = new Map()
  // peerUserId → { sessionId, sentAt } — 最近一次推到该 peer 的 session
  // 用于 PTY stdin proxy：用户在微信回话时知道往哪个 PTY 写
  const lastPushByPeer = new Map()

  function getOpenClawConfig() {
    const cfg = getConfig() || {}
    return cfg.openclaw || {}
  }

  function isEnabled() {
    const oc = getOpenClawConfig()
    return Boolean(oc.enabled)
  }

  function rateLimitOk() {
    const oc = getOpenClawConfig()
    const limit = Math.max(1, Number(oc?.askUser?.rateLimitPerMin) || 6)
    const cutoff = nowMs() - 60_000
    while (sendTimestamps.length && sendTimestamps[0] < cutoff) sendTimestamps.shift()
    return sendTimestamps.length < limit
  }

  function recordSend() {
    sendTimestamps.push(nowMs())
  }

  function registerSessionRoute(sessionId, { targetUserId, account, channel, threadId, topicName, triggerMessageId } = {}) {
    if (!sessionId || !targetUserId) return
    sessionRoutes.set(sessionId, {
      targetUserId,
      account: account || null,
      channel: channel || getOpenClawConfig().channel || 'openclaw-weixin',
      threadId: threadId != null ? threadId : null,    // ← Telegram Topic 路由用
      topicName: topicName || null,                     // ← SessionEnd 改名 ✅ 用
      triggerMessageId: triggerMessageId != null ? triggerMessageId : null,  // D 方案：reaction 加在用户触发消息上
    })
  }

  function clearSessionRoute(sessionId, reason = 'unknown') {
    if (sessionId && sessionRoutes.has(sessionId)) {
      logger.info?.(`[openclaw-bridge] clearSessionRoute sid=${sessionId} reason=${reason}`)
    }
    sessionRoutes.delete(sessionId)
  }

  function hasExplicitRoute(sessionId) {
    return Boolean(sessionId && sessionRoutes.has(sessionId))
  }

  function resolveRoute(sessionId) {
    const explicit = sessionRoutes.get(sessionId)
    if (explicit) return explicit
    const oc = getOpenClawConfig()
    if (!oc.targetUserId) return null
    return {
      targetUserId: oc.targetUserId,
      account: null,
      channel: oc.channel || 'openclaw-weixin',
    }
  }

  /**
   * 调用 `openclaw message send`，返回 { ok: true, payload } 或 { ok: false, reason, stderr? }。
   * 失败原因可能是：disabled / rate_limited / misconfigured / cli_failed / timeout
   */
  async function postText({ sessionId, target, message, channel, account, replyToId, attachment = null, replyMarkup = null } = {}) {
    if (!isEnabled()) return { ok: false, reason: 'disabled' }
    if (!message || typeof message !== 'string') return { ok: false, reason: 'message_required' }
    if (!rateLimitOk()) return { ok: false, reason: 'rate_limited' }

    const oc = getOpenClawConfig()
    const route = sessionId ? resolveRoute(sessionId) : null
    const effectiveChannel = channel || route?.channel || oc.channel || 'openclaw-weixin'
    const rawTarget = target || route?.targetUserId || oc.targetUserId
    const effectiveTarget = normalizeTarget(rawTarget, effectiveChannel)
    const effectiveAccount = account || route?.account

    if (!effectiveTarget) return { ok: false, reason: 'misconfigured', detail: 'targetUserId missing' }

    // ─── Telegram 快路径：直接 HTTPS POST Bot API（~1-3s vs CLI 30+s 冷启动） ───
    if (effectiveChannel === 'telegram') {
      const token = loadTelegramToken()
      if (token) {
        const threadIdForSend = route?.threadId || null
        // 防御兜底：sessionId-routed 但没拿到 thread → fallback 路径，不能静默落 General。
        // 仅当 caller 传了 sessionId 时启用（无 sessionId 是显式 broadcast，允许直发默认 chat）。
        if (!threadIdForSend && sessionId && !sessionRoutes.has(sessionId)) {
          logger.warn?.(`[openclaw-bridge] refuse send to telegram general: sid=${sessionId} has no registered route (routesSize=${sessionRoutes.size}); would have leaked to General. msgLen=${message.length}`)
          return { ok: false, reason: 'no_thread_id_route_missing' }
        }
        logger.info?.(`[openclaw-bridge] telegram send sessionId=${sessionId} chatId=${effectiveTarget} threadId=${threadIdForSend} (route=${route ? JSON.stringify({tid: route.threadId, tn: route.topicName}) : 'null'}) attachment=${attachment ? 'yes' : 'no'} msgLen=${message.length}`)
        // 网络抖动重试 1 次：fetch_error / timeout 才重试，telegram 业务错误（parse 失败、429）不重试
        const sendOnce = () => telegramSender({
          token,
          chatId: String(effectiveTarget),
          threadId: threadIdForSend,
          text: message,
          replyMarkup,                    // ask_user / wizard 注入的 inline keyboard，无则 null
          logger,
        })
        let r = await sendOnce()
        if (!r.ok && (r.reason === 'fetch_error' || r.reason === 'timeout')) {
          logger.warn?.(`[openclaw-bridge] fast-path transient error (${r.reason}); retrying once after 1s`)
          await new Promise((res) => setTimeout(res, 1000))
          r = await sendOnce()
        }
        if (r.ok) {
          recordSend()
          if (sessionId && rawTarget) {
            lastPushByPeer.set(String(rawTarget), { sessionId, sentAt: Date.now() })
          }
          // 文本送达后，如果有附件，再发一次 sendDocument（不阻塞主结果）
          if (attachment && telegramBot?.sendDocument) {
            telegramBot.sendDocument({
              chatId: String(effectiveTarget),
              threadId: threadIdForSend,
              filePath: attachment,
              fileName: attachment.split('/').pop(),
            }).catch((e) => logger.warn?.(`[openclaw-bridge] sendDocument failed: ${e.message}`))
          }
          return { ok: true, payload: r.payload, fast: true }
        }
        // 懒检测：topic 被删 / thread 失效 → 触发 onTopicGone（同关闭语义）
        const detail = String(r.detail || '').toLowerCase()
        const looksLikeTopicGone = /thread not found|topic.*deleted|message.*not.*found|topic_closed/.test(detail)
        if (looksLikeTopicGone && threadIdForSend && topicGoneHandler) {
          logger.warn?.(`[openclaw-bridge] topic gone detected (${r.detail}); triggering close handler chatId=${effectiveTarget} threadId=${threadIdForSend}`)
          try { topicGoneHandler({ chatId: String(effectiveTarget), threadId: threadIdForSend }) } catch (e) {
            logger.warn?.(`[openclaw-bridge] topicGoneHandler threw: ${e.message}`)
          }
          return { ok: false, reason: 'topic_gone', detail: r.detail }
        }
        // 关键：fast-path 失败时，如果**应该发到 topic**（有 threadId）→ 不能 fallback 到 CLI，
        // 因为 CLI 命令不带 threadId，会把消息默认丢到 General → 数据落错地方。
        // 网络失败让 caller 决定重试 / 上报；topic 路由是正确的，不能为了"成功"而牺牲位置。
        if (threadIdForSend) {
          logger.warn?.(`[openclaw-bridge] telegram fast-path failed (${r.reason}: ${r.detail}); refusing CLI fallback (threadId=${threadIdForSend} would leak to General)`)
          return { ok: false, reason: r.reason || 'telegram_api_error', detail: r.detail }
        }
        logger.warn?.(`[openclaw-bridge] telegram fast-path failed (${r.reason}: ${r.detail}); falling back to CLI`)
        // fallthrough to CLI（无 threadId 的场景才允许）
      } else {
        logger.warn?.(`[openclaw-bridge] telegram fast-path: token missing — falling back to CLI`)
      }
    }

    const args = [
      'message', 'send',
      '--channel', effectiveChannel,
      '--target', String(effectiveTarget),
      '--message', message,
      '--json',
    ]
    if (effectiveAccount) args.push('--account', effectiveAccount)
    if (replyToId) args.push('--reply-to', String(replyToId))

    // openclaw CLI 自己读 ~/.openclaw/openclaw.json（0600）取 gateway token，
    // 不需要在这里注入；继承父进程 env 即可。
    const env = process.env

    return new Promise((resolve) => {
      let stdout = ''
      let stderr = ''
      let settled = false

      const finish = (result) => {
        if (settled) return
        settled = true
        if (result.ok) recordSend()
        resolve(result)
      }

      let proc
      try {
        proc = spawnFn(cliBin, args, { env })
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
          logger.warn?.(`[openclaw-bridge] cli exit ${code}: ${stderr.trim().slice(0, 240)}`)
          finish({ ok: false, reason: 'cli_failed', exitCode: code, stderr })
          return
        }
        let payload = null
        try { payload = JSON.parse(stdout) } catch {}
        // 记 last-push：peer → sessionId（用于 stdin proxy）
        if (sessionId && rawTarget) {
          lastPushByPeer.set(rawTarget, { sessionId, sentAt: Date.now() })
        }
        finish({ ok: true, payload })
      })
    })
  }

  /**
   * 拿这个 peer 最近一次被推过的 sessionId（PTY stdin proxy 用）。
   * 超过 maxAgeMs（默认 6 小时）就视为过期 —— 用户体验考虑：只要那个
   * session 还活着，就允许直接回复给它。
   */
  function getLastPushedSession(peer, maxAgeMs = 6 * 60 * 60 * 1000) {
    if (!peer) return null
    const entry = lastPushByPeer.get(peer)
    if (!entry) return null
    if (Date.now() - entry.sentAt > maxAgeMs) {
      lastPushByPeer.delete(peer)
      return null
    }
    return entry.sessionId
  }

  /**
   * 显式把 peer 绑定到 sessionId（telegram inline button 选 session 用）。
   * 跟 push 路径里的 lastPushByPeer.set 对齐；sentAt 用 now，下次 stdin proxy 路由生效。
   */
  function setLastPushedSession(peer, sessionId) {
    if (!peer || !sessionId) return false
    lastPushByPeer.set(String(peer), { sessionId, sentAt: Date.now() })
    return true
  }

  /** session 结束时清掉它的 last-push 记录，避免下条用户消息误投到死 session */
  function clearLastPushForSession(sessionId) {
    if (!sessionId) return
    for (const [peer, entry] of lastPushByPeer) {
      if (entry.sessionId === sessionId) lastPushByPeer.delete(peer)
    }
  }

  /** 用户主动退出 PTY 直连：清这个 peer 的 last-push */
  function clearLastPushForPeer(peer) {
    if (!peer) return false
    return lastPushByPeer.delete(peer)
  }

  /**
   * 反查：哪些 sessionId 绑定到这个 peer 上。
   */
  function findSessionsByTarget(peer) {
    if (!peer) return []
    const out = []
    for (const [sid, info] of sessionRoutes) {
      // 同一个 peer 可能有多个 session；route 里 targetUserId 可能带或不带后缀
      const tgt = info?.targetUserId || ''
      if (tgt === peer || tgt.startsWith(peer + '@') || peer.startsWith(tgt + '@')) {
        out.push(sid)
      }
    }
    return out
  }

  /**
   * 反查：找绑定到 (chatId, threadId) 的 session。
   * Telegram Topic 路由用：用户在 task topic 里回话时知道写哪个 PTY。
   * 返回 sessionId 或 null。
   */
  function findSessionByRoute({ chatId, threadId } = {}) {
    if (!chatId) return null
    const targetStr = String(chatId)
    for (const [sid, info] of sessionRoutes) {
      if (String(info?.targetUserId || '') !== targetStr) continue
      if ((info?.threadId || null) !== (threadId || null)) continue
      return sid
    }
    return null
  }

  /**
   * 健康检查：跑 `openclaw doctor` 或简单跑 `openclaw --version`。
   * 仅看是否能起进程 + 退出码 0；不深入语义。
   */
  async function healthCheck() {
    return new Promise((resolve) => {
      let ok = false
      let stderr = ''
      const proc = spawnFn(cliBin, ['--version'], { env: process.env })
      const timer = setTimeout(() => {
        try { proc.kill() } catch {}
        resolve({ ok: false, reason: 'timeout' })
      }, 5_000)
      timer.unref?.()
      proc.stdout?.on('data', () => { ok = true })
      proc.stderr?.on('data', (d) => { stderr += d.toString() })
      proc.on('error', (e) => {
        clearTimeout(timer)
        resolve({ ok: false, reason: 'cli_unavailable', detail: e.message })
      })
      proc.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0 && ok) resolve({ ok: true })
        else resolve({ ok: false, reason: 'cli_failed', exitCode: code, stderr })
      })
    })
  }

  function describe() {
    const oc = getOpenClawConfig()
    return {
      enabled: Boolean(oc.enabled),
      channel: oc.channel || 'openclaw-weixin',
      gatewayUrl: oc.gatewayUrl || null,
      targetUserIdSet: Boolean(oc.targetUserId),
      sessionRoutesCount: sessionRoutes.size,
      rateLimit: {
        perMin: Math.max(1, Number(oc?.askUser?.rateLimitPerMin) || 6),
        recent: sendTimestamps.length,
      },
    }
  }

  function setTelegramBot(bot) { telegramBot = bot }
  function setTopicGoneHandler(fn) { topicGoneHandler = typeof fn === 'function' ? fn : null }
  function listSessionRoutes() {
    return Array.from(sessionRoutes.entries()).map(([sessionId, info]) => ({ sessionId, ...info }))
  }

  return {
    postText,
    healthCheck,
    isEnabled,
    registerSessionRoute,
    clearSessionRoute,
    resolveRoute,
    getLastPushedSession,
    setLastPushedSession,
    clearLastPushForSession,
    clearLastPushForPeer,
    findSessionsByTarget,
    findSessionByRoute,
    setTelegramBot,
    setTopicGoneHandler,
    listSessionRoutes,
    hasExplicitRoute,
    describe,
  }
}
