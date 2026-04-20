import React, { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Button, Space, Tag, Drawer, Form, Input, DatePicker,
  Radio, message, Popconfirm, Spin, Tooltip, Dropdown, Select, Switch, Segmented, Modal,
} from 'antd'
import {
  PlusOutlined,
  DeleteOutlined, CheckOutlined,
  ClockCircleOutlined, SearchOutlined,
  PlayCircleOutlined, SettingOutlined, CopyOutlined,
  CodeOutlined, DesktopOutlined, SendOutlined, EditOutlined,
  DownOutlined, UpOutlined, CloseOutlined, RightOutlined,
  DashboardOutlined, FileTextOutlined, ExportOutlined,
} from '@ant-design/icons'
import {
  DndContext, closestCenter, PointerSensor, TouchSensor,
  useSensor, useSensors, DragOverlay, DragStartEvent,
  DragEndEvent, useDroppable,
} from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import dayjs from 'dayjs'
import {
  listTodos, createTodo, updateTodo, deleteTodo,
  startAiExec, getWorkDirOptions, pickDirectory, deleteTodoAiSession,
  openTraeCN, openTerminal, updateSessionLabel,
  listComments, addComment, deleteComment,
  listLiveSessions, stopAiExec,
  listTemplates, PromptTemplate,
  createRecurringRule, getRecurringRule, updateRecurringRule, deactivateRecurringRule,
  RecurringFrequency, RecurringRule,
  Todo, Quadrant, AiTool, Comment,
} from './api'
import { renderAppliedTemplates } from './promptRender'
import SessionViewer from './SessionViewer'
import SettingsDrawer from './SettingsDrawer'
import StatsDrawer from './StatsDrawer'
import WikiDrawer from './WikiDrawer'
import ExportDialog from './ExportDialog'
import TemplateDrawer from './TemplateDrawer'
import ForkDialog from './ForkDialog'
import DashboardDrawer from './dashboard/DashboardDrawer'
import PetView from './pet/PetView'
import TranscriptSearchDrawer from './transcripts/TranscriptSearchDrawer'
import { useAiSessionStore } from './store/aiSessionStore'
import { getTranscriptStats } from './api'
import './TodoManage.css'

const { TextArea } = Input

// ─── 常量 ───

const QUADRANT_CONFIG = [
  { q: 1 as Quadrant, label: '重要且紧急', priority: 'P0', color: '#ff4d4f', bgBadge: 'count-badge-1' },
  { q: 2 as Quadrant, label: '重要不紧急', priority: 'P1', color: '#faad14', bgBadge: 'count-badge-2' },
  { q: 3 as Quadrant, label: '紧急不重要', priority: 'P2', color: '#1677ff', bgBadge: 'count-badge-3' },
  { q: 4 as Quadrant, label: '不重要不紧急', priority: 'P3', color: '#52c41a', bgBadge: 'count-badge-4' },
]

function formatDate(ts: number | null) {
  if (!ts) return ''
  return dayjs(ts).format('MM-DD HH:mm')
}

function isOverdue(dueDate: number | null) {
  return dueDate ? dueDate < Date.now() : false
}

function shortSessionId(id?: string | null) {
  if (!id) return ''
  return id.length > 12 ? id.slice(0, 12) : id
}

function formatSessionTime(ts?: number | null) {
  if (!ts) return ''
  return dayjs(ts).format('MM/DD HH:mm')
}

function toolDisplayName(tool: AiTool) {
  return tool === 'claude' ? 'Claude Code' : 'Codex'
}

function buildTodoPrompt(todo: Todo, templates: PromptTemplate[] = []) {
  const templatePrefix = renderAppliedTemplates(todo, templates)
  const base = `请完成以下待办任务:

标题: ${todo.title}
描述: ${todo.description || '无'}

请先理解需求和当前项目上下文，再开始执行。
完成后请给出变更摘要、验证结果，以及仍需我确认的事项。`
  return templatePrefix ? `${templatePrefix}\n\n---\n\n${base}` : base
}

function currentStatusLabel(status: Todo['status']) {
  if (status === 'ai_running') return { text: '运行中', className: 'status-chip-running' }
  if (status === 'ai_pending') return { text: '待交互', className: 'status-chip-pending' }
  if (status === 'ai_done') return { text: '待验收', className: 'status-chip-done' }
  if (status === 'done') return { text: '已完成', className: 'status-chip-complete' }
  return { text: '待办', className: 'status-chip-idle' }
}

function todoDndId(todo: Todo) {
  return todo.parentId ? `subtodo:${todo.id}` : todo.id
}

function parseTodoDndId(id: string) {
  if (id.startsWith('subtodo:')) {
    return { todoId: id.slice('subtodo:'.length), kind: 'subtodo' as const }
  }
  return { todoId: id, kind: 'todo' as const }
}

// ─── 可拖拽任务卡片 ───

interface SortableTodoCardProps {
  todo: Todo
  children?: Todo[]
  childHitIds?: Set<string>
  isSubtodo?: boolean
  onCreateSubtodo?: (todo: Todo) => void
  onClick: (t: Todo) => void
  onToggleDone: (t: Todo) => void
  onAiExec: (todo: Todo, tool: AiTool, session?: Todo['aiSessions'][number]) => void
  onAiExecBoth: (todo: Todo) => void
  onDeleteAiSession: (todo: Todo, session: Todo['aiSessions'][number], currentSessionId?: string | null) => void
  onUpdateSessionLabel: (todo: Todo, session: Todo['aiSessions'][number], label: string) => void
  onDelete: (t: Todo) => void
  onOpenTrae: (todo: Todo, editor?: 'trae-cn' | 'trae' | 'cursor') => void
  onOpenTerminal: (todo: Todo) => void
  onCopyPrompt: (todo: Todo) => void
  onExport: (todo: Todo) => void
  expandedTerminal: { todoId: string; sessionId: string } | null
  setExpandedTerminal: (v: { todoId: string; sessionId: string } | null) => void
  hiddenTerminalSessionId?: string | null
  hiddenTerminalSessionIdByTodo?: Record<string, string | null>
  onHideTerminal: (todoId: string, sessionId: string) => void
  onShowTerminal: (todoId: string) => void
  terminalCollapsed: boolean
  collapsedTerminalByTodo?: Record<string, boolean>
  onToggleTerminalCollapsed: (todoId: string) => void
  sideBySideSessionId: string | null
  sideBySideByTodo?: Record<string, string | null>
  onSetSideBySide: (todoId: string, secondSessionId: string | null) => void
  isNarrow: boolean
  onRequestFork: (todo: Todo, sessionId: string) => void
  onRefresh: () => void
}

