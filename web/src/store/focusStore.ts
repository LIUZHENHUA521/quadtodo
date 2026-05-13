import { create } from 'zustand'

export type FocusTab = 'conversation' | 'live'

interface FocusState {
  /** Currently-focused todo (null = no focus / Grid mode) */
  focusedTodoId: string | null
  /** The session ID being shown in focus (may be null if todo has no active session) */
  focusedSessionId: string | null
  /** Active tab inside Focus Mode */
  focusedTab: FocusTab

  setFocus: (todoId: string | null, sessionId?: string | null) => void
  clearFocus: () => void
  setTab: (tab: FocusTab) => void
  replaceFocusedSession: (oldId: string, nextId: string) => void
}

export const useFocusStore = create<FocusState>((set) => ({
  focusedTodoId: null,
  focusedSessionId: null,
  focusedTab: 'conversation',  // Default landing tab matches mockup (rendered chat first)

  setFocus: (todoId, sessionId) => set(() => ({
    focusedTodoId: todoId,
    focusedSessionId: sessionId ?? null,
    focusedTab: 'conversation',  // Reset tab on new focus
  })),
  clearFocus: () => set(() => ({ focusedTodoId: null, focusedSessionId: null })),
  setTab: (tab) => set(() => ({ focusedTab: tab })),
  replaceFocusedSession: (oldId, nextId) => set((state) => {
    if (state.focusedSessionId !== oldId) return state
    return { focusedSessionId: nextId }
  }),
}))
