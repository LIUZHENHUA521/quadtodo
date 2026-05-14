import { describe, expect, it, beforeEach } from 'vitest'
import { useAiSessionStore } from '../web/src/store/aiSessionStore.ts'

describe('aiSessionStore turn done updates', () => {
  beforeEach(() => {
    useAiSessionStore.getState().reset()
  })

  it('marks a live session idle and records lastTurnDoneAt immediately', () => {
    useAiSessionStore.getState().setSessions([
      {
        sessionId: 's1',
        todoId: 't1',
        todoTitle: 'T',
        quadrant: 1,
        tool: 'claude',
        status: 'running',
        autoMode: null,
        nativeSessionId: 'n1',
        cwd: null,
        startedAt: 1000,
        completedAt: null,
        lastOutputAt: 2000,
        lastTurnDoneAt: null,
        outputBytesTotal: 0,
        awaitingReply: false,
      },
    ])

    useAiSessionStore.getState().markSessionTurnDone('s1', 'idle', 3000)

    const session = useAiSessionStore.getState().sessions.get('s1')
    expect(session?.status).toBe('idle')
    expect(session?.lastTurnDoneAt).toBe(3000)
    expect(session?.awaitingReply).toBe(true)
  })

  it('markSessionAwaitingReply flips awaitingReply without touching status or lastTurnDoneAt', () => {
    useAiSessionStore.getState().setSessions([
      {
        sessionId: 's1',
        todoId: 't1',
        todoTitle: 'T',
        quadrant: 1,
        tool: 'claude',
        status: 'running',
        autoMode: null,
        nativeSessionId: 'n1',
        cwd: null,
        startedAt: 1000,
        completedAt: null,
        lastOutputAt: 2000,
        lastTurnDoneAt: null,
        outputBytesTotal: 0,
        awaitingReply: false,
      },
    ])

    useAiSessionStore.getState().markSessionAwaitingReply('s1', true)

    const session = useAiSessionStore.getState().sessions.get('s1')
    expect(session?.awaitingReply).toBe(true)
    // 不应触及 status / lastTurnDoneAt —— 后续服务端真正的 turn_done 才更新它们
    expect(session?.status).toBe('running')
    expect(session?.lastTurnDoneAt).toBeNull()
  })

  it('markSessionAwaitingReply is a no-op when value already matches', () => {
    useAiSessionStore.getState().setSessions([
      {
        sessionId: 's1',
        todoId: 't1',
        todoTitle: 'T',
        quadrant: 1,
        tool: 'claude',
        status: 'running',
        autoMode: null,
        nativeSessionId: 'n1',
        cwd: null,
        startedAt: 1000,
        completedAt: null,
        lastOutputAt: 2000,
        lastTurnDoneAt: null,
        outputBytesTotal: 0,
        awaitingReply: true,
      },
    ])

    const before = useAiSessionStore.getState().sessions
    useAiSessionStore.getState().markSessionAwaitingReply('s1', true)
    // 引用相等：值没变就不重建 Map，避免无意义的 React re-render
    expect(useAiSessionStore.getState().sessions).toBe(before)
  })

  it('markSessionAwaitingReply ignores unknown sessionId', () => {
    const before = useAiSessionStore.getState().sessions
    useAiSessionStore.getState().markSessionAwaitingReply('missing', true)
    expect(useAiSessionStore.getState().sessions).toBe(before)
  })
})
