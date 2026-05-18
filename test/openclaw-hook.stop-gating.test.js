import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db.js'
import { createOpenClawHookHandler } from '../src/openclaw-hook.js'
import { DEFAULT_PRICING } from '../src/pricing.js'

// Stop hook 校验门：只有 jsonl 末行 assistant.stop_reason === 'end_turn' 才会翻状态。
//
// 回归场景（用户在 2026-05-13 报：「某个 hook 提前触发了结束，然后就 idle 了，过了一会真的结束
// 才变成待确认」）：Claude 的 Stop hook 在 sub-agent 完成 / 中间停顿 / 内部 transition 等
// 边界态下会假阳性 fire，stop_reason 不是 'end_turn'。新的门把这种假阳性挡在外面，等 jsonl
// watcher 在真 end_turn 时再翻状态。

function makeFakeBridge() {
  const sent = []
  const routes = new Map()
  return {
    sent,
    routes,
    isEnabled: () => true,
    hasExplicitRoute: vi.fn(() => true),
    resolveRoute: vi.fn((sessionId) => routes.get(sessionId) || null),
    registerSessionRoute: vi.fn((sessionId, routeInfo) => routes.set(sessionId, routeInfo)),
    postText: vi.fn(async ({ sessionId, message }) => {
      sent.push({ sessionId, message })
      return { ok: true }
    }),
    broadcastText: vi.fn(async ({ sessionId, message }) => {
      sent.push({ sessionId, message })
      return { ok: true }
    }),
  }
}

