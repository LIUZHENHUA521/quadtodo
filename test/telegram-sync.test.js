import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import supertest from 'supertest'
import { openDb } from '../src/db.js'
import { createTelegramSyncRouter } from '../src/routes/telegram-sync.js'

function makeFakeAi(initialSessions = []) {
  const sessions = new Map()
  for (const s of initialSessions) sessions.set(s.sessionId, s)
  return { sessions }
}

function makeFakeBridge() {
  const routes = new Map()
  return {
    routes,
    resolveRoute: (sid) => routes.get(sid) || null,
    listSessionRoutes: () => [...routes.entries()].map(([sessionId, info]) => ({ sessionId, ...info })),
    clearSessionRoute: (sid) => routes.delete(sid),
    registerSessionRoute: (sid, info) => routes.set(sid, info),
    findSessionByRoute: () => null,
  }
}

function makeFakeWizard() {
  const calls = []
  return {
    calls,
    ensureTopicForSession: vi.fn(async (args) => {
      calls.push({ kind: 'ensure', ...args })
      return { ok: true, action: 'created', threadId: Math.floor(Math.random() * 1000) }
    }),
    handleTopicEvent: vi.fn(async (args) => {
      calls.push({ kind: 'event', ...args })
      return { ok: true, action: 'closed' }
    }),
  }
}

describe('telegram-sync planner', () => {
  let db, ai, bridge, wizard, app

  beforeEach(() => {
    db = openDb(':memory:')
    ai = makeFakeAi()
    bridge = makeFakeBridge()
    wizard = makeFakeWizard()
    const { router } = createTelegramSyncRouter({ db, aiTerminal: ai, openclaw: bridge, wizard })
    app = express()
    app.use(express.json())
    app.use('/api/telegram-sync', router)
  })

  it('plans open_topic for live session without topic', async () => {
    const t = db.createTodo({ title: 'live-no-topic', quadrant: 2, workDir: '/tmp' })
    db.updateTodo(t.id, {
      status: 'ai_running',
      aiSessions: [{ sessionId: 'sid1', tool: 'claude', status: 'running' }],
    })
    ai.sessions.set('sid1', { sessionId: 'sid1', todoId: t.id, status: 'running' })
    const res = await supertest(app).post('/api/telegram-sync').send({ dryRun: true })
    expect(res.body.summary.open_topic).toBe(1)
    expect(res.body.actions[0]).toMatchObject({ type: 'open_topic', todoId: t.id })
  })

  it('plans close_topic for dead session with active route', async () => {
    const t = db.createTodo({ title: 'dead-but-bound', quadrant: 2, workDir: '/tmp' })
    db.updateTodo(t.id, {
      status: 'ai_running',
      aiSessions: [{
        sessionId: 'sid2', tool: 'claude', status: 'running',
        telegramRoute: { targetUserId: '-100', threadId: 42, topicName: 'bound', channel: 'telegram' },
      }],
    })
    // ai.sessions 没有 sid2 → PTY 死了
    const res = await supertest(app).post('/api/telegram-sync').send({ dryRun: true })
    expect(res.body.summary.close_topic).toBe(1)
    expect(res.body.actions[0]).toMatchObject({
      type: 'close_topic', todoId: t.id, threadId: 42, chatId: '-100',
    })
  })

  it('skips close_topic for already-done todos (idempotent)', async () => {
    const t = db.createTodo({ title: 'already-done', quadrant: 2, workDir: '/tmp' })
    db.updateTodo(t.id, {
      status: 'done',
      aiSessions: [{
        sessionId: 'sid3', tool: 'claude', status: 'done',
        telegramRoute: { targetUserId: '-100', threadId: 50, topicName: 'd', channel: 'telegram' },
      }],
    })
    const res = await supertest(app).post('/api/telegram-sync').send({ dryRun: true })
    expect(res.body.summary.close_topic).toBe(0)
  })

  it('plans clear_route for orphan bridge route (sessionId not in ait.sessions)', async () => {
    bridge.routes.set('sid-orphan', { targetUserId: '-100', threadId: 77, topicName: 'orphan' })
    const res = await supertest(app).post('/api/telegram-sync').send({ dryRun: true })
    expect(res.body.summary.clear_route).toBe(1)
    expect(res.body.actions[0]).toMatchObject({ type: 'clear_route', sessionId: 'sid-orphan' })
  })

  it('dryRun does not invoke wizard', async () => {
    const t = db.createTodo({ title: 'x', quadrant: 2, workDir: '/tmp' })
    db.updateTodo(t.id, {
      status: 'ai_running',
      aiSessions: [{ sessionId: 'sid-x', tool: 'claude', status: 'running' }],
    })
    ai.sessions.set('sid-x', { sessionId: 'sid-x', todoId: t.id, status: 'running' })
    await supertest(app).post('/api/telegram-sync').send({ dryRun: true })
    expect(wizard.ensureTopicForSession).not.toHaveBeenCalled()
  })

  it('non-dryRun executes plan and returns per-action results', async () => {
    const t1 = db.createTodo({ title: 'live', quadrant: 2, workDir: '/tmp' })
    db.updateTodo(t1.id, {
      status: 'ai_running',
      aiSessions: [{ sessionId: 's-live', tool: 'claude', status: 'running' }],
    })
    ai.sessions.set('s-live', { sessionId: 's-live', todoId: t1.id, status: 'running' })

    const t2 = db.createTodo({ title: 'dead', quadrant: 2, workDir: '/tmp' })
    db.updateTodo(t2.id, {
      status: 'ai_running',
      aiSessions: [{
        sessionId: 's-dead', tool: 'claude', status: 'failed',
        telegramRoute: { targetUserId: '-100', threadId: 99, topicName: 'd', channel: 'telegram' },
      }],
    })

    bridge.routes.set('s-orphan', { targetUserId: '-100', threadId: 100, topicName: 'o' })

    const res = await supertest(app).post('/api/telegram-sync').send({ dryRun: false })
    expect(res.body.summary.total).toBe(3)
    expect(res.body.summary.succeeded).toBe(3)
    expect(wizard.ensureTopicForSession).toHaveBeenCalledTimes(1)
    expect(wizard.handleTopicEvent).toHaveBeenCalledTimes(1)
    expect(bridge.routes.has('s-orphan')).toBe(false)
  })

  it('returns empty plan when all aligned', async () => {
    const t = db.createTodo({ title: 'aligned', quadrant: 2, workDir: '/tmp' })
    db.updateTodo(t.id, {
      status: 'ai_running',
      aiSessions: [{
        sessionId: 'sid-ok', tool: 'claude', status: 'running',
        telegramRoute: { targetUserId: '-100', threadId: 12, topicName: 'ok', channel: 'telegram' },
      }],
    })
    ai.sessions.set('sid-ok', { sessionId: 'sid-ok', todoId: t.id, status: 'running' })
    bridge.routes.set('sid-ok', { targetUserId: '-100', threadId: 12, topicName: 'ok' })
    const res = await supertest(app).post('/api/telegram-sync').send({ dryRun: true })
    expect(res.body.summary.total).toBe(0)
  })
})
