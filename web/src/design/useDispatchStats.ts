import { useMemo } from 'react'
import { useAiSessionStore } from '../store/aiSessionStore'

export interface DispatchStats {
  /** Sessions currently running OR thinking */
  activeCount: number
  /** Sessions waiting for user confirmation */
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

  return useMemo(() => {
    let activeCount = 0
    let pendingCount = 0
    let tokenSum = 0
    sessions.forEach((session) => {
      const status = (session as { status?: string }).status
      if (status === 'running' || status === 'thinking') activeCount += 1
      if (status === 'pending_confirm') pendingCount += 1
      // Token sum: try common fields; if none present, contributes 0.
      const tokens = (session as { totalTokens?: number; tokens?: number }).totalTokens
        ?? (session as { tokens?: number }).tokens
        ?? 0
      if (typeof tokens === 'number') tokenSum += tokens
    })
    return { activeCount, pendingCount, tokenSum, tokenSumLabel: formatTokens(tokenSum) }
  }, [sessions])
}
