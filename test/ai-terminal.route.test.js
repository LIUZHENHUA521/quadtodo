import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db.js'
import { createAiTerminal } from '../src/routes/ai-terminal.js'

// 假 PtyManager：不 spawn 真进程，手动触发事件
class FakePty extends EventEmitter {
  constructor() {
    super()
    this.started = []
    this.writes = []
    this.resizes = []
    this.stopped = []
    this._has = new Set()
  }
  start(opts) {
    this.started.push(opts)
    this._has.add(opts.sessionId)
  }
  write(id, data) { this.writes.push({ id, data }) }
  resize(id, cols, rows) { this.resizes.push({ id, cols, rows }) }
  stop(id) {
    this.stopped.push(id)
    this._has.delete(id)
    this.emit('done', { sessionId: id, exitCode: 0, fullLog: '', nativeId: null, stopped: true })
  }
  has(id) { return this._has.has(id) }
  list() { return [...this._has] }
}

function makeApp() {
  const db = openDb(':memory:')
  const pty = new FakePty()
  const logDir = mkdtempSync(join(tmpdir(), 'quadtodo-log-'))
  const ait = createAiTerminal({ db, pty, logDir })
  const app = express()
  app.use(express.json())
  app.use('/api/ai-terminal', ait.router)
  return { app, db, pty, ait, logDir }
}