function SortableTodoCard({ todo, children = [], childHitIds, isSubtodo = false, onCreateSubtodo, onClick, onToggleDone, onAiExec, onAiExecBoth, onDeleteAiSession, onUpdateSessionLabel, onDelete, onOpenTrae, onOpenTerminal, onCopyPrompt, onExport, expandedTerminal, setExpandedTerminal, hiddenTerminalSessionId, hiddenTerminalSessionIdByTodo, onHideTerminal, onShowTerminal, terminalCollapsed, collapsedTerminalByTodo, onToggleTerminalCollapsed, sideBySideSessionId, sideBySideByTodo, onSetSideBySide, isNarrow, onRequestFork, onRefresh }: SortableTodoCardProps) {
  const [editingLabelSessionId, setEditingLabelSessionId] = useState<string | null>(null)
  const [editingLabelText, setEditingLabelText] = useState('')
  const [childrenExpanded, setChildrenExpanded] = useState(true)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: todoDndId(todo) })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }
  const isAiActive = todo.status === 'ai_running' || todo.status === 'ai_pending'
  const terminalOpen = expandedTerminal?.todoId === todo.id
  const hasChildren = children.length > 0
  const showChildren = hasChildren && (childrenExpanded || (!!childHitIds && childHitIds.size > 0))
  const cardClassName = `todo-card quadrant-${todo.quadrant} ${isDragging ? 'dragging' : ''} ${todo.status === 'done' ? 'done' : ''} ${isSubtodo ? 'subtodo-card' : ''}`
  const sessionId = terminalOpen ? expandedTerminal!.sessionId : todo.aiSession?.sessionId
  const historySessions = todo.aiSessions || []
  const hasHistory = historySessions.length > 0
  const statusChip = currentStatusLabel(todo.status)
  const selectedSession = sessionId
    ? historySessions.find(item => item.sessionId === sessionId) || null
    : todo.aiSession || historySessions[0] || null
  const resumeTarget = (selectedSession?.nativeSessionId ? selectedSession : null)
    || historySessions.find(item => item.nativeSessionId) || null
  const terminalHidden = Boolean(sessionId && hiddenTerminalSessionId === sessionId)
  const aiMenuItems = [
    { key: 'start:claude', label: '▶ 启动 Claude' },
    { key: 'start:codex', label: '▶ 启动 Codex' },
    { key: 'start:both', label: '▶ 同时启动 Claude + Codex（并排）' },
  ]

  const { role: _r, tabIndex: _t, ...safeAttributes } = attributes as any
  const finalAttributes = terminalOpen ? safeAttributes : attributes

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...finalAttributes}
      tabIndex={terminalOpen ? -1 : undefined}
      className={cardClassName}
    >
      <div className="todo-card-shell">
        <div
          {...listeners}
          className="todo-card-head"
          onClick={(e) => { e.stopPropagation(); onClick(todo) }}
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
            <div className="todo-card-meta">
              {todo.brainstorm && (
                <span className="todo-meta-pill" style={{ background: '#fff7e6', color: '#d46b08', border: '1px solid #ffd591' }}>
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
          </div>
        </div>

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
          <Tooltip title="启动终端">
            <Button size="small" icon={<DesktopOutlined />} onClick={() => onOpenTerminal(todo)} className="todo-primary-action" />
          </Tooltip>
          <Dropdown
            menu={{
              items: aiMenuItems,
              onClick: ({ key }) => {
                const [action, value] = key.split(':')
                if (action === 'start') {
                  onShowTerminal(todo.id)
                  if (value === 'both') {
                    onAiExecBoth(todo)
                  } else {
                    onAiExec(todo, value as AiTool)
                  }
                  return
                }
                const target = historySessions.find(item => item.sessionId === value)
                if (!target) return
                if (action === 'open') {
                  onShowTerminal(todo.id)
                  setExpandedTerminal({ todoId: todo.id, sessionId: target.sessionId })
                  return
                }
                if (action === 'resume') {
                  onShowTerminal(todo.id)
                  onAiExec(todo, target.tool, target)
                }
              },
            }}
            trigger={['click']}
          >
            <Button size="small" icon={<PlayCircleOutlined />} className="todo-primary-action">AI 终端</Button>
          </Dropdown>
          {(todo.status === 'ai_running' || todo.status === 'ai_pending' || todo.status === 'ai_done') && (
            <Tag className="todo-toolbar-tag" color={todo.status === 'ai_pending' ? 'error' : todo.status === 'ai_done' ? 'warning' : 'processing'}>
              {todo.status === 'ai_pending' ? '待交互' : todo.status === 'ai_done' ? '待验收' : '运行中'}
            </Tag>
          )}
          {!isSubtodo && onCreateSubtodo && (
            <Tooltip title="添加子待办">
              <Button size="small" icon={<PlusOutlined />} onClick={() => onCreateSubtodo(todo)} className="todo-primary-action" />
            </Tooltip>
          )}
          <Tooltip title="导出 Markdown / 推送到飞书">
            <Button size="small" icon={<ExportOutlined />} onClick={() => onExport(todo)} className="todo-primary-action" />
          </Tooltip>
          <Popconfirm title="确认删除？" onConfirm={() => onDelete(todo)}>
            <Button size="small" danger icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()} className="todo-danger-action" />
          </Popconfirm>
        </div>

        {hasHistory && (
          <div className="todo-history-box" onClick={(e) => e.stopPropagation()}>
            <div className="todo-history-title">历史会话 ({historySessions.length})</div>
            <div className="todo-history-list">
              {historySessions.map((session) => {
                const isCurrent = session.sessionId === sessionId
                const nativeSessionId = session.nativeSessionId || ''
                const terminalCommand = session.tool === 'claude'
                  ? `claude --resume ${nativeSessionId}`
                  : `codex resume ${nativeSessionId}`
                return (
                  <button
                    key={session.sessionId}
                    type="button"
                    className={`todo-history-item ${isCurrent ? 'active' : ''}`}
                    onClick={() => {
                      onShowTerminal(todo.id)
                      setExpandedTerminal({ todoId: todo.id, sessionId: session.sessionId })
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
                            <span style={{ fontSize: 12, fontWeight: 600, color: '#333', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={session.label}>
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
                      </div>
                      <div className="todo-history-native-id" title={nativeSessionId || session.sessionId}>
                        session id: {nativeSessionId || session.sessionId}
                        {!nativeSessionId && (
                          <Tooltip title="该会话未正常结束，没有拿到原生 session ID，无法 resume/fork。请在 AI 完成后在终端里按 Ctrl+D 或 /exit 正常退出。">
                            <Tag color="warning" style={{ marginLeft: 6 }}>未正常结束</Tag>
                          </Tooltip>
                        )}
                      </div>
                      {nativeSessionId && (
                        <div className="todo-history-command" title={terminalCommand}>
                          {terminalCommand}
                        </div>
                      )}
                    </div>
                    <div className="todo-history-actions" onClick={(e) => e.stopPropagation()}>
                      {nativeSessionId && (
                        <>
                          <button
                            type="button"
                            className="todo-history-link"
                            onClick={() => navigator.clipboard?.writeText(nativeSessionId).then(() => {
                              message.success('session ID 已复制')
                            }).catch(() => {
                              message.error('复制失败')
                            })}
                            title="复制原生 session ID"
                          >
                            <CopyOutlined />
                          </button>
                          <button
                            type="button"
                            className="todo-history-link"
                            onClick={() => onAiExec(todo, session.tool, session)}
                          >
                            恢复
                          </button>
                          <button
                            type="button"
                            className="todo-history-link"
                            onClick={() => onRequestFork(todo, session.sessionId)}
                            title="Fork：带摘要继续新对话"
                          >
                            Fork
                          </button>
                          {!isNarrow && session.sessionId !== sessionId && (
                            <button
                              type="button"
                              className="todo-history-link"
                              onClick={() => {
                                onShowTerminal(todo.id)
                                onSetSideBySide(todo.id, session.sessionId)
                              }}
                              title="与当前会话并排显示"
                            >
                              并排
                            </button>
                          )}
                        </>
                      )}
                      <Popconfirm
                        title="删除这条历史会话？"
                        description="只删除 quadtodo 中的记录，不影响 Claude/Codex 本地会话。"
                        onConfirm={() => onDeleteAiSession(todo, session, sessionId)}
                      >
                        <button
                          type="button"
                          className="todo-history-delete"
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
                      onAiExecBoth={onAiExecBoth}
                      onDeleteAiSession={onDeleteAiSession}
                      onUpdateSessionLabel={onUpdateSessionLabel}
                      onDelete={onDelete}
                      onOpenTrae={onOpenTrae}
                      onOpenTerminal={onOpenTerminal}
                      onCopyPrompt={onCopyPrompt}
                      onExport={onExport}
                      expandedTerminal={expandedTerminal}
                      setExpandedTerminal={setExpandedTerminal}
                      hiddenTerminalSessionId={hiddenTerminalSessionIdByTodo?.[child.id] || null}
                      hiddenTerminalSessionIdByTodo={hiddenTerminalSessionIdByTodo}
                      onHideTerminal={onHideTerminal}
                      onShowTerminal={onShowTerminal}
                      terminalCollapsed={!!collapsedTerminalByTodo?.[child.id]}
                      collapsedTerminalByTodo={collapsedTerminalByTodo}
                      onToggleTerminalCollapsed={onToggleTerminalCollapsed}
                      sideBySideSessionId={sideBySideByTodo?.[child.id] || null}
                      sideBySideByTodo={sideBySideByTodo}
                      onSetSideBySide={onSetSideBySide}
                      isNarrow={isNarrow}
                      onRefresh={onRefresh}
                    />
                  ))}
                </div>
              </SortableContext>
            )}
          </div>
        )}
      </div>

      {/* 内嵌 AI 终端 */}
      {sessionId && !terminalHidden && (terminalOpen || isAiActive || todo.status === 'ai_done') && (
        <div
          className={`todo-terminal-panel ${terminalCollapsed ? 'collapsed' : ''}`}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          onKeyUp={(e) => e.stopPropagation()}
        >
          <div className="todo-terminal-collapse-bar">
            <span className="collapse-title">
              {terminalCollapsed ? <DownOutlined style={{ fontSize: 10 }} /> : <UpOutlined style={{ fontSize: 10 }} />}
              <span>AI 终端 · {selectedSession?.tool === 'codex' ? 'Codex' : 'Claude'}{selectedSession?.label ? ` · ${selectedSession.label}` : ''}</span>
            </span>
            <Space size={4}>
              {sideBySideSessionId && !isNarrow && (
                <Tooltip title="关闭并排视图">
                  <Button
                    size="small"
                    type="text"
                    onClick={() => onSetSideBySide(todo.id, null)}
                  >并排✕</Button>
                </Tooltip>
              )}
              <Tooltip title={terminalCollapsed ? '展开终端' : '折叠终端'}>
                <Button
                  size="small"
                  type="text"
                  icon={terminalCollapsed ? <DownOutlined /> : <UpOutlined />}
                  onClick={() => onToggleTerminalCollapsed(todo.id)}
                />
              </Tooltip>
              <Tooltip title="关闭终端">
                <Button
                  size="small"
                  type="text"
                  icon={<CloseOutlined />}
                  onClick={() => {
                    onHideTerminal(todo.id, sessionId!)
                    setExpandedTerminal(null)
                  }}
                />
              </Tooltip>
            </Space>
          </div>
          <div className={`todo-terminal-body ${sideBySideSessionId && !isNarrow ? 'side-by-side' : ''}`}>
          <SessionViewer
            sessionId={sessionId}
            todoId={todo.id}
            status={todo.status}
            cwd={todo.workDir || resumeTarget?.cwd || null}
            resumeTarget={resumeTarget ? {
              todoId: todo.id,
              tool: resumeTarget.tool,
              prompt: resumeTarget.prompt,
              cwd: resumeTarget.cwd || todo.workDir || undefined,
              nativeSessionId: resumeTarget.nativeSessionId!,
            } : null}
            onSessionRecovered={(nextSessionId) => {
              onShowTerminal(todo.id)
              setExpandedTerminal({ todoId: todo.id, sessionId: nextSessionId })
              onRefresh()
            }}
            onClose={() => {
              onHideTerminal(todo.id, sessionId)
              setExpandedTerminal(null)
            }}
            onDone={() => onRefresh()}
            onFork={() => onRequestFork(todo, sessionId)}
          />
          {sideBySideSessionId && !isNarrow && (() => {
            const rightSession = historySessions.find(s => s.sessionId === sideBySideSessionId)
            if (!rightSession) return null
            return (
              <SessionViewer
                sessionId={rightSession.sessionId}
                todoId={todo.id}
                status={todo.status}
                cwd={rightSession.cwd || todo.workDir || null}
                resumeTarget={rightSession.nativeSessionId ? {
                  todoId: todo.id,
                  tool: rightSession.tool,
                  prompt: rightSession.prompt,
                  cwd: rightSession.cwd || todo.workDir || undefined,
                  nativeSessionId: rightSession.nativeSessionId,
                } : null}
                onSessionRecovered={() => onRefresh()}
                onClose={() => onSetSideBySide(todo.id, null)}
                onDone={() => onRefresh()}
                onFork={() => onRequestFork(todo, rightSession.sessionId)}
              />
            )
          })()}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── 象限 Drop Zone ───

interface QuadrantZoneProps {
  config: typeof QUADRANT_CONFIG[0]
  todos: Todo[]
  childrenByParentId: Record<string, Todo[]>
  childHitIdsByParentId: Record<string, Set<string>>
  onCreateSubtodo: (todo: Todo) => void
  onCardClick: (t: Todo) => void
  onToggleDone: (t: Todo) => void
  onAiExec: (todo: Todo, tool: AiTool, session?: Todo['aiSessions'][number]) => void
  onAiExecBoth: (todo: Todo) => void
  onDeleteAiSession: (todo: Todo, session: Todo['aiSessions'][number], currentSessionId?: string | null) => void
  onUpdateSessionLabel: (todo: Todo, session: Todo['aiSessions'][number], label: string) => void
  onDelete: (t: Todo) => void
  onOpenTrae: (todo: Todo, editor?: 'trae-cn' | 'trae' | 'cursor') => void
  onOpenTerminal: (todo: Todo) => void
  onCopyPrompt: (todo: Todo) => void
  onExport: (todo: Todo) => void
  style?: React.CSSProperties
  expandedTerminal: { todoId: string; sessionId: string } | null
  setExpandedTerminal: (v: { todoId: string; sessionId: string } | null) => void
  hiddenTerminalSessionIdByTodo: Record<string, string | null>
  collapsedTerminalByTodo: Record<string, boolean>
  onToggleTerminalCollapsed: (todoId: string) => void
  sideBySideByTodo: Record<string, string | null>
  onSetSideBySide: (todoId: string, secondSessionId: string | null) => void
  isNarrow: boolean
  onHideTerminal: (todoId: string, sessionId: string) => void
  onShowTerminal: (todoId: string) => void
  onRequestFork: (todo: Todo, sessionId: string) => void
  onRefresh: () => void
}

function QuadrantZone({ config, todos, childrenByParentId, childHitIdsByParentId, onCreateSubtodo, onCardClick, onToggleDone, onAiExec, onAiExecBoth, onDeleteAiSession, onUpdateSessionLabel, onDelete, onOpenTrae, onOpenTerminal, onCopyPrompt, onExport, style, expandedTerminal, setExpandedTerminal, hiddenTerminalSessionIdByTodo, onHideTerminal, onShowTerminal, collapsedTerminalByTodo, onToggleTerminalCollapsed, sideBySideByTodo, onSetSideBySide, isNarrow, onRequestFork, onRefresh }: QuadrantZoneProps) {
  const { setNodeRef, isOver } = useDroppable({ id: `quadrant-${config.q}` })

  const header = (
    <div className="todo-quadrant-header">
      <span className={`priority-tag priority-tag-${config.priority}`}>{config.priority}</span>
      <span className="quadrant-title">{config.label}</span>
      <span className={`count-badge ${config.bgBadge}`}>{todos.length}</span>
    </div>
  )

  const content = (
    <SortableContext items={todos.map(t => todoDndId(t))} strategy={verticalListSortingStrategy}>
      <div ref={setNodeRef} className="todo-quadrant-list" style={{ minHeight: 60 }}>
        {todos.map((t) => (
          <SortableTodoCard
            key={t.id}
            todo={t}
            children={childrenByParentId[t.id] || []}
            childHitIds={childHitIdsByParentId[t.id]}
            onCreateSubtodo={onCreateSubtodo}
            onClick={onCardClick}
            onToggleDone={onToggleDone}
            onAiExec={onAiExec}
            onRequestFork={onRequestFork}
            onAiExecBoth={onAiExecBoth}
            onDeleteAiSession={onDeleteAiSession}
            onUpdateSessionLabel={onUpdateSessionLabel}
            onDelete={onDelete}
            onOpenTrae={onOpenTrae}
            onOpenTerminal={onOpenTerminal}
            onCopyPrompt={onCopyPrompt}
            onExport={onExport}
            expandedTerminal={expandedTerminal}
            setExpandedTerminal={setExpandedTerminal}
            hiddenTerminalSessionId={hiddenTerminalSessionIdByTodo[t.id] || null}
            onHideTerminal={onHideTerminal}
            onShowTerminal={onShowTerminal}
            terminalCollapsed={!!collapsedTerminalByTodo[t.id]}
            onToggleTerminalCollapsed={onToggleTerminalCollapsed}
            sideBySideSessionId={sideBySideByTodo[t.id] || null}
            onSetSideBySide={onSetSideBySide}
            isNarrow={isNarrow}
            onRefresh={onRefresh}
          />
        ))}
        {todos.length === 0 && (
          <div className="todo-drop-placeholder">拖拽任务到此处</div>
        )}
      </div>
    </SortableContext>
  )

  return (
    <div className={`todo-quadrant ${isOver ? 'drag-over' : ''}`} style={style}>
      {header}
      {content}
    </div>
  )
}

// ─── 主页面 ───

export default function TodoManage() {
  // 数据
  const [todos, setTodos] = useState<Todo[]>([])
  const [loading, setLoading] = useState(false)
  const [templates, setTemplates] = useState<PromptTemplate[]>([])
  const refreshTemplates = useCallback(async () => {
    try { setTemplates(await listTemplates()) } catch { /* ignore */ }
  }, [])
  useEffect(() => { refreshTemplates() }, [refreshTemplates])

  // 视图
  const [filterStatus, setFilterStatus] = useState<'todo' | 'done' | ''>('todo')
  const [keyword, setKeyword] = useState('')

  // Drawer
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editingTodo, setEditingTodo] = useState<Todo | null>(null)
  const [parentForCreate, setParentForCreate] = useState<Todo | null>(null)
  const [form] = Form.useForm()
  const selectedWorkDir = Form.useWatch('workDir', form)

  // 详情
  const [detailTodo, setDetailTodo] = useState<Todo | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailRule, setDetailRule] = useState<RecurringRule | null>(null)

  // 重复规则编辑 Modal
  const [ruleModalOpen, setRuleModalOpen] = useState(false)
  const [ruleEditing, setRuleEditing] = useState<RecurringRule | null>(null)
  const [ruleForm] = Form.useForm()
  const [comments, setComments] = useState<Comment[]>([])
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [commentText, setCommentText] = useState('')
  const [commentSubmitting, setCommentSubmitting] = useState(false)

  // 设置
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [statsOpen, setStatsOpen] = useState(false)
  const [wikiOpen, setWikiOpen] = useState(false)
  const [templateDrawerOpen, setTemplateDrawerOpen] = useState(false)
  const [dashboardOpen, setDashboardOpen] = useState(false)
  const [transcriptDrawerOpen, setTranscriptDrawerOpen] = useState(false)
  const [unboundTranscripts, setUnboundTranscripts] = useState(0)
  const [viewMode, setViewMode] = useState<'list' | 'pet'>(() => {
    return (localStorage.getItem('quadtodo:viewMode') as 'list' | 'pet') || 'list'
  })
  const changeViewMode = useCallback((v: 'list' | 'pet') => {
    setViewMode(v)
    localStorage.setItem('quadtodo:viewMode', v)
  }, [])
  const setLiveSessions = useAiSessionStore(s => s.setSessions)
  const [workDirOptions, setWorkDirOptions] = useState<{ label: string; value: string }[]>([])
  const [workDirRoot, setWorkDirRoot] = useState<string>('')
  const [workDirLoading, setWorkDirLoading] = useState(false)
  const [pickingWorkDir, setPickingWorkDir] = useState(false)

  // AI 终端展开
  const [autoFillPrompt, setAutoFillPrompt] = useState(() => {
    const v = localStorage.getItem('quadtodo:autoFillPrompt')
    return v === null ? true : v === '1'
  })
  const toggleAutoFillPrompt = useCallback((val: boolean) => {
    setAutoFillPrompt(val)
    localStorage.setItem('quadtodo:autoFillPrompt', val ? '1' : '0')
  }, [])
  const [expandedTerminal, setExpandedTerminal] = useState<{ todoId: string; sessionId: string } | null>(null)
  // 独立于视图模式的浮层终端：点击宠物 / Dashboard 展开终端 时使用，
  // 因为 expandedTerminal 只能在列表视图的 SortableTodoCard 内被消费
  const [overlayTerminal, setOverlayTerminal] = useState<{ todoId: string; sessionId: string } | null>(null)
  const [hiddenTerminalSessionIdByTodo, setHiddenTerminalSessionIdByTodo] = useState<Record<string, string | null>>({})
  const [collapsedTerminalByTodo, setCollapsedTerminalByTodo] = useState<Record<string, boolean>>({})
  const [sideBySideByTodo, setSideBySideByTodo] = useState<Record<string, string | null>>({})
  const [forkTarget, setForkTarget] = useState<{ todo: Todo; sessionId: string } | null>(null)
  const [isNarrow, setIsNarrow] = useState<boolean>(() => typeof window !== 'undefined' ? window.innerWidth < 900 : false)
  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth < 900)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const list = await listLiveSessions()
        if (!cancelled) setLiveSessions(list)
      } catch {}
    }
    poll()
    const t = setInterval(poll, 3000)
    return () => { cancelled = true; clearInterval(t) }
  }, [setLiveSessions])

  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const s = await getTranscriptStats()
        if (!cancelled) setUnboundTranscripts(s.unboundCount)
      } catch {}
    }
    poll()
    const t = setInterval(poll, 30000)
    return () => { cancelled = true; clearInterval(t) }
  }, [transcriptDrawerOpen])

  const handleDashboardOpenTerminal = useCallback((_sessionId: string, todoId: string) => {
    setDashboardOpen(false)
    // 同步 expandedTerminal 以便列表视图切回时能看到；同时用 overlayTerminal 在当前视图直接展示
    setExpandedTerminal({ todoId, sessionId: _sessionId })
    setOverlayTerminal({ todoId, sessionId: _sessionId })
  }, [])

  const handleDashboardStop = useCallback(async (sessionId: string) => {
    try {
      await stopAiExec(sessionId)
      message.success('已发送停止')
    } catch (e) {
      message.error((e as Error).message)
    }
  }, [])

  // 拖拽
  const [activeId, setActiveId] = useState<string | null>(null)

  // 四象限分割比例（百分比）
  const [splitH, setSplitH] = useState(50)  // 上下分割：上面占比
  const [splitV, setSplitV] = useState(50)  // 左右分割：左边占比
  const boardRef = React.useRef<HTMLDivElement>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
  )

  // ─── 数据获取 ───

  const fetchTodos = useCallback(async () => {
    setLoading(true)
    try {
      const params: { status?: 'todo' | 'done'; keyword?: string } = {}
      if (filterStatus === 'todo' || filterStatus === 'done') params.status = filterStatus
      if (keyword) params.keyword = keyword
      const list = await listTodos(params)
      setTodos(list)
    } catch (e: any) {
      message.error(e?.message || '网络错误')
    }
    setLoading(false)
  }, [filterStatus, keyword])

  const childrenByParentId = useMemo(() => {
    const groups: Record<string, Todo[]> = {}
    for (const t of todos) {
      if (!t.parentId) continue
      if (!groups[t.parentId]) groups[t.parentId] = []
      groups[t.parentId].push(t)
    }
    for (const key of Object.keys(groups)) {
      groups[key].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
    }
    return groups
  }, [todos])

  const childHitIdsByParentId = useMemo(() => {
    if (!keyword.trim()) return {}
    const groups: Record<string, Set<string>> = {}
    for (const t of todos) {
      if (!t.parentId) continue
      if (!t.title.toLowerCase().includes(keyword.toLowerCase())) continue
      if (!groups[t.parentId]) groups[t.parentId] = new Set<string>()
      groups[t.parentId].add(t.id)
    }
    return groups
  }, [todos, keyword])

  useEffect(() => { fetchTodos() }, [fetchTodos])

  // ─── 按象限分组 ───

  const todosByQuadrant = useMemo(() => {
    const groups: Record<number, Todo[]> = { 1: [], 2: [], 3: [], 4: [] }
    for (const t of todos) {
      if (t.parentId) continue
      const q = t.quadrant || 4
      if (groups[q]) groups[q].push(t)
    }
    for (const q of Object.keys(groups)) {
      groups[Number(q)].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
    }
    return groups
  }, [todos])

  // ─── CRUD ───

  const handleCreate = () => {
    setEditingTodo(null)
    setParentForCreate(null)
    form.resetFields()
    form.setFieldsValue({
      quadrant: 1,
      workDir: undefined,
      recurring: false,
      recurringFrequency: 'daily',
      recurringWeekdays: [1, 2, 3, 4, 5],
      recurringMonthDays: [1],
    })
    setDrawerOpen(true)
  }

  const handleCreateSubtodo = (todo: Todo) => {
    setEditingTodo(null)
    setParentForCreate(todo)
    form.resetFields()
    form.setFieldsValue({ quadrant: todo.quadrant, workDir: todo.workDir || undefined })
    setDrawerOpen(true)
  }

  const handleEdit = (todo: Todo) => {
    setParentForCreate(null)
    setEditingTodo(todo)
    form.setFieldsValue({
      title: todo.title,
      description: todo.description,
      quadrant: todo.quadrant,
      dueDate: todo.dueDate ? dayjs(todo.dueDate) : null,
      workDir: todo.workDir || undefined,
      brainstorm: !!todo.brainstorm,
      useTemplates: (todo.appliedTemplateIds || []).length > 0,
      appliedTemplateIds: todo.appliedTemplateIds || [],
    })
    setDrawerOpen(true)
  }

  const fetchWorkDirOptions = useCallback(async () => {
    setWorkDirLoading(true)
    try {
      const result = await getWorkDirOptions()
      setWorkDirRoot(result.root)
      setWorkDirOptions(result.options)
    } catch (e: any) {
      message.error(e?.message || '读取目录失败')
    } finally {
      setWorkDirLoading(false)
    }
  }, [])

  useEffect(() => {
    if (drawerOpen) fetchWorkDirOptions()
  }, [drawerOpen, fetchWorkDirOptions])

  const handlePickWorkDir = async () => {
    try {
      setPickingWorkDir(true)
      const result = await pickDirectory({
        defaultPath: form.getFieldValue('workDir') || workDirRoot,
        prompt: '选择待办工作目录',
      })
      if (result.cancelled || !result.path) return
      form.setFieldValue('workDir', result.path)
    } catch (e: any) {
      message.error(e?.message || '选择目录失败')
    } finally {
      setPickingWorkDir(false)
    }
  }

  const handleSave = async () => {
    try {
      const values = await form.validateFields()
      const data = {
        title: values.title,
        description: values.description || '',
        quadrant: values.quadrant as Quadrant,
        dueDate: values.dueDate ? values.dueDate.valueOf() : null,
        workDir: values.workDir || null,
        brainstorm: !!values.brainstorm,
        appliedTemplateIds: values.useTemplates ? (values.appliedTemplateIds || []) : [],
        parentId: parentForCreate?.id ?? undefined,
      }

      if (editingTodo) {
        await updateTodo(editingTodo.id, { ...data, parentId: editingTodo.parentId })
        message.success('已更新')
        setDrawerOpen(false)
        setParentForCreate(null)
        fetchTodos()
      } else if (values.recurring && !parentForCreate) {
        const frequency = values.recurringFrequency as RecurringFrequency
        if (frequency === 'weekly' && !(values.recurringWeekdays || []).length) {
          message.error('请至少选择一个星期几')
          return
        }
        if (frequency === 'monthly' && !(values.recurringMonthDays || []).length) {
          message.error('请至少选择一个月内日期')
          return
        }
        await createRecurringRule({
          title: data.title,
          description: data.description,
          quadrant: data.quadrant,
          workDir: data.workDir,
          brainstorm: data.brainstorm,
          appliedTemplateIds: data.appliedTemplateIds,
          frequency,
          weekdays: frequency === 'weekly' ? values.recurringWeekdays : undefined,
          monthDays: frequency === 'monthly' ? values.recurringMonthDays : undefined,
          subtodos: [],
        })
        message.success('已创建每日待办规则')
        setDrawerOpen(false)
        setParentForCreate(null)
        fetchTodos()
      } else {
        await createTodo(data)
        message.success(parentForCreate ? '子待办已创建' : '已创建')
        setDrawerOpen(false)
        setParentForCreate(null)
        fetchTodos()
      }
    } catch (e: any) {
      if (e?.message) message.error(e.message)
    }
  }

  const handleToggleDone = async (todo: Todo) => {
    const newStatus = todo.status === 'done' ? 'todo' : 'done'
    try {
      await updateTodo(todo.id, { status: newStatus })
      fetchTodos()
    } catch (e: any) {
      message.error(e?.message || '操作失败')
    }
  }

  const handleDelete = async (todo: Todo) => {
    try {
      await deleteTodo(todo.id)
      message.success('已删除')
      fetchTodos()
    } catch (e: any) {
      message.error(e?.message || '删除失败')
    }
  }

  const handleUpdateSessionLabel = useCallback(async (todo: Todo, session: Todo['aiSessions'][number], label: string) => {
    try {
      await updateSessionLabel(todo.id, session.sessionId, label)
      fetchTodos()
    } catch (e: any) {
      message.error(e?.message || '更新标题失败')
    }
  }, [fetchTodos])

  const handleDeleteAiSession = useCallback(async (todo: Todo, session: Todo['aiSessions'][number], currentSessionId?: string | null) => {
    try {
      const nextTodo = await deleteTodoAiSession(todo.id, session.sessionId)
      message.success('历史会话已删除')
      if (currentSessionId === session.sessionId) {
        const nextSession = nextTodo.aiSessions[0]
        if (nextSession) {
          setExpandedTerminal({ todoId: todo.id, sessionId: nextSession.sessionId })
        } else {
          setExpandedTerminal(null)
        }
      }
      fetchTodos()
    } catch (e: any) {
      message.error(e?.message || '删除历史会话失败')
    }
  }, [fetchTodos])

  // ─── 重复规则 ───

  const describeRule = useCallback((r: RecurringRule) => {
    if (r.frequency === 'daily') return '每天重复'
    if (r.frequency === 'weekly') {
      const names = ['日', '一', '二', '三', '四', '五', '六']
      return '每周 ' + (r.weekdays || []).map(w => names[w]).join('、')
    }
    if (r.frequency === 'monthly') {
      return '每月 ' + (r.monthDays || []).join('、') + ' 号'
    }
    return '重复'
  }, [])

  const openRuleEdit = useCallback((rule: RecurringRule) => {
    setRuleEditing(rule)
    ruleForm.resetFields()
    ruleForm.setFieldsValue({
      title: rule.title,
      description: rule.description,
      frequency: rule.frequency,
      weekdays: rule.weekdays.length ? rule.weekdays : [1, 2, 3, 4, 5],
      monthDays: rule.monthDays.length ? rule.monthDays : [1],
    })
    setRuleModalOpen(true)
  }, [ruleForm])

  const handleRuleSave = useCallback(async () => {
    if (!ruleEditing) return
    try {
      const values = await ruleForm.validateFields()
      const frequency = values.frequency as RecurringFrequency
      if (frequency === 'weekly' && !(values.weekdays || []).length) {
        message.error('请至少选择一个星期几')
        return
      }
      if (frequency === 'monthly' && !(values.monthDays || []).length) {
        message.error('请至少选择一个月内日期')
        return
      }
      const next = await updateRecurringRule(ruleEditing.id, {
        title: values.title,
        description: values.description || '',
        frequency,
        weekdays: frequency === 'weekly' ? values.weekdays : [],
        monthDays: frequency === 'monthly' ? values.monthDays : [],
      })
      message.success('规则已更新（仅影响未来生成的实例）')
      setRuleModalOpen(false)
      setRuleEditing(null)
      if (detailRule && detailRule.id === next.id) setDetailRule(next)
    } catch (e: any) {
      if (e?.errorFields) return
      message.error(e?.message || '保存失败')
    }
  }, [ruleEditing, ruleForm, detailRule])

  const handleStopRule = useCallback(async (ruleId: string) => {
    try {
      await deactivateRecurringRule(ruleId)
      message.success('已停止重复，明天起不再生成')
      setDetailRule(prev => prev && prev.id === ruleId ? { ...prev, active: false } : prev)
    } catch (e: any) {
      message.error(e?.message || '停止失败')
    }
  }, [])

  // ─── 详情 ───

  const openDetail = (todo: Todo) => {
    setDetailTodo(todo)
    setDetailOpen(true)
    setCommentText('')
    setComments([])
    setCommentsLoading(true)
    setDetailRule(null)
    if (todo.recurringRuleId) {
      getRecurringRule(todo.recurringRuleId).then(setDetailRule).catch(() => {})
    }
    listComments(todo.id).then(setComments).catch(() => {}).finally(() => setCommentsLoading(false))
  }

  const handleAddComment = async () => {
    if (!detailTodo || !commentText.trim()) return
    setCommentSubmitting(true)
    try {
      const c = await addComment(detailTodo.id, commentText.trim())
      setComments(prev => [...prev, c])
      setCommentText('')
    } catch (e: any) {
      message.error(e?.message || '添加评论失败')
    }
    setCommentSubmitting(false)
  }

  const handleDeleteComment = async (commentId: string) => {
    if (!detailTodo) return
    try {
      await deleteComment(detailTodo.id, commentId)
      setComments(prev => prev.filter(c => c.id !== commentId))
    } catch (e: any) {
      message.error(e?.message || '删除评论失败')
    }
  }

  // ─── AI 执行 ───

  const handleAiExec = useCallback(async (todo: Todo, tool: AiTool, session?: Todo['aiSessions'][number]) => {
    try {
      const prompt = session?.prompt || (autoFillPrompt ? buildTodoPrompt(todo, templates) : '')
      // 读取用户上次选择的托管模式（持久化在 localStorage），
      // 这样新启动/恢复会话时能直接通过原生 CLI 标志生效，不依赖运行时的正则兜底。
      let permissionMode: string | null = null
      try { permissionMode = localStorage.getItem('quadtodo.autoMode') } catch { /* ignore */ }
      const { sessionId } = await startAiExec({
        todoId: todo.id,
        prompt,
        tool,
        cwd: session?.cwd || todo.workDir || undefined,
        resumeNativeId: session?.nativeSessionId || undefined,
        permissionMode: permissionMode || undefined,
      })
      setHiddenTerminalSessionIdByTodo(prev => ({ ...prev, [todo.id]: null }))
      setExpandedTerminal({ todoId: todo.id, sessionId })
      fetchTodos()
    } catch (e: any) {
      message.error(e?.message || 'AI 启动失败')
    }
  }, [fetchTodos, autoFillPrompt, templates])

  const handleAiExecBoth = useCallback(async (todo: Todo) => {
    try {
      const prompt = autoFillPrompt ? buildTodoPrompt(todo, templates) : ''
      let permissionMode: string | null = null
      try { permissionMode = localStorage.getItem('quadtodo.autoMode') } catch { /* ignore */ }
      const cwd = todo.workDir || undefined
      const [r1, r2] = await Promise.all([
        startAiExec({ todoId: todo.id, prompt, tool: 'claude', cwd, permissionMode: permissionMode || undefined }),
        startAiExec({ todoId: todo.id, prompt, tool: 'codex', cwd, permissionMode: permissionMode || undefined }),
      ])
      setHiddenTerminalSessionIdByTodo(prev => ({ ...prev, [todo.id]: null }))
      setExpandedTerminal({ todoId: todo.id, sessionId: r1.sessionId })
      setSideBySideByTodo(prev => ({ ...prev, [todo.id]: r2.sessionId }))
      fetchTodos()
    } catch (e: any) {
      message.error(e?.message || '并行启动失败')
    }
  }, [fetchTodos, autoFillPrompt, templates])

  const handleRequestFork = useCallback((todo: Todo, sessionId: string) => {
    setForkTarget({ todo, sessionId })
  }, [])

  const handleForkConfirm = useCallback(async (r: { prompt: string; targetTodoId: string; tool: AiTool; cwd: string | null }) => {
    setForkTarget(null)
    try {
      let permissionMode: string | null = null
      try { permissionMode = localStorage.getItem('quadtodo.autoMode') } catch { /* ignore */ }
      const { sessionId } = await startAiExec({
        todoId: r.targetTodoId,
        prompt: r.prompt,
        tool: r.tool,
        cwd: r.cwd || undefined,
        permissionMode: permissionMode || undefined,
      })
      setHiddenTerminalSessionIdByTodo(prev => ({ ...prev, [r.targetTodoId]: null }))
      setExpandedTerminal({ todoId: r.targetTodoId, sessionId })
      fetchTodos()
      message.success('Fork 成功，新会话已启动')
    } catch (e: any) {
      message.error(e?.message || 'Fork 启动失败')
    }
  }, [fetchTodos])

  const handleHideTerminal = useCallback((todoId: string, sessionId: string) => {
    setHiddenTerminalSessionIdByTodo(prev => ({ ...prev, [todoId]: sessionId }))
  }, [])

  const handleShowTerminal = useCallback((todoId: string) => {
    setHiddenTerminalSessionIdByTodo(prev => ({ ...prev, [todoId]: null }))
  }, [])

  const handleToggleTerminalCollapsed = useCallback((todoId: string) => {
    setCollapsedTerminalByTodo(prev => ({ ...prev, [todoId]: !prev[todoId] }))
  }, [])

  const handleSetSideBySide = useCallback((todoId: string, secondSessionId: string | null) => {
    setSideBySideByTodo(prev => ({ ...prev, [todoId]: secondSessionId }))
  }, [])

  // ─── 拖拽 ───

  const handleDragStart = (event: DragStartEvent) => {
    const { todoId } = parseTodoDndId(String(event.active.id))
    setActiveId(todoId)
  }

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveId(null)
    const { active, over } = event
    if (!over) return

    const activeParsed = parseTodoDndId(String(active.id))
    const overRawId = String(over.id)
    const overParsed = overRawId.startsWith('quadrant-') ? null : parseTodoDndId(overRawId)
    if (activeParsed.todoId === overParsed?.todoId) return

    const draggedTodo = todos.find(t => t.id === activeParsed.todoId)
    if (!draggedTodo) return

    if (draggedTodo.parentId) {
      if (!overParsed) return
      const overTodo = todos.find(t => t.id === overParsed.todoId)
      if (!overTodo || overTodo.parentId !== draggedTodo.parentId) return
      const siblings = (childrenByParentId[draggedTodo.parentId] || []).slice()
      const oldIdx = siblings.findIndex(t => t.id === draggedTodo.id)
      const newIdx = siblings.findIndex(t => t.id === overTodo.id)
      if (oldIdx === -1 || newIdx === -1 || oldIdx === newIdx) return
      const reordered = arrayMove(siblings, oldIdx, newIdx)
      const updates = reordered.map((t, i) => ({ id: t.id, sortOrder: (i + 1) * 1024 }))
      setTodos(prev => {
        const soMap = new Map(updates.map(u => [u.id, u.sortOrder]))
        return prev.map(t => soMap.has(t.id) ? { ...t, sortOrder: soMap.get(t.id)! } : t)
      })
      try {
        await Promise.all(updates.map(u => updateTodo(u.id, { sortOrder: u.sortOrder, parentId: draggedTodo.parentId })))
      } catch (e: any) {
        message.error(e?.message || '子待办排序失败')
        fetchTodos()
      }
      return
    }

    let targetQuadrant: Quadrant | null = null
    if (overRawId.startsWith('quadrant-')) {
      targetQuadrant = Number(overRawId.replace('quadrant-', '')) as Quadrant
    } else if (overParsed) {
      const overTodo = todos.find(t => t.id === overParsed.todoId)
      if (!overTodo || overTodo.parentId) return
      targetQuadrant = overTodo.quadrant
    }

    if (!targetQuadrant) return

    if (draggedTodo.quadrant !== targetQuadrant) {
      const qTodos = todos.filter(t => t.quadrant === targetQuadrant && !t.parentId)
      const maxSort = qTodos.length > 0 ? Math.max(...qTodos.map(t => t.sortOrder || 0)) : 0
      const newSort = maxSort + 1024
      setTodos(prev => prev.map(t => t.id === draggedTodo.id ? { ...t, quadrant: targetQuadrant!, sortOrder: newSort } : t))
      try {
        await updateTodo(draggedTodo.id, { quadrant: targetQuadrant, sortOrder: newSort })
      } catch (e: any) {
        message.error(e?.message || '移动失败')
        fetchTodos()
      }
      return
    }

    if (!overParsed) return
    const qTodos = todos.filter(t => t.quadrant === targetQuadrant && !t.parentId).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
    const oldIdx = qTodos.findIndex(t => t.id === draggedTodo.id)
    const newIdx = qTodos.findIndex(t => t.id === overParsed.todoId)
    if (oldIdx === -1 || newIdx === -1 || oldIdx === newIdx) return

    const reordered = arrayMove(qTodos, oldIdx, newIdx)
    const prev = newIdx > 0 ? (reordered[newIdx - 1].sortOrder || 0) : 0
    const next = newIdx < reordered.length - 1 ? (reordered[newIdx + 1].sortOrder || 0) : prev + 2048
    const newSort = Math.round((prev + next) / 2)

    if (newSort === prev || newSort === next) {
      const updates: { id: string; sortOrder: number }[] = []
      reordered.forEach((t, i) => {
        updates.push({ id: t.id, sortOrder: (i + 1) * 1024 })
      })
      setTodos(prevTodos => {
        const soMap = new Map(updates.map(u => [u.id, u.sortOrder]))
        return prevTodos.map(t => soMap.has(t.id) ? { ...t, sortOrder: soMap.get(t.id)! } : t)
      })
      await Promise.all(updates.map(u => updateTodo(u.id, { sortOrder: u.sortOrder })))
    } else {
      setTodos(prevTodos => prevTodos.map(t => t.id === draggedTodo.id ? { ...t, sortOrder: newSort } : t))
      try {
        await updateTodo(draggedTodo.id, { sortOrder: newSort })
      } catch (e: any) {
        message.error(e?.message || '排序失败')
        fetchTodos()
      }
    }
  }

  const handleOpenTrae = useCallback(async (todo: Todo, editor: 'trae-cn' | 'trae' | 'cursor' = (localStorage.getItem('quadtodo.editor') as any) || 'trae-cn') => {
    try { localStorage.setItem('quadtodo.editor', editor) } catch {}
    const cwd = todo.workDir || undefined
    const label = editor === 'trae-cn' ? 'Trae CN' : editor === 'trae' ? 'Trae' : 'Cursor'
    try {
      await openTraeCN(cwd || '', editor)
      message.success(`已打开 ${label}`)
    } catch (e: any) {
      message.error(e?.message || `打开 ${label} 失败`)
    }
  }, [])

  const handleOpenTerminal = useCallback(async (todo: Todo) => {
    const cwd = todo.workDir || undefined
    try {
      const { sessionId } = await openTerminal(cwd || '')
      setHiddenTerminalSessionIdByTodo(prev => ({ ...prev, [todo.id]: null }))
      setExpandedTerminal({ todoId: todo.id, sessionId })
    } catch (e: any) {
      message.error(e?.message || '启动终端失败')
    }
  }, [])

  const handleCopyPrompt = useCallback((todo: Todo) => {
    const text = buildTodoPrompt(todo, templates)
    navigator.clipboard.writeText(text).then(
      () => message.success('已复制到剪贴板'),
      () => message.error('复制失败')
    )
  }, [])

  const [exportTarget, setExportTarget] = useState<Todo | null>(null)
  const handleExport = useCallback((todo: Todo) => {
    setExportTarget(todo)
  }, [])

  const activeTodo = activeId ? todos.find(t => t.id === activeId) : null

  // ─── 渲染 ───

  return (
    <div style={{ padding: 16 }}>
      <div className="todo-sticky-header">
      {/* 工具栏 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>待办事项</h2>
        <div style={{ flex: 1 }} />
        <Button type="primary" icon={<PlusOutlined />} size="small" onClick={handleCreate}>
          新建
        </Button>
        <Tooltip title="启动 AI 终端时自动将标题和描述填入 prompt">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#666' }}>
            自动填入 <Switch size="small" checked={autoFillPrompt} onChange={toggleAutoFillPrompt} />
          </span>
        </Tooltip>
        <Button
          icon={<DashboardOutlined />}
          size="small"
          onClick={() => setDashboardOpen(true)}
          title="AI 工作面板"
        />
        <Button
          icon={<SearchOutlined />}
          size="small"
          onClick={() => setTranscriptDrawerOpen(true)}
          title="历史会话找回"
        />
        <Button
          icon={<FileTextOutlined />}
          size="small"
          onClick={() => setTemplateDrawerOpen(true)}
          title="Prompt 模板库"
        />
        <Button
          icon={<SettingOutlined />}
          size="small"
          onClick={() => setSettingsOpen(true)}
          title="设置"
        />
        <Button size="small" onClick={() => setWikiOpen(true)}>🧠 记忆</Button>
        <Button size="small" onClick={() => setStatsOpen(true)}>📊 统计</Button>
      </div>

      {/* 筛选栏 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <Radio.Group
          size="small"
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          options={[
            { label: '待办', value: 'todo' },
            { label: '已完成', value: 'done' },
            { label: '全部', value: '' },
          ]}
          optionType="button"
        />
        <Input
          placeholder="搜索标题..."
          size="small"
          style={{ width: 200 }}
          prefix={<SearchOutlined />}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onPressEnter={() => fetchTodos()}
          allowClear
        />
        <div style={{ flex: 1 }} />
        <Segmented
          size="small"
          value={viewMode}
          onChange={(v) => changeViewMode(v as 'list' | 'pet')}
          options={[
            { label: '列表', value: 'list' },
            { label: '宠物', value: 'pet' },
          ]}
        />
      </div>
      </div>

      {viewMode === 'pet' ? (
        <PetView onPetClick={handleDashboardOpenTerminal} />
      ) : (
      <Spin spinning={loading}>
        {/* 看板视图 */}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div className="todo-board" ref={boardRef}>
            {/* 上面一行：Q1 | 分隔线 | Q2 */}
            <div className="todo-board-row" style={{ flex: splitH }}>
              <QuadrantZone
                config={QUADRANT_CONFIG[0]} todos={todosByQuadrant[1] || []}
                childrenByParentId={childrenByParentId}
                childHitIdsByParentId={childHitIdsByParentId}
                onCreateSubtodo={handleCreateSubtodo}
                onCardClick={openDetail} onToggleDone={handleToggleDone}
                onAiExec={handleAiExec} onAiExecBoth={handleAiExecBoth} onRequestFork={handleRequestFork} onDeleteAiSession={handleDeleteAiSession} onUpdateSessionLabel={handleUpdateSessionLabel} onDelete={handleDelete}
                onOpenTrae={handleOpenTrae} onOpenTerminal={handleOpenTerminal} onCopyPrompt={handleCopyPrompt} onExport={handleExport}
                style={{ flex: splitV }}
                expandedTerminal={expandedTerminal}
                setExpandedTerminal={setExpandedTerminal}
                hiddenTerminalSessionIdByTodo={hiddenTerminalSessionIdByTodo}
                collapsedTerminalByTodo={collapsedTerminalByTodo}
                onToggleTerminalCollapsed={handleToggleTerminalCollapsed}
                sideBySideByTodo={sideBySideByTodo}
                onSetSideBySide={handleSetSideBySide}
                isNarrow={isNarrow}
                onHideTerminal={handleHideTerminal}
                onShowTerminal={handleShowTerminal}
                onRefresh={fetchTodos}
              />
              <div
                className="todo-divider-v"
                onMouseDown={(e) => {
                  e.preventDefault()
                  const board = boardRef.current
                  if (!board) return
                  const startX = e.clientX
                  const startSplit = splitV
                  const boardW = board.getBoundingClientRect().width
                  const onMove = (ev: MouseEvent) => {
                    const delta = ((ev.clientX - startX) / boardW) * 100
                    setSplitV(Math.max(20, Math.min(80, startSplit + delta)))
                  }
                  const onUp = () => {
                    document.removeEventListener('mousemove', onMove)
                    document.removeEventListener('mouseup', onUp)
                  }
                  document.addEventListener('mousemove', onMove)
                  document.addEventListener('mouseup', onUp)
                }}
              />
              <QuadrantZone
                config={QUADRANT_CONFIG[1]} todos={todosByQuadrant[2] || []}
                childrenByParentId={childrenByParentId}
                childHitIdsByParentId={childHitIdsByParentId}
                onCreateSubtodo={handleCreateSubtodo}
                onCardClick={openDetail} onToggleDone={handleToggleDone}
                onAiExec={handleAiExec} onAiExecBoth={handleAiExecBoth} onRequestFork={handleRequestFork} onDeleteAiSession={handleDeleteAiSession} onUpdateSessionLabel={handleUpdateSessionLabel} onDelete={handleDelete}
                onOpenTrae={handleOpenTrae} onOpenTerminal={handleOpenTerminal} onCopyPrompt={handleCopyPrompt} onExport={handleExport}
                style={{ flex: 100 - splitV }}
                expandedTerminal={expandedTerminal}
                setExpandedTerminal={setExpandedTerminal}
                hiddenTerminalSessionIdByTodo={hiddenTerminalSessionIdByTodo}
                collapsedTerminalByTodo={collapsedTerminalByTodo}
                onToggleTerminalCollapsed={handleToggleTerminalCollapsed}
                sideBySideByTodo={sideBySideByTodo}
                onSetSideBySide={handleSetSideBySide}
                isNarrow={isNarrow}
                onHideTerminal={handleHideTerminal}
                onShowTerminal={handleShowTerminal}
                onRefresh={fetchTodos}
              />
            </div>

            {/* 水平分隔线 */}
            <div
              className="todo-divider-h"
              onMouseDown={(e) => {
                e.preventDefault()
                const board = boardRef.current
                if (!board) return
                const startY = e.clientY
                const startSplit = splitH
                const boardH = board.getBoundingClientRect().height
                const onMove = (ev: MouseEvent) => {
                  const delta = ((ev.clientY - startY) / boardH) * 100
                  setSplitH(Math.max(20, Math.min(80, startSplit + delta)))
                }
                const onUp = () => {
                  document.removeEventListener('mousemove', onMove)
                  document.removeEventListener('mouseup', onUp)
                }
                document.addEventListener('mousemove', onMove)
                document.addEventListener('mouseup', onUp)
              }}
            />

            {/* 下面一行：Q3 | 分隔线 | Q4 */}
            <div className="todo-board-row" style={{ flex: 100 - splitH }}>
              <QuadrantZone
                config={QUADRANT_CONFIG[2]} todos={todosByQuadrant[3] || []}
                childrenByParentId={childrenByParentId}
                childHitIdsByParentId={childHitIdsByParentId}
                onCreateSubtodo={handleCreateSubtodo}
                onCardClick={openDetail} onToggleDone={handleToggleDone}
                onAiExec={handleAiExec} onAiExecBoth={handleAiExecBoth} onRequestFork={handleRequestFork} onDeleteAiSession={handleDeleteAiSession} onUpdateSessionLabel={handleUpdateSessionLabel} onDelete={handleDelete}
                onOpenTrae={handleOpenTrae} onOpenTerminal={handleOpenTerminal} onCopyPrompt={handleCopyPrompt} onExport={handleExport}
                style={{ flex: splitV }}
                expandedTerminal={expandedTerminal}
                setExpandedTerminal={setExpandedTerminal}
                hiddenTerminalSessionIdByTodo={hiddenTerminalSessionIdByTodo}
                collapsedTerminalByTodo={collapsedTerminalByTodo}
                onToggleTerminalCollapsed={handleToggleTerminalCollapsed}
                sideBySideByTodo={sideBySideByTodo}
                onSetSideBySide={handleSetSideBySide}
                isNarrow={isNarrow}
                onHideTerminal={handleHideTerminal}
                onShowTerminal={handleShowTerminal}
                onRefresh={fetchTodos}
              />
              <div
                className="todo-divider-v"
                onMouseDown={(e) => {
                  e.preventDefault()
                  const board = boardRef.current
                  if (!board) return
                  const startX = e.clientX
                  const startSplit = splitV
                  const boardW = board.getBoundingClientRect().width
                  const onMove = (ev: MouseEvent) => {
                    const delta = ((ev.clientX - startX) / boardW) * 100
                    setSplitV(Math.max(20, Math.min(80, startSplit + delta)))
                  }
                  const onUp = () => {
                    document.removeEventListener('mousemove', onMove)
                    document.removeEventListener('mouseup', onUp)
                  }
                  document.addEventListener('mousemove', onMove)
                  document.addEventListener('mouseup', onUp)
                }}
              />
              <QuadrantZone
                config={QUADRANT_CONFIG[3]} todos={todosByQuadrant[4] || []}
                childrenByParentId={childrenByParentId}
                childHitIdsByParentId={childHitIdsByParentId}
                onCreateSubtodo={handleCreateSubtodo}
                onCardClick={openDetail} onToggleDone={handleToggleDone}
                onAiExec={handleAiExec} onAiExecBoth={handleAiExecBoth} onRequestFork={handleRequestFork} onDeleteAiSession={handleDeleteAiSession} onUpdateSessionLabel={handleUpdateSessionLabel} onDelete={handleDelete}
                onOpenTrae={handleOpenTrae} onOpenTerminal={handleOpenTerminal} onCopyPrompt={handleCopyPrompt} onExport={handleExport}
                style={{ flex: 100 - splitV }}
                expandedTerminal={expandedTerminal}
                setExpandedTerminal={setExpandedTerminal}
                hiddenTerminalSessionIdByTodo={hiddenTerminalSessionIdByTodo}
                collapsedTerminalByTodo={collapsedTerminalByTodo}
                onToggleTerminalCollapsed={handleToggleTerminalCollapsed}
                sideBySideByTodo={sideBySideByTodo}
                onSetSideBySide={handleSetSideBySide}
                isNarrow={isNarrow}
                onHideTerminal={handleHideTerminal}
                onShowTerminal={handleShowTerminal}
                onRefresh={fetchTodos}
              />
            </div>
          </div>
          <DragOverlay>
            {activeTodo ? (
              <div className={`todo-card quadrant-${activeTodo.quadrant}`} style={{ boxShadow: '0 4px 12px rgba(0,0,0,0.15)', width: 300 }}>
                <div className="todo-card-title">{activeTodo.title}</div>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </Spin>
      )}

      {/* 新建/编辑 Drawer */}
      <Drawer
        title={editingTodo ? '编辑待办' : parentForCreate ? `新建子待办 · ${parentForCreate.title}` : '新建待办'}
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); setParentForCreate(null) }}
        width={640}
        extra={
          <Button type="primary" onClick={handleSave}>保存</Button>
        }
      >
        <Form form={form} layout="vertical" size="small">
          <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入标题' }]}>
            <Input placeholder="待办事项标题" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <TextArea rows={3} placeholder="详细描述（可选）" />
          </Form.Item>
          <Form.Item name="useTemplates" label="启用模板" valuePropName="checked" extra="开启后 AI 启动时会在 prompt 前按顺序拼接所选模板">
            <Switch />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(p, n) => p.useTemplates !== n.useTemplates}>
            {({ getFieldValue }) => getFieldValue('useTemplates') ? (
              <Form.Item name="appliedTemplateIds" label="应用的模板（按顺序拼接）">
                <Select
                  mode="multiple"
                  placeholder={templates.length ? '选择要应用的模板' : '暂无模板，请先在模板管理中创建'}
                  options={templates.map(t => ({ value: t.id, label: t.builtin ? `${t.name}（内置）` : t.name }))}
                  optionFilterProp="label"
                />
              </Form.Item>
            ) : null}
          </Form.Item>
          <Form.Item
            label="工作目录"
            extra={workDirRoot ? `默认根目录：${workDirRoot}` : '未加载到默认启动目录'}
          >
            <Space.Compact block>
              <Form.Item name="workDir" noStyle>
                <Input allowClear placeholder="不填则使用默认启动目录" />
              </Form.Item>
              <Button loading={pickingWorkDir} onClick={handlePickWorkDir}>选择目录</Button>
            </Space.Compact>
            <div style={{ marginTop: 8 }}>
              <Select
                allowClear
                showSearch
                loading={workDirLoading}
                placeholder="快速选择默认目录下的子文件夹"
                options={workDirOptions}
                optionFilterProp="label"
                value={workDirOptions.some(item => item.value === selectedWorkDir) ? selectedWorkDir : undefined}
                onChange={(value) => form.setFieldValue('workDir', value)}
              />
            </div>
          </Form.Item>
          <Form.Item name="quadrant" label="象限">
            <Radio.Group disabled={!!parentForCreate}>
              {QUADRANT_CONFIG.map(c => (
                <Radio.Button key={c.q} value={c.q} style={{ fontSize: 12 }}>
                  {c.label}
                </Radio.Button>
              ))}
            </Radio.Group>
          </Form.Item>
          {!editingTodo && !parentForCreate && (
            <>
              <Form.Item
                name="recurring"
                label="重复"
                valuePropName="checked"
                extra="开启后会按规则每天生成一条当天待办；未完成的旧实例会自动标记为错过"
              >
                <Switch />
              </Form.Item>
              <Form.Item noStyle shouldUpdate={(p, n) => p.recurring !== n.recurring || p.recurringFrequency !== n.recurringFrequency}>
                {({ getFieldValue }) => {
                  if (!getFieldValue('recurring')) return null
                  const freq = getFieldValue('recurringFrequency') as RecurringFrequency
                  return (
                    <>
                      <Form.Item name="recurringFrequency" label="频率">
                        <Segmented
                          options={[
                            { label: '每天', value: 'daily' },
                            { label: '每周', value: 'weekly' },
                            { label: '每月', value: 'monthly' },
                          ]}
                        />
                      </Form.Item>
                      {freq === 'weekly' && (
                        <Form.Item name="recurringWeekdays" label="星期几">
                          <Select
                            mode="multiple"
                            placeholder="选择星期几"
                            options={[
                              { value: 1, label: '一' },
                              { value: 2, label: '二' },
                              { value: 3, label: '三' },
                              { value: 4, label: '四' },
                              { value: 5, label: '五' },
                              { value: 6, label: '六' },
                              { value: 0, label: '日' },
                            ]}
                          />
                        </Form.Item>
                      )}
                      {freq === 'monthly' && (
                        <Form.Item name="recurringMonthDays" label="每月几号">
                          <Select
                            mode="multiple"
                            placeholder="选择日期"
                            options={Array.from({ length: 31 }, (_, i) => ({ value: i + 1, label: String(i + 1) }))}
                          />
                        </Form.Item>
                      )}
                    </>
                  )
                }}
              </Form.Item>
            </>
          )}
          <Form.Item name="dueDate" label="截止日期">
            <DatePicker showTime style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Drawer>

      {/* 详情 Drawer */}
      <Drawer
        title={detailTodo?.title || '待办详情'}
        open={detailOpen}
        onClose={() => { setDetailOpen(false); setDetailTodo(null); setDetailRule(null) }}
        width={640}
        extra={
          <Space>
            {detailTodo?.status === 'ai_done' && (
              <Button size="small" type="primary" icon={<CheckOutlined />} onClick={async () => {
                if (!detailTodo) return
                await updateTodo(detailTodo.id, { status: 'done' })
                message.success('已验收')
                setDetailOpen(false)
                fetchTodos()
              }}>验收通过</Button>
            )}
            {detailTodo && (
              <Button size="small" onClick={() => { setDetailOpen(false); handleEdit(detailTodo) }}>编辑</Button>
            )}
          </Space>
        }
      >
        {detailTodo && (
          <div>
            <p style={{ color: '#666' }}>{detailTodo.description || '无描述'}</p>
            {detailRule && (
              <div style={{ marginBottom: 12, padding: '8px 12px', background: '#f6ffed', border: '1px solid #b7eb8f', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <Space size="small">
                  <Tag color={detailRule.active ? 'green' : 'default'}>{detailRule.active ? '重复中' : '已停止'}</Tag>
                  <span style={{ fontSize: 13, color: '#555' }}>{describeRule(detailRule)}</span>
                </Space>
                {detailRule.active && (
                  <Space size="small">
                    <Button size="small" onClick={() => openRuleEdit(detailRule)}>编辑规则</Button>
                    <Popconfirm title="停止后今天的待办保留，明天起不再重复" onConfirm={() => handleStopRule(detailRule.id)}>
                      <Button size="small" danger>停止重复</Button>
                    </Popconfirm>
                  </Space>
                )}
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 13, marginBottom: 16 }}>
              <div><strong>象限：</strong>{QUADRANT_CONFIG.find(c => c.q === detailTodo.quadrant)?.label}</div>
              <div><strong>状态：</strong>{detailTodo.status === 'done' ? '已完成' : '待办'}</div>
              <div><strong>层级：</strong>{detailTodo.parentId ? '子待办' : '顶级待办'}</div>
              <div><strong>截止：</strong>{formatDate(detailTodo.dueDate) || '无'}</div>
              <div><strong>工作目录：</strong>{detailTodo.workDir || '默认目录'}</div>
            </div>

            <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: 16 }}>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>评论 ({comments.length})</div>

              <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                <Input.TextArea
                  value={commentText}
                  onChange={e => setCommentText(e.target.value)}
                  placeholder="添加评论..."
                  autoSize={{ minRows: 1, maxRows: 4 }}
                  onPressEnter={e => {
                    if (!e.shiftKey) { e.preventDefault(); handleAddComment() }
                  }}
                  style={{ flex: 1 }}
                />
                <Button
                  type="primary"
                  icon={<SendOutlined />}
                  loading={commentSubmitting}
                  disabled={!commentText.trim()}
                  onClick={handleAddComment}
                  style={{ alignSelf: 'flex-end' }}
                />
              </div>

              <Spin spinning={commentsLoading}>
                {comments.length === 0 && !commentsLoading && (
                  <div style={{ color: '#bbb', fontSize: 13, textAlign: 'center', padding: 16 }}>暂无评论</div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {comments.map(c => (
                    <div key={c.id} style={{
                      padding: '10px 12px', borderRadius: 8, background: '#fafafa',
                      border: '1px solid #f0f0f0', fontSize: 13, position: 'relative',
                    }}>
                      <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', paddingRight: 24 }}>{c.content}</div>
                      <div style={{ fontSize: 11, color: '#999', marginTop: 6 }}>{dayjs(c.createdAt).format('YYYY-MM-DD HH:mm')}</div>
                      <Popconfirm title="删除该评论？" onConfirm={() => handleDeleteComment(c.id)}>
                        <Button
                          type="text" size="small" danger icon={<DeleteOutlined />}
                          style={{ position: 'absolute', right: 4, top: 4, width: 20, height: 20, minWidth: 20, fontSize: 11 }}
                        />
                      </Popconfirm>
                    </div>
                  ))}
                </div>
              </Spin>
            </div>
          </div>
        )}
      </Drawer>

      <Modal
        title="编辑重复规则"
        open={ruleModalOpen}
        onCancel={() => { setRuleModalOpen(false); setRuleEditing(null) }}
        onOk={handleRuleSave}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={ruleForm} layout="vertical" size="small">
          <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入标题' }]}>
            <Input placeholder="未来生成的实例会用这个标题" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <TextArea rows={2} placeholder="可选" />
          </Form.Item>
          <Form.Item name="frequency" label="频率">
            <Segmented
              options={[
                { label: '每天', value: 'daily' },
                { label: '每周', value: 'weekly' },
                { label: '每月', value: 'monthly' },
              ]}
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(p, n) => p.frequency !== n.frequency}>
            {({ getFieldValue }) => {
              const freq = getFieldValue('frequency') as RecurringFrequency
              if (freq === 'weekly') {
                return (
                  <Form.Item name="weekdays" label="星期几">
                    <Select
                      mode="multiple"
                      options={[
                        { value: 1, label: '一' },
                        { value: 2, label: '二' },
                        { value: 3, label: '三' },
                        { value: 4, label: '四' },
                        { value: 5, label: '五' },
                        { value: 6, label: '六' },
                        { value: 0, label: '日' },
                      ]}
                    />
                  </Form.Item>
                )
              }
              if (freq === 'monthly') {
                return (
                  <Form.Item name="monthDays" label="每月几号">
                    <Select
                      mode="multiple"
                      options={Array.from({ length: 31 }, (_, i) => ({ value: i + 1, label: String(i + 1) }))}
                    />
                  </Form.Item>
                )
              }
              return null
            }}
          </Form.Item>
          <div style={{ color: '#999', fontSize: 12 }}>保存后只影响未来新生成的实例，不会回写已存在的待办。</div>
        </Form>
      </Modal>

      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <StatsDrawer open={statsOpen} onClose={() => setStatsOpen(false)} />
      <WikiDrawer open={wikiOpen} onClose={() => setWikiOpen(false)} />
      <ExportDialog
        todo={exportTarget}
        open={!!exportTarget}
        onClose={() => setExportTarget(null)}
      />
      <TemplateDrawer
        open={templateDrawerOpen}
        onClose={() => setTemplateDrawerOpen(false)}
        onChanged={refreshTemplates}
      />
      <DashboardDrawer
        open={dashboardOpen}
        onClose={() => setDashboardOpen(false)}
        onOpenTerminal={handleDashboardOpenTerminal}
        onStop={handleDashboardStop}
      />
      <TranscriptSearchDrawer
        open={transcriptDrawerOpen}
        onClose={() => setTranscriptDrawerOpen(false)}
        preselectTodoId={detailTodo?.id || null}
        initialQuery={detailTodo?.title}
        initialCwd={detailTodo?.workDir || ''}
        onBindingChanged={() => { void fetchTodos() }}
      />
      <ForkDialog
        open={!!forkTarget}
        sourceTodo={forkTarget?.todo || null}
        sourceSessionId={forkTarget?.sessionId || null}
        todos={todos}
        onCancel={() => setForkTarget(null)}
        onConfirm={handleForkConfirm}
      />
      {(() => {
        if (!overlayTerminal) return null
        const t = todos.find(x => x.id === overlayTerminal.todoId)
        if (!t) return null
        const sess = (t.aiSessions || []).find(s => s.sessionId === overlayTerminal.sessionId)
        const resumeTarget = sess?.nativeSessionId ? {
          todoId: t.id,
          tool: sess.tool,
          prompt: sess.prompt,
          cwd: sess.cwd || t.workDir || undefined,
          nativeSessionId: sess.nativeSessionId,
        } : null
        return (
          <Modal
            open
            onCancel={() => setOverlayTerminal(null)}
            footer={null}
            title={`AI 终端 · ${t.title}${sess?.tool === 'codex' ? ' · Codex' : ' · Claude'}${sess?.label ? ` · ${sess.label}` : ''}`}
            width="90vw"
            style={{ top: 20 }}
            styles={{ body: { padding: 0, height: '80vh', display: 'flex', flexDirection: 'column' } }}
            destroyOnClose
          >
            <SessionViewer
              key={overlayTerminal.sessionId}
              sessionId={overlayTerminal.sessionId}
              todoId={t.id}
              status={t.status}
              cwd={t.workDir || resumeTarget?.cwd || null}
              resumeTarget={resumeTarget}
              fillHeight
              onSessionRecovered={(nextSessionId) => {
                setOverlayTerminal({ todoId: t.id, sessionId: nextSessionId })
                setExpandedTerminal({ todoId: t.id, sessionId: nextSessionId })
                fetchTodos()
              }}
              onClose={() => setOverlayTerminal(null)}
              onDone={() => fetchTodos()}
              onFork={() => { setForkTarget({ todo: t, sessionId: overlayTerminal.sessionId }); setOverlayTerminal(null) }}
            />
          </Modal>
        )
      })()}
    </div>
  )
}
