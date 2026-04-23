import { Router } from 'express'

/**
 * 统一搜索 HTTP 端点。
 *
 * GET /api/search?q=...&scopes=todos,comments,wiki,ai_sessions&includeArchived=false&limit=20
 *
 * 返回:
 *   {
 *     ok: true,
 *     total: 37,
 *     results: [{ scope, todoId, todoTitle, snippet, score, ...scope-specific-ids }, ...]
 *   }
 */
export function createSearchRouter({ searchService } = {}) {
  if (!searchService || typeof searchService.search !== 'function') {
    throw new Error('searchService_required')
  }
  const router = Router()

  router.get('/', (req, res) => {
    try {
      const q = String(req.query.q || '').trim()
      if (!q) {
        res.status(400).json({ ok: false, error: 'query_required' })
        return
      }
      let scopes
      const rawScopes = req.query.scopes
      if (typeof rawScopes === 'string' && rawScopes.length) {
        scopes = rawScopes.split(',').map((s) => s.trim()).filter(Boolean)
      }
      const includeArchived =
        req.query.includeArchived === 'true' || req.query.includeArchived === '1'
      const limit = req.query.limit == null ? undefined : Number(req.query.limit)
      const out = searchService.search({ query: q, scopes, includeArchived, limit })
      res.json({ ok: true, ...out })
    } catch (e) {
      const msg = e?.message || String(e)
      const status = msg === 'query_required' ? 400 : 500
      res.status(status).json({ ok: false, error: msg })
    }
  })

  return router
}
