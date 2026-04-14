import { Router } from 'express'

export function createTemplatesRouter({ db }) {
  const router = Router()

  router.get('/', (req, res) => {
    try {
      res.json({ ok: true, list: db.listTemplates() })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  router.post('/', (req, res) => {
    try {
      const { name, description, content, sortOrder } = req.body || {}
      if (!name || typeof name !== 'string') {
        res.status(400).json({ ok: false, error: 'missing name' })
        return
      }
      if (typeof content !== 'string') {
        res.status(400).json({ ok: false, error: 'missing content' })
        return
      }
      const tpl = db.createTemplate({ name: name.trim(), description: description || '', content, sortOrder })
      res.json({ ok: true, template: tpl })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  router.put('/:id', (req, res) => {
    try {
      const tpl = db.updateTemplate(req.params.id, req.body || {})
      if (!tpl) {
        res.status(404).json({ ok: false, error: 'not_found' })
        return
      }
      res.json({ ok: true, template: tpl })
    } catch (e) {
      if (e.message === 'builtin_template_readonly') {
        res.status(400).json({ ok: false, error: '内置模板不可编辑，请先复制再修改' })
        return
      }
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  router.delete('/:id', (req, res) => {
    try {
      db.deleteTemplate(req.params.id)
      res.json({ ok: true })
    } catch (e) {
      if (e.message === 'builtin_template_readonly') {
        res.status(400).json({ ok: false, error: '内置模板不可删除' })
        return
      }
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  return router
}
