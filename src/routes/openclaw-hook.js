import { Router } from 'express'

/**
 * POST /api/openclaw/hook
 *   body: { event, sessionId, targetUserId?, todoId?, todoTitle?, hookPayload? }
 *
 * Claude Code hook 脚本（~/.quadtodo/claude-hooks/notify.js）调用此端点。
 * 端到端逻辑都委托给 openclaw-hook handler，路由层只做 body 校验。
 */
export function createOpenClawHookRouter({ hookHandler } = {}) {
  if (!hookHandler) throw new Error('hookHandler required')
  const router = Router()

  router.post('/', async (req, res) => {
    try {
      const {
        event,
        sessionId,
        targetUserId,
        todoId,
        todoTitle,
        hookPayload,
      } = req.body || {}

      if (!event || typeof event !== 'string') {
        return res.status(400).json({ ok: false, error: 'event_required' })
      }

      const result = await hookHandler.handle({
        event,
        sessionId: sessionId || null,
        todoId: todoId || null,
        todoTitle: todoTitle || null,
        targetUserId: targetUserId || null,
        hookPayload: hookPayload || null,
      })

      return res.json({ ok: result.ok, ...result })
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || 'hook_handle_failed' })
    }
  })

  return router
}
