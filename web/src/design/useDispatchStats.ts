import { useMemo } from 'react'
import { useAiSessionStore } from '../store/aiSessionStore'
import { useUnreadStore, isSessionUnread } from '../store/unreadStore'
import { useTodoSnapshotStore } from '../store/todoSnapshotStore'
import { deriveAiState, isClosedAiStatus } from './aiPresentationState'
import type { LiveSession, Todo } from '../api'

export interface DispatchStats {
  /** status === 'running' 的 session 数（按 todoId 折叠） */
  runningCount: number
  /** 严格 unread（且非 running）的 session 数 */
  pendingCount: number
  /** 既非 running 也非 unread 的 session 数（按 todoId 折叠） */
  idleCount: number
}

export function computeDispatchStats(
  sessions: Map<string, LiveSession>,
  lastSeenMap: Map<string, number>,
  todos: Todo[],
): DispatchStats {
  // 同一 todoId 多 session 时折叠为 1（与 TopbarDispatch 弹层一致），避免 pill 计数与
  // 列表长度对不上。pending 仍按 session 维度统计（与 unreadItems 一致）。
  const runningTodoIds = new Set<string>()
  const idleTodoIds = new Set<string>()
  let pendingCount = 0
  sessions.forEach((session) => {
    const unread = isSessionUnread(session.lastTurnDoneAt, lastSeenMap.get(session.sessionId))
    const state = deriveAiState(session.effectiveStatus ?? session.status, unread, session.awaitingReply ?? false)
    if (state === 'running') runningTodoIds.add(session.todoId)
    else if (state === 'pending') pendingCount += 1
    else if (!isClosedAiStatus(session.status)) idleTodoIds.add(session.todoId)
  })
  // 同 TodoCard 的 fallback：todos 里有 active aiSession 但 live store 还没 poll 到的，
  // 按 todo.aiSession.status 计入，避免 running 计数延迟 3s。
  for (const t of todos) {
    const sid = t.aiSession?.sessionId
    if (!sid || sessions.has(sid)) continue
    const status = t.aiSession?.status
    const unread = isSessionUnread(t.aiSession?.lastTurnDoneAt ?? null, lastSeenMap.get(sid))
    const state = deriveAiState(status, unread)
    if (state === 'running') runningTodoIds.add(t.id)
    else if (state === 'pending') pendingCount += 1
    else if (!isClosedAiStatus(status)) idleTodoIds.add(t.id)
  }
  // running 和 idle 在同一 todo 上互斥：running 优先，从 idle 集合里剔除。
  for (const id of runningTodoIds) idleTodoIds.delete(id)
  return {
    runningCount: runningTodoIds.size,
    pendingCount,
    idleCount: idleTodoIds.size,
  }
}

export function useDispatchStats(): DispatchStats {
  const sessions = useAiSessionStore((s) => s.sessions)
  const lastSeenMap = useUnreadStore((s) => s.lastSeenAt)
  const todos = useTodoSnapshotStore((s) => s.todos)
  return useMemo(
    () => computeDispatchStats(sessions, lastSeenMap, todos),
    [sessions, lastSeenMap, todos],
  )
}
