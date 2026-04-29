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

const DEFAULT_CLI_BIN = 'openclaw'
const DEFAULT_TIMEOUT_MS = 15_000

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

export function createOpenClawBridge({ getConfig, cliBin = DEFAULT_CLI_BIN, spawnFn = spawn, logger = console } = {}) {
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

  function registerSessionRoute(sessionId, { targetUserId, account, channel } = {}) {
    if (!sessionId || !targetUserId) return
    sessionRoutes.set(sessionId, {
      targetUserId,
      account: account || null,
      channel: channel || getOpenClawConfig().channel || 'openclaw-weixin',
    })
  }

  function clearSessionRoute(sessionId) {
    sessionRoutes.delete(sessionId)
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
  async function postText({ sessionId, target, message, channel, account, replyToId } = {}) {
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

    const args = [
      'message', 'send',
      '--channel', effectiveChannel,
      '--target', effectiveTarget,
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

  /** session 结束时清掉它的 last-push 记录，避免下条用户消息误投到死 session */
  function clearLastPushForSession(sessionId) {
    if (!sessionId) return
    for (const [peer, entry] of lastPushByPeer) {
      if (entry.sessionId === sessionId) lastPushByPeer.delete(peer)
    }
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

  return {
    postText,
    healthCheck,
    isEnabled,
    registerSessionRoute,
    clearSessionRoute,
    resolveRoute,
    getLastPushedSession,
    clearLastPushForSession,
    findSessionsByTarget,
    describe,
  }
}
