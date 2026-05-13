/**
 * 待确认追踪：服务端记 lastTurnDoneAt（每次 AI turn_done 时更新到 session 内存
 * 与 todo.aiSessions 持久化），客户端记 confirmedTurnDoneAt（localStorage，本浏览器维度）。
 *
 * 待确认判定：lastTurnDoneAt > confirmedTurnDoneAt（confirmedTurnDoneAt 缺省视为 0）。
 *
 * 历史上旧 key `quadtodo:sessionLastSeen` 曾在打开/聚焦会话时自动写入 Date.now，
 * 会把新一轮回复错误判成已确认。这里换新 key，只允许显式“确认”写入。
 */

import { create } from 'zustand'

const STORAGE_KEY = 'quadtodo:sessionConfirmedTurn'

function loadFromStorage(): Map<string, number> {
  if (typeof window === 'undefined') return new Map()
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Map()
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return new Map()
    const out = new Map<string, number>()
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof k === 'string' && typeof v === 'number' && Number.isFinite(v)) out.set(k, v)
    }
    return out
  } catch {
    return new Map()
  }
}

function persist(map: Map<string, number>) {
  if (typeof window === 'undefined') return
  try {
    const obj: Record<string, number> = {}
    for (const [k, v] of map) obj[k] = v
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(obj))
  } catch { /* ignore quota / serialization */ }
}

interface UnreadState {
  lastSeenAt: Map<string, number>
  markSeen: (sessionId: string, at?: number) => void
  clearSession: (sessionId: string) => void
}

export const useUnreadStore = create<UnreadState>((set) => ({
  lastSeenAt: loadFromStorage(),

  markSeen: (sessionId, at = Date.now()) => set((state) => {
    const prev = state.lastSeenAt.get(sessionId) || 0
    if (prev >= at) return {}
    const next = new Map(state.lastSeenAt)
    next.set(sessionId, at)
    persist(next)
    return { lastSeenAt: next }
  }),

  clearSession: (sessionId) => set((state) => {
    if (!state.lastSeenAt.has(sessionId)) return {}
    const next = new Map(state.lastSeenAt)
    next.delete(sessionId)
    persist(next)
    return { lastSeenAt: next }
  }),
}))

/** 给定 session 的 lastTurnDoneAt 与本地 lastSeenAt，返回是否未读。 */
export function isSessionUnread(
  lastTurnDoneAt: number | null | undefined,
  lastSeenAt: number | null | undefined,
): boolean {
  if (!lastTurnDoneAt) return false
  return lastTurnDoneAt > (lastSeenAt || 0)
}
