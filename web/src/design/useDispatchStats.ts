import { useMemo } from 'react'
import { useAiSessionStore } from '../store/aiSessionStore'
import { useUnreadStore, isSessionUnread } from '../store/unreadStore'
import { deriveAiState } from './aiPresentationState'

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

  return useMemo(() => {
    let runningCount = 0
    let pendingCount = 0
    let idleCount = 0
    sessions.forEach((session) => {
      const unread = isSessionUnread(session.lastTurnDoneAt, lastSeenMap.get(session.sessionId))
      const state = deriveAiState(session.status, unread)
      if (state === 'running') runningCount += 1
      else if (state === 'pending') pendingCount += 1
      else idleCount += 1
    })
    return { runningCount, pendingCount, idleCount }
  }, [sessions, lastSeenMap])
}
