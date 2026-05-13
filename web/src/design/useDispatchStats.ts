import { useMemo } from 'react'
import { useAiSessionStore } from '../store/aiSessionStore'
import { useUnreadStore, isSessionUnread } from '../store/unreadStore'

export interface DispatchStats {
  /** Sessions currently running */
  activeCount: number
  /** "待确认" semantics (matches TodoCard): pending_confirm OR unread reply */
  pendingCount: number
  /** Aggregate input + output tokens used today (rough estimate) */
  tokenSum: number
  /** Display string for tokenSum (e.g. "24.5k") */
  tokenSumLabel: string
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'm'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}

export function useDispatchStats(): DispatchStats {
  const sessions = useAiSessionStore((s) => s.sessions)
  const lastSeenMap = useUnreadStore((s) => s.lastSeenAt)

  return useMemo(() => {
    let activeCount = 0
    let pendingCount = 0
    // tokenSum: LiveSession does NOT carry token totals as of M2.
    // Always returns 0 until a server-pushed source is wired.
    const tokenSum = 0
    sessions.forEach((session) => {
      if (session.status === 'running') activeCount += 1
      const unread = isSessionUnread(session.lastTurnDoneAt, lastSeenMap.get(session.sessionId))
      // 待确认 = real pending_confirm OR unread reply (matches TodoCard semantics)
      if (session.status === 'pending_confirm' || unread) pendingCount += 1
    })
    return { activeCount, pendingCount, tokenSum, tokenSumLabel: formatTokens(tokenSum) }
  }, [sessions, lastSeenMap])
}
