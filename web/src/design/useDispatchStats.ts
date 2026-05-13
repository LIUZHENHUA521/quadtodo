import { useMemo } from 'react'
import { useAiSessionStore } from '../store/aiSessionStore'
import { useUnreadStore, isSessionUnread } from '../store/unreadStore'
import { useTodoSnapshotStore } from '../store/todoSnapshotStore'
import { deriveAiState, isClosedAiStatus } from './aiPresentationState'

export interface DispatchStats {
  /** status === 'running' 的 session 数 */
  runningCount: number
  /** 严格 unread（且非 running）的 session 数 */
  pendingCount: number
  /** 既非 running 也非 unread 的 session 数 */
  idleCount: number
}

export function useDispatchStats(): DispatchStats {
  const sessions = useAiSessionStore((s) => s.sessions)
  const lastSeenMap = useUnreadStore((s) => s.lastSeenAt)
  const todos = useTodoSnapshotStore((s) => s.todos)

  return useMemo(() => {
    let runningCount = 0
    let pendingCount = 0
    let idleCount = 0
    sessions.forEach((session) => {
      const unread = isSessionUnread(session.lastTurnDoneAt, lastSeenMap.get(session.sessionId))
      const state = deriveAiState(session.status, unread)
      if (state === 'running') runningCount += 1
      else if (state === 'pending') pendingCount += 1
      else if (!isClosedAiStatus(session.status)) idleCount += 1
    })
    // 同 TodoCard 的 fallback：todos 里有 active aiSession 但 live store 还没 poll 到的，
    // 按 todo.aiSession.status 计入，避免 running 计数延迟 3s。
    for (const t of todos) {
      const sid = t.aiSession?.sessionId
      if (!sid || sessions.has(sid)) continue
      const status = t.aiSession?.status
      const unread = isSessionUnread(t.aiSession?.lastTurnDoneAt ?? null, lastSeenMap.get(sid))
      const state = deriveAiState(status, unread)
      if (state === 'running') runningCount += 1
      else if (state === 'pending') pendingCount += 1
      else if (!isClosedAiStatus(status)) idleCount += 1
    }
    return { runningCount, pendingCount, idleCount }
  }, [sessions, lastSeenMap, todos])
}
