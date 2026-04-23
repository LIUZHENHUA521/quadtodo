import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import request from 'supertest'
import { openDb } from '../src/db.js'
import { createSearchService } from '../src/search/index.js'
import { createSearchRouter } from '../src/routes/search.js'

describe('routes/search', () => {
  let db, tmp, app, svc

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'quadtodo-search-route-'))
    db = openDb(':memory:')
    svc = createSearchService({ db, wikiDir: join(tmp, 'wiki') })
    svc.init()
    app = express()
    app.use('/api/search', createSearchRouter({ searchService: svc }))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('400 on missing q', async () => {
    const res = await request(app).get('/api/search')
    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)
    expect(res.body.error).toBe('query_required')
  })

  it('returns matches for a simple keyword', async () => {
    db.createTodo({ title: 'Fix login bug', quadrant: 1 })
    const res = await request(app).get('/api/search').query({ q: 'login' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.total).toBeGreaterThan(0)
    expect(res.body.results[0].todoTitle).toMatch(/login/i)
  })

  it('scopes parameter narrows to comments only', async () => {
    const a = db.createTodo({ title: 'alpha word', quadrant: 1 })
    db.addComment(a.id, 'also alpha here')
    const res = await request(app).get('/api/search').query({ q: 'alpha', scopes: 'comments' })
    expect(res.status).toBe(200)
    expect(res.body.results.every((r) => r.scope === 'comments')).toBe(true)
  })

  it('excludes archived by default; includeArchived=true returns them', async () => {
    const a = db.createTodo({ title: 'archived dragon', quadrant: 1 })
    db.archiveTodo(a.id)
    const r1 = await request(app).get('/api/search').query({ q: 'dragon' })
    expect(r1.body.results.find((x) => x.todoId === a.id)).toBeFalsy()
    const r2 = await request(app).get('/api/search').query({ q: 'dragon', includeArchived: 'true' })
    expect(r2.body.results.find((x) => x.todoId === a.id)).toBeTruthy()
  })

  it('limit caps result length', async () => {
    for (let i = 0; i < 10; i++) {
      db.createTodo({ title: `shared word #${i}`, quadrant: 1 })
    }
    const res = await request(app).get('/api/search').query({ q: 'shared', limit: 3 })
    expect(res.body.results.length).toBeLessThanOrEqual(3)
  })
})
