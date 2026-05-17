import React, { useMemo } from 'react'
import { Button, Popconfirm } from 'antd'
import dayjs from 'dayjs'
import { useTranslation } from 'react-i18next'
import type { AiSession, Todo, AiTool } from '../../api'

const TOOL_COLOR: Record<AiTool, string> = {
  claude: '#d97706',
  codex: '#4a90e2',
  cursor: '#8b5cf6',
}

const TOOL_NAME: Record<AiTool, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
}

function formatElapsed(s: AiSession): string {
  const start = s.startedAt
  if (!start) return ''
  const end = s.completedAt || Date.now()
  const ms = Math.max(0, end - start)
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${(ms / 3_600_000).toFixed(1)}h`
}

export interface SessionCardProps {
  session: AiSession
  parent: Todo
  /** 当前 PTY 是否还活着（用于决定 Cancel/Close 行为） */
  live?: boolean
  /** 当前列对应的 status 类别 */
  columnStatus: 'running' | 'pending_confirm' | 'idle'
  /** FLIP 跨列动画注册 —— StatusBoard 传 `register(key, el)` */
  flipRegister?: (sessionId: string, el: HTMLElement | null) => void
  onOpen?: (s: AiSession, parent: Todo) => void
  onOpenParent?: (parent: Todo) => void
  onCancel?: (s: AiSession, parent: Todo) => void
  onConfirm?: (s: AiSession, parent: Todo) => void
  onClose?: (s: AiSession, parent: Todo) => void
  onReopen?: (s: AiSession, parent: Todo) => void
}

export function SessionCard({
  session, parent, columnStatus, flipRegister,
  onOpen, onOpenParent, onCancel, onConfirm, onClose, onReopen,
}: SessionCardProps) {
  const { t } = useTranslation(['common', 'todo'])

  const statusColor = useMemo(() => {
    switch (columnStatus) {
      case 'running': return 'var(--sb-running)'
      case 'pending_confirm': return 'var(--sb-warn)'
      case 'idle': return 'var(--sb-calm)'
    }
  }, [columnStatus])

  const statusLabel = useMemo(() => {
    switch (columnStatus) {
      case 'running': return t('todo:session.statusRunning', { defaultValue: '运行中' })
      case 'pending_confirm': return t('todo:session.statusNeedsInput', { defaultValue: '需确认' })
      case 'idle': return t('todo:session.statusIdle', { defaultValue: '已空闲' })
    }
  }, [columnStatus, t])

  const className = [
    'session-card',
    columnStatus === 'pending_confirm' ? 'is-needs-input' : '',
  ].filter(Boolean).join(' ')

  const handleCardClick = (e: React.MouseEvent) => {
    // 按钮区点击不进 focus；其余位置（含 parent title 那一行）都打开 AI 看板（reopen 语义）
    if ((e.target as HTMLElement).closest('.session-card-actions')) return
    onOpen?.(session, parent)
  }

  return (
    <article
      className={className}
      onClick={handleCardClick}
      ref={(el) => flipRegister?.(session.sessionId, el)}
    >
      {/* Parent 链接：点击不再拦截，让事件冒泡到 article 走 reopen 逻辑 */}
      <div className="session-card-parent" title={parent.title}>
        <span className="parent-title">{parent.title}</span>
      </div>

      <div className="session-card-meta-row" style={{ ['--status-color' as any]: statusColor }}>
        <span
          className="tool"
          style={{ ['--tool-color' as any]: TOOL_COLOR[session.tool] || '#888' }}
        >
          {TOOL_NAME[session.tool] || session.tool}
        </span>
        <span>{dayjs(session.startedAt).format('MM/DD HH:mm')}</span>
        <span className={`status ${columnStatus === 'running' ? 'is-running' : ''}`}>
          <span className="dot" />
          {statusLabel}
        </span>
        <span>· {formatElapsed(session)}</span>
      </div>

      <div className="session-card-actions">
        {columnStatus === 'running' && (
          <Popconfirm
            title={t('common:confirm.cancelSession', { defaultValue: '停止当前 session？' })}
            okText={t('common:confirm.yes', { defaultValue: '停' })}
            cancelText={t('common:confirm.no', { defaultValue: '不停' })}
            onConfirm={(e) => { e?.stopPropagation(); onCancel?.(session, parent) }}
            onCancel={(e) => e?.stopPropagation()}
          >
            <Button size="small" danger onClick={(e) => e.stopPropagation()}>
              Cancel
            </Button>
          </Popconfirm>
        )}
        {columnStatus === 'pending_confirm' && (
          <>
            <Button size="small" onClick={(e) => { e.stopPropagation(); onCancel?.(session, parent) }} danger>
              Cancel
            </Button>
            <Button size="small" type="primary" onClick={(e) => { e.stopPropagation(); onConfirm?.(session, parent) }}>
              Open
            </Button>
          </>
        )}
        {columnStatus === 'idle' && (
          <Button size="small" onClick={(e) => { e.stopPropagation(); onClose?.(session, parent) }}>
            × Close
          </Button>
        )}
        {/* Re-open 按钮已删除 —— 直接点卡片任意位置即可回到 AI 看板（reopen 语义）*/}
      </div>
    </article>
  )
}
