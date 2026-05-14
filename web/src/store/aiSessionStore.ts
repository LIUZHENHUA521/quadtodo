import { create } from 'zustand'
import type { AiStatus, AiTool, LiveSession, Quadrant, ResourceSnapshot } from '../api'

export type PetState = 'idle' | 'working' | 'thinking' | 'calling' | 'celebrating' | 'fallen' | 'statue' | 'disconnected'

export interface SessionMeta extends LiveSession {}

interface OutputWindowSample {
  t: number
  bytes: number
}

interface AiSessionState {
  sessions: Map<string, SessionMeta>
  outputSamples: Map<string, OutputWindowSample[]>
  outputRates: Map<string, number>
  resources: Map<string, ResourceSnapshot>
  resourceHistory: Map<string, number[]>

  setSessions: (list: SessionMeta[]) => void
  upsertSession: (s: SessionMeta) => void
  removeSession: (sessionId: string) => void
  updateSessionStatus: (sessionId: string, status: AiStatus, completedAt?: number | null) => void
  markSessionTurnDone: (sessionId: string, status: AiStatus, timestamp: number) => void
  markSessionAwaitingReply: (sessionId: string, awaitingReply: boolean) => void
  recordOutputBytes: (sessionId: string, len: number, at?: number) => void
  setResources: (list: ResourceSnapshot[]) => void
  replaceSessionId: (oldId: string, nextId: string) => void
  reset: () => void
}

const WINDOW_MS = 5000
const HISTORY_LEN = 30

export const useAiSessionStore = create<AiSessionState>((set) => ({
  sessions: new Map(),
  outputSamples: new Map(),
  outputRates: new Map(),
  resources: new Map(),
  resourceHistory: new Map(),

  setSessions: (list) => set(() => {
    const m = new Map<string, SessionMeta>()
    for (const s of list) m.set(s.sessionId, s)
    return { sessions: m }
  }),

  upsertSession: (s) => set((state) => {
    const m = new Map(state.sessions)
    m.set(s.sessionId, s)
    return { sessions: m }
  }),

  removeSession: (sessionId) => set((state) => {
    const m = new Map(state.sessions)
    m.delete(sessionId)
    const samples = new Map(state.outputSamples); samples.delete(sessionId)
    const rates = new Map(state.outputRates); rates.delete(sessionId)
    const res = new Map(state.resources); res.delete(sessionId)
    const rh = new Map(state.resourceHistory); rh.delete(sessionId)
    return { sessions: m, outputSamples: samples, outputRates: rates, resources: res, resourceHistory: rh }
  }),

  updateSessionStatus: (sessionId, status, completedAt = null) => set((state) => {
    const s = state.sessions.get(sessionId)
    if (!s) return {}
    const m = new Map(state.sessions)
    m.set(sessionId, { ...s, status, completedAt: completedAt ?? s.completedAt })
    return { sessions: m }
  }),

  markSessionTurnDone: (sessionId, status, timestamp) => set((state) => {
    const s = state.sessions.get(sessionId)
    if (!s) return {}
    const m = new Map(state.sessions)
    m.set(sessionId, {
      ...s,
      status,
      lastTurnDoneAt: timestamp,
      awaitingReply: true,
    })
    return { sessions: m }
  }),

  // 用户手动打断（按下 Ctrl+C）后乐观更新：服务端有 1.5s+ grace 才会广播 turn_done，
  // 这期间 deriveAiState 还是 running → "AI 思考中" pill 卡住。先把 awaitingReply 翻 true，
  // pill 立即消失；后续服务端真正的 turn_done 广播会用 markSessionTurnDone 兜底定型。
  markSessionAwaitingReply: (sessionId, awaitingReply) => set((state) => {
    const s = state.sessions.get(sessionId)
    if (!s) return {}
    if (s.awaitingReply === awaitingReply) return {}
    const m = new Map(state.sessions)
    m.set(sessionId, { ...s, awaitingReply })
    return { sessions: m }
  }),

  recordOutputBytes: (sessionId, len, at = Date.now()) => set((state) => {
    const prev = state.outputSamples.get(sessionId) || []
    const cutoff = at - WINDOW_MS
    const next: OutputWindowSample[] = [...prev.filter(s => s.t >= cutoff), { t: at, bytes: len }]
    const totalBytes = next.reduce((sum, s) => sum + s.bytes, 0)
    const rate = totalBytes / (WINDOW_MS / 1000)
    const samples = new Map(state.outputSamples)
    samples.set(sessionId, next)
    const rates = new Map(state.outputRates)
    rates.set(sessionId, rate)
    return { outputSamples: samples, outputRates: rates }
  }),

  setResources: (list) => set((state) => {
    const m = new Map<string, ResourceSnapshot>()
    const rh = new Map(state.resourceHistory)
    for (const r of list) {
      m.set(r.sessionId, r)
      const hist = rh.get(r.sessionId) || []
      hist.push(r.cpu)
      if (hist.length > HISTORY_LEN) hist.shift()
      rh.set(r.sessionId, hist)
    }
    return { resources: m, resourceHistory: rh }
  }),

  replaceSessionId: (oldId, nextId) => set((state) => {
    const oldSession = state.sessions.get(oldId)
    if (!oldSession) return {}
    const sessions = new Map(state.sessions)
    sessions.delete(oldId)
    sessions.set(nextId, { ...oldSession, sessionId: nextId })

    const moveMap = <V,>(src: Map<string, V>): Map<string, V> => {
      if (!src.has(oldId)) return src
      const next = new Map(src)
      const v = next.get(oldId)
      next.delete(oldId)
      if (v !== undefined) next.set(nextId, v)
      return next
    }

    return {
      sessions,
      outputSamples: moveMap(state.outputSamples),
      outputRates: moveMap(state.outputRates),
      resources: moveMap(state.resources),
      resourceHistory: moveMap(state.resourceHistory),
    }
  }),

  reset: () => set({
    sessions: new Map(),
    outputSamples: new Map(),
    outputRates: new Map(),
    resources: new Map(),
    resourceHistory: new Map(),
  }),
}))

/** 把 session 状态 + 输出速率映射到宠物状态 */
export function derivePetState(session: SessionMeta, bytesPerSec: number, now = Date.now()): PetState {
  if (session.status === 'pending_confirm') return 'calling'
  if (session.status === 'idle') return 'idle'
  if (session.status === 'stopped' || session.status === 'failed') return 'fallen'
  if (session.status === 'done') return 'celebrating'
  // running
  if (!session.lastOutputAt) return 'idle'
  const silentMs = now - session.lastOutputAt
  if (silentMs > 10_000) return 'thinking'
  if (bytesPerSec > 50) return 'working'
  return 'idle'
}

/** 输出速率 → 动画倍率 */
export function rateMultiplier(bytesPerSec: number): number {
  if (bytesPerSec < 50) return 0.5
  if (bytesPerSec < 500) return 1.0
  if (bytesPerSec < 5000) return 1.5
  return 2.0
}

export type { AiTool, Quadrant }
