import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import request from 'supertest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '../src/server.js'

class FakePty extends EventEmitter {
  constructor() { super(); this._has = new Set() }
  start(opts) { this._has.add(opts.sessionId) }
  write() {}
  resize() {}
  stop(id) {
    this._has.delete(id)
    this.emit('done', { sessionId: id, exitCode: 0, fullLog: '', nativeId: null, stopped: true })
  }
  has(id) { return this._has.has(id) }
  list() { return [...this._has] }
}

describe('server', () => {
  let srv
  beforeEach(() => {
    const logDir = mkdtempSync(join(tmpdir(), 'quadtodo-srv-'))
    srv = createServer({
      dbFile: ':memory:',
      logDir,
      pty: new FakePty(),
    })
  })
  afterEach(() => { srv.close() })

  it('GET /api/status returns ok + version + activeSessions', async () => {
    const r = await request(srv.app).get('/api/status')
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(typeof r.body.version).toBe('string')
    expect(r.body.activeSessions).toEqual(0)
  })

  it('mounts /api/todos', async () => {
    const r = await request(srv.app).get('/api/todos')
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
  })

  it('mounts /api/ai-terminal', async () => {
    const todo = srv.db.createTodo({ title: 'T', quadrant: 1 })
    const r = await request(srv.app)
      .post('/api/ai-terminal/exec')
      .send({ todoId: todo.id, prompt: 'hi', tool: 'claude' })
    expect(r.status).toBe(200)
  })

  it('listen + close resolves cleanly on random port', async () => {
    await srv.listen(0)
    const addr = srv.httpServer.address()
    expect(addr.port).toBeGreaterThan(0)
    await srv.close()
  })

  it('serves web/dist/index.html at /', async () => {
    const webDist = mkdtempSync(join(tmpdir(), 'quadtodo-dist-'))
    writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>test</title>')

    const srv2 = createServer({
      dbFile: ':memory:',
      logDir: mkdtempSync(join(tmpdir(), 'quadtodo-log2-')),
      pty: new FakePty(),
      webDist,
    })
    const r = await request(srv2.app).get('/')
    expect(r.status).toBe(200)
    expect(r.text).toContain('<title>test</title>')
    await srv2.close()
  })
})
