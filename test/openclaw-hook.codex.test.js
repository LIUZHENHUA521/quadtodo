import { describe, it, expect, vi } from 'vitest'
import { createOpenClawHookHandler } from '../src/openclaw-hook.js'

function fakeBridge() {
  return {
    postText: vi.fn(async () => ({ ok: true })),
    broadcastText: vi.fn(async () => ({ ok: true })),
    postCard: vi.fn(async () => ({ ok: true })),
    sendDocument: vi.fn(async () => ({ ok: true })),
  }
}

describe('openclaw-hook codex branch', () => {
  it('routes source=codex,path=jsonl Stop to bridge.postText with codex transcript', async () => {
    const bridge = fakeBridge()
    const aiTerminal = { sessions: new Map() }
    const sidecar = { lookup: () => ({ quadtodoSessionId: 'qs1', todoId: 't1', cwd: '/x' }) }
    const handler = createOpenClawHookHandler({
      bridge,
      openclaw: bridge,
      db: { listPendingQuestions: () => [], getTodo: () => null },
      aiTerminal,
      sidecar,
      pty: { findCodexSession: () => ({ filePath: 'fake.jsonl', cwd: '/x', nativeId: 'n1' }) },
      readLatestCodexTurnFresh: vi.fn(async () => ({ text: 'codex says hi', raw: {}, timestamp: null })),
      buildFullCodexTranscript: () => ({ markdown: '# header\n\nhi' }),
      extractCodexTurnUsageFromLines: () => ({ input: 100, output: 50, cacheRead: 0, cacheCreation: 0 }),
      extractSessionUsageFromLines: () => ({ input: 1000, output: 500, primaryModel: 'gpt-5-codex', turnCount: 3 }),
      readJsonlLines: () => [],
      logger: { warn: () => {}, info: () => {} },
    })
    const result = await handler.handle({
      source: 'codex', path: 'jsonl', event: 'Stop', nativeId: 'n1', transcript_path: 'fake.jsonl',
    })
    expect(result.ok).toBe(true)
    expect(bridge.broadcastText).toHaveBeenCalled()
    const sentArg = bridge.broadcastText.mock.calls[0][0]
    // 必须用 `message`，不是 `text`——bridge.broadcastText 形参名是 message，传错了 bridge
    // 直接走 missing_args 短路。这是 IM 推送实测不发的回归点。
    expect(sentArg.message).toContain('codex says hi')
    expect(sentArg.text).toBeUndefined()
  })

  it('falls back to aiTerminal.sessions scan via session.nativeId when sidecar misses', async () => {
    const bridge = fakeBridge()
    // 关键回归：pty.js 把 native id 挂在 session.nativeId（不是 nativeSessionId）；
    // handler 早期实现写错了字段名导致 fallback 永远 miss → 看起来"Codex 推不出来"。
    const aiTerminal = { sessions: new Map([['qs-from-scan', { nativeId: 'n42', todoId: 't42', cwd: '/proj' }]]) }
    const handler = createOpenClawHookHandler({
      bridge,
      openclaw: bridge,
      db: { listPendingQuestions: () => [], getTodo: async () => ({ id: 't42', title: 'scan-fallback todo' }) },
      aiTerminal,
      sidecar: { lookup: () => null },                   // 故意 miss，逼走 fallback
      pty: { findCodexSession: () => ({ filePath: 'f.jsonl', cwd: '/proj', nativeId: 'n42' }) },
      readLatestCodexTurnFresh: async () => ({ text: 'fallback hi', raw: {}, timestamp: null }),
      buildFullCodexTranscript: () => ({ markdown: '#h\n\nfb' }),
      extractCodexTurnUsageFromLines: () => ({ input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }),
      extractSessionUsageFromLines: () => ({ input: 1, output: 1, primaryModel: 'gpt-5', turnCount: 1 }),
      readJsonlLines: () => [],
      logger: { warn: () => {}, info: () => {} },
    })
    const result = await handler.handle({
      source: 'codex', path: 'jsonl', event: 'Stop', nativeId: 'n42', transcript_path: 'f.jsonl',
    })
    expect(result.ok).toBe(true)
    expect(bridge.broadcastText).toHaveBeenCalled()
    const sent = bridge.broadcastText.mock.calls[0][0]
    expect(sent.sessionId).toBe('qs-from-scan')
    expect(sent.message).toContain('fallback hi')
  })

  it('flips AgentQuad session to idle on Stop / TurnAborted (markSessionAwaitingReply + notifyTurnDone + dispatcher flush)', async () => {
    // 回归：codex task_complete → handleCodexJsonl 早期只推 IM，从来不动 ait 状态，导致
    // 前端 deriveAiState 看到 status='running'/awaitingReply=false → pill 永远显示"运行中"。
    // 这条断言确保 Stop 和 TurnAborted 都会把状态翻成 awaitingReply=true 并 flush dispatcher。
    const bridge = fakeBridge()
    const aiTerminal = {
      sessions: new Map([['qs1', { status: 'running', awaitingReply: false, todoId: 't1' }]]),
      markSessionAwaitingReply: vi.fn(() => true),
      notifyTurnDone: vi.fn(),
    }
    const sessionInputDispatcher = { onSessionIdle: vi.fn(async () => {}) }
    const sidecar = { lookup: () => ({ quadtodoSessionId: 'qs1', todoId: 't1', cwd: '/x' }) }
    const handler = createOpenClawHookHandler({
      bridge,
      openclaw: bridge,
      db: { listPendingQuestions: () => [], getTodo: () => null },
      aiTerminal,
      sidecar,
      sessionInputDispatcher,
      pty: { findCodexSession: () => ({ filePath: 'fake.jsonl', cwd: '/x', nativeId: 'n1' }) },
      readLatestCodexTurnFresh: async () => ({ text: 'codex finished', raw: {}, timestamp: null }),
      buildFullCodexTranscript: () => ({ markdown: '' }),
      extractCodexTurnUsageFromLines: () => null,
      extractSessionUsageFromLines: () => null,
      readJsonlLines: () => [],
      logger: { warn: () => {}, info: () => {} },
    })

    await handler.handle({ source: 'codex', path: 'jsonl', event: 'Stop', nativeId: 'n1', transcript_path: 'fake.jsonl' })
    expect(aiTerminal.markSessionAwaitingReply).toHaveBeenCalledWith('qs1', true)
    expect(aiTerminal.notifyTurnDone).toHaveBeenCalledWith('qs1', expect.objectContaining({ event: 'stop', status: 'idle' }))
    expect(sessionInputDispatcher.onSessionIdle).toHaveBeenCalledWith('qs1')

    // TurnAborted（用户按 Esc 中断）也走同样翻转
    aiTerminal.markSessionAwaitingReply.mockClear()
    aiTerminal.notifyTurnDone.mockClear()
    sessionInputDispatcher.onSessionIdle.mockClear()
    await handler.handle({ source: 'codex', path: 'jsonl', event: 'TurnAborted', nativeId: 'n1', transcript_path: 'fake.jsonl' })
    expect(aiTerminal.markSessionAwaitingReply).toHaveBeenCalledWith('qs1', true)
    expect(aiTerminal.notifyTurnDone).toHaveBeenCalledWith('qs1', expect.objectContaining({ event: 'stop', status: 'idle' }))
    expect(sessionInputDispatcher.onSessionIdle).toHaveBeenCalledWith('qs1')
  })

  it('handler returns error when nativeId not in sidecar nor sessions', async () => {
    const bridge = fakeBridge()
    const handler = createOpenClawHookHandler({
      bridge,
      openclaw: bridge,
      db: { listPendingQuestions: () => [], getTodo: () => null },
      aiTerminal: { sessions: new Map() },
      sidecar: { lookup: () => null },
      pty: { findCodexSession: () => null },
      logger: { warn: () => {}, info: () => {} },
    })
    const result = await handler.handle({ source: 'codex', path: 'jsonl', event: 'Stop', nativeId: 'unknown' })
    expect(result.ok).toBe(false)
    expect(bridge.broadcastText).not.toHaveBeenCalled()
  })

  it('routes source=codex,path=detector Notification to bridge.postCard with Codex header', async () => {
    const bridge = fakeBridge()
    const aiTerminal = { sessions: new Map([['qs1', { todoId: 't1' }]]) }
    const handler = createOpenClawHookHandler({
      bridge,
      openclaw: bridge,
      db: {
        listPendingQuestions: () => [],
        getTodo: async () => ({ id: 't1', title: '清理仓库' }),
      },
      aiTerminal,
      sidecar: { lookup: () => null },
      pty: { findCodexSession: () => null },
      logger: { warn: () => {}, info: () => {} },
    })
    const result = await handler.handle({
      source: 'codex',
      path: 'detector',
      event: 'Notification',
      sessionId: 'qs1',
      promptText: 'Approve? (y/n)',
    })
    expect(result.ok).toBe(true)
    expect(bridge.postCard).toHaveBeenCalled()
    const arg = bridge.postCard.mock.calls[0][0]
    expect(arg.sessionId).toBe('qs1')
    const cardJson = JSON.stringify(arg.card)
    expect(cardJson).toContain('Codex 等待授权')
    expect(cardJson).not.toContain('Claude Code 等待授权')
    expect(cardJson).toContain('Approve? (y/n)')
  })

  it('returns session_gone when sessionId not in aiTerminal.sessions', async () => {
    const bridge = fakeBridge()
    const handler = createOpenClawHookHandler({
      bridge,
      openclaw: bridge,
      db: { listPendingQuestions: () => [], getTodo: async () => null },
      aiTerminal: { sessions: new Map() },
      sidecar: { lookup: () => null },
      pty: { findCodexSession: () => null },
      logger: { warn: () => {}, info: () => {} },
    })
    const result = await handler.handle({
      source: 'codex',
      path: 'detector',
      event: 'Notification',
      sessionId: 'gone',
      promptText: 'Approve? (y/n)',
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('session_gone')
    expect(bridge.postCard).not.toHaveBeenCalled()
  })
})
