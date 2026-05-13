import { create } from 'zustand'
import { useFocusStore } from './focusStore'

export type DrawerKey = 'settings' | 'stats' | 'wiki' | 'report' | 'statsReports' | 'template'

interface DispatchState {
  // Drawer open flags (lifted from TodoManage local state)
  settings: boolean
  stats: boolean
  wiki: boolean
  report: boolean
  /** Unified flag for the merged Stats + Reports drawer (M4-T2). */
  statsReports: boolean
  /** Prompt template drawer (M4-T4: surfaced via CommandPalette). */
  template: boolean

  // Command palette open state
  palette: boolean

  // Action: open a drawer by name
  openDrawer: (key: DrawerKey) => void
  // Action: close a drawer by name
  closeDrawer: (key: DrawerKey) => void
  // Convenience: close every drawer at once (used when opening palette)
  closeAllDrawers: () => void

  // Palette controls
  openPalette: () => void
  closePalette: () => void
  togglePalette: () => void

  /** Open the session focus overlay for the given todo (and its session, if known). Closes palette + drawers. */
  openFocus: (todoId: string, sessionId?: string | null) => void

  /** When set, TodoManage should scroll/focus this todo and clear the field */
  jumpToTodoId: string | null

  /** Generic signal flags (key → has-pending-intent). Use signal()/consumeSignal(). */
  signals: Record<string, boolean>
  /** Set a signal flag to true (e.g. signal('newTodo'), signal('recover'), signal('telegramSync')).
   *  Also closes the command palette (matches existing semantics). */
  signal: (key: string) => void
  /** Read AND clear a signal in one call. Returns true if it was set. */
  consumeSignal: (key: string) => boolean
  /** Read without consuming. Use in selectors with caution (won't trigger re-render predictably). */
  hasSignal: (key: string) => boolean

  setJumpTo: (id: string | null) => void
}

export const useDispatchStore = create<DispatchState>((set, get) => ({
  settings: false,
  stats: false,
  wiki: false,
  report: false,
  statsReports: false,
  template: false,
  palette: false,

  openDrawer: (key) => set((s) => ({ ...s, [key]: true, palette: false })),
  closeDrawer: (key) => set(() => ({ [key]: false } as Partial<DispatchState>)),
  closeAllDrawers: () => set(() => ({ settings: false, stats: false, wiki: false, report: false, statsReports: false, template: false })),

  openPalette: () => set(() => ({ palette: true })),
  closePalette: () => set(() => ({ palette: false })),
  togglePalette: () => set((s) => ({ palette: !s.palette })),

  openFocus: (todoId, sessionId) => {
    // Close any open palette/drawers, then activate focus mode
    set(() => ({ palette: false, settings: false, stats: false, wiki: false, report: false, statsReports: false, template: false }))
    useFocusStore.getState().setFocus(todoId, sessionId ?? null)
  },

  jumpToTodoId: null,

  signals: {},
  signal: (key) => set((s) => ({ signals: { ...s.signals, [key]: true }, palette: false })),
  consumeSignal: (key) => {
    const has = get().signals[key] === true
    if (has) set((s) => {
      const next = { ...s.signals }
      delete next[key]
      return { signals: next }
    })
    return has
  },
  hasSignal: (key) => get().signals[key] === true,

  setJumpTo: (id) => set(() => ({ jumpToTodoId: id })),
}))
