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
})
