import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import { openDb } from '../src/db.js'
import { createOpenClawHookHandler, __test__ } from '../src/openclaw-hook.js'
import { createOpenClawHookRouter } from '../src/routes/openclaw-hook.js'

function makeFakeBridge({ sendOk = true, sendReason = null } = {}) {
  const sent = []
  return {
    sent,
    isEnabled: () => true,
    postText: vi.fn(async ({ sessionId, message }) => {
      sent.push({ sessionId, message })
      if (sendOk) return { ok: true }
      return { ok: false, reason: sendReason || 'cli_failed' }
    }),
  }
}

describe('openclaw-hook helpers', () => {
  it('shortTodoId takes last 3 alphanumeric chars lowercase', () => {
    expect(__test__.shortTodoId('todo-abc-XYZ')).toBe('xyz')
    expect(__test__.shortTodoId('a3f-9d8-fff')).toBe('fff')
    expect(__test__.shortTodoId('')).toBeNull()
    expect(__test__.shortTodoId(null)).toBeNull()
  })

  it('buildMessage uses different prefixes per event', () => {
    const stop = __test__.buildMessage({ event: 'stop', todoId: 'abc', todoTitle: 'Fix' })
    expect(stop).toContain('🤖')
    expect(stop).toContain('[#tabc]')
    expect(stop).toContain('Fix')
    const notif = __test__.buildMessage({ event: 'notification', todoId: 'xyz', todoTitle: 'Build', snippet: 'pwd?' })
    expect(notif).toContain('⚠️')
    expect(notif).toContain('pwd?')
    const end = __test__.buildMessage({ event: 'session-end', todoId: 'qq', todoTitle: 'Done' })
    expect(end).toContain('✅')
  })

  it('buildMessage falls back when todoId missing', () => {
    const m = __test__.buildMessage({ event: 'stop' })
    expect(m).toContain('[#hook]')
    expect(m).toContain('当前任务')
  })

  it('buildMessage strips box-drawing chars from snippet', () => {
    const ugly = '╭─────╮\n│ abc │\n╰─────╯\n请回 a/b/c'
    const m = __test__.buildMessage({ event: 'stop', todoId: 'x', todoTitle: 'T', snippet: ugly })
    expect(m).not.toMatch(/[╭╮╰╯─│]/)
    expect(m).toContain('请回 a/b/c')
    expect(m).toContain('（直接在这里回我，会转给 AI）')
  })

  it('buildMessage compacts blank lines', () => {
    const m = __test__.buildMessage({
      event: 'stop',
      todoId: 'x', todoTitle: 'T',
      snippet: 'line1\n\n\n\n\nline2',
    })
    expect(m).not.toContain('\n\n\n')
    expect(m).toContain('line1\n\nline2')
  })

  it('buildMessage with snippet skips the legacy "去 Web UI 看" hint', () => {
    const m = __test__.buildMessage({ event: 'stop', todoId: 'x', todoTitle: 'T', snippet: 'something' })
    expect(m).not.toContain('Web UI')
    expect(m).toContain('something')
  })
})

