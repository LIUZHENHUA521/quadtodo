import React, { useMemo } from 'react'
import { Button, Popconfirm } from 'antd'
import { Bot } from 'lucide-react'
import dayjs from 'dayjs'
import { useTranslation } from 'react-i18next'
import type { AiSession, Todo, AiTool, PromptTemplate } from '../../api'

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
  /** 用作 session.agentName 缺失（老会话）时的回退：从 parent.appliedTemplateIds[0] 反查 */
  agents?: PromptTemplate[]
  /** 当前 PTY 是否还活着（用于决定 Cancel/Close 行为） */
  live?: boolean
  /** 当前列对应的 status 类别 */
  columnStatus: 'running' | 'pending_confirm' | 'idle'
  /** FLIP 跨列动画注册 —— StatusBoard 传 `register(key, columnId, el)`，
   *  columnId 让 hook 区分"同列重渲（不动）"与"跨列搬家（FLIP）" */
  flipRegister?: (sessionId: string, columnId: string, el: HTMLElement | null) => void
  onOpen?: (s: AiSession, parent: Todo) => void
  onOpenParent?: (parent: Todo) => void
  onCancel?: (s: AiSession, parent: Todo) => void
  onConfirm?: (s: AiSession, parent: Todo) => void
  onClose?: (s: AiSession, parent: Todo) => void
  onReopen?: (s: AiSession, parent: Todo) => void
}

export function SessionCard({
  session, parent, agents, columnStatus, flipRegister,
  onOpen, onOpenParent, onCancel, onConfirm, onClose, onReopen,
}: SessionCardProps) {
  const { t } = useTranslation(['common', 'todo'])

  // session.agentName 是派活那一刻的快照，最权威；缺失时退回到 parent 当前绑定的 agent。
  const agentLabel = useMemo(() => {
    if (session.agentName) return session.agentName
    const fallbackId = (parent.appliedTemplateIds || [])[0]
    if (!fallbackId || !agents?.length) return null
    return agents.find(a => a.id === fallbackId)?.name || null
  }, [session.agentName, parent.appliedTemplateIds, agents])

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
    columnStatus === 'running' ? 'is-running' : '',
    columnStatus === 'pending_confirm' ? 'is-needs-input' : '',
    columnStatus === 'idle' ? 'is-idle' : '',
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
      ref={(el) => flipRegister?.(session.sessionId, columnStatus, el)}
    >
      {/* Parent 链接：点击不再拦截，让事件冒泡到 article 走 reopen 逻辑 */}
      <div className="session-card-parent" title={parent.title}>
        <span className="parent-title">{parent.title}</span>
      </div>

      {agentLabel && (() => {
        // 内置模板名形如 "全自动工程师（自动驾驶）" —— 主名 + 全角括号备注。
        // 主名加粗显示、备注弱化，避免在卡片里抢戏。
        const m = agentLabel.match(/^(.+?)（(.+?)）\s*$/)
        const mainName = m ? m[1] : agentLabel
        const subName = m ? m[2] : null
        return (
          <div className="session-card-agent" title={agentLabel}>
            <Bot size={11} aria-hidden />
            <span className="session-card-agent-name">{mainName}</span>
            {subName && <span className="session-card-agent-sub">{subName}</span>}
          </div>
        )
      })()}

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
        <span>· {t('todo:session.elapsedTotal', { ago: formatElapsed(session), defaultValue: 'Total {{ago}}' })}</span>
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
          <Button size="small" onClick={(e) => { e.stopPropagation(); onCancel?.(session, parent) }} danger>
            Cancel
          </Button>
        )}
        {/* "Open" 按钮已删除 —— 跟 idle / running 列对齐，点卡片本身就进 AI 看板 */}
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
