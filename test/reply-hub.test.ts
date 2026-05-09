import { describe, expect, it } from 'vitest'
import type { AiSession, Todo } from '../web/src/api.ts'
import {
  buildAttentionItems,
  countAttentionItems,
  parseSeenReplySessionIds,
  serializeSeenReplySessionIds,
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
  }
}

describe('buildAttentionItems', () => {
  it('creates a待交互 item for live pending_confirm sessions', () => {
    const items = buildAttentionItems({
      todos: [todo({ id: 'todo-1', title: 'Fix login', quadrant: 1 })],
      liveSessions: [live({ sessionId: 's-live', todoId: 'todo-1', status: 'pending_confirm', lastOutputAt: 3000 })],
      seenSessionIds: new Set(),
    })

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'interaction:s-live',
      kind: 'interaction',
      sessionId: 's-live',
      todoId: 'todo-1',
      todoTitle: 'Fix login',
      quadrant: 1,
      tool: 'claude',
      timestamp: 3000,
    })
  })

  it('creates a待验收 item for ai_done todos with done sessions', () => {
    const items = buildAttentionItems({
      todos: [todo({ id: 'todo-2', title: 'Refactor terminal', status: 'ai_done', quadrant: 2, aiSessions: [session({ sessionId: 's-done', completedAt: 4000 })] })],
      liveSessions: [],
      seenSessionIds: new Set(),
    })

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'review:s-done',
      kind: 'review',
      sessionId: 's-done',
      todoId: 'todo-2',
      todoTitle: 'Refactor terminal',
      quadrant: 2,
      timestamp: 4000,
    })
  })

  it('filters completed review items that have been marked seen', () => {
    const items = buildAttentionItems({
      todos: [todo({ id: 'todo-2', title: 'Refactor terminal', status: 'ai_done', aiSessions: [session({ sessionId: 's-done' })] })],
      liveSessions: [],
      seenSessionIds: new Set(['s-done']),
    })

    expect(items).toEqual([])
  })

  it('does not remove待交互 items when their session id is marked seen', () => {
    const items = buildAttentionItems({
      todos: [todo({ id: 'todo-1', title: 'Needs input' })],
      liveSessions: [live({ sessionId: 's-pending', todoId: 'todo-1', status: 'pending_confirm' })],
      seenSessionIds: new Set(['s-pending']),
    })

    expect(items.map(item => item.kind)).toEqual(['interaction'])
  })

  it('prevents duplicate items when the same session appears as pending and in todo history', () => {
    const items = buildAttentionItems({
      todos: [todo({ id: 'todo-1', title: 'Needs input', status: 'ai_done', aiSessions: [session({ sessionId: 's-same', status: 'done' })] })],
      liveSessions: [live({ sessionId: 's-same', todoId: 'todo-1', status: 'pending_confirm' })],
      seenSessionIds: new Set(),
    })

    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('interaction')
  })

  it('sorts待交互 before待验收, then by newest timestamp', () => {
    const items = buildAttentionItems({
      todos: [
        todo({ id: 'todo-1', title: 'Old review', status: 'ai_done', aiSessions: [session({ sessionId: 's-old', completedAt: 1000 })] }),
        todo({ id: 'todo-2', title: 'New review', status: 'ai_done', aiSessions: [session({ sessionId: 's-new', completedAt: 5000 })] }),
      ],
      liveSessions: [live({ sessionId: 's-pending', todoId: 'todo-3', todoTitle: 'Pending', status: 'pending_confirm', lastOutputAt: 2000 })],
      seenSessionIds: new Set(),
    })

    expect(items.map(item => item.sessionId)).toEqual(['s-pending', 's-new', 's-old'])
  })

  it('counts待交互 and待验收 separately', () => {
    const counts = countAttentionItems([
      { id: 'interaction:a', kind: 'interaction', sessionId: 'a', todoId: 'ta', todoTitle: 'A', quadrant: 1, tool: 'claude', timestamp: 1 },
      { id: 'review:b', kind: 'review', sessionId: 'b', todoId: 'tb', todoTitle: 'B', quadrant: 2, tool: 'codex', timestamp: 2 },
      { id: 'review:c', kind: 'review', sessionId: 'c', todoId: 'tc', todoTitle: 'C', quadrant: 3, tool: 'cursor', timestamp: 3 },
    ])

    expect(counts).toEqual({ total: 3, interaction: 1, review: 2 })
  })
})

describe('seen reply storage helpers', () => {
  it('parses array storage values', () => {
    expect([...parseSeenReplySessionIds('["a","b",3,null]')]).toEqual(['a', 'b'])
  })

  it('parses object storage values for forward compatibility', () => {
    expect([...parseSeenReplySessionIds('{"a":171,"b":172}')]).toEqual(['a', 'b'])
  })

  it('returns an empty set for invalid storage', () => {
    expect(parseSeenReplySessionIds('not json')).toEqual(new Set())
  })

  it('serializes seen ids as a stable sorted array', () => {
    expect(serializeSeenReplySessionIds(new Set(['b', 'a']))).toBe('["a","b"]')
  })
})
