import { useEffect } from 'react'
import { useFocusStore } from '../../store/focusStore'
import { useAiSessionStore } from '../../store/aiSessionStore'
import { useUnreadStore } from '../../store/unreadStore'
import { useTodoSnapshotStore } from '../../store/todoSnapshotStore'
import { FocusSubbar } from './FocusSubbar'
import { FocusTabs } from './FocusTabs'
import SessionViewer from '../../SessionViewer'
import './SessionFocus.css'

export function SessionFocus() {
  const focusedTodoId = useFocusStore((s) => s.focusedTodoId)
  const focusedSessionId = useFocusStore((s) => s.focusedSessionId)
  const replaceFocusedSession = useFocusStore((s) => s.replaceFocusedSession)
  const focusedTab = useFocusStore((s) => s.focusedTab)
  const setTab = useFocusStore((s) => s.setTab)
  const clearFocus = useFocusStore((s) => s.clearFocus)

  const sessions = useAiSessionStore((s) => s.sessions)
  const replaceSessionId = useAiSessionStore((s) => s.replaceSessionId)

  // live session 缺失时（首启动 3s 窗口）回退到 todo.aiSession.status，让 FocusSubbar
  // 的 pill 不再闪 idle。
  // ⚠️ 必须在任何早返回之前调用所有 Hook，否则会触发 React error #310
  // (Rendered more hooks than during the previous render)。
  const fallbackTodo = useTodoSnapshotStore((s) =>
    focusedSessionId ? s.bySessionId.get(focusedSessionId) : undefined,
  )

  // 用户打开 focus mode 即视为"已读" —— 让 TodoCard 的待确认徽章清掉
  // (条件：sessionId 存在且 user 真在 focus 这个 session)
  const markSeen = useUnreadStore((s) => s.markSeen)
  useEffect(() => {
    if (!focusedSessionId) return
    markSeen(focusedSessionId)
  }, [focusedSessionId, markSeen])

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

  const handleSessionSwitch = (nextSessionId: string) => {
    if (!focusedSessionId) return
    replaceSessionId(focusedSessionId, nextSessionId)
    replaceFocusedSession(focusedSessionId, nextSessionId)
  }

  if (!focusedTodoId) return null

  const session = focusedSessionId ? sessions.get(focusedSessionId) : undefined
  const fallbackStatus = fallbackTodo?.aiSession?.sessionId === focusedSessionId
    ? fallbackTodo?.aiSession?.status
    : undefined

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
        fallbackStatus={fallbackStatus}
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
            onSessionSwitch={handleSessionSwitch}
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
