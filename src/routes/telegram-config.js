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

  return router
}
