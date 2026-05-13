import { useState } from 'react'
import { Button, Tooltip, Dropdown, Popconfirm, Tag, Input } from 'antd'
import { Plus, Trash2, Clock, Play, Copy, Code, Pencil, ChevronDown, ChevronRight } from 'lucide-react'
import { useSortable, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import dayjs from 'dayjs'
import { updateTodo, type Todo, type AiTool, type StageTag } from '../../api'
import { StageTagChip } from '../StageTagChip'
import { useAppMessages } from '../../design/useAppMessages'
import { deriveAiState, AI_STATE_LABEL, AI_STATE_ICON } from '../../design/aiPresentationState'
import { useAiSessionStore } from '../../store/aiSessionStore'
import { useUnreadStore, isSessionUnread } from '../../store/unreadStore'
import { useDispatchStore } from '../../store/dispatchStore'
import { todoDndId } from '../../TodoManage'

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
  onCopyPrompt: (todo: Todo) => void
  onExport: (todo: Todo) => void
  isNarrow: boolean
  onRequestFork: (todo: Todo, sessionId: string) => void
  onRefresh: () => void
  highlightTodoId?: string | null
}

// AI session 的"已结束"状态——只在这些状态下显示"未正常结束"标签，
// 避免 running / pending_confirm 期间因为 nativeId 还没到位而误报。
const TERMINAL_AI_STATUSES = new Set<string>(['done', 'failed', 'stopped'])

export function SortableTodoCard({ todo, children = [], childHitIds, isSubtodo = false, onCreateSubtodo, onClick, onToggleDone, onAiExec, onDeleteAiSession, onUpdateSessionLabel, onDelete, onOpenTrae, onOpenTerminal, onOpenNativeResume, onCopyPrompt, onExport, isNarrow, onRequestFork, onRefresh, highlightTodoId }: SortableTodoCardProps) {
  const { message } = useAppMessages()
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
    { key: 'start:claude', label: '▶ 启动 Claude' },
    { key: 'start:codex', label: '▶ 启动 Codex' },
    { key: 'start:cursor', label: '▶ 启动 Cursor' },
  ]

  const handleStageTagChange = async (next: StageTag | null) => {
    try {
      await updateTodo(todo.id, { stageTag: next })
      onRefresh()
    } catch (e: any) {
      message.error(e?.message || '阶段标签更新失败')
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
              <div className="todo-card-title">{todo.title}</div>
              <StageTagChip value={todo.stageTag} onChange={handleStageTagChange} />
            </div>
          </div>
        </div>

        <div className="todo-card-footer">
          <div className="todo-card-meta">
            {todo.brainstorm && (
              <span className="todo-meta-pill" style={{ background: 'color-mix(in srgb, var(--ai-pending-confirm) 12%, var(--surface-1))', color: 'var(--ai-pending-confirm)', border: '1px solid color-mix(in srgb, var(--ai-pending-confirm) 40%, var(--surface-1))' }}>
                脑爆
              </span>
            )}
            {todo.workDir && (
              <span className="todo-meta-pill" title={todo.workDir}>
                目录 · {todo.workDir.split('/').filter(Boolean).slice(-1)[0] || todo.workDir}
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
                会话 {historySessions.length}
              </span>
            )}
          </div>

          <div className="todo-card-toolbar" onClick={(e) => e.stopPropagation()}>
          <Tooltip title="复制标题和描述">
            <Button size="small" icon={<Copy size={13} />} onClick={() => onCopyPrompt(todo)} className="todo-primary-action" />
          </Tooltip>
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
            <Tooltip title="选择编辑器打开">
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
            <Button size="small" icon={<Play size={13} />} className="todo-primary-action">AI 终端</Button>
          </Dropdown>
          {!isSubtodo && onCreateSubtodo && (
            <Tooltip title="添加子待办">
              <Button size="small" icon={<Plus size={13} />} onClick={() => onCreateSubtodo(todo)} className="todo-primary-action" />
            </Tooltip>
          )}
          <Popconfirm title="确认删除？" onConfirm={() => onDelete(todo)}>
            <Button size="small" danger icon={<Trash2 size={13} />} onClick={(e) => e.stopPropagation()} className="todo-danger-action" />
          </Popconfirm>
          </div>
        </div>

        {hasHistory && (
          <div className="todo-history-box" onClick={(e) => e.stopPropagation()}>
            <div className="todo-history-title">历史会话 ({historySessions.length})</div>
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
                // idle（已结束 / 沉默中）不渲染徽标，避免给所有终态会话堆视觉噪音。
                const sessionState = deriveAiState(
                  liveSession?.status ?? session.status,
                  sessionUnread,
                  liveSession?.awaitingReply ?? false,
                )
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
                      {editingLabelSessionId === session.sessionId ? (
                        <div style={{ display: 'flex', gap: 4, marginBottom: 4 }} onClick={(e) => e.stopPropagation()}>
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
                            placeholder="输入会话标题..."
                            autoFocus
                            style={{ flex: 1, fontSize: 11 }}
                          />
                        </div>
                      ) : (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: session.label ? 2 : 0 }}>
                          {session.label && (
                            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={session.label}>
                              {session.label}
                            </span>
                          )}
                          <button
                            type="button"
                            className="todo-history-link"
                            onClick={(e) => {
                              e.stopPropagation()
                              setEditingLabelSessionId(session.sessionId)
                              setEditingLabelText(session.label || '')
                            }}
                            title="编辑标题"
                            style={{ flexShrink: 0 }}
                          >
                            <Pencil size={10} />
                          </button>
                        </div>
                      )}
                      <div className="todo-history-headline">
                        <span className="todo-history-tool">{toolDisplayName(session.tool)}</span>
                        <span className="todo-history-time">{formatSessionTime(session.startedAt || session.completedAt)}</span>
                        {sessionState !== 'idle' && (
                          <span className={`todo-ai-state todo-ai-state-${sessionState}`}>{AI_STATE_ICON[sessionState]()}{' '}{AI_STATE_LABEL[sessionState]}</span>
                        )}
                        {!nativeSessionId && TERMINAL_AI_STATUSES.has(String(session.status)) && (
                          <Tooltip title="该会话未正常结束，没有拿到原生 session ID，无法 resume/fork。请在 AI 完成后在终端里按 Ctrl+D 或 /exit 正常退出。">
                            <Tag color="warning" style={{ marginLeft: 6 }}>未正常结束</Tag>
                          </Tooltip>
                        )}
                        {nativeSessionId && !sessionCwd && (
                          <Tooltip title="找不到此会话的原始 cwd，命令必须在创建该会话时所处的项目目录下执行，否则会报 'No conversation found'。">
                            <Tag color="warning" style={{ marginLeft: 6 }}>缺少 cwd</Tag>
                          </Tooltip>
                        )}
                      </div>
                      {session.localResume?.openedAt && (
                        <div style={{ marginTop: 4 }}>
                          <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                            已本地继续 · {dayjs(session.localResume.openedAt).format('HH:mm')}
                          </Tag>
                        </div>
                      )}
                    </div>
                    {nativeSessionId && (
                      <div className="todo-history-actions">
                        <button
                          type="button"
                          className="todo-history-link"
                          onClick={(e) => {
                            e.stopPropagation()
                            onOpenNativeResume(todo, session)
                          }}
                          title="在本地 Terminal 中 resume 当前 AI 会话"
                        >
                          本地继续
                        </button>
                      </div>
                    )}
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
              <span>子待办 {children.length}</span>
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
                      onCopyPrompt={onCopyPrompt}
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
