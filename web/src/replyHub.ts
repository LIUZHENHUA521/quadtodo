import type { AiSession, AiTool, Quadrant, Todo } from './api'
import type { SessionMeta } from './store/aiSessionStore'

export interface UnreadSessionItem {
  id: string
  sessionId: string
  todoId: string
  todoTitle: string
  quadrant: Quadrant
  tool: AiTool
  timestamp: number
  label?: string
}

export interface BuildUnreadSessionItemsInput {
  todos: Todo[]
  liveSessions: SessionMeta[]
  lastSeenMap: Map<string, number>
}

function uniqueTodoSessions(todo: Todo): AiSession[] {
  const byId = new Map<string, AiSession>()
  for (const session of [todo.aiSession, ...(todo.aiSessions || [])]) {
    if (!session?.sessionId) continue
    if (!byId.has(session.sessionId)) byId.set(session.sessionId, session)
  }
  return [...byId.values()]
}

export function buildUnreadSessionItems({ todos, liveSessions, lastSeenMap }: BuildUnreadSessionItemsInput): UnreadSessionItem[] {
  const tsBySid = new Map<string, number>()
  const metaBySid = new Map<string, { todoId: string; todoTitle: string; quadrant: Quadrant; tool: AiTool; label?: string }>()

  for (const todo of todos) {
    for (const session of uniqueTodoSessions(todo)) {
      const ts = session.lastTurnDoneAt || 0
      if (ts > 0) {
        const prev = tsBySid.get(session.sessionId) || 0
        if (ts > prev) tsBySid.set(session.sessionId, ts)
      }
      if (!metaBySid.has(session.sessionId)) {
        metaBySid.set(session.sessionId, {
          todoId: todo.id,
          todoTitle: todo.title || '(无标题)',
          quadrant: todo.quadrant,
          tool: session.tool,
          label: session.label,
        })
      }
    }
  }

  for (const live of liveSessions) {
    const ts = live.lastTurnDoneAt || 0
    if (ts > 0) {
      const prev = tsBySid.get(live.sessionId) || 0
      if (ts > prev) tsBySid.set(live.sessionId, ts)
    }
    if (!metaBySid.has(live.sessionId)) {
      metaBySid.set(live.sessionId, {
        todoId: live.todoId,
        todoTitle: live.todoTitle || '(无标题)',
        quadrant: live.quadrant,
        tool: live.tool,
      })
    }
  }

  const items: UnreadSessionItem[] = []
  for (const [sid, ts] of tsBySid) {
    const lastSeen = lastSeenMap.get(sid) || 0
    if (ts <= lastSeen) continue
    const meta = metaBySid.get(sid)
    if (!meta) continue
    items.push({
      id: `unread:${sid}`,
      sessionId: sid,
      timestamp: ts,
      ...meta,
    })
  }

  items.sort((a, b) => b.timestamp - a.timestamp)
  return items
}
