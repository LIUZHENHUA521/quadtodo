import { describe, expect, it } from 'vitest'
import { computeDispatchStats } from '../web/src/design/useDispatchStats.ts'
import type { LiveSession, Todo } from '../web/src/api.ts'

function makeSession(overrides: Partial<LiveSession> & Pick<LiveSession, 'sessionId' | 'todoId'>): LiveSession {
  return {
    sessionId: overrides.sessionId,
    todoId: overrides.todoId,
    todoTitle: overrides.todoTitle ?? 'T',
    quadrant: overrides.quadrant ?? 1,
    tool: overrides.tool ?? 'claude',
    status: overrides.status ?? 'running',
    autoMode: overrides.autoMode ?? null,
    nativeSessionId: overrides.nativeSessionId ?? null,
    cwd: overrides.cwd ?? null,
    startedAt: overrides.startedAt ?? 1000,
    completedAt: overrides.completedAt ?? null,
    lastOutputAt: overrides.lastOutputAt ?? null,
    lastTurnDoneAt: overrides.lastTurnDoneAt ?? null,
    outputBytesTotal: overrides.outputBytesTotal ?? 0,
    awaitingReply: overrides.awaitingReply ?? false,
  }
}

function buildSessions(list: LiveSession[]): Map<string, LiveSession> {
  const m = new Map<string, LiveSession>()
  for (const s of list) m.set(s.sessionId, s)
  return m
}

const NO_TODOS: Todo[] = []
const NO_LAST_SEEN = new Map<string, number>()

describe('computeDispatchStats — 按 todoId 折叠', () => {
  it('同一个 todoId 上的两条 running session 只计一次', () => {
    const sessions = buildSessions([
      makeSession({ sessionId: 's-old', todoId: 'todo-1', startedAt: 1000, status: 'running' }),
      makeSession({ sessionId: 's-new', todoId: 'todo-1', startedAt: 2000, status: 'running' }),
    ])
    const stats = computeDispatchStats(sessions, NO_LAST_SEEN, NO_TODOS)
    expect(stats.runningCount).toBe(1)
  })

  it('两个不同 todoId 上的 running session 分别计入', () => {
    const sessions = buildSessions([
      makeSession({ sessionId: 's-a', todoId: 'todo-a', status: 'running' }),
      makeSession({ sessionId: 's-b', todoId: 'todo-b', status: 'running' }),
    ])
    const stats = computeDispatchStats(sessions, NO_LAST_SEEN, NO_TODOS)
    expect(stats.runningCount).toBe(2)
  })

  it('同 todo 一条 running + 一条 idle，running 优先（idle 不再计入）', () => {
    const sessions = buildSessions([
      makeSession({ sessionId: 's-run', todoId: 'todo-x', status: 'running' }),
      makeSession({ sessionId: 's-idle', todoId: 'todo-x', status: 'idle' }),
    ])
    const stats = computeDispatchStats(sessions, NO_LAST_SEEN, NO_TODOS)
    expect(stats.runningCount).toBe(1)
    expect(stats.idleCount).toBe(0)
  })

  it('idle session 同 todoId 多条也只计一次', () => {
    const sessions = buildSessions([
      makeSession({ sessionId: 's1', todoId: 'todo-y', status: 'idle' }),
      makeSession({ sessionId: 's2', todoId: 'todo-y', status: 'idle' }),
    ])
    const stats = computeDispatchStats(sessions, NO_LAST_SEEN, NO_TODOS)
    expect(stats.idleCount).toBe(1)
  })

  it('已关闭状态（done/stopped/failed）不计入 idle', () => {
    const sessions = buildSessions([
      makeSession({ sessionId: 's-done', todoId: 'todo-z', status: 'done' }),
      makeSession({ sessionId: 's-stop', todoId: 'todo-z', status: 'stopped' }),
    ])
    const stats = computeDispatchStats(sessions, NO_LAST_SEEN, NO_TODOS)
    expect(stats.idleCount).toBe(0)
    expect(stats.runningCount).toBe(0)
  })
})
