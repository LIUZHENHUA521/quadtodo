import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useFocusStore } from '../../store/focusStore'
import { useAiSessionStore } from '../../store/aiSessionStore'
import { useTodoSnapshotStore } from '../../store/todoSnapshotStore'
import { useUnreadStore } from '../../store/unreadStore'
import { FocusSubbar } from './FocusSubbar'
import { FocusTabs } from './FocusTabs'
import SessionViewer from '../../SessionViewer'
import type { AutoModeController } from '../../AiTerminalMini'
import type { AiSession, Todo } from '../../api'
import './SessionFocus.css'

function findAiSession(todo: Todo | undefined, sessionId: string): AiSession | null {
  if (!todo) return null
  if (todo.aiSession?.sessionId === sessionId) return todo.aiSession
  return todo.aiSessions?.find((s) => s.sessionId === sessionId) ?? null
}

export function SessionFocus() {
  const { t } = useTranslation(['session'])
  const focusedTodoId = useFocusStore((s) => s.focusedTodoId)
  const focusedSessionId = useFocusStore((s) => s.focusedSessionId)
  const replaceFocusedSession = useFocusStore((s) => s.replaceFocusedSession)
  const focusedTab = useFocusStore((s) => s.focusedTab)
  const setTab = useFocusStore((s) => s.setTab)
  const clearFocus = useFocusStore((s) => s.clearFocus)

  const sessions = useAiSessionStore((s) => s.sessions)
  const replaceSessionId = useAiSessionStore((s) => s.replaceSessionId)
  const markSeen = useUnreadStore((s) => s.markSeen)

  // 由 AiTerminalMini 在 mount 后回填；切换 focus session 时 AiTerminalMini 卸载会先推 null。
  const [autoModeController, setAutoModeController] = useState<AutoModeController | null>(null)

  // 进入聚焦视图时自动标记已读，让 pending → idle
  useEffect(() => {
    if (!focusedSessionId) return
    const session = sessions.get(focusedSessionId)
    if (session?.lastTurnDoneAt) {
      markSeen(focusedSessionId, session.lastTurnDoneAt)
    }
  }, [focusedSessionId, sessions, markSeen])

  // live session 缺失时（首启动 3s 窗口 / 进程已死 / 服务重启后）回退到 todo 快照里的 AiSession，
  // 让 FocusSubbar 的 pill / 标题不再闪 idle，并让 TranscriptView 仍能从磁盘加载历史对话。
  // ⚠️ 必须在任何早返回之前调用所有 Hook，否则会触发 React error #310
  // (Rendered more hooks than during the previous render)。
  const fallbackTodo = useTodoSnapshotStore((s) =>
    focusedSessionId ? s.bySessionId.get(focusedSessionId) : undefined,
  )

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
  const fallbackAiSession = focusedSessionId ? findAiSession(fallbackTodo, focusedSessionId) : null
  const fallbackStatus = fallbackAiSession?.status

  // Map our 'conversation' | 'live' tab → SessionViewer's 'transcript' | 'live'
  const sessionViewerMode: 'transcript' | 'live' =
    focusedTab === 'conversation' ? 'transcript' : 'live'

  // SessionViewer expects a TodoStatus. Approximate from SessionMeta.status:
  //   running / idle / pending_confirm → 'ai_running' (so SessionViewer treats it as live)
  //   anything else             → 'ai_done'
  const isActive = session?.status === 'running' || session?.status === 'idle' || session?.status === 'pending_confirm'
  const todoStatus: 'ai_running' | 'ai_done' = isActive ? 'ai_running' : 'ai_done'

  // 还原 cwd：live session 优先，否则用快照里的 aiSession.cwd
  const effectiveCwd = session?.cwd ?? fallbackAiSession?.cwd ?? null

  // 真正"无任何可呈现内容"才显示空态：live 缺失 + 快照里也找不到对应 AiSession
  const hasRenderable = Boolean(focusedSessionId && (session || fallbackAiSession))

  return (
    <div className="session-focus">
      <FocusSubbar
        todoId={focusedTodoId}
        sessionId={focusedSessionId}
        session={session}
        fallbackStatus={fallbackStatus}
        fallbackTitle={fallbackTodo?.title}
        fallbackTool={fallbackAiSession?.tool}
        fallbackNativeSessionId={fallbackAiSession?.nativeSessionId ?? null}
        fallbackCwd={fallbackAiSession?.cwd ?? null}
        liveMissing={!session && Boolean(fallbackAiSession)}
        autoModeController={autoModeController}
        onResumed={handleSessionSwitch}
        onClose={clearFocus}
      />
      <FocusTabs value={focusedTab} onChange={setTab} />
      <div className="session-focus-content">
        {hasRenderable && focusedSessionId ? (
          <SessionViewer
            sessionId={focusedSessionId}
            todoId={focusedTodoId}
            status={todoStatus}
            cwd={effectiveCwd}
            onClose={clearFocus}
            onSessionSwitch={handleSessionSwitch}
            hideTabs
            mode={sessionViewerMode}
            fillHeight
            viewerRole="primary"
            onAutoModeReady={setAutoModeController}
          />
        ) : (
          <div className="session-focus-empty">{t('session:focus.noActiveSession')}</div>
        )}
      </div>
    </div>
  )
}
