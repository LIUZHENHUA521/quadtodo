import { Tooltip } from 'antd'
import type { SessionMeta } from '../../store/aiSessionStore'

interface Props {
  todoId: string
  sessionId: string | null
  session?: SessionMeta
  onClose: () => void
}

export function FocusSubbar({ session, onClose }: Props) {
  const title = session?.todoTitle ?? '(untitled)'
  const tool = session?.tool ?? 'ai'
  const status = session?.status ?? 'idle'
  const sessionShortId = session?.sessionId?.slice(0, 8) ?? '—'
  const quadrant = session?.quadrant ?? 0

  const quadColor =
    quadrant >= 1 && quadrant <= 4 ? `var(--q${quadrant})` : 'var(--text-tertiary)'

  const statusLabel =
    status === 'running' ? '运行中' :
    status === 'pending_confirm' ? '待确认' :
    status === 'done' ? '完成' :
    status === 'failed' ? '失败' :
    status === 'stopped' ? '停止' : 'idle'

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
