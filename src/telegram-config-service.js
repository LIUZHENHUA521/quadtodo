/**
 * Telegram 配置辅助：
 *  - maskBotToken / isMaskedToken：UI 上 token 的遮罩与回显检测
 *
 * 跟 telegram-bot.js 解耦，所有 IO 由 caller 注入。
 */

const MASK_PREFIX = 'tg_***'

/**
 * 把真实 token 转成展示串：tg_***末四位。null/空返回 null。
 */
export function maskBotToken(token) {
  if (!token || typeof token !== 'string') return null
  const tail = token.length >= 4 ? token.slice(-4) : token
  return MASK_PREFIX + tail
}

/**
 * 判断字符串是不是 mask 格式（用户在 UI 没改 token 时回传的就是 mask）。
 */
export function isMaskedToken(value) {
  if (!value || typeof value !== 'string') return false
  return value.startsWith(MASK_PREFIX)
}

/**
 * Probe 状态机：startProbe(durationSec) 后，record(hit) 会写到 buffer 并通知订阅者。
 * 同一时刻只能有一个活跃 probe（second startProbe 会失败）。
 *
 * 时间通过 now() 注入，便于测试。
 *
 * 返回：{ startProbe, stopProbe, record, subscribe, isActive, snapshot }
 */
export function createProbeRegistry({ now = () => Date.now() } = {}) {
  let expiresAt = 0
  let hits = []
  const subscribers = new Set()

  function isActive() {
    return now() < expiresAt
  }

  function startProbe(durationSec) {
    if (isActive()) return { ok: false, reason: 'already_active' }
    const clamped = Math.min(120, Math.max(10, Number(durationSec) || 60))
    expiresAt = now() + clamped * 1000
    hits = []
    return { ok: true, durationSec: clamped, expiresAt }
  }

  function stopProbe() {
    expiresAt = 0
    hits = []
    for (const fn of subscribers) {
      try { fn(null) } catch {}
    }
  }

  function record(hit) {
    if (!isActive()) return false
    const entry = { ...hit, at: now() }
    hits.push(entry)
    for (const fn of subscribers) {
      try { fn(entry) } catch {}
    }
    return true
  }

  function subscribe(fn) {
    subscribers.add(fn)
    return () => subscribers.delete(fn)
  }

  function snapshot() {
    return {
      active: isActive(),
      expiresAt,
      hits: [...hits],
    }
  }

  return { startProbe, stopProbe, record, subscribe, isActive, snapshot }
}
