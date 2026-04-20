import { Router } from 'express'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'

function walkDir(root, current = root, out = [], maxDepth = 5, depth = 0) {
  if (depth > maxDepth) return out
  let entries = []
  try { entries = readdirSync(current, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (e.name === '.git') continue
    const abs = join(current, e.name)
    const rel = relative(root, abs)
    if (e.isDirectory()) {
      out.push({ path: rel, type: 'dir' })
      walkDir(root, abs, out, maxDepth, depth + 1)
    } else if (e.isFile()) {
      let size = 0
      try { size = statSync(abs).size } catch {}
      out.push({ path: rel, type: 'file', size })
    }
  }
  return out
}

function isPathSafe(wikiDir, relPath) {
  if (typeof relPath !== 'string' || !relPath) return false
  if (relPath.startsWith('/')) return false
  const abs = resolve(wikiDir, relPath)
  const wikiResolved = resolve(wikiDir)
  return abs === wikiResolved || abs.startsWith(wikiResolved + '/')
}

export function createWikiRouter({ service }) {
  const router = Router()

  router.get('/status', (_req, res) => {
    try {
      res.json({ ok: true, status: service.status() })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  router.get('/pending', (_req, res) => {
    try {
      res.json({ ok: true, list: service.pending() })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  router.get('/tree', (_req, res) => {
    try {
      const s = service.status()
      if (!existsSync(s.wikiDir)) {
        res.json({ ok: true, files: [] })
        return
      }
      res.json({ ok: true, files: walkDir(s.wikiDir) })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  router.get('/file', (req, res) => {
    try {
      const s = service.status()
      const p = typeof req.query.path === 'string' ? req.query.path : ''
      if (!isPathSafe(s.wikiDir, p)) {
        res.status(400).json({ ok: false, error: 'invalid_path' })
        return
      }
      const abs = resolve(s.wikiDir, p)
      if (!existsSync(abs)) {
        res.status(404).json({ ok: false, error: 'not_found' })
        return
      }
      const st = statSync(abs)
      if (st.isDirectory()) {
        res.status(400).json({ ok: false, error: 'is_directory' })
        return
      }
      if (st.size > 2 * 1024 * 1024) {
        res.status(400).json({ ok: false, error: 'file_too_large' })
        return
      }
      res.json({ ok: true, path: p, content: readFileSync(abs, 'utf8') })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  router.post('/run', async (req, res) => {
    try {
      const { todoIds, dryRun = false } = req.body || {}
      if (!Array.isArray(todoIds) || todoIds.length === 0) {
        res.status(400).json({ ok: false, error: 'todoIds must be non-empty array' })
        return
      }
      const result = await service.runOnce({ todoIds, dryRun: !!dryRun })
      res.json({ ok: true, ...result })
    } catch (e) {
      const code = /already running/i.test(e.message) ? 409 : 500
      res.status(code).json({ ok: false, error: e.message })
    }
  })

  router.post('/init', async (_req, res) => {
    try {
      const r = await service.init()
      res.json({ ok: true, ...r })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  router.get('/runs', (req, res) => {
    try {
      const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 20))
      res.json({ ok: true, list: service.listRuns(limit) })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  return router
}
