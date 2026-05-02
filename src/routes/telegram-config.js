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
import { readBotTokenWithSource } from '../telegram-bot.js'

export function createTelegramConfigRouter({ getConfig, getTelegramBot, probeRegistry }) {
  if (typeof getConfig !== 'function') throw new Error('getConfig required')
  if (typeof getTelegramBot !== 'function') throw new Error('getTelegramBot required')

  const router = Router()

  // POST /test —— getMe 探测
  router.post('/test', async (_req, res) => {
    const { token, source } = readBotTokenWithSource(getConfig)
    if (!token) {
      return res.json({ ok: false, errorReason: 'token_missing', source })
    }
    const bot = getTelegramBot()
    if (!bot || typeof bot.getMe !== 'function') {
      return res.json({ ok: false, errorReason: 'bot_not_running', source })
    }
    try {
      const me = await bot.getMe()
      res.json({
        ok: true,
        botId: me.id,
        botUsername: me.username || null,
        botFirstName: me.first_name || null,
        source,
      })
    } catch (e) {
      res.json({ ok: false, errorReason: e.message || 'unknown', source })
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
