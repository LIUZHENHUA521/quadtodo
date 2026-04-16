import { Router } from 'express'
import { resolve, isAbsolute } from 'node:path'
import { readGitStatus, readGitDiff } from '../git/gitStatus.js'

export function createGitRouter() {
  const cache = new Map()

  function invalidate(workDir) {
    if (!workDir) return
    cache.delete(resolve(workDir))
  }

  function validateAbsolute(workDir) {
    if (!workDir || typeof workDir !== 'string') return null
    if (!isAbsolute(workDir)) return null
    return resolve(workDir)
  }

  async function computeStatus(key) {
    const status = await readGitStatus(key)
    const entry = { status, timestamp: Date.now(), inflight: null }
    cache.set(key, entry)
    return entry
  }

  async function getOrComputeStatus(key) {
    const existing = cache.get(key)
    if (existing) {
      if (existing.inflight) {
        const status = await existing.inflight
        return cache.get(key) || { status, timestamp: Date.now(), inflight: null }
      }
      return existing
    }
    const placeholder = { status: null, timestamp: 0, inflight: null }
    placeholder.inflight = readGitStatus(key)
    cache.set(key, placeholder)
    const status = await placeholder.inflight
    const entry = { status, timestamp: Date.now(), inflight: null }
    cache.set(key, entry)
    return entry
  }

  const router = Router()

  router.get('/status', async (req, res) => {
    const key = validateAbsolute(req.query.workDir)
    if (!key) {
      res.status(400).json({ ok: false, error: 'bad_request' })
      return
    }
    try {
      const entry = await getOrComputeStatus(key)
      res.json({ ok: true, status: entry.status, timestamp: entry.timestamp })
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message || 'internal_error' })
    }
  })

  router.post('/refresh', async (req, res) => {
    const key = validateAbsolute(req.body?.workDir)
    if (!key) {
      res.status(400).json({ ok: false, error: 'bad_request' })
      return
    }
    try {
      const entry = await computeStatus(key)
      res.json({ ok: true, status: entry.status, timestamp: entry.timestamp })
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message || 'internal_error' })
    }
  })

  router.get('/diff', async (req, res) => {
    const key = validateAbsolute(req.query.workDir)
    if (!key) {
      res.status(400).json({ ok: false, error: 'bad_request' })
      return
    }
    try {
      const diff = await readGitDiff(key)
      res.json({ ok: true, diff })
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message || 'internal_error' })
    }
  })

  return { router, invalidate }
}
