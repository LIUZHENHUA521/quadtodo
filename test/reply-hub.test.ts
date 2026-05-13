import { describe, expect, it } from 'vitest'
import type { AiSession, Todo } from '../web/src/api.ts'
import {
  buildUnreadSessionItems,
} from '../web/src/replyHub.ts'
import type { SessionMeta } from '../web/src/store/aiSessionStore.ts'

function session(input: Partial<AiSession> & { sessionId: string }): AiSession {
  return {
    sessionId: input.sessionId,
    tool: input.tool || 'claude',
    nativeSessionId: input.nativeSessionId ?? null,
    cwd: input.cwd ?? null,
    status: input.status || 'done',
    startedAt: input.startedAt ?? 1000,
    completedAt: input.completedAt ?? 2000,
    prompt: input.prompt || 'prompt',
    label: input.label,
    lastTurnDoneAt: input.lastTurnDoneAt ?? null,
  }
}

function todo(input: Partial<Todo> & { id: string; title: string }): Todo {
  return {
    id: input.id,
    parentId: input.parentId ?? null,
    title: input.title,
    description: input.description || '',
    quadrant: input.quadrant || 1,
    status: input.status || 'todo',
    dueDate: input.dueDate ?? null,
    workDir: input.workDir ?? null,
    brainstorm: input.brainstorm ?? false,
    appliedTemplateIds: input.appliedTemplateIds || [],
    sortOrder: input.sortOrder ?? 0,
    aiSession: input.aiSession ?? null,
    aiSessions: input.aiSessions || [],
    recurringRuleId: input.recurringRuleId ?? null,
    instanceDate: input.instanceDate ?? null,
    completedAt: input.completedAt ?? null,
    createdAt: input.createdAt ?? 1,
    updatedAt: input.updatedAt ?? 1,
  }
}

function live(input: Partial<SessionMeta> & { sessionId: string; todoId: string }): SessionMeta {
  return {
    sessionId: input.sessionId,
    todoId: input.todoId,
    todoTitle: input.todoTitle || 'Live todo',
    quadrant: input.quadrant || 2,
    tool: input.tool || 'claude',
    status: input.status || 'running',
    autoMode: input.autoMode ?? null,
    nativeSessionId: input.nativeSessionId ?? null,
    cwd: input.cwd ?? null,
    startedAt: input.startedAt ?? 1000,
    completedAt: input.completedAt ?? null,
    lastOutputAt: input.lastOutputAt ?? null,
    outputBytesTotal: input.outputBytesTotal ?? 0,
    awaitingReply: input.awaitingReply ?? false,
    lastTurnDoneAt: input.lastTurnDoneAt ?? null,
  }
}

describe('buildUnreadSessionItems', () => {
  it('returns one item per session whose lastTurnDoneAt exceeds lastSeenAt', () => {
    const items = buildUnreadSessionItems({
      todos: [
        todo({
          id: 'todo-1',
          title: 'Inbox A',
          aiSessions: [session({ sessionId: 's-unread', lastTurnDoneAt: 5000 })],
        }),
      ],
      liveSessions: [],
      lastSeenMap: new Map([['s-unread', 4000]]),
    })

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'unread:s-unread',
      sessionId: 's-unread',
      todoId: 'todo-1',
      todoTitle: 'Inbox A',
      timestamp: 5000,
    })
  })

  it('excludes sessions whose lastSeenAt has caught up with lastTurnDoneAt', () => {
    const items = buildUnreadSessionItems({
      todos: [todo({ id: 'todo-1', title: 'Seen', aiSessions: [session({ sessionId: 's1', lastTurnDoneAt: 3000 })] })],
      liveSessions: [],
      lastSeenMap: new Map([['s1', 3000]]),
    })

    expect(items).toEqual([])
  })

  it('takes the most recent lastTurnDoneAt across live and historical', () => {
    const items = buildUnreadSessionItems({
      todos: [todo({ id: 'todo-1', title: 'Hybrid', aiSessions: [session({ sessionId: 's1', lastTurnDoneAt: 2000 })] })],
      liveSessions: [live({ sessionId: 's1', todoId: 'todo-1', lastTurnDoneAt: 7000 })],
      lastSeenMap: new Map([['s1', 5000]]),
    })

    expect(items).toHaveLength(1)
    expect(items[0].timestamp).toBe(7000)
  })

  it('sorts newest unread first', () => {
    const items = buildUnreadSessionItems({
      todos: [
        todo({ id: 'todo-a', title: 'A', aiSessions: [session({ sessionId: 's-old', lastTurnDoneAt: 1000 })] }),
        todo({ id: 'todo-b', title: 'B', aiSessions: [session({ sessionId: 's-mid', lastTurnDoneAt: 5000 })] }),
        todo({ id: 'todo-c', title: 'C', aiSessions: [session({ sessionId: 's-new', lastTurnDoneAt: 9000 })] }),
      ],
      liveSessions: [],
      lastSeenMap: new Map(),
    })

    expect(items.map(i => i.sessionId)).toEqual(['s-new', 's-mid', 's-old'])
  })

  it('ignores sessions with no lastTurnDoneAt at all', () => {
    const items = buildUnreadSessionItems({
      todos: [todo({ id: 'todo-1', title: 'Quiet', aiSessions: [session({ sessionId: 's-quiet', lastTurnDoneAt: null })] })],
      liveSessions: [live({ sessionId: 's-quiet', todoId: 'todo-1' })],
      lastSeenMap: new Map(),
    })

    expect(items).toEqual([])
  })

  it('falls back to live meta when a session is not in todos', () => {
    const items = buildUnreadSessionItems({
      todos: [],
      liveSessions: [live({ sessionId: 's-orphan', todoId: 'todo-x', todoTitle: 'Orphan', quadrant: 2, lastTurnDoneAt: 6000 })],
      lastSeenMap: new Map(),
    })

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ sessionId: 's-orphan', todoId: 'todo-x', todoTitle: 'Orphan', quadrant: 2 })
  })

  it('excludes pending_confirm sessions that have no unread reply', () => {
    const items = buildUnreadSessionItems({
      todos: [todo({ id: 'todo-1', title: 'Already seen pending_confirm' })],
      liveSessions: [live({
        sessionId: 's-pc',
        todoId: 'todo-1',
        status: 'pending_confirm',
        lastOutputAt: 3000,
        lastTurnDoneAt: null,
      })],
      lastSeenMap: new Map(),
    })

    expect(items).toEqual([])
  })

  it('treats pending_confirm with newer lastTurnDoneAt purely as unread', () => {
    const items = buildUnreadSessionItems({
      todos: [todo({ id: 'todo-1', title: 'Pending with reply' })],
      liveSessions: [live({
        sessionId: 's-pc',
        todoId: 'todo-1',
        status: 'pending_confirm',
        lastTurnDoneAt: 5000,
      })],
      lastSeenMap: new Map([['s-pc', 4000]]),
    })

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ sessionId: 's-pc', timestamp: 5000 })
    // reason field has been removed in spec
    expect((items[0] as Record<string, unknown>).reason).toBeUndefined()
  })

  it('excludes pending_confirm sessions whose lastSeen already covers the latest reply', () => {
    const items = buildUnreadSessionItems({
      todos: [todo({ id: 'todo-1', title: 'Seen pending' })],
      liveSessions: [live({
        sessionId: 's-pc',
        todoId: 'todo-1',
        status: 'pending_confirm',
        lastTurnDoneAt: 1000,
      })],
      lastSeenMap: new Map([['s-pc', 1000]]),
    })

    expect(items).toEqual([])
  })
})
