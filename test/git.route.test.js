import { describe, it, expect, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { createGitRouter } from '../src/routes/git.js'

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'quadtodo-gitroute-'))
  execSync('git init -q', { cwd: dir })
  execSync('git config user.email "t@e.com"', { cwd: dir })
  execSync('git config user.name "t"', { cwd: dir })
  execSync('git config commit.gpgsign false', { cwd: dir })
  writeFileSync(join(dir, 'a.txt'), 'x')
  execSync('git add a.txt && git commit -m "a"', { cwd: dir })
  return dir
}

function makeApp() {
  const app = express()
  app.use(express.json())
  const { router, invalidate } = createGitRouter()
  app.use('/api/git', router)
  return { app, invalidate }
}

describe('routes/git', () => {
  let dirs = []
  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }) } catch {}
    }
    dirs = []
  })

  it('GET /status rejects missing workDir', async () => {
    const { app } = makeApp()
    const r = await request(app).get('/api/git/status')
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('bad_request')
  })

  it('GET /status rejects relative workDir', async () => {
    const { app } = makeApp()
    const r = await request(app).get('/api/git/status').query({ workDir: './foo' })
    expect(r.status).toBe(400)
  })

  it('GET /status returns ok state for real repo', async () => {
    const d = makeRepo(); dirs.push(d)
    const { app } = makeApp()
    const r = await request(app).get('/api/git/status').query({ workDir: d })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(r.body.status.state).toBe('ok')
    expect(typeof r.body.timestamp).toBe('number')
  })

  it('GET /status is cached (second call does not re-spawn)', async () => {
    const d = makeRepo(); dirs.push(d)
    const { app } = makeApp()
    const r1 = await request(app).get('/api/git/status').query({ workDir: d })
    const ts1 = r1.body.timestamp
    await new Promise((resolve) => setTimeout(resolve, 20))
    const r2 = await request(app).get('/api/git/status').query({ workDir: d })
    expect(r2.body.timestamp).toBe(ts1)
  })

  it('POST /refresh bypasses cache', async () => {
    const d = makeRepo(); dirs.push(d)
    const { app } = makeApp()
    const r1 = await request(app).get('/api/git/status').query({ workDir: d })
    const ts1 = r1.body.timestamp
    await new Promise((resolve) => setTimeout(resolve, 20))
    const r2 = await request(app).post('/api/git/refresh').send({ workDir: d })
    expect(r2.body.timestamp).toBeGreaterThan(ts1)
  })

  it('invalidate() drops cache for that workDir', async () => {
    const d = makeRepo(); dirs.push(d)
    const { app, invalidate } = makeApp()
    const r1 = await request(app).get('/api/git/status').query({ workDir: d })
    const ts1 = r1.body.timestamp
    invalidate(d)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const r2 = await request(app).get('/api/git/status').query({ workDir: d })
    expect(r2.body.timestamp).toBeGreaterThan(ts1)
  })

  it('GET /diff returns diff for modified repo', async () => {
    const d = makeRepo(); dirs.push(d)
    writeFileSync(join(d, 'a.txt'), 'xyz')
    const { app } = makeApp()
    const r = await request(app).get('/api/git/diff').query({ workDir: d })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(r.body.diff.state).toBe('ok')
    expect(r.body.diff.diff).toContain('a.txt')
  })
})
