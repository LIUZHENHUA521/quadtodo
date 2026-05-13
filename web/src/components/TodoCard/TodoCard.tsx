import { useState } from 'react'
import { Button, Tooltip, Dropdown, Popconfirm, Tag, Input } from 'antd'
import {
  PlusOutlined,
  DeleteOutlined,
  ClockCircleOutlined,
  PlayCircleOutlined,
  CopyOutlined,
  CodeOutlined,
  EditOutlined,
  DownOutlined,
  RightOutlined,
} from '@ant-design/icons'
import { useSortable, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import dayjs from 'dayjs'
import type { Todo, AiTool } from '../../api'
import { useAppMessages } from '../../design/useAppMessages'
import { deriveAiState, AI_STATE_LABEL } from '../../design/aiPresentationState'
import { useAiSessionStore } from '../../store/aiSessionStore'
import { useUnreadStore, isSessionUnread } from '../../store/unreadStore'
import { useDispatchStore } from '../../store/dispatchStore'
import { ActivitySparkline } from '../ActivitySparkline'
import { currentStatusLabel, todoDndId } from '../../TodoManage'

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
  const sessionId = todo.aiSession?.sessionId
  const historySessions = todo.aiSessions || []
  const hasHistory = historySessions.length > 0
  const statusChip = currentStatusLabel(todo.status)

  const lastSeenMap = useUnreadStore(s => s.lastSeenAt)
  const liveSessionsMap = useAiSessionStore(s => s.sessions)

  const aiMenuItems = [
    { key: 'start:claude', label: '▶ 启动 Claude' },
    { key: 'start:codex', label: '▶ 启动 Codex' },
    { key: 'start:cursor', label: '▶ 启动 Cursor' },
  ]

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      className={cardClassName}
      id={`todo-card-${todo.id}`}
      data-todo-id={todo.id}
    >
      {todo.aiSession && (
        <span className="todo-card-focus-hint">⌘ to focus</span>
      )}
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
              <span className={`todo-status-chip ${statusChip.className}`}>{statusChip.text}</span>
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
                <ClockCircleOutlined style={{ marginRight: 4 }} />
                {formatDate(todo.dueDate)}
              </span>
            )}
            {hasHistory && (
              <span className="todo-meta-pill">
                会话 {historySessions.length}
              </span>
            )}
          </div>

          {todo.aiSession && (() => {
            // 三态严格定义：running / pending(待确认) / idle。详见
            // docs/superpowers/specs/2026-05-13-ai-state-3-state-strict-design.md
            const liveSession = liveSessionsMap.get(todo.aiSession.sessionId)
            const liveTurnDoneAt = liveSession?.lastTurnDoneAt ?? null
            const turnDoneAt = liveTurnDoneAt || todo.aiSession.lastTurnDoneAt || null
            const unread = isSessionUnread(turnDoneAt, lastSeenMap.get(todo.aiSession.sessionId))
            const state = deriveAiState(liveSession?.status, unread)
            return (
              <div className="todo-ai-status-row" onClick={(e) => e.stopPropagation()}>
                <span className="todo-ai-tag">{todo.aiSession.tool}</span>
                <span className={`todo-ai-state todo-ai-state-${state}`}>{AI_STATE_LABEL[state]}</span>
                <ActivitySparkline sessionId={todo.aiSession.sessionId} width={70} height={14} />
              </div>
            )
          })()}

          <div className="todo-card-toolbar" onClick={(e) => e.stopPropagation()}>
          <Tooltip title="复制标题和描述">
            <Button size="small" icon={<CopyOutlined />} onClick={() => onCopyPrompt(todo)} className="todo-primary-action" />
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
              <Button size="small" icon={<CodeOutlined />} className="todo-primary-action" />
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
            <Button size="small" icon={<PlayCircleOutlined />} className="todo-primary-action">AI 终端</Button>
          </Dropdown>
          {!isSubtodo && onCreateSubtodo && (
            <Tooltip title="添加子待办">
              <Button size="small" icon={<PlusOutlined />} onClick={() => onCreateSubtodo(todo)} className="todo-primary-action" />
            </Tooltip>
          )}
          <Popconfirm title="确认删除？" onConfirm={() => onDelete(todo)}>
            <Button size="small" danger icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()} className="todo-danger-action" />
          </Popconfirm>
          </div>
        </div>

        {hasHistory && (
          <div className="todo-history-box" onClick={(e) => e.stopPropagation()}>
            <div className="todo-history-title">历史会话 ({historySessions.length})</div>
            <div className="todo-history-list">
              {historySessions.map((session) => {
                const nativeSessionId = session.nativeSessionId || ''
                const baseResumeCommand = session.tool === 'codex'
                  ? `codex resume ${nativeSessionId}`
                  : session.tool === 'cursor'
                    ? `cursor-agent --resume ${nativeSessionId}`
                    : `claude --resume ${nativeSessionId}`
                // resume 命令必须在原 cwd 下执行，否则 ~/.claude/projects/<encoded-cwd>/ 找不到 jsonl
                // 会立刻报 "No conversation found"。这里把 cd 拼进去，复制即可在任意终端运行。
                const sessionCwd = session.cwd || todo.workDir || ''
                const shellQuoted = sessionCwd
                  ? `'${sessionCwd.replace(/'/g, `'\\''`)}'`
                  : ''
                const terminalCommand = sessionCwd
                  ? `cd ${shellQuoted} && ${baseResumeCommand}`
                  : baseResumeCommand
                // 未读优先取 live session（in-memory，最新），其次 historical（持久化值）
                const liveTurnDoneAt = liveSessionsMap.get(session.sessionId)?.lastTurnDoneAt ?? null
                const turnDoneAt = liveTurnDoneAt || session.lastTurnDoneAt || null
                const sessionUnread = isSessionUnread(turnDoneAt, lastSeenMap.get(session.sessionId))
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
                    {sessionUnread && (
                      <Tooltip title="此 AI 会话有新回复未读">
                        <span
                          className="todo-history-dock-dot is-unread"
                          aria-label="此 AI 会话有新回复未读"
                        />
                      </Tooltip>
                    )}
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
                            <EditOutlined style={{ fontSize: 10 }} />
                          </button>
                        </div>
                      )}
                      <div className="todo-history-headline">
                        <span className="todo-history-tool">{toolDisplayName(session.tool)}</span>
                        <span className="todo-history-time">{formatSessionTime(session.startedAt || session.completedAt)}</span>
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
                    <div className="todo-history-actions">
                      {nativeSessionId && (
                        <>
                          <button
                            type="button"
                            className="todo-history-link"
                            onClick={(e) => {
                              e.stopPropagation()
                              navigator.clipboard?.writeText(terminalCommand).then(() => {
                                message.success('启动命令已复制')
                              }).catch(() => {
                                message.error('复制失败')
                              })
                            }}
                            title="复制启动命令"
                          >
                            <CopyOutlined />
                          </button>
                          <button
                            type="button"
                            className="todo-history-link"
                            onClick={(e) => {
                              e.stopPropagation()
                              onAiExec(todo, session.tool, session)
                            }}
                            title="恢复该会话（重新挂载到 AI 终端）"
                          >
                            恢复
                          </button>
                          {session.nativeSessionId ? (
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
                          ) : null}
                          <button
                            type="button"
                            className="todo-history-link"
                            onClick={(e) => {
                              e.stopPropagation()
                              onRequestFork(todo, session.sessionId)
                            }}
                            title="Fork：带摘要继续新对话"
                          >
                            Fork
                          </button>
                        </>
                      )}
                      <Popconfirm
                        title="删除这条历史会话？"
                        description="只删除 AgentQuad 中的记录，不影响 Claude/Codex 本地会话。"
                        onConfirm={() => onDeleteAiSession(todo, session, sessionId)}
                      >
                        <button
                          type="button"
                          className="todo-history-delete"
                          onClick={(e) => e.stopPropagation()}
                        >
                          删除
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
              {childrenExpanded ? <DownOutlined /> : <RightOutlined />}
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
