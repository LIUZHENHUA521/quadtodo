/**
 * /api/config/telegram/* 路由：
 *   POST /test           —— getMe 连通性测试
 *   POST /probe-chat-id  —— 启动一个 probe 窗口（Task 9 添加）
 *   GET  /probe-chat-id/stream —— SSE 实时推命中（Task 9 添加）
 *
 * 依赖：
 *   - getConfig: () => 当前配置
 *   - getTelegramBot: () => 当前 telegramBot 实例（可能 null，比如 enabled=false）
 *   - probeRegistry: createProbeRegistry() 返回的对象（Task 9 用）
 */
import { Router } from 'express'
import { isMaskedToken } from '../telegram-config-service.js'
import * as telegramBot from '../telegram-bot.js'

const { readBotTokenWithSource } = telegramBot

const TELEGRAM_API = 'https://api.telegram.org'

async function getMeWithToken(token, fetchFn) {
  const res = await fetchFn(`${TELEGRAM_API}/bot${token}/getMe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok || !data?.ok) throw new Error(data?.description || `HTTP ${res.status}`)
  return data.result
}

// Node 的 undici fetch 失败时 e.message 只有光秃秃的 "fetch failed"，真正的网络
// 原因藏在 e.cause.message。前端只展示 e.message 没法排查（用户截图就是这个症状）。
function describeFetchError(e) {
  const base = e?.message || 'unknown'
  const causeMsg = e?.cause?.message
  if (causeMsg && causeMsg !== base) return `${base}: ${causeMsg}`
  return base
}

export function createTelegramConfigRouter({ getConfig, getTelegramBot, probeRegistry, fetchFn }) {
  if (typeof getConfig !== 'function') throw new Error('getConfig required')
  if (typeof getTelegramBot !== 'function') throw new Error('getTelegramBot required')

  // 没注入 fetchFn 时按需取 proxy-aware fetcher，跟 telegram-bot.js 一致；
  // 这样设置页"测试"按钮和 bot 长轮询走同一条出口，不会一个能连一个 fetch failed。
  // 每次请求都 resolve 一遍：让 HTTPS_PROXY 改了之后不用重启 AgentQuad。
  const resolveFetch = fetchFn
    ? async () => fetchFn
    : () => telegramBot.getProxyFetch()

  const router = Router()

  // POST /test —— getMe 探测
  router.post('/test', async (req, res) => {
    const inputToken = typeof req.body?.botToken === 'string' ? req.body.botToken.trim() : ''
    if (inputToken && !isMaskedToken(inputToken)) {
      try {
        const f = await resolveFetch()
        const me = await getMeWithToken(inputToken, f)
        return res.json({
          ok: true,
          botId: me.id,
          botUsername: me.username || null,
          botFirstName: me.first_name || null,
          source: 'input',
        })
      } catch (e) {
        return res.json({ ok: false, errorReason: describeFetchError(e), source: 'input' })
      }
    }

    const { token, source } = readBotTokenWithSource(getConfig)
    if (!token) {
      return res.json({ ok: false, errorReason: 'token_missing', source })
    }
    try {
      const f = await resolveFetch()
      const me = await getMeWithToken(token, f)
      res.json({
        ok: true,
        botId: me.id,
        botUsername: me.username || null,
        botFirstName: me.first_name || null,
        source,
      })
    } catch (e) {
      res.json({ ok: false, errorReason: describeFetchError(e), source })
    }
  })

  // POST /probe-chat-id —— 启动 probe 窗口
  router.post('/probe-chat-id', (req, res) => {
    if (!probeRegistry) {
      return res.status(500).json({ ok: false, reason: 'no_registry' })
    }
    const bot = getTelegramBot()
    if (!bot || typeof bot.setProbeListener !== 'function') {
      return res.json({ ok: false, reason: 'bot_not_running' })
    }
    const r = probeRegistry.startProbe(Number(req.body?.durationSec) || 60)
    if (!r.ok) {
      return res.json({ ok: false, reason: r.reason })
    }
    bot.setProbeListener((hit) => probeRegistry.record(hit))
    res.json({ ok: true, durationSec: r.durationSec, expiresAt: r.expiresAt })
  })

  // GET /probe-chat-id/stream —— SSE 推命中
  router.get('/probe-chat-id/stream', (req, res) => {
    if (!probeRegistry) {
      return res.status(500).json({ ok: false, reason: 'no_registry' })
    }
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    // 立即把 snapshot 推一遍（让重连客户端看到已有 hits）
    for (const hit of probeRegistry.snapshot().hits) {
      res.write(`data: ${JSON.stringify(hit)}\n\n`)
    }

    const unsub = probeRegistry.subscribe((hit) => {
      if (hit === null) {
        res.write(`event: done\ndata: {}\n\n`)
        res.end()
        return
      }
      res.write(`data: ${JSON.stringify(hit)}\n\n`)
    })

    // 每 25 秒发个 ping 防止反向代理掐
    const pingInterval = setInterval(() => {
      try { res.write(`: ping\n\n`) } catch {}
    }, 25_000)

    req.on('close', () => {
      clearInterval(pingInterval)
      unsub()
    })
  })

  // POST /probe-chat-id/stop —— 主动停
  router.post('/probe-chat-id/stop', (_req, res) => {
    const bot = getTelegramBot()
    if (bot && typeof bot.setProbeListener === 'function') bot.setProbeListener(null)
    if (probeRegistry) probeRegistry.stopProbe()
    res.json({ ok: true })
  })

  return router
}
