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
  getPids() { return [...this._has].map((id, i) => ({ sessionId: id, pid: 10000 + i, tool: 'claude' })) }
}

function makeApp(opts = {}) {
  const db = openDb(':memory:')
  const pty = new FakePty()
  const logDir = mkdtempSync(join(tmpdir(), 'quadtodo-log-'))
  const ait = createAiTerminal({
    db,
    pty,
    logDir,
    defaultCwd: opts.defaultCwd,
    getWebhookConfig: opts.getWebhookConfig,
    notifier: opts.notifier,
  })
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
    expect(updated.aiSessions).toHaveLength(1)
  })

  it('POST /exec falls back to defaultCwd when request cwd is missing', async () => {
    ctx = makeApp({ defaultCwd: '/Users/liuzhenhua/Desktop/code/crazyCombo' })
    const todo = ctx.db.createTodo({ title: 'T', quadrant: 1 })
    const r = await request(ctx.app)
      .post('/api/ai-terminal/exec')
      .send({ todoId: todo.id, prompt: 'hello', tool: 'claude' })
    expect(r.status).toBe(200)
    expect(ctx.pty.started[0].cwd).toBe('/Users/liuzhenhua/Desktop/code/crazyCombo')
  })

  it('POST /exec allows a new session on the same todo (concurrent)', async () => {
    const todo = ctx.db.createTodo({ title: 'T', quadrant: 1 })
    const first = await request(ctx.app).post('/api/ai-terminal/exec')
      .send({ todoId: todo.id, prompt: 'hi', tool: 'claude' })
    const second = await request(ctx.app).post('/api/ai-terminal/exec')
      .send({ todoId: todo.id, prompt: 'again', tool: 'claude' })
    expect(second.status).toBe(200)
    expect(second.body.sessionId).not.toBe(first.body.sessionId)
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

  it('POST /exec with resumeNativeId replaces prior history entry for same native session', async () => {
    const todo = ctx.db.createTodo({
      title: 'T',
      quadrant: 1,
      aiSessions: [{
        sessionId: 'old-session',
        tool: 'claude',
        nativeSessionId: 'old-native',
        status: 'done',
        startedAt: 1,
        completedAt: 2,
        prompt: 'old',
      }],
    })
    const { body } = await request(ctx.app).post('/api/ai-terminal/exec')
      .send({
        todoId: todo.id,
        prompt: 'resume me',
        tool: 'claude',
        resumeNativeId: 'old-native',
      })
    expect(body.ok).toBe(true)
    const updated = ctx.db.getTodo(todo.id)
    expect(updated.aiSessions).toHaveLength(1)
    expect(updated.aiSessions[0].sessionId).toBe(body.sessionId)
    expect(updated.aiSessions[0].nativeSessionId).toBe('old-native')
  })

  it('POST /exec with same native session reuses existing in-memory session', async () => {
    const todo = ctx.db.createTodo({ title: 'T', quadrant: 1 })
    const first = await request(ctx.app).post('/api/ai-terminal/exec')
      .send({ todoId: todo.id, prompt: 'hi', tool: 'claude' })
    ctx.pty.emit('native-session', {
      sessionId: first.body.sessionId,
      nativeId: 'abcdef12-3456-7890-abcd-ef1234567890',
    })
    const second = await request(ctx.app).post('/api/ai-terminal/exec')
      .send({
        todoId: todo.id,
        prompt: 'hi again',
        tool: 'claude',
        resumeNativeId: 'abcdef12-3456-7890-abcd-ef1234567890',
      })
    expect(second.status).toBe(200)
    expect(second.body.reused).toBe(true)
    expect(second.body.sessionId).toBe(first.body.sessionId)
    expect(ctx.pty.started).toHaveLength(1)
  })

  it('POST /exec reserves resumed native session immediately to avoid duplicate starts', async () => {
    const todo = ctx.db.createTodo({ title: 'T', quadrant: 1 })
    const first = await request(ctx.app).post('/api/ai-terminal/exec')
      .send({
        todoId: todo.id,
        prompt: 'resume me',
        tool: 'claude',
        resumeNativeId: 'abcdef12-3456-7890-abcd-ef1234567890',
      })
    const second = await request(ctx.app).post('/api/ai-terminal/exec')
      .send({
        todoId: todo.id,
        prompt: 'resume me again',
        tool: 'claude',
        resumeNativeId: 'abcdef12-3456-7890-abcd-ef1234567890',
      })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.body.reused).toBe(true)
    expect(second.body.sessionId).toBe(first.body.sessionId)
    expect(ctx.pty.started).toHaveLength(1)
  })

  it('auto-recovers restartable sessions on startup', () => {
    const db = openDb(':memory:')
    const todo = db.createTodo({
      title: 'T',
      quadrant: 1,
      status: 'ai_running',
      workDir: '/Users/liuzhenhua/Desktop/code',
      aiSessions: [{
        sessionId: 'old-session',
        tool: 'claude',
        nativeSessionId: 'abcdef12-3456-7890-abcd-ef1234567890',
        cwd: '/Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo',
        status: 'running',
        startedAt: 1,
        completedAt: null,
        prompt: 'old prompt',
      }],
    })
    const pty = new FakePty()
    const logDir = mkdtempSync(join(tmpdir(), 'quadtodo-log-'))
    const ait = createAiTerminal({ db, pty, logDir, defaultCwd: '/Users/liuzhenhua/Desktop/code/crazyCombo' })
    expect(pty.started).toHaveLength(1)
    expect(pty.started[0].resumeNativeId).toBe('abcdef12-3456-7890-abcd-ef1234567890')
    expect(pty.started[0].prompt).toBeNull()
    expect(pty.started[0].cwd).toBe('/Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo')
    const updated = db.getTodo(todo.id)
    expect(updated.status).toBe('ai_running')
    expect(updated.aiSession.nativeSessionId).toBe('abcdef12-3456-7890-abcd-ef1234567890')
    expect(updated.aiSession.sessionId).not.toBe('old-session')
    expect(updated.aiSession.cwd).toBe('/Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo')
    ait.close()
    rmSync(logDir, { recursive: true, force: true })
    db.close()
  })

  it('startup recovery resets todo when no recoverable native session exists', () => {
    const db = openDb(':memory:')
    const todo = db.createTodo({
      title: 'T',
      quadrant: 1,
      status: 'ai_running',
      aiSessions: [{
        sessionId: 'old-session',
        tool: 'claude',
        nativeSessionId: null,
        status: 'running',
        startedAt: 1,
        completedAt: null,
        prompt: 'old prompt',
      }],
    })
    const pty = new FakePty()
    const logDir = mkdtempSync(join(tmpdir(), 'quadtodo-log-'))
    const ait = createAiTerminal({ db, pty, logDir })
    expect(pty.started).toHaveLength(0)
    const updated = db.getTodo(todo.id)
    expect(updated.status).toBe('todo')
    ait.close()
    rmSync(logDir, { recursive: true, force: true })
    db.close()
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
    expect(sent1.some(item => JSON.parse(item).type === 'output')).toBe(true)
    expect(sent2.some(item => JSON.parse(item).type === 'output')).toBe(true)
    expect(sent1.some(item => JSON.parse(item).type === 'auto_mode')).toBe(true)
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

  it('confirm-like output marks todo as ai_pending and notifies', async () => {
    const notify = vi.fn(async () => true)
    ctx = makeApp({
      notifier: {
        detectConfirmMatch: () => 'Press Enter to confirm',
        detectKeywordMatch: () => null,
        canNotifyPendingConfirm: () => true,
        notify,
      },
      getWebhookConfig: () => ({ enabled: true }),
    })
    const todo = ctx.db.createTodo({ title: 'T', quadrant: 1 })
    const { body } = await request(ctx.app).post('/api/ai-terminal/exec')
      .send({ todoId: todo.id, prompt: 'hi', tool: 'claude' })

    ctx.pty.emit('output', { sessionId: body.sessionId, data: 'Press Enter to confirm' })

    const updated = ctx.db.getTodo(todo.id)
    expect(updated.status).toBe('ai_pending')
    expect(updated.aiSession.status).toBe('pending_confirm')
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('set_auto_mode bypass auto-confirms an existing pending prompt', async () => {
    vi.useFakeTimers()
    ctx = makeApp({
      notifier: {
        detectConfirmMatch: () => 'Press Enter to confirm',
        detectKeywordMatch: () => null,
        canNotifyPendingConfirm: () => false,
        notify: vi.fn(),
      },
    })
    const todo = ctx.db.createTodo({ title: 'T', quadrant: 1 })
    const { body } = await request(ctx.app).post('/api/ai-terminal/exec')
      .send({ todoId: todo.id, prompt: 'hi', tool: 'claude' })

    const sent = []
    const ws = { readyState: 1, OPEN: 1, send: (d) => sent.push(JSON.parse(d)) }
    ctx.ait.addBrowser(body.sessionId, ws)
    ctx.pty.emit('output', { sessionId: body.sessionId, data: 'Press Enter to confirm' })

    ctx.ait.handleBrowserMessage(body.sessionId, { type: 'set_auto_mode', autoMode: 'bypass' })
    vi.advanceTimersByTime(250)

    expect(ctx.pty.writes).toContainEqual({ id: body.sessionId, data: '\r' })
    expect(sent.some(msg => msg.type === 'auto_mode' && msg.autoMode === 'bypass')).toBe(true)
    vi.useRealTimers()
  })

  describe('dashboard routes', () => {
    it('GET /sessions lists active sessions with todo metadata', async () => {
      const todo = ctx.db.createTodo({ title: 'Hello', quadrant: 2 })
      await request(ctx.app).post('/api/ai-terminal/exec')
        .send({ todoId: todo.id, prompt: 'hi', tool: 'claude' })
      const r = await request(ctx.app).get('/api/ai-terminal/sessions')
      expect(r.status).toBe(200)
      expect(r.body.ok).toBe(true)
      expect(r.body.sessions).toHaveLength(1)
      expect(r.body.sessions[0]).toMatchObject({
        todoId: todo.id,
        todoTitle: 'Hello',
        quadrant: 2,
        tool: 'claude',
        status: 'running',
      })
    })

    it('GET /stats returns aggregated stats for range', async () => {
      const todo = ctx.db.createTodo({ title: 'T', quadrant: 1 })
      const { body } = await request(ctx.app).post('/api/ai-terminal/exec')
        .send({ todoId: todo.id, prompt: 'hi', tool: 'claude' })
      ctx.pty.emit('done', { sessionId: body.sessionId, exitCode: 0, fullLog: '', nativeId: null, stopped: false })
      const r = await request(ctx.app).get('/api/ai-terminal/stats?range=today')
      expect(r.status).toBe(200)
      expect(r.body.ok).toBe(true)
      expect(r.body.stats.total).toBe(1)
      expect(r.body.stats.byStatus.done).toBe(1)
      expect(r.body.stats.byTool.claude).toBe(1)
    })

    it('GET /resource returns empty when no active sessions', async () => {
      const r = await request(ctx.app).get('/api/ai-terminal/resource')
      expect(r.status).toBe(200)
      expect(r.body.ok).toBe(true)
      expect(r.body.resources).toEqual([])
    })
  })
})
