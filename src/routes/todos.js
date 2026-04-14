import { Router } from 'express'
import { loadTranscript } from '../transcript.js'
import { summarizeTurns } from '../summarize.js'

export function createTodosRouter({ db, logDir }) {
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
      const { title, description, quadrant, dueDate, workDir, brainstorm, appliedTemplateIds } = req.body || {}
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
        brainstorm: !!brainstorm,
        appliedTemplateIds: Array.isArray(appliedTemplateIds) ? appliedTemplateIds : [],
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

  router.get('/:id/ai-sessions/:sessionId/transcript', (req, res) => {
    try {
      const todo = db.getTodo(req.params.id)
      if (!todo) {
        res.status(404).json({ ok: false, error: 'not_found' })
        return
      }
      const session = (todo.aiSessions || []).find(s => s?.sessionId === req.params.sessionId)
      if (!session) {
        res.status(404).json({ ok: false, error: 'session_not_found' })
        return
      }
      const result = loadTranscript({
        tool: session.tool,
        nativeSessionId: session.nativeSessionId,
        cwd: session.cwd || todo.workDir || null,
        sessionId: session.sessionId,
        logDir,
      })
      const since = Number(req.query.since)
      const turns = Number.isFinite(since) && since > 0
        ? result.turns.slice(since)
        : result.turns
      res.json({
        ok: true,
        source: result.source,
        total: result.turns.length,
        offset: Number.isFinite(since) && since > 0 ? since : 0,
        turns,
        session: {
          sessionId: session.sessionId,
          tool: session.tool,
          nativeSessionId: session.nativeSessionId,
          status: session.status,
          label: session.label || '',
          startedAt: session.startedAt,
          completedAt: session.completedAt,
        },
      })
    } catch (e) {
      console.error('[transcript]', e)
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  router.post('/:id/ai-sessions/:sessionId/fork', async (req, res) => {
    try {
      const sourceTodo = db.getTodo(req.params.id)
      if (!sourceTodo) {
        res.status(404).json({ ok: false, error: 'not_found' })
        return
      }
      const session = (sourceTodo.aiSessions || []).find(s => s?.sessionId === req.params.sessionId)
      if (!session) {
        res.status(404).json({ ok: false, error: 'session_not_found' })
        return
      }

      const {
        targetTodoId,
        tool = session.tool,
        newInstruction = '',
        keepLastTurns = 6,
        summarize = true,
      } = req.body || {}

      if (!['claude', 'codex'].includes(tool)) {
        res.status(400).json({ ok: false, error: 'invalid tool' })
        return
      }

      const targetTodo = targetTodoId ? db.getTodo(targetTodoId) : sourceTodo
      if (!targetTodo) {
        res.status(404).json({ ok: false, error: 'target_not_found' })
        return
      }

      const transcript = loadTranscript({
        tool: session.tool,
        nativeSessionId: session.nativeSessionId,
        cwd: session.cwd || sourceTodo.workDir || null,
        sessionId: session.sessionId,
        logDir,
      })

      const allTurns = transcript.turns || []
      const keep = Math.max(0, Math.min(Number(keepLastTurns) || 0, allTurns.length))
      const tail = keep > 0 ? allTurns.slice(-keep) : []
      const head = keep > 0 ? allTurns.slice(0, -keep) : allTurns.slice()

      let summary = ''
      if (summarize && head.length > 0) {
        try {
          summary = await summarizeTurns(head, { tool })
        } catch (e) {
          console.warn('[fork] summarize failed:', e.message)
          summary = `（自动摘要失败：${e.message}）`
        }
      }

      const parts = []
      parts.push(`# 继续任务：${targetTodo.title}`)
      if (targetTodo.description) parts.push(`## 任务描述\n${targetTodo.description}`)
      if (summary) parts.push(`## 历史会话摘要\n${summary}`)
      if (tail.length > 0) {
        const tailText = tail.map(t => {
          const role = t.role === 'user' ? '用户' : t.role === 'assistant' ? 'AI' : t.role
          return `【${role}】${String(t.content || '').slice(0, 2000)}`
        }).join('\n\n')
        parts.push(`## 最近 ${tail.length} 轮原始对话\n${tailText}`)
      }
      if (newInstruction && newInstruction.trim()) {
        parts.push(`## 新指令\n${newInstruction.trim()}`)
      } else {
        parts.push(`## 新指令\n请在上面的上下文基础上继续推进。`)
      }

      const prompt = parts.join('\n\n')

      res.json({
        ok: true,
        prompt,
        targetTodoId: targetTodo.id,
        tool,
        cwd: targetTodo.workDir || session.cwd || null,
        sourceSessionId: session.sessionId,
        summaryUsed: !!summary,
        tailCount: tail.length,
        headCount: head.length,
      })
    } catch (e) {
      console.error('[fork]', e)
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  return router
}
