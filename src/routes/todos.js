import { Router } from 'express'

export function createTodosRouter({ db }) {
  const router = Router()

  router.get('/', (req, res) => {
    try {
      const { quadrant, status, keyword } = req.query
      const list = db.listTodos({ quadrant, status, keyword })
      res.json({ ok: true, list })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  router.post('/', (req, res) => {
    try {
      const { title, description, quadrant, dueDate, workDir } = req.body || {}
      if (!title || typeof title !== 'string') {
        res.status(400).json({ ok: false, error: 'missing title' })
        return
      }
      const q = Number(quadrant) || 4
      if (![1, 2, 3, 4].includes(q)) {
        res.status(400).json({ ok: false, error: 'invalid quadrant' })
        return
      }
      const todo = db.createTodo({
        title,
        description: description || '',
        quadrant: q,
        dueDate: dueDate ?? null,
        workDir: workDir || null,
      })
      res.json({ ok: true, todo })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  router.put('/:id', (req, res) => {
    try {
      const existing = db.getTodo(req.params.id)
      if (!existing) {
        res.status(404).json({ ok: false, error: 'not_found' })
        return
      }
      const todo = db.updateTodo(req.params.id, req.body || {})
      res.json({ ok: true, todo })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  router.delete('/:id', (req, res) => {
    try {
      const existing = db.getTodo(req.params.id)
      if (!existing) {
        res.status(404).json({ ok: false, error: 'not_found' })
        return
      }
      db.deleteTodo(req.params.id)
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  router.delete('/:id/ai-sessions/:sessionId', (req, res) => {
    try {
      const existing = db.getTodo(req.params.id)
      if (!existing) {
        res.status(404).json({ ok: false, error: 'not_found' })
        return
      }

      const nextAiSessions = (existing.aiSessions || []).filter(item => item?.sessionId !== req.params.sessionId)
      if (nextAiSessions.length === (existing.aiSessions || []).length) {
        res.status(404).json({ ok: false, error: 'session_not_found' })
        return
      }

      const todo = db.updateTodo(req.params.id, { aiSessions: nextAiSessions })
      res.json({ ok: true, todo })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  return router
}
