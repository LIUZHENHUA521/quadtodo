import { useEffect } from 'react'
import { useDispatchStore } from '../store/dispatchStore'
import { useFocusStore } from '../store/focusStore'

/**
 * Global keyboard shortcuts. MUST be mounted exactly once (call from main.tsx ThemedApp).
 *
 * Currently:
 * - ⌘K / Ctrl+K → toggle command palette
 * - Esc → close palette (if open)
 *
 * Future: 1-4 quadrant nav, N for new todo, etc. (those will be wired through
 * the palette's command list to keep one source of truth.)
 */
export function useGlobalShortcuts() {
  const togglePalette = useDispatchStore((s) => s.togglePalette)
  const closePalette = useDispatchStore((s) => s.closePalette)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // ⌘K / Ctrl+K (avoid catching when user is typing in an input)
      const target = e.target as HTMLElement | null
      const isTypingInForm =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable === true

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        // Allow ⌘K even inside inputs — that's the standard pattern
        e.preventDefault()
        togglePalette()
        return
      }

      if (e.key === 'Escape' && !isTypingInForm) {
        // Priority: focus → palette → drawerStack handles drawers separately (their own listener)
        const focusOpen = useFocusStore.getState().focusedTodoId !== null
        if (focusOpen) {
          useFocusStore.getState().clearFocus()
          return
        }
        closePalette()
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [togglePalette, closePalette])
}
