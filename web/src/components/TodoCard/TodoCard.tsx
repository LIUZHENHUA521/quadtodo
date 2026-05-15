import { useState } from 'react'
import { Button, Tooltip, Dropdown, Popconfirm, Tag, Input } from 'antd'
import { Plus, Trash2, Clock, Play, Code, Pencil, ChevronDown, ChevronRight, CornerDownLeft, AlertTriangle } from 'lucide-react'
import { useSortable, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import dayjs from 'dayjs'
import { useTranslation } from 'react-i18next'
import { updateTodo, type Todo, type AiTool, type StageTag, type LiveSession } from '../../api'
import { StageTagChip } from '../StageTagChip'
import { AgentIcon } from '../AgentIcon'
import { useAppMessages } from '../../design/useAppMessages'
import { deriveAiState, AI_STATE_LABEL_KEY, AI_STATE_ICON, isClosedAiStatus } from '../../design/aiPresentationState'
import { useAiSessionStore } from '../../store/aiSessionStore'
import { useUnreadStore, isSessionUnread } from '../../store/unreadStore'
import { useDispatchStore } from '../../store/dispatchStore'
import { useFocusStore } from '../../store/focusStore'
import { todoDndId } from '../../TodoManage'
import { formatRelativeShort } from '../../utils/time'

function formatDate(ts: number | null) {
  if (!ts) return ''
  return dayjs(ts).format('MM-DD HH:mm')
}

function isOverdue(dueDate: number | null) {
  return dueDate ? dueDate < Date.now() : false
}

function formatSessionTime(ts?: number | null) {
  if (!ts) return ''
  return dayjs(ts).format('MM/DD HH:mm')
}

function toolDisplayName(tool: AiTool) {
  if (tool === 'claude') return 'Claude Code'
  if (tool === 'codex') return 'Codex'
  if (tool === 'cursor') return 'Cursor'
  return tool
}

export interface SortableTodoCardProps {
  todo: Todo
  children?: Todo[]
  childHitIds?: Set<string>
  isSubtodo?: boolean
  onCreateSubtodo?: (todo: Todo) => void
  onClick: (t: Todo) => void
  onToggleDone: (t: Todo) => void
  onAiExec: (todo: Todo, tool: AiTool, session?: Todo['aiSessions'][number]) => void
  onDeleteAiSession: (todo: Todo, session: Todo['aiSessions'][number], currentSessionId?: string | null) => void
  onUpdateSessionLabel: (todo: Todo, session: Todo['aiSessions'][number], label: string) => void
  onDelete: (t: Todo) => void
  onOpenTrae: (todo: Todo, editor?: 'trae-cn' | 'trae' | 'cursor') => void
  onOpenTerminal: (todo: Todo) => void
  onOpenNativeResume: (todo: Todo, session: Todo['aiSessions'][number]) => void
  onExport: (todo: Todo) => void
  isNarrow: boolean
  onRequestFork: (todo: Todo, sessionId: string) => void
  onRefresh: () => void
  highlightTodoId?: string | null
}

// AI session 的"已结束"状态——只在这些状态下显示"未正常结束"标签，
// 避免 running / pending_confirm 期间因为 nativeId 还没到位而误报。
const TERMINAL_AI_STATUSES = new Set<string>(['done', 'failed', 'stopped'])

export function SortableTodoCard({ todo, children = [], childHitIds, isSubtodo = false, onCreateSubtodo, onClick, onToggleDone, onAiExec, onDeleteAiSession, onUpdateSessionLabel, onDelete, onOpenTrae, onOpenTerminal, onOpenNativeResume, onExport, isNarrow, onRequestFork, onRefresh, highlightTodoId }: SortableTodoCardProps) {
  const { message } = useAppMessages()
  const { t } = useTranslation(['todo', 'errors', 'session'])
  const [editingLabelSessionId, setEditingLabelSessionId] = useState<string | null>(null)
  const [editingLabelText, setEditingLabelText] = useState('')
  const [childrenExpanded, setChildrenExpanded] = useState(true)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: todoDndId(todo) })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }
  const hasChildren = children.length > 0
  const showChildren = hasChildren && (childrenExpanded || (!!childHitIds && childHitIds.size > 0))
  const cardClassName = `todo-card quadrant-${todo.quadrant} ${isDragging ? 'dragging' : ''} ${todo.status === 'done' ? 'done' : ''} ${isSubtodo ? 'subtodo-card' : ''} ${highlightTodoId === todo.id ? 'attention-target-highlight' : ''}`
  const historySessions = todo.aiSessions || []
  const hasHistory = historySessions.length > 0

  const lastSeenMap = useUnreadStore(s => s.lastSeenAt)
  const liveSessionsMap = useAiSessionStore(s => s.sessions)

  const aiMenuItems = [
    { key: 'start:claude', icon: <AgentIcon tool="claude" />, label: t('todo:card.startClaude') },
    { key: 'start:codex', icon: <AgentIcon tool="codex" />, label: t('todo:card.startCodex') },
    { key: 'start:cursor', icon: <AgentIcon tool="cursor" />, label: t('todo:card.startCursor') },
  ]

  const handleStageTagChange = async (next: StageTag | null) => {
    try {
      await updateTodo(todo.id, { stageTag: next })
      onRefresh()
    } catch (e: any) {
      message.error(e?.message || t('errors:stageTagUpdateFailed'))
    }
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      className={cardClassName}
      id={`todo-card-${todo.id}`}
      data-todo-id={todo.id}
    >
      <div className="todo-card-shell">
        <div
          {...listeners}
          className="todo-card-head"
          onClick={(e) => {
            e.stopPropagation()
            // 点卡片只开 detail drawer。要进 Focus Mode 走 ⌘K → "Focus session"。
            onClick(todo)
          }}
        >
          <input
            type="checkbox"
            checked={todo.status === 'done'}
            onClick={(e) => e.stopPropagation()}
            onChange={() => onToggleDone(todo)}
            className="todo-card-checkbox"
          />
          <div className="todo-card-main">
            <div className="todo-card-title-row">
              <div className="todo-card-title" title={todo.title}>{todo.title}</div>
              <StageTagChip value={todo.stageTag} onChange={handleStageTagChange} />
            </div>
          </div>
        </div>

        <div className="todo-card-footer">
          <div className="todo-card-meta">
            {todo.brainstorm && (
              <span className="todo-meta-pill" style={{ background: 'color-mix(in srgb, var(--ai-pending-confirm) 12%, var(--surface-1))', color: 'var(--ai-pending-confirm)', border: '1px solid color-mix(in srgb, var(--ai-pending-confirm) 40%, var(--surface-1))' }}>
                {t('todo:card.brainstorm')}
              </span>
            )}
            {todo.workDir && (
              <span className="todo-meta-pill" title={todo.workDir}>
                {t('todo:card.workDirLabel', { name: todo.workDir.split('/').filter(Boolean).slice(-1)[0] || todo.workDir })}
              </span>
            )}
            {todo.dueDate && (
              <span className={`todo-meta-pill ${isOverdue(todo.dueDate) && todo.status !== 'done' ? 'overdue' : ''}`}>
                <Clock size={11} style={{ marginRight: 4 }} />
                {formatDate(todo.dueDate)}
              </span>
            )}
            {hasHistory && (
              <span className="todo-meta-pill">
                {t('todo:card.sessionCount', { count: historySessions.length })}
              </span>
            )}
          </div>

          <div className="todo-card-toolbar" onClick={(e) => e.stopPropagation()}>
          <Dropdown
            menu={{
              items: [
                { key: 'trae-cn', label: 'Trae CN' },
                { key: 'trae', label: 'Trae' },
                { key: 'cursor', label: 'Cursor' },
              ],
              onClick: ({ key }) => onOpenTrae(todo, key as 'trae-cn' | 'trae' | 'cursor'),
            }}
            trigger={['click']}
          >
            <Tooltip title={t('todo:card.openEditorTooltip')}>
              <Button size="small" icon={<Code size={13} />} className="todo-primary-action" />
            </Tooltip>
          </Dropdown>
          <Dropdown
            menu={{
              items: aiMenuItems,
              onClick: ({ key }) => {
                const [action, value] = key.split(':')
                if (action === 'start') {
                  onAiExec(todo, value as AiTool)
                }
              },
            }}
            trigger={['click']}
          >
            <Button size="small" icon={<Play size={13} />} className="todo-primary-action">{t('todo:card.aiTerminal')}</Button>
          </Dropdown>
          {!isSubtodo && onCreateSubtodo && (
            <Tooltip title={t('todo:card.addSubtodo')}>
              <Button size="small" icon={<Plus size={13} />} onClick={() => onCreateSubtodo(todo)} className="todo-primary-action" />
            </Tooltip>
          )}
          <Popconfirm
            title={t('todo:card.deleteConfirm')}
            okButtonProps={{ danger: true }}
            onConfirm={() => onDelete(todo)}
          >
            <Button size="small" icon={<Trash2 size={13} />} onClick={(e) => e.stopPropagation()} className="todo-danger-action" aria-label={t('todo:card.deleteConfirm')} />
          </Popconfirm>
          </div>
        </div>

        {hasHistory && (
          <div className="todo-history-box" onClick={(e) => e.stopPropagation()}>
            <div className="todo-history-list">
              {historySessions.map((session) => {
                const nativeSessionId = session.nativeSessionId || ''
                const sessionCwd = session.cwd || todo.workDir || ''
                const liveSession = liveSessionsMap.get(session.sessionId)
                // 未读优先取 live session（in-memory，最新），其次 historical（持久化值）
                const liveTurnDoneAt = liveSession?.lastTurnDoneAt ?? null
                const turnDoneAt = liveTurnDoneAt || session.lastTurnDoneAt || null
                const sessionUnread = isSessionUnread(turnDoneAt, lastSeenMap.get(session.sessionId))
                // 历史条目内的 AI 三态徽标（running / pending / idle，详见
                // docs/superpowers/specs/2026-05-13-ai-state-3-state-strict-design.md）。
                // idle 仅在 liveSession 存在时渲染——与顶栏 idle pill 的计数口径保持一致：
                // 顶栏数它则卡片显示它，反之亦然（避免给所有终态历史会话堆视觉噪音）。
                // 优先吃 effectiveStatus：后端兜底"PTY 还在喷但 hook/watcher 误判 idle"的边界。
                const sessionState = deriveAiState(
                  liveSession?.effectiveStatus ?? liveSession?.status ?? session.status,
                  sessionUnread,
                  liveSession?.awaitingReply ?? false,
                )
                // PTY 已死的会话（done/failed/stopped）一律不渲染状态徽章 + LiveInfoBadge：
                // 卡片回归普通 todo 外观，避免被误认为"空闲可发"。详情页负责提供 Resume 入口。
                const sessionClosed = isClosedAiStatus(liveSession?.effectiveStatus ?? liveSession?.status ?? session.status)
                return (
                  <button
                    key={session.sessionId}
                    type="button"
                    className="todo-history-item"
                    onClick={() => {
                      // 如果用户正在拖蓝选中里面的 session id / 命令文字，就别触发展开
                      if (typeof window !== 'undefined' && window.getSelection()?.toString()) return
                      useDispatchStore.getState().openFocus(todo.id, session.sessionId)
                    }}
                  >
                    <div className="todo-history-body">
                      <div className="todo-history-headline">
                        {editingLabelSessionId === session.sessionId ? (
                          <Input
                            size="small"
                            value={editingLabelText}
                            onChange={(e) => setEditingLabelText(e.target.value)}
                            onPressEnter={() => {
                              onUpdateSessionLabel(todo, session, editingLabelText)
                              setEditingLabelSessionId(null)
                            }}
                            onBlur={() => {
                              onUpdateSessionLabel(todo, session, editingLabelText)
                              setEditingLabelSessionId(null)
                            }}
                            onClick={(e) => e.stopPropagation()}
                            placeholder={t('todo:card.sessionLabelPlaceholder')}
                            autoFocus
                            style={{ width: 160, height: 22, fontSize: 11 }}
                          />
                        ) : session.label ? (
                          <Tag
                            className="todo-history-label"
                            onClick={(e) => {
                              e.stopPropagation()
                              setEditingLabelSessionId(session.sessionId)
                              setEditingLabelText(session.label || '')
                            }}
                            title={t('todo:card.editLabelTooltip')}
                            style={{ cursor: 'pointer', margin: 0, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          >
                            {session.label}
                          </Tag>
                        ) : (
                          <Tag
                            className="todo-history-label-empty"
                            onClick={(e) => {
                              e.stopPropagation()
                              setEditingLabelSessionId(session.sessionId)
                              setEditingLabelText('')
                            }}
                            title={t('todo:card.editLabelTooltip')}
                            style={{ cursor: 'pointer', margin: 0, borderStyle: 'dashed', display: 'inline-flex', alignItems: 'center' }}
                          >
                            <Pencil size={10} />
                          </Tag>
                        )}
                        <span className="todo-history-tool">
                          <AgentIcon tool={session.tool} />
                          {toolDisplayName(session.tool)}
                        </span>
                        <span className="todo-history-time">{formatSessionTime(session.startedAt || session.completedAt)}</span>
                        {!sessionClosed && (sessionState !== 'idle' || liveSession) && (
                          <span className={`todo-ai-state todo-ai-state-${sessionState}`}>{AI_STATE_ICON[sessionState]()}{' '}{t(AI_STATE_LABEL_KEY[sessionState])}</span>
                        )}
                        {!sessionClosed && liveSession && (sessionState === 'running' || sessionState === 'pending' || sessionState === 'idle') && (
                          <LiveInfoBadge
                            state={sessionState}
                            liveSession={liveSession}
                            onOpenFocus={() => useDispatchStore.getState().openFocus(todo.id, session.sessionId)}
                          />
                        )}
                        {session.localResume?.openedAt && (
                          <span
                            className="todo-history-resumed"
                            title={t('todo:card.localResumedTooltip', { time: dayjs(session.localResume.openedAt).format('YYYY-MM-DD HH:mm') })}
                          >
                            <CornerDownLeft size={10} />
                            {t('todo:card.localResumedShort', { time: dayjs(session.localResume.openedAt).format('HH:mm') })}
                          </span>
                        )}
                        {!nativeSessionId && TERMINAL_AI_STATUSES.has(String(session.status)) && (
                          <Tooltip title={t('todo:card.sessionNotFinishedTooltip')}>
                            <Tag color="warning" style={{ marginLeft: 6 }}>{t('todo:card.sessionNotFinished')}</Tag>
                          </Tooltip>
                        )}
                        {nativeSessionId && !sessionCwd && (
                          <Tooltip title={t('todo:card.missingCwdTooltip')}>
                            <Tag color="warning" style={{ marginLeft: 6 }}>{t('todo:card.missingCwd')}</Tag>
                          </Tooltip>
                        )}
                      </div>
                    </div>
                    <div
                      className="todo-history-actions"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {nativeSessionId && (
                        <button
                          type="button"
                          className="todo-history-link"
                          onClick={(e) => {
                            e.stopPropagation()
                            onOpenNativeResume(todo, session)
                          }}
                          title={t('todo:card.localResumeTooltip')}
                        >
                          {t('todo:card.localResume')}
                        </button>
                      )}
                      <Popconfirm
                        title={t('todo:card.deleteSessionConfirmTitle')}
                        description={t('todo:card.deleteSessionConfirmDesc')}
                        okText={t('todo:card.deleteSessionConfirmOk')}
                        cancelText={t('todo:card.deleteSessionConfirmCancel')}
                        okButtonProps={{ danger: true }}
                        onConfirm={() => onDeleteAiSession(todo, session, useFocusStore.getState().focusedSessionId)}
                      >
                        <button
                          type="button"
                          className="todo-history-delete"
                          onClick={(e) => e.stopPropagation()}
                          title={t('todo:card.deleteSessionTooltip')}
                          aria-label={t('todo:card.deleteSession')}
                          style={{ display: 'inline-flex', alignItems: 'center' }}
                        >
                          <Trash2 size={11} />
                        </button>
                      </Popconfirm>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {!isSubtodo && hasChildren && (
          <div className="subtodo-group" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="subtodo-group-toggle"
              onClick={() => setChildrenExpanded(v => !v)}
            >
              {childrenExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <span>{t('todo:card.subtodoCount', { count: children.length })}</span>
            </button>
            {showChildren && (
              <SortableContext items={children.map(child => todoDndId(child))} strategy={verticalListSortingStrategy}>
                <div className="subtodo-list">
                  {children.map(child => (
                    <SortableTodoCard
                      key={child.id}
                      todo={child}
                      isSubtodo
                      onClick={onClick}
                      onToggleDone={onToggleDone}
                      onAiExec={onAiExec}
                      onRequestFork={onRequestFork}
                      onDeleteAiSession={onDeleteAiSession}
                      onUpdateSessionLabel={onUpdateSessionLabel}
                      onDelete={onDelete}
                      onOpenTrae={onOpenTrae}
                      onOpenTerminal={onOpenTerminal}
                      onOpenNativeResume={onOpenNativeResume}
                      onExport={onExport}
                      isNarrow={isNarrow}
                      onRefresh={onRefresh}
                      highlightTodoId={highlightTodoId}
                    />
                  ))}
                </div>
              </SortableContext>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function truncatePromptText(text: string): string {
  const firstLine = (text.split('\n')[0] || '').trim()
  if (!firstLine) return ''
  const chars = Array.from(firstLine)
  if (chars.length <= 40) return firstLine
  return chars.slice(0, 40).join('') + '…'
}

function LiveInfoBadge({
  state,
  liveSession,
  onOpenFocus,
}: {
  state: 'running' | 'pending' | 'idle'
  liveSession: LiveSession
  onOpenFocus: () => void
}) {
  const { t } = useTranslation(['todo'])
  if (state === 'running') {
    const lastOutputAt = liveSession.lastOutputAt
    return (
      <span className="todo-history-live todo-history-live--running" onClick={(e) => e.stopPropagation()}>
        <span className="todo-history-pulse-dot" aria-hidden />
        {lastOutputAt ? (
          <span className="todo-history-live-text">
            {t('todo:card.liveActive', { ago: formatRelativeShort(Date.now() - lastOutputAt) })}
          </span>
        ) : null}
      </span>
    )
  }
  if (state === 'pending') {
    const prompt = liveSession.permissionPrompt
    const promptText = prompt?.text ? truncatePromptText(prompt.text) : ''
    const waitingAgo = prompt?.createdAt
      ? formatRelativeShort(Date.now() - prompt.createdAt)
      : null
    return (
      <button
        type="button"
        className="todo-history-live todo-history-live--pending"
        onClick={(e) => {
          e.stopPropagation()
          onOpenFocus()
        }}
        title={prompt?.text || ''}
      >
        <AlertTriangle size={12} aria-hidden />
        {promptText ? <span className="todo-history-live-text">{promptText}</span> : null}
        {waitingAgo ? <span className="todo-history-live-meta">{t('todo:card.liveWaiting', { ago: waitingAgo })}</span> : null}
      </button>
    )
  }
  const refTs = liveSession.lastTurnDoneAt || liveSession.startedAt
  if (!refTs) return null
  return (
    <span className="todo-history-live todo-history-live--idle" onClick={(e) => e.stopPropagation()}>
      <span className="todo-history-live-text">
        {t('todo:card.liveLastActive', { ago: formatRelativeShort(Date.now() - refTs) })}
      </span>
    </span>
  )
}
