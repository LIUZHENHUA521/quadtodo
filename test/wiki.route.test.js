import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db.js'
import { createWikiService } from '../src/wiki/index.js'
import { createWikiRouter } from '../src/routes/wiki.js'

function makeApp(svc) {
  const app = express()
  app.use(express.json())
  app.use('/api/wiki', createWikiRouter({ service: svc }))
  return app
}

describe('routes/wiki', () => {
  let root, wikiDir, db, svc, todo

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'qt-wiki-route-'))
    wikiDir = join(root, 'wiki')
    db = openDb(':memory:')
    todo = db.createTodo({ title: 't1', quadrant: 1, status: 'done' })
    svc = createWikiService({
      db, logDir: root, wikiDir,
      getTools: () => ({ claude: { command: 'claude', bin: 'claude', args: [] } }),
      execClaude: async ({ cwd }) => {
        writeFileSync(join(cwd, 'topics', 'x.md'), '# X\n')
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    })
    await svc.init()
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    try { db.raw.close() } catch {}
  })

  it('GET /api/wiki/status returns wikiDir + initState', async () => {
    const res = await request(makeApp(svc)).get('/api/wiki/status')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.status.wikiDir).toBe(wikiDir)
    expect(res.body.status.initState).toBe('ready')
  })

  it('GET /api/wiki/pending returns unapplied done todos', async () => {
    const res = await request(makeApp(svc)).get('/api/wiki/pending')
    expect(res.status).toBe(200)
    expect(res.body.list).toHaveLength(1)
    expect(res.body.list[0].id).toBe(todo.id)
  })

  it('POST /api/wiki/run with empty todoIds returns 400', async () => {
    const res = await request(makeApp(svc)).post('/api/wiki/run').send({ todoIds: [] })
    expect(res.status).toBe(400)
  })

  it('POST /api/wiki/run with dryRun=true returns success without calling claude', async () => {
    const res = await request(makeApp(svc)).post('/api/wiki/run').send({ todoIds: [todo.id], dryRun: true })
    expect(res.status).toBe(200)
    expect(res.body.dryRun).toBe(true)
    expect(res.body.sourcesWritten).toBe(1)
  })

  it('POST /api/wiki/run with dryRun=false calls claude and returns success', async () => {
    const res = await request(makeApp(svc)).post('/api/wiki/run').send({ todoIds: [todo.id], dryRun: false })
    expect(res.status).toBe(200)
    expect(res.body.exitCode).toBe(0)
  })

  it('GET /api/wiki/tree returns file list under wikiDir', async () => {
    const res = await request(makeApp(svc)).get('/api/wiki/tree')
    expect(res.status).toBe(200)
    const paths = res.body.files.map(f => f.path)
    expect(paths).toContain('WIKI_GUIDE.md')
    expect(paths).toContain('index.md')
  })

  it('GET /api/wiki/file reads file content within wikiDir', async () => {
    const res = await request(makeApp(svc)).get('/api/wiki/file').query({ path: 'WIKI_GUIDE.md' })
    expect(res.status).toBe(200)
    expect(res.body.content).toMatch(/Wiki 维护指南/)
  })

  it('GET /api/wiki/file rejects path traversal', async () => {
    const res = await request(makeApp(svc)).get('/api/wiki/file').query({ path: '../../../etc/passwd' })
    expect(res.status).toBe(400)
  })

  it('GET /api/wiki/file rejects absolute path outside wikiDir', async () => {
    const res = await request(makeApp(svc)).get('/api/wiki/file').query({ path: '/etc/passwd' })
    expect(res.status).toBe(400)
  })

  it('GET /api/wiki/runs returns recent runs', async () => {
    await request(makeApp(svc)).post('/api/wiki/run').send({ todoIds: [todo.id], dryRun: true })
    const res = await request(makeApp(svc)).get('/api/wiki/runs')
    expect(res.status).toBe(200)
    expect(res.body.list.length).toBeGreaterThan(0)
  })
})
