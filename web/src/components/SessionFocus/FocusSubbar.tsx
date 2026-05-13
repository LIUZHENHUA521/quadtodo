import { Tooltip } from 'antd'
import type { SessionMeta } from '../../store/aiSessionStore'
import type { AiStatus } from '../../api'
import { deriveAiState, AI_STATE_PILL_LABEL } from '../../design/aiPresentationState'
import { useUnreadStore, isSessionUnread } from '../../store/unreadStore'

interface Props {
  todoId: string
  sessionId: string | null
  session?: SessionMeta
  /** live session 还没出现时用 todo.aiSession.status 兜底，避免首启动闪 idle */
  fallbackStatus?: AiStatus
  onClose: () => void
}

export function FocusSubbar({ session, fallbackStatus, onClose }: Props) {
  const title = session?.todoTitle ?? '(untitled)'
  const tool = session?.tool ?? 'ai'
  const sessionShortId = session?.sessionId?.slice(0, 8) ?? '—'
  const quadrant = session?.quadrant ?? 0

  const lastSeen = useUnreadStore((s) =>
    session?.sessionId ? s.lastSeenAt.get(session.sessionId) : undefined,
  )
  const unread = isSessionUnread(session?.lastTurnDoneAt, lastSeen)
  const state = deriveAiState(session?.status ?? fallbackStatus, unread, session?.awaitingReply ?? false)
  const statusLabel = AI_STATE_PILL_LABEL[state]

  const quadColor =
    quadrant >= 1 && quadrant <= 4 ? `var(--q${quadrant})` : 'var(--text-tertiary)'

  return (
    <div className="focus-subbar">
      <button className="focus-back" onClick={onClose} aria-label="Back to grid">
        <span>←</span>
        <span>Grid</span>
      </button>
      <div className="focus-task-title">
        <span
          className="quad-dot"
          style={{ background: quadColor, boxShadow: `0 0 8px ${quadColor}` }}
        />
        <span>{title}</span>
        <span className="focus-task-id">#{sessionShortId}</span>
      </div>
      <div className="focus-actions">
        <span className="pill-select green">{tool} · {statusLabel}</span>
        <Tooltip title="Close (Esc)">
          <button className="focus-icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </Tooltip>
      </div>
    </div>
  )
}