describe('routes/ai-terminal', () => {
  let ctx
  beforeEach(() => { ctx = makeApp() })

  it('POST /exec requires todoId, prompt, tool', async () => {
    const r = await request(ctx.app).post('/api/ai-terminal/exec').send({})
    expect(r.status).toBe(400)
  })

  it('POST /exec rejects unknown todo', async () => {
    const r = await request(ctx.app)
      .post('/api/ai-terminal/exec')
      .send({ todoId: 'nope', prompt: 'hi', tool: 'claude' })
    expect(r.status).toBe(404)
  })

  it('POST /exec starts a pty and updates todo', async () => {
    const todo = ctx.db.createTodo({ title: 'T', quadrant: 1 })
    const r = await request(ctx.app)
      .post('/api/ai-terminal/exec')
      .send({ todoId: todo.id, prompt: 'hello', tool: 'claude' })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(r.body.sessionId).toMatch(/^ai-/)
    expect(ctx.pty.started).toHaveLength(1)
    expect(ctx.pty.started[0].tool).toBe('claude')
    expect(ctx.pty.started[0].prompt).toBe('hello')
    const updated = ctx.db.getTodo(todo.id)
    expect(updated.status).toBe('ai_running')
    expect(updated.aiSession.tool).toBe('claude')
    expect(updated.aiSession.status).toBe('running')
  })

  it('POST /exec refuses concurrent session on same todo', async () => {
    const todo = ctx.db.createTodo({ title: 'T', quadrant: 1 })
    await request(ctx.app).post('/api/ai-terminal/exec')
      .send({ todoId: todo.id, prompt: 'hi', tool: 'claude' })
    const r = await request(ctx.app).post('/api/ai-terminal/exec')
      .send({ todoId: todo.id, prompt: 'again', tool: 'claude' })
    expect(r.status).toBe(409)
  })

  it('native-session event saves nativeSessionId on todo', async () => {
    const todo = ctx.db.createTodo({ title: 'T', quadrant: 1 })
    const { body } = await request(ctx.app).post('/api/ai-terminal/exec')
      .send({ todoId: todo.id, prompt: 'hi', tool: 'claude' })
    ctx.pty.emit('native-session', {
      sessionId: body.sessionId,
      nativeId: 'abcdef12-3456-7890-abcd-ef1234567890',
    })
    const updated = ctx.db.getTodo(todo.id)
    expect(updated.aiSession.nativeSessionId).toBe('abcdef12-3456-7890-abcd-ef1234567890')
  })

  it('output event is captured in history buffer', async () => {
    const todo = ctx.db.createTodo({ title: 'T', quadrant: 1 })
    const { body } = await request(ctx.app).post('/api/ai-terminal/exec')
      .send({ todoId: todo.id, prompt: 'hi', tool: 'claude' })
    ctx.pty.emit('output', { sessionId: body.sessionId, data: 'chunk1' })
    ctx.pty.emit('output', { sessionId: body.sessionId, data: 'chunk2' })
    const session = ctx.ait.sessions.get(body.sessionId)
    expect(session.outputHistory).toEqual(['chunk1', 'chunk2'])
  })

  it('done event with exitCode 0 marks todo ai_done and writes log', async () => {
    const todo = ctx.db.createTodo({ title: 'T', quadrant: 1 })
    const { body } = await request(ctx.app).post('/api/ai-terminal/exec')
      .send({ todoId: todo.id, prompt: 'hi', tool: 'claude' })
    ctx.pty.emit('done', {
      sessionId: body.sessionId,
      exitCode: 0,
      fullLog: 'final log content',
      nativeId: 'abcdef12-3456-7890-abcd-ef1234567890',
      stopped: false,
    })
    const updated = ctx.db.getTodo(todo.id)
    expect(updated.status).toBe('ai_done')
    expect(updated.aiSession.status).toBe('done')
    const logPath = join(ctx.logDir, `${body.sessionId}.log`)
    // file write is async — wait briefly
    await new Promise(r => setTimeout(r, 50))
    expect(existsSync(logPath)).toBe(true)
    expect(readFileSync(logPath, 'utf8')).toBe('final log content')
  })

  it('done event with non-zero exit marks todo todo/failed', async () => {
    const todo = ctx.db.createTodo({ title: 'T', quadrant: 1 })
    const { body } = await request(ctx.app).post('/api/ai-terminal/exec')
      .send({ todoId: todo.id, prompt: 'hi', tool: 'claude' })
    ctx.pty.emit('done', {
      sessionId: body.sessionId,
      exitCode: 1,
      fullLog: '',
      nativeId: null,
      stopped: false,
    })
    const updated = ctx.db.getTodo(todo.id)
    expect(updated.status).toBe('todo')
    expect(updated.aiSession.status).toBe('failed')
  })

  it('POST /stop delegates to pty and sets todo=todo', async () => {
    const todo = ctx.db.createTodo({ title: 'T', quadrant: 1 })
    const exec = await request(ctx.app).post('/api/ai-terminal/exec')
      .send({ todoId: todo.id, prompt: 'hi', tool: 'claude' })
    const r = await request(ctx.app).post('/api/ai-terminal/stop')
      .send({ sessionId: exec.body.sessionId })
    expect(r.status).toBe(200)
    expect(ctx.pty.stopped).toEqual([exec.body.sessionId])
    const updated = ctx.db.getTodo(todo.id)
    expect(updated.status).toBe('todo')
    expect(updated.aiSession.status).toBe('stopped')
  })

  it('POST /stop 404 for unknown session', async () => {
    const r = await request(ctx.app).post('/api/ai-terminal/stop').send({ sessionId: 'nope' })
    expect(r.status).toBe(404)
  })

  it('broadcastToSession sends to all ws browsers for that session', async () => {
    const todo = ctx.db.createTodo({ title: 'T', quadrant: 1 })
    const { body } = await request(ctx.app).post('/api/ai-terminal/exec')
      .send({ todoId: todo.id, prompt: 'hi', tool: 'claude' })
    const sent1 = []
    const sent2 = []
    const fakeWs1 = { readyState: 1, OPEN: 1, send: (d) => sent1.push(d) }
    const fakeWs2 = { readyState: 1, OPEN: 1, send: (d) => sent2.push(d) }
    ctx.ait.addBrowser(body.sessionId, fakeWs1)
    ctx.ait.addBrowser(body.sessionId, fakeWs2)
    ctx.pty.emit('output', { sessionId: body.sessionId, data: 'hi' })
    expect(sent1).toHaveLength(1)
    expect(sent2).toHaveLength(1)
    expect(JSON.parse(sent1[0])).toEqual({ type: 'output', data: 'hi' })
  })

  it('addBrowser replays existing outputHistory immediately', async () => {
    const todo = ctx.db.createTodo({ title: 'T', quadrant: 1 })
    const { body } = await request(ctx.app).post('/api/ai-terminal/exec')
      .send({ todoId: todo.id, prompt: 'hi', tool: 'claude' })
    ctx.pty.emit('output', { sessionId: body.sessionId, data: 'chunk1' })
    ctx.pty.emit('output', { sessionId: body.sessionId, data: 'chunk2' })
    const sent = []
    const ws = { readyState: 1, OPEN: 1, send: (d) => sent.push(JSON.parse(d)) }
    ctx.ait.addBrowser(body.sessionId, ws)
    const replay = sent.find(m => m.type === 'replay')
    expect(replay).toBeTruthy()
    expect(replay.chunks).toEqual(['chunk1', 'chunk2'])
  })

  it('addBrowser on unknown session sends error', () => {
    const sent = []
    const ws = { readyState: 1, OPEN: 1, send: (d) => sent.push(JSON.parse(d)), close: vi.fn() }
    ctx.ait.addBrowser('nope', ws)
    expect(sent[0]).toEqual({ type: 'error', error: 'session_not_found' })
    expect(ws.close).toHaveBeenCalled()
  })

  it('outputHistory enforces 512KB ceiling', async () => {
    const todo = ctx.db.createTodo({ title: 'T', quadrant: 1 })
    const { body } = await request(ctx.app).post('/api/ai-terminal/exec')
      .send({ todoId: todo.id, prompt: 'hi', tool: 'claude' })
    const big = 'x'.repeat(100 * 1024)
    for (let i = 0; i < 10; i++) {
      ctx.pty.emit('output', { sessionId: body.sessionId, data: big })
    }
    const session = ctx.ait.sessions.get(body.sessionId)
    expect(session.outputSize).toBeLessThanOrEqual(512 * 1024 + big.length)
    expect(session.outputHistory.length).toBeLessThan(10)
  })
})