describe('openclaw-hook handler', () => {
  let db, bridge, handler

  beforeEach(() => {
    db = openDb(':memory:')
    bridge = makeFakeBridge()
    handler = createOpenClawHookHandler({ db, openclaw: bridge, cooldownMs: 30000 })
  })

  it('sends a stop event when no pending and not on cooldown', async () => {
    const r = await handler.handle({
      event: 'stop',
      sessionId: 's1',
      todoId: 't1',
      todoTitle: 'Task A',
    })
    expect(r.ok).toBe(true)
    expect(r.action).toBe('sent')
    expect(bridge.sent).toHaveLength(1)
    expect(bridge.sent[0].message).toContain('🤖')
    expect(bridge.sent[0].message).toContain('Task A')
  })

  it('SUPPRESSES Stop when there is a pending ask_user for that session', async () => {
    // 先建一条 pending question 给 s1
    db.createPendingQuestion({
      ticket: 'a3f',
      sessionId: 's1',
      todoId: 't1',
      question: 'q',
      options: ['a', 'b'],
      timeoutMs: 60000,
    })
    const r = await handler.handle({
      event: 'stop',
      sessionId: 's1',
      todoId: 't1',
      todoTitle: 'A',
    })
    expect(r.ok).toBe(true)
    expect(r.action).toBe('skipped')
    expect(r.reason).toBe('ask_user_pending')
    expect(bridge.sent).toHaveLength(0)
  })

  it('Stop on different session is NOT suppressed by another sessions pending', async () => {
    db.createPendingQuestion({
      ticket: 'a3f',
      sessionId: 's-other',
      todoId: 't0',
      question: 'q',
      options: ['a', 'b'],
      timeoutMs: 60000,
    })
    const r = await handler.handle({ event: 'stop', sessionId: 's1', todoId: 't1', todoTitle: 'A' })
    expect(r.action).toBe('sent')
  })

  it('cooldown suppresses second stop within window', async () => {
    const r1 = await handler.handle({ event: 'stop', sessionId: 's1', todoId: 't1', todoTitle: 'A' })
    expect(r1.action).toBe('sent')
    const r2 = await handler.handle({ event: 'stop', sessionId: 's1', todoId: 't1', todoTitle: 'A' })
    expect(r2.action).toBe('skipped')
    expect(r2.reason).toBe('cooldown')
  })

  it('cooldown is per (sessionId × event) — different events bypass', async () => {
    await handler.handle({ event: 'stop', sessionId: 's1', todoId: 't1' })
    const r = await handler.handle({ event: 'session-end', sessionId: 's1', todoId: 't1' })
    expect(r.action).toBe('sent')
  })

  it('Notification ignores cooldown (high priority)', async () => {
    await handler.handle({ event: 'notification', sessionId: 's1', todoId: 't1' })
    const r = await handler.handle({ event: 'notification', sessionId: 's1', todoId: 't1' })
    expect(r.action).toBe('sent')
  })

  it('SessionEnd ignores cooldown (final state)', async () => {
    await handler.handle({ event: 'session-end', sessionId: 's1', todoId: 't1' })
    const r = await handler.handle({ event: 'session-end', sessionId: 's1', todoId: 't1' })
    expect(r.action).toBe('sent')
  })

  it('returns failed when bridge returns not ok', async () => {
    bridge = makeFakeBridge({ sendOk: false, sendReason: 'rate_limited' })
    handler = createOpenClawHookHandler({ db, openclaw: bridge })
    const r = await handler.handle({ event: 'stop', sessionId: 's1', todoId: 't1' })
    expect(r.ok).toBe(false)
    expect(r.action).toBe('failed')
    expect(r.reason).toBe('rate_limited')
  })

  it('returns failed for missing event', async () => {
    const r = await handler.handle({ sessionId: 's1' })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('event_required')
  })
})

describe('openclaw-hook router', () => {
  let app, db, bridge, handler

  beforeEach(() => {
    db = openDb(':memory:')
    bridge = makeFakeBridge()
    handler = createOpenClawHookHandler({ db, openclaw: bridge })
    app = express()
    app.use(express.json())
    app.use('/api/openclaw/hook', createOpenClawHookRouter({ hookHandler: handler }))
  })

  it('400 when event missing', async () => {
    const supertest = (await import('supertest')).default
    const res = await supertest(app).post('/api/openclaw/hook').send({ sessionId: 's1' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('event_required')
  })

  it('200 + sent for valid stop', async () => {
    const supertest = (await import('supertest')).default
    const res = await supertest(app).post('/api/openclaw/hook').send({
      event: 'stop',
      sessionId: 's1',
      todoId: 't1',
      todoTitle: 'Task A',
    })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.action).toBe('sent')
  })

  it('200 + skipped on cooldown', async () => {
    const supertest = (await import('supertest')).default
    await supertest(app).post('/api/openclaw/hook').send({ event: 'stop', sessionId: 's1' })
    const r = await supertest(app).post('/api/openclaw/hook').send({ event: 'stop', sessionId: 's1' })
    expect(r.body.action).toBe('skipped')
  })
})
