import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { openDb } from '../src/db.js'
import { createReportsRouter } from '../src/routes/reports.js'

function makeApp() {
  const db = openDb(':memory:')
  const app = express()
  app.use(express.json())
  app.use('/api/reports', createReportsRouter({ db }))
  return { app, db }
}

describe('routes/reports', () => {
  let app, db
  beforeEach(() => { ({ app, db } = makeApp()) })

  it('GET /api/reports/done rejects invalid range', async () => {
    const res = await request(app).get('/api/reports/done').query({ since: 'x', until: 'y' })
    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)
    expect(res.body.error).toBe('invalid_range')
  })

  it('GET /api/reports/done returns done todos + daily counts + missedCount', async () => {
    const a = db.createTodo({ title: 'A', quadrant: 1 })
    const b = db.createTodo({ title: 'B', quadrant: 2 })
    const notDone = db.createTodo({ title: 'Still pending', quadrant: 1 })
    db.updateTodo(a.id, { status: 'done' })
    await new Promise(r => setTimeout(r, 2))
    db.updateTodo(b.id, { status: 'done' })

    // 模拟一条 missed
    const missed = db.createTodo({ title: 'Missed', quadrant: 3 })
    const missedAt = Date.now()
    db.raw.prepare(`UPDATE todos SET status = 'missed', updated_at = ? WHERE id = ?`).run(missedAt, missed.id)

    const now = Date.now()
    const res = await request(app).get('/api/reports/done').query({ since: now - 60_000, until: now + 60_000 })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.total).toBe(2)
    expect(res.body.list.map(t => t.title)).toContain('A')
    expect(res.body.list.map(t => t.title)).toContain('B')
    expect(res.body.list.map(t => t.title)).not.toContain('Still pending')
    expect(res.body.missedCount).toBe(1)
    expect(Array.isArray(res.body.dailyCounts)).toBe(true)
    expect(res.body.dailyCounts.length).toBeGreaterThanOrEqual(1)
    expect(res.body.dailyCounts[0]).toHaveProperty('date')
    expect(res.body.dailyCounts[0]).toHaveProperty('count')
  })

  it('GET /api/reports/done excludes todos completed outside range', async () => {
    const a = db.createTodo({ title: 'Future', quadrant: 1 })
    db.updateTodo(a.id, { status: 'done' })
    const now = Date.now()
    const res = await request(app).get('/api/reports/done').query({ since: now + 3600_000, until: now + 7200_000 })
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(0)
    expect(res.body.missedCount).toBe(0)
  })
})