describe('openclaw-hook Stop hook JSONL stop_reason gating', () => {
  let tmp, jsonlPath, db, bridge

  // 写一个 jsonl，user → assistant（assistant.timestamp > user.timestamp 保证 fresh）
  function writeJsonl({ stopReason }) {
    const lines = [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-05-13T10:00:00.000Z',
        message: { role: 'user', content: 'fix it' },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-05-13T10:00:01.000Z',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-20260101',
          content: [{ type: 'text', text: 'sure' }],
          stop_reason: stopReason,
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
    ]
    writeFileSync(jsonlPath, lines.join('\n') + '\n', 'utf8')
  }

  function mkHandler({ markSessionAwaitingReply, notifyTurnDone, onSessionIdle, logger } = {}) {
    return createOpenClawHookHandler({
      db,
      openclaw: bridge,
      cooldownMs: 0,
      aiTerminal: {
        sessions: new Map([['s1', { nativeSessionId: 'native-uuid-1', recentOutput: '', outputHistory: [] }]]),
        notifyTurnDone: notifyTurnDone || vi.fn(() => true),
        markSessionAwaitingReply: markSessionAwaitingReply || vi.fn(() => true),
      },
      pty: { findClaudeSession: (nid) => nid === 'native-uuid-1' ? { filePath: jsonlPath } : null },
      sessionInputDispatcher: { onSessionIdle: onSessionIdle || vi.fn(async () => ({ flushed: 0 })) },
      getConfig: () => ({ telegram: {}, pricing: { ...DEFAULT_PRICING } }),
      logger: logger || { warn: vi.fn(), info: vi.fn() },
    })
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'qt-hook-gate-'))
    jsonlPath = join(tmp, 'native-uuid-1.jsonl')
    db = openDb(':memory:')
    bridge = makeFakeBridge()
  })

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }) } catch {}
  })

  it('stop_reason=end_turn → 翻 idle 状态、notifyTurnDone、flush dispatcher', async () => {
    writeJsonl({ stopReason: 'end_turn' })
    const markSessionAwaitingReply = vi.fn(() => true)
    const notifyTurnDone = vi.fn(() => true)
    const onSessionIdle = vi.fn(async () => ({ flushed: 0 }))

    const handler = mkHandler({ markSessionAwaitingReply, notifyTurnDone, onSessionIdle })
    const r = await handler.handle({ event: 'stop', sessionId: 's1', todoId: 't1', todoTitle: 'A' })
    await new Promise((res) => setTimeout(res, 5))

    expect(r.ok).toBe(true)
    expect(markSessionAwaitingReply).toHaveBeenCalledWith('s1', true)
    expect(notifyTurnDone).toHaveBeenCalled()
    expect(onSessionIdle).toHaveBeenCalledWith('s1')
  })

  it('stop_reason=tool_use → defer：不翻状态、不广播 turn_done、不 flush dispatcher，且 warn', async () => {
    writeJsonl({ stopReason: 'tool_use' })
    const markSessionAwaitingReply = vi.fn(() => true)
    const notifyTurnDone = vi.fn(() => true)
    const onSessionIdle = vi.fn(async () => ({ flushed: 0 }))
    const logger = { warn: vi.fn(), info: vi.fn() }

    const handler = mkHandler({ markSessionAwaitingReply, notifyTurnDone, onSessionIdle, logger })
    const r = await handler.handle({ event: 'stop', sessionId: 's1', todoId: 't1', todoTitle: 'A' })
    await new Promise((res) => setTimeout(res, 5))

    // 推送仍然走（消息内容相关的不受 gating 影响），但状态相关三处都被 defer
    expect(r.ok).toBe(true)
    expect(markSessionAwaitingReply).not.toHaveBeenCalled()
    expect(notifyTurnDone).not.toHaveBeenCalled()
    expect(onSessionIdle).not.toHaveBeenCalled()
    // 日志含 "deferred"
    const warnCalls = logger.warn.mock.calls.map((c) => String(c[0]))
    expect(warnCalls.some((m) => m.includes('Stop hook deferred'))).toBe(true)
  })

  it('stop_reason=max_tokens → 也按 defer 处理', async () => {
    writeJsonl({ stopReason: 'max_tokens' })
    const markSessionAwaitingReply = vi.fn(() => true)
    const notifyTurnDone = vi.fn(() => true)

    const handler = mkHandler({ markSessionAwaitingReply, notifyTurnDone })
    await handler.handle({ event: 'stop', sessionId: 's1', todoId: 't1', todoTitle: 'A' })
    await new Promise((res) => setTimeout(res, 5))

    expect(markSessionAwaitingReply).not.toHaveBeenCalled()
    expect(notifyTurnDone).not.toHaveBeenCalled()
  })

  it('jsonl 读不到（nativeId 缺失或 pty.findClaudeSession 返回 null）→ 兜底为允许（保留旧行为）', async () => {
    const markSessionAwaitingReply = vi.fn(() => true)
    const notifyTurnDone = vi.fn(() => true)
    const onSessionIdle = vi.fn(async () => ({ flushed: 0 }))

    // 这里故意不写 jsonl，handler 默认 findClaudeSession 返回 null
    const handler = createOpenClawHookHandler({
      db,
      openclaw: bridge,
      cooldownMs: 0,
      aiTerminal: {
        sessions: new Map([['s1', { nativeSessionId: null, recentOutput: '', outputHistory: [] }]]),
        notifyTurnDone,
        markSessionAwaitingReply,
      },
      pty: { findClaudeSession: () => null },
      sessionInputDispatcher: { onSessionIdle },
      getConfig: () => ({ telegram: {}, pricing: { ...DEFAULT_PRICING } }),
      logger: { warn: vi.fn(), info: vi.fn() },
    })

    const r = await handler.handle({ event: 'stop', sessionId: 's1', todoId: 't1', todoTitle: 'A' })
    await new Promise((res) => setTimeout(res, 5))

    expect(r.ok).toBe(true)
    // 没法判定 → 不能阻塞 dispatcher，必须照旧翻状态
    expect(markSessionAwaitingReply).toHaveBeenCalledWith('s1', true)
    expect(notifyTurnDone).toHaveBeenCalled()
    expect(onSessionIdle).toHaveBeenCalledWith('s1')
  })
})
