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

  it('buildMessage: stop with body returns body verbatim (no prefix/footer noise)', () => {
    const stop = __test__.buildMessage({ event: 'stop', cleanContent: '修复完成，已经 commit。' })
    expect(stop).toBe('修复完成，已经 commit。')
    expect(stop).not.toContain('AI 一轮结束')
    expect(stop).not.toContain('直接在这里回我')
  })

  it('buildMessage: notification keeps ⚠️ prefix (status signal)', () => {
    const notif = __test__.buildMessage({ event: 'notification', snippet: 'pwd?' })
    expect(notif).toContain('⚠️')
    expect(notif).toContain('pwd?')
  })

  it('buildMessage: session-end keeps ✅ prefix', () => {
    const end = __test__.buildMessage({ event: 'session-end', cleanContent: '收工。' })
    expect(end).toContain('✅')
    expect(end).toContain('收工。')
  })

  it('buildMessage: stop without body falls back to placeholder', () => {
    const m = __test__.buildMessage({ event: 'stop' })
    expect(m).toContain('🤖')
    expect(m).toContain('无新内容')
  })

  it('buildMessage strips box-drawing chars from snippet', () => {
    const ugly = '╭─────╮\n│ abc │\n╰─────╯\n请回 a/b/c'
    const m = __test__.buildMessage({ event: 'stop', todoId: 'x', todoTitle: 'T', snippet: ugly })
    expect(m).not.toMatch(/[╭╮╰╯─│]/)
    expect(m).toContain('请回 a/b/c')
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

  it('extractTailSnippet filters Claude Code spinner / status / border lines', () => {
    const ugly = `
请告诉我 bug 现象：
| a | 登录后白屏 |
| b | 登录失败 |
| c | 账号不存在 |
✶
✳
Drizzling…
✻
Cooked for 3m 28s
----------------------------------------
❯
⏵⏵ auto mode on (shift+tab to cycle)
`
    const m = __test__.buildMessage({ event: 'notification', todoId: 'x', todoTitle: 'T', snippet: ugly })
    expect(m).toContain('请告诉我 bug 现象')
    expect(m).toContain('登录后白屏')
    expect(m).not.toContain('✶')
    expect(m).not.toContain('Drizzling')
    expect(m).not.toContain('Cooked for')
    expect(m).not.toContain('auto mode')
    expect(m).not.toContain('❯')
  })

  it('extractTailSnippet falls back to historicalRaw when recentOutput is all spinner', () => {
    const allSpinner = '✶\n✳\nDrizzling…\nCooked for 5m\n❯\n⏵⏵ auto mode on'
    const realContent = '请选择 a/b/c：\n| a | 登录白屏 |\n| b | 登录失败 |\n| c | 账号不存在 |'
    const m = __test__.buildMessage({
      event: 'notification', todoId: 'x', todoTitle: 'T',
      snippet: allSpinner,
      historicalRaw: realContent + '\n' + allSpinner,
    })
    expect(m).toContain('请选择 a/b/c')
    expect(m).toContain('登录白屏')
  })

  it('extractTailSnippet returns empty when nothing meaningful and no fallback', () => {
    const m = __test__.buildMessage({
      event: 'notification', todoId: 'x', todoTitle: 'T',
      snippet: '✶\n✳\nDrizzling…\nCooked for 3m',
    })
    expect(m).toContain('AI 还在思考')
    expect(m).not.toContain('Drizzling')
  })

  it('filters unknown spinner verbs via generic ellipsis pattern', () => {
    // Claude Code 不断加新动词 —— Skedaddling 不在词典里但应被通用规则过滤
    const ugly = `
请告诉我答案：
| a | 选 a |
| b | 选 b |
✶Skedaddling…
✶Schmoozing…
✻Marinating…
*Bedazzling…
✻Cooked for 5m 12s
`
    const m = __test__.buildMessage({
      event: 'stop', todoId: 'x', todoTitle: 'T', snippet: ugly,
    })
    expect(m).toContain('请告诉我答案')
    expect(m).toContain('选 a')
    expect(m).not.toContain('Skedaddling')
    expect(m).not.toContain('Schmoozing')
    expect(m).not.toContain('Marinating')
    expect(m).not.toContain('Bedazzling')
    expect(m).not.toContain('Cooked for')
  })

  it('filters lines that look like generic Verbing/Verbed + ellipsis', () => {
    expect(__test__.buildMessage({
      event: 'notification', todoId: 'x', todoTitle: 'T',
      snippet: 'Whirring…\nGyrating…\nSpinning…',
    })).toContain('AI 还在思考')   // 全部被滤掉，回退到占位
  })

  it('keeps lines that look like real content (not status-shaped)', () => {
    const m = __test__.buildMessage({
      event: 'stop', todoId: 'x', todoTitle: 'T',
      snippet: 'I have completed the task.\nThe answer is X.\nNext step: review.',
    })
    expect(m).toContain('I have completed the task')
    expect(m).toContain('Next step: review')
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

  it('Stop has NO cooldown — multi-turn conversations all push through', async () => {
    // 多轮 AI 对话，每个 Stop 都该送达；之前的 30s cooldown 已废除
    const r1 = await handler.handle({ event: 'stop', sessionId: 's1', todoId: 't1', todoTitle: 'A' })
    expect(r1.action).toBe('sent')
    const r2 = await handler.handle({ event: 'stop', sessionId: 's1', todoId: 't1', todoTitle: 'A' })
    expect(r2.action).toBe('sent')
    const r3 = await handler.handle({ event: 'stop', sessionId: 's1', todoId: 't1', todoTitle: 'A' })
    expect(r3.action).toBe('sent')
  })

  it('different events all bypass any cooldown', async () => {
    await handler.handle({ event: 'stop', sessionId: 's1', todoId: 't1' })
    const r = await handler.handle({ event: 'session-end', sessionId: 's1', todoId: 't1' })
    expect(r.action).toBe('sent')
  })

  it('Notification: with suppressNotificationEvents=false, 2nd within cooldown is skipped', async () => {
    // 关掉默认 suppress 才能走到 cooldown 路径
    handler = createOpenClawHookHandler({
      db, openclaw: bridge,
      getConfig: () => ({ telegram: { suppressNotificationEvents: false } }),
    })
    await handler.handle({ event: 'notification', sessionId: 's1', todoId: 't1' })
    const r = await handler.handle({ event: 'notification', sessionId: 's1', todoId: 't1' })
    expect(r.action).toBe('skipped')
    expect(r.reason).toBe('notification_cooldown')
  })

  it('Notification: with suppressNotificationEvents=false + cooldownMs=0, every event fires', async () => {
    handler = createOpenClawHookHandler({
      db, openclaw: bridge,
      getConfig: () => ({ telegram: { suppressNotificationEvents: false, notificationCooldownMs: 0 } }),
    })
    await handler.handle({ event: 'notification', sessionId: 's1', todoId: 't1' })
    const r = await handler.handle({ event: 'notification', sessionId: 's1', todoId: 't1' })
    expect(r.action).toBe('sent')
  })

  it('Notification: suppressed by default (no config) — 早期短路，不调 bridge', async () => {
    // 默认无 getConfig → suppressNotificationEvents 视为 true
    const r = await handler.handle({ event: 'notification', sessionId: 's1', todoId: 't1' })
    expect(r.ok).toBe(true)
    expect(r.action).toBe('skipped')
    expect(r.reason).toBe('notification_suppressed')
    // 关键：早期短路，没浪费 IO，bridge 完全没被调用
    expect(bridge.postText).not.toHaveBeenCalled()
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

  it('200 + sent for repeat stop (cooldown removed for multi-turn)', async () => {
    const supertest = (await import('supertest')).default
    await supertest(app).post('/api/openclaw/hook').send({ event: 'stop', sessionId: 's1' })
    const r = await supertest(app).post('/api/openclaw/hook').send({ event: 'stop', sessionId: 's1' })
    expect(r.body.action).toBe('sent')
  })
})
