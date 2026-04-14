import express from 'express'

export function createTranscriptsRouter({ service }) {
  const router = express.Router()

  router.post('/scan', async (_req, res) => {
    try {
      const r = await service.scanIncremental()
      res.json({ ok: true, ...r })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  router.get('/stats', (_req, res) => {
    res.json({ ok: true, ...service.getStats() })
  })

  router.get('/search', (req, res) => {
    try {
      const { q, tool, cwd, since, unboundOnly, limit, offset } = req.query
      const r = service.search({
        q: q ? String(q) : undefined,
        tool: tool ? String(tool) : undefined,
        cwd: cwd ? String(cwd) : undefined,
        since: since ? Number(since) : undefined,
        unboundOnly: unboundOnly === '1' || unboundOnly === 'true',
        limit: limit ? Math.min(Number(limit), 200) : 50,
        offset: offset ? Number(offset) : 0,
      })
      res.json({ ok: true, ...r })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  router.get('/:fileId', (req, res) => {
    const f = service.getFile(Number(req.params.fileId))
    if (!f) return res.status(404).json({ ok: false, error: 'not found' })
    res.json({ ok: true, file: f })
  })

  router.get('/:fileId/preview', async (req, res) => {
    try {
      const r = await service.preview(Number(req.params.fileId), {
        offset: req.query.offset ? Number(req.query.offset) : 0,
        limit: req.query.limit ? Math.min(Number(req.query.limit), 500) : 200,
      })
      if (!r) return res.status(404).json({ ok: false, error: 'not found' })
      res.json({ ok: true, ...r })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  router.post('/:fileId/bind', (req, res) => {
    const { todoId, force } = req.body || {}
    if (!todoId) return res.status(400).json({ ok: false, error: 'todoId required' })
    const r = service.bind(Number(req.params.fileId), String(todoId), { force: Boolean(force) })
    if (!r.ok) {
      if (r.code === 'ALREADY_BOUND') return res.status(409).json({ ok: false, code: r.code, currentTodoId: r.currentTodoId })
      if (r.code === 'NOT_FOUND') return res.status(404).json({ ok: false, error: 'not found' })
      return res.status(400).json({ ok: false, code: r.code })
    }
    res.json({ ok: true })
  })

  router.post('/:fileId/unbind', (req, res) => {
    const r = service.unbind(Number(req.params.fileId))
    if (!r.ok) return res.status(404).json({ ok: false, error: 'not found' })
    res.json({ ok: true })
  })

  return router
}
