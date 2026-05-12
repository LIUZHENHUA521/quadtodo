import { useEffect } from 'react'
import { useFocusStore } from '../../store/focusStore'
import { useAiSessionStore } from '../../store/aiSessionStore'
import { FocusSubbar } from './FocusSubbar'
import { FocusTabs } from './FocusTabs'
import SessionViewer from '../../SessionViewer'
import './SessionFocus.css'

export function SessionFocus() {
  const focusedTodoId = useFocusStore((s) => s.focusedTodoId)
  const focusedSessionId = useFocusStore((s) => s.focusedSessionId)
  const focusedTab = useFocusStore((s) => s.focusedTab)
  const setTab = useFocusStore((s) => s.setTab)
  const clearFocus = useFocusStore((s) => s.clearFocus)

  const sessions = useAiSessionStore((s) => s.sessions)

  // Nudge ResizeObservers (xterm fit, etc.) after the focus mode opens or
  // after a tab switch. Without this, the Live xterm canvas can stay sized
  // for its previously-hidden display:none parent and render narrow with
  // empty space on the right. Defer to next-next frame so the new flex
  // layout has actually applied before we measure.
  useEffect(() => {
    if (!focusedTodoId) return
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event('resize'))
      })
    })
    return () => cancelAnimationFrame(id)
  }, [focusedTodoId, focusedTab])

  if (!focusedTodoId) return null

  const session = focusedSessionId ? sessions.get(focusedSessionId) : undefined

  // Map our 'conversation' | 'live' tab → SessionViewer's 'transcript' | 'live'
  const sessionViewerMode: 'transcript' | 'live' =
    focusedTab === 'conversation' ? 'transcript' : 'live'

  // SessionViewer expects a TodoStatus. Approximate from SessionMeta.status:
  //   running / pending_confirm → 'ai_running' (so SessionViewer treats it as live)
  //   anything else             → 'ai_done'
  const isActive = session?.status === 'running' || session?.status === 'pending_confirm'
  const todoStatus: 'ai_running' | 'ai_done' = isActive ? 'ai_running' : 'ai_done'

  return (
    <div className="session-focus">
      <FocusSubbar
        todoId={focusedTodoId}
        sessionId={focusedSessionId}
        session={session}
        onClose={clearFocus}
      />
      <FocusTabs value={focusedTab} onChange={setTab} />
      <div className="session-focus-content">
        {focusedSessionId && session ? (
          <SessionViewer
            sessionId={focusedSessionId}
            todoId={focusedTodoId}
            status={todoStatus}
            cwd={session.cwd ?? null}
            onClose={clearFocus}
            hideTabs
            mode={sessionViewerMode}
            fillHeight
          />
        ) : (
          <div className="session-focus-empty">No active session for this todo.</div>
        )}
      </div>
    </div>
  )
}
