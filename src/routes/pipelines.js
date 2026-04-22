import { Router } from 'express'

export function createPipelinesRouter({ db, orchestrator }) {
  const router = Router()

  // ─── templates ───
  router.get('/templates', (req, res) => {
    try { res.json({ ok: true, templates: db.listPipelineTemplates() }) }
    catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })

  router.get('/templates/:id', (req, res) => {
    const t = db.getPipelineTemplate(req.params.id)
    if (!t) return res.status(404).json({ ok: false, error: 'not_found' })
    res.json({ ok: true, template: t })
  })

  router.post('/templates', (req, res) => {
    try {
      const t = db.createPipelineTemplate(req.body || {})
      res.json({ ok: true, template: t })
    } catch (e) { res.status(400).json({ ok: false, error: e.message }) }
  })

  router.put('/templates/:id', (req, res) => {
    try {
      const t = db.updatePipelineTemplate(req.params.id, req.body || {})
      if (!t) return res.status(404).json({ ok: false, error: 'not_found' })
      res.json({ ok: true, template: t })
    } catch (e) {
      const code = e.message === 'builtin_pipeline_template_readonly' ? 400 : 500
      res.status(code).json({ ok: false, error: e.message })
    }
  })

  router.delete('/templates/:id', (req, res) => {
    try {
      db.deletePipelineTemplate(req.params.id)
      res.json({ ok: true })
    } catch (e) {
      const code = e.message === 'builtin_pipeline_template_readonly' ? 400 : 500
      res.status(code).json({ ok: false, error: e.message })
    }
  })

  // ─── runs ───
  router.get('/runs/todo/:todoId', (req, res) => {
    try { res.json({ ok: true, runs: db.listPipelineRunsForTodo(req.params.todoId) }) }
    catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })

  router.get('/runs/:id', (req, res) => {
    const r = db.getPipelineRun(req.params.id)
    if (!r) return res.status(404).json({ ok: false, error: 'not_found' })
    res.json({ ok: true, run: r })
  })

  router.post('/runs', async (req, res) => {
    try {
      const { todoId, templateId } = req.body || {}
      if (!todoId || !templateId) return res.status(400).json({ ok: false, error: 'todoId + templateId required' })
      if (!orchestrator || typeof orchestrator.startRun !== 'function') {
        return res.status(503).json({ ok: false, error: 'orchestrator_unavailable' })
      }
      const run = await orchestrator.startRun({ todoId, templateId })
      res.json({ ok: true, run })
    } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })

  router.post('/runs/:id/stop', async (req, res) => {
    try {
      if (!orchestrator || typeof orchestrator.stopRun !== 'function') {
        return res.status(503).json({ ok: false, error: 'orchestrator_unavailable' })
      }
      const run = await orchestrator.stopRun(req.params.id)
      res.json({ ok: true, run })
    } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })

  return router
}
