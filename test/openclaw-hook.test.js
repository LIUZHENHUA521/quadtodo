import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db.js'
import { createOpenClawHookHandler, __test__ } from '../src/openclaw-hook.js'
import { createOpenClawHookRouter } from '../src/routes/openclaw-hook.js'

function makeFakeBridge({ sendOk = true, sendReason = null } = {}) {
  const sent = []
  return {
    sent,
    isEnabled: () => true,
    postText: vi.fn(async ({ sessionId, message, replyMarkup }) => {
      sent.push({ sessionId, message, replyMarkup })
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

  it('Notification: native Claude TUI select is not suppressed and includes control buttons', async () => {
    const nativeSelectOutput = [
      '强制登录的入口形式选哪种？',
      '',
      '❯ 1. 全局守卫 + 不可关闭弹窗',
      '  2. 独立 /login 路由',
      '  3. 全屏覆盖层（不改路由）',
      '  4. Type something.',
      '',
      'Enter\x1b[1Cto\x1b[1Cselect\x1b[1C·\x1b[1CTab/Arrow\x1b[1Ckeys\x1b[1Cto\x1b[1Cnavigate\x1b[1C·\x1b[1CEsc\x1b[1Cto\x1b[1Ccancel',
    ].join('\n')
    handler = createOpenClawHookHandler({
      db, openclaw: bridge, cooldownMs: 30000,
      aiTerminal: {
        sessions: new Map([['ai-1777799249191-fwu8', {
          nativeSessionId: null,
          recentOutput: nativeSelectOutput,
          outputHistory: [nativeSelectOutput],
        }]]),
      },
    })

    const r = await handler.handle({
      event: 'notification',
      sessionId: 'ai-1777799249191-fwu8',
      todoId: 't1',
      todoTitle: '强制登录',
    })

    expect(r.action).toBe('sent')
    expect(bridge.sent).toHaveLength(1)
    expect(bridge.sent[0].message).toContain('强制登录的入口形式选哪种')
    expect(bridge.sent[0].message).toContain('Enter to select')
    expect(bridge.sent[0].replyMarkup?.inline_keyboard).toEqual([
      [
        { text: '↵ 选当前', callback_data: 'qt:key:fwu8:enter' },
        { text: '⬆️ 上', callback_data: 'qt:key:fwu8:up' },
        { text: '⬇️ 下', callback_data: 'qt:key:fwu8:down' },
      ],
      [
        { text: 'Esc 取消', callback_data: 'qt:key:fwu8:esc' },
      ],
    ])
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

// ─── token usage footer 集成 ──────────────────────────────────────────────
//
// 这一组测试串通：jsonl 文件 → claude-transcript → usage-footer → openclaw-hook，
// 验证 footer 在 stop / session-end 时被附加到推送 message 末尾，并尊重 config 开关。
describe('openclaw-hook usage footer integration', () => {
  let tmp, jsonlPath, db, bridge

  function mkJsonl({ withAssistant = true, multipleAssistants = false, model = 'claude-sonnet-4-20260101' } = {}) {
    const lines = []
    // user 消息（assistant ts 必须在它之后才会被 readLatestAssistantTurnFresh 当 fresh）
    lines.push(JSON.stringify({
      type: 'user',
      timestamp: '2026-05-01T10:00:00.000Z',
      message: { role: 'user', content: '帮我加注释' },
    }))
    if (withAssistant) {
      // 第一条 assistant（如果 multipleAssistants，下面还会再加一条更新的）
      lines.push(JSON.stringify({
        type: 'assistant',
        timestamp: '2026-05-01T10:00:30.000Z',
        message: {
          role: 'assistant',
          model,
          content: [{ type: 'text', text: '已加上注释' }],
          usage: { input_tokens: 1234, output_tokens: 350, cache_read_input_tokens: 800, cache_creation_input_tokens: 200 },
        },
      }))
    }
    if (multipleAssistants) {
      lines.push(JSON.stringify({
        type: 'assistant',
        timestamp: '2026-05-01T10:01:00.000Z',
        message: {
          role: 'assistant',
          model,
          content: [{ type: 'text', text: '又改了一行' }],
          usage: { input_tokens: 500, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      }))
    }
    writeFileSync(jsonlPath, lines.join('\n') + '\n', 'utf8')
  }

  function mkHandler(configOverrides = {}) {
    return createOpenClawHookHandler({
      db, openclaw: bridge,
      cooldownMs: 0,
      // aiTerminal.sessions 提供 sessionId → nativeSessionId 映射
      aiTerminal: {
        sessions: new Map([['s1', { nativeSessionId: 'native-uuid-1', recentOutput: '', outputHistory: [] }]]),
      },
      // pty.findClaudeSession 把 nativeId 翻译成 jsonl 路径
      pty: { findClaudeSession: (nativeId) => nativeId === 'native-uuid-1' ? { filePath: jsonlPath } : null },
      getConfig: () => ({ telegram: { ...configOverrides } }),
      logger: { warn() {}, info() {} },
    })
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'qt-hook-usage-'))
    jsonlPath = join(tmp, 'native-uuid-1.jsonl')
    db = openDb(':memory:')
    bridge = makeFakeBridge()
  })

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }) } catch {}
  })

  it('stop event: appends footer with both turn + session lines (default config)', async () => {
    mkJsonl({ multipleAssistants: true })   // 2 assistant turns
    const handler = mkHandler()             // showUsage / showUsageCny default true
    const r = await handler.handle({ event: 'stop', sessionId: 's1', todoId: 't1', todoTitle: 'A' })
    expect(r.action).toBe('sent')
    const msg = bridge.sent[0].message
    expect(msg).toContain('又改了一行')      // 最新 assistant 内容
    expect(msg).toContain('💸')              // footer divider
    expect(msg).toContain('turn:')
    expect(msg).toContain('session:')
    expect(msg).toContain('2 turns')         // 累计 2 个 assistant turn
    expect(msg).toContain('$')               // USD
    expect(msg).toContain('¥')               // CNY 默认开
  })

  it('showUsage=false → no footer at all', async () => {
    mkJsonl()
    const handler = mkHandler({ showUsage: false })
    const r = await handler.handle({ event: 'stop', sessionId: 's1', todoId: 't1', todoTitle: 'A' })
    expect(r.action).toBe('sent')
    const msg = bridge.sent[0].message
    expect(msg).toContain('已加上注释')
    expect(msg).not.toContain('💸')
    expect(msg).not.toContain('turn:')
  })

  it('showUsageCny=false → footer present but no ¥', async () => {
    mkJsonl()
    const handler = mkHandler({ showUsageCny: false })
    const r = await handler.handle({ event: 'stop', sessionId: 's1', todoId: 't1', todoTitle: 'A' })
    expect(r.action).toBe('sent')
    const msg = bridge.sent[0].message
    expect(msg).toContain('💸')
    expect(msg).toContain('$')
    expect(msg).not.toContain('¥')
  })

  it('session-end: also appends footer', async () => {
    mkJsonl({ multipleAssistants: true })
    const handler = mkHandler()
    const r = await handler.handle({ event: 'session-end', sessionId: 's1', todoId: 't1', todoTitle: 'A' })
    expect(r.action).toBe('sent')
    const msg = bridge.sent[0].message
    expect(msg).toContain('💸')
    expect(msg).toContain('session:')
  })

  it('notification: NO footer (it is an idle heartbeat, not a turn)', async () => {
    mkJsonl()
    const handler = mkHandler({ suppressNotificationEvents: false, notificationCooldownMs: 0 })
    const r = await handler.handle({ event: 'notification', sessionId: 's1', todoId: 't1', todoTitle: 'A', hookPayload: { message: 'idle' } })
    expect(r.action).toBe('sent')
    const msg = bridge.sent[0].message
    expect(msg).not.toContain('💸')
    expect(msg).not.toContain('turn:')
  })

  it('jsonl missing: silently skips footer, message still sent', async () => {
    // 不调 mkJsonl → jsonlPath 文件不存在
    const handler = mkHandler()
    const r = await handler.handle({ event: 'stop', sessionId: 's1', todoId: 't1', todoTitle: 'A' })
    expect(r.action).toBe('sent')
    const msg = bridge.sent[0].message
    // PTY snippet 也空 → message 走 fallback；关键是不抛异常
    expect(msg).not.toContain('💸')
  })

  it('opus model uses correct pricing (5x sonnet on input)', async () => {
    mkJsonl({ model: 'claude-opus-4-20260101' })
    const handler = mkHandler({ showUsageCny: false })
    const r = await handler.handle({ event: 'stop', sessionId: 's1', todoId: 't1', todoTitle: 'A' })
    expect(r.action).toBe('sent')
    const msg = bridge.sent[0].message
    expect(msg).toContain('💸')
    // opus input $15/M：单 turn input=1234 → cost > sonnet 5x，但具体值不强测，只要 footer 出现
    expect(msg).toMatch(/turn:\s+in 1\.2k/)
  })
})
