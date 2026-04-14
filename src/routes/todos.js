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

  router.get('/:id/comments', (req, res) => {
    try {
      const existing = db.getTodo(req.params.id)
      if (!existing) {
        res.status(404).json({ ok: false, error: 'not_found' })
        return
      }
      const list = db.listComments(req.params.id)
      res.json({ ok: true, list })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  router.post('/:id/comments', (req, res) => {
    try {
      const existing = db.getTodo(req.params.id)
      if (!existing) {
        res.status(404).json({ ok: false, error: 'not_found' })
        return
      }
      const { content } = req.body || {}
      if (!content || typeof content !== 'string' || !content.trim()) {
        res.status(400).json({ ok: false, error: 'missing content' })
        return
      }
      const comment = db.addComment(req.params.id, content.trim())
      res.json({ ok: true, comment })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  router.delete('/:id/comments/:commentId', (req, res) => {
    try {
      const comment = db.getComment(req.params.commentId)
      if (!comment || comment.todoId !== req.params.id) {
        res.status(404).json({ ok: false, error: 'comment_not_found' })
        return
      }
      db.deleteComment(req.params.commentId)
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  router.patch('/:id/ai-sessions/:sessionId', (req, res) => {
    try {
      const existing = db.getTodo(req.params.id)
      if (!existing) {
        res.status(404).json({ ok: false, error: 'not_found' })
        return
      }
      const { label } = req.body || {}
      const nextAiSessions = (existing.aiSessions || []).map(item => {
        if (item?.sessionId !== req.params.sessionId) return item
        return { ...item, label: typeof label === 'string' ? label.trim() : (item.label || '') }
      })
      const found = nextAiSessions.some(item => item?.sessionId === req.params.sessionId)
      if (!found) {
        res.status(404).json({ ok: false, error: 'session_not_found' })
        return
      }
      const todo = db.updateTodo(req.params.id, { aiSessions: nextAiSessions })
      res.json({ ok: true, todo })
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
