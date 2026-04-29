import { Router } from 'express'

/**
 * POST /api/openclaw/inbound
 *   body: { from: string, text: string }
 *
 * OpenClaw skill 把每条用户微信消息转发到这里，由 wizard 状态机
 * 自己决定怎么响应。返回 { reply: string, action?: string, ... }，
 * skill 把 reply 转发给用户即可。
 */
export function createOpenClawInboundRouter({ wizard } = {}) {
  if (!wizard) throw new Error('wizard required')
  const router = Router()

  router.post('/', async (req, res) => {
    try {
      const { from, text } = req.body || {}
      if (!from || typeof from !== 'string') {
        return res.status(400).json({ ok: false, error: 'from_required' })
      }
      if (!text || typeof text !== 'string') {
        return res.status(400).json({ ok: false, error: 'text_required' })
      }
      const result = await wizard.handleInbound({ peer: from, text })
      return res.json({ ok: true, ...result })
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || 'inbound_failed' })
    }
  })

  router.get('/state', (_req, res) => {
    return res.json({ ok: true, ...wizard.describe() })
  })

  return router
}
