import { Router } from 'express'

const USER_ERRORS = new Set([
  'invalid_frequency',
  'weekdays_required',
  'month_days_required',
  'invalid_quadrant',
  'title_required',
])

function handleError(res, e) {
  if (USER_ERRORS.has(e?.message)) {
    res.status(400).json({ ok: false, error: e.message })
    return
  }
  res.status(500).json({ ok: false, error: e?.message || 'internal_error' })
}

export function createRecurringRulesRouter({ db }) {
  const router = Router()

  router.get('/:id', (req, res) => {
    try {
      const rule = db.getRecurringRule(req.params.id)
      if (!rule) {
        res.status(404).json({ ok: false, error: 'not_found' })
        return
      }
      res.json({ ok: true, rule })
    } catch (e) {
      handleError(res, e)
    }
  })

  router.post('/', (req, res) => {
    try {
      const result = db.createRecurringRule(req.body || {})
      res.json({ ok: true, ...result })
    } catch (e) {
      handleError(res, e)
    }
  })

  router.put('/:id', (req, res) => {
    try {
      const rule = db.updateRecurringRule(req.params.id, req.body || {})
      if (!rule) {
        res.status(404).json({ ok: false, error: 'not_found' })
        return
      }
      res.json({ ok: true, rule })
    } catch (e) {
      handleError(res, e)
    }
  })

  router.post('/:id/deactivate', (req, res) => {
    try {
      const rule = db.setRecurringRuleActive(req.params.id, false)
      if (!rule) {
        res.status(404).json({ ok: false, error: 'not_found' })
        return
      }
      res.json({ ok: true, rule })
    } catch (e) {
      handleError(res, e)
    }
  })

  router.delete('/:id', (req, res) => {
    try {
      db.deleteRecurringRule(req.params.id)
      res.json({ ok: true })
    } catch (e) {
      handleError(res, e)
    }
  })

  return router
}
