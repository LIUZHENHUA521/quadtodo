import React, { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Button, Space, Tag, Drawer, Form, Input, DatePicker,
  Radio, message, Popconfirm, Spin, Tooltip, Dropdown, Select,
} from 'antd'
import {
  PlusOutlined,
  DeleteOutlined, CheckOutlined,
  ClockCircleOutlined, SearchOutlined,
  PlayCircleOutlined, SettingOutlined, CopyOutlined,
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
  Todo, Quadrant, AiTool,
} from './api'
import AiTerminalMini from './AiTerminalMini'
import SettingsDrawer from './SettingsDrawer'
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

function buildTodoPrompt(todo: Todo) {
  return `请完成以下待办任务:

标题: ${todo.title}
描述: ${todo.description || '无'}

请先理解需求和当前项目上下文，再开始执行。
完成后请给出变更摘要、验证结果，以及仍需我确认的事项。`
}

function currentStatusLabel(status: Todo['status']) {
  if (status === 'ai_running') return { text: '运行中', className: 'status-chip-running' }
  if (status === 'ai_pending') return { text: '待交互', className: 'status-chip-pending' }
  if (status === 'ai_done') return { text: '待验收', className: 'status-chip-done' }
  if (status === 'done') return { text: '已完成', className: 'status-chip-complete' }
  return { text: '待办', className: 'status-chip-idle' }
}

// ─── 可拖拽任务卡片 ───

interface SortableTodoCardProps {
  todo: Todo
  onClick: (t: Todo) => void
  onToggleDone: (t: Todo) => void
  onAiExec: (todo: Todo, tool: AiTool, session?: Todo['aiSessions'][number]) => void
  onDeleteAiSession: (todo: Todo, session: Todo['aiSessions'][number], currentSessionId?: string | null) => void
  onDelete: (t: Todo) => void
  expandedTerminal: { todoId: string; sessionId: string } | null
  setExpandedTerminal: (v: { todoId: string; sessionId: string } | null) => void
  hiddenTerminalSessionId?: string | null
  onHideTerminal: (todoId: string, sessionId: string) => void
  onShowTerminal: (todoId: string) => void
  onRefresh: () => void
}

function SortableTodoCard({ todo, onClick, onToggleDone, onAiExec, onDeleteAiSession, onDelete, expandedTerminal, setExpandedTerminal, hiddenTerminalSessionId, onHideTerminal, onShowTerminal, onRefresh }: SortableTodoCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: todo.id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }
  const isAiActive = todo.status === 'ai_running' || todo.status === 'ai_pending'
  const terminalOpen = expandedTerminal?.todoId === todo.id
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
  ]

  const { role: _r, tabIndex: _t, ...safeAttributes } = attributes as any
  const finalAttributes = terminalOpen ? safeAttributes : attributes

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...finalAttributes}
      tabIndex={terminalOpen ? -1 : undefined}
      className={`todo-card quadrant-${todo.quadrant} ${isDragging ? 'dragging' : ''} ${todo.status === 'done' ? 'done' : ''}`}
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
          <Dropdown
            menu={{
              items: aiMenuItems,
              onClick: ({ key }) => {
                const [action, value] = key.split(':')
                if (action === 'start') {
                  onShowTerminal(todo.id)
                  onAiExec(todo, value as AiTool)
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
                      <div className="todo-history-headline">
                        <span className="todo-history-tool">{toolDisplayName(session.tool)}</span>
                        <span className="todo-history-time">{formatSessionTime(session.startedAt || session.completedAt)}</span>
                      </div>
                      <div className="todo-history-native-id" title={nativeSessionId || session.sessionId}>
                        session id: {nativeSessionId || session.sessionId}
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
      </div>

      {/* 内嵌 AI 终端 */}
      {sessionId && !terminalHidden && (terminalOpen || isAiActive || todo.status === 'ai_done') && (
        <div
          className="todo-terminal-panel"
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          onKeyUp={(e) => e.stopPropagation()}
        >
          <AiTerminalMini
            sessionId={sessionId}
            todoId={todo.id}
            status={todo.status}
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
          />
        </div>
      )}
    </div>
  )
}

// ─── 象限 Drop Zone ───

interface QuadrantZoneProps {
  config: typeof QUADRANT_CONFIG[0]
  todos: Todo[]
  onCardClick: (t: Todo) => void
  onToggleDone: (t: Todo) => void
  onAiExec: (todo: Todo, tool: AiTool, session?: Todo['aiSessions'][number]) => void
  onDeleteAiSession: (todo: Todo, session: Todo['aiSessions'][number], currentSessionId?: string | null) => void
  onDelete: (t: Todo) => void
  style?: React.CSSProperties
  expandedTerminal: { todoId: string; sessionId: string } | null
  setExpandedTerminal: (v: { todoId: string; sessionId: string } | null) => void
  hiddenTerminalSessionIdByTodo: Record<string, string | null>
  onHideTerminal: (todoId: string, sessionId: string) => void
  onShowTerminal: (todoId: string) => void
  onRefresh: () => void
}

function QuadrantZone({ config, todos, onCardClick, onToggleDone, onAiExec, onDeleteAiSession, onDelete, style, expandedTerminal, setExpandedTerminal, hiddenTerminalSessionIdByTodo, onHideTerminal, onShowTerminal, onRefresh }: QuadrantZoneProps) {
  const { setNodeRef, isOver } = useDroppable({ id: `quadrant-${config.q}` })

  const header = (
    <div className="todo-quadrant-header">
      <span className={`priority-tag priority-tag-${config.priority}`}>{config.priority}</span>
      <span className="quadrant-title">{config.label}</span>
      <span className={`count-badge ${config.bgBadge}`}>{todos.length}</span>
    </div>
  )

  const content = (
    <SortableContext items={todos.map(t => t.id)} strategy={verticalListSortingStrategy}>
      <div ref={setNodeRef} className="todo-quadrant-list" style={{ minHeight: 60 }}>
        {todos.map((t) => (
          <SortableTodoCard
            key={t.id}
            todo={t}
            onClick={onCardClick}
            onToggleDone={onToggleDone}
            onAiExec={onAiExec}
            onDeleteAiSession={onDeleteAiSession}
            onDelete={onDelete}
            expandedTerminal={expandedTerminal}
            setExpandedTerminal={setExpandedTerminal}
            hiddenTerminalSessionId={hiddenTerminalSessionIdByTodo[t.id] || null}
            onHideTerminal={onHideTerminal}
            onShowTerminal={onShowTerminal}
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

  // 视图
  const [filterStatus, setFilterStatus] = useState<'todo' | 'done' | ''>('todo')
  const [keyword, setKeyword] = useState('')

  // Drawer
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editingTodo, setEditingTodo] = useState<Todo | null>(null)
  const [form] = Form.useForm()
  const selectedWorkDir = Form.useWatch('workDir', form)

  // 详情
  const [detailTodo, setDetailTodo] = useState<Todo | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)

  // 设置
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [workDirOptions, setWorkDirOptions] = useState<{ label: string; value: string }[]>([])
  const [workDirRoot, setWorkDirRoot] = useState<string>('')
  const [workDirLoading, setWorkDirLoading] = useState(false)
  const [pickingWorkDir, setPickingWorkDir] = useState(false)

  // AI 终端展开
  const [expandedTerminal, setExpandedTerminal] = useState<{ todoId: string; sessionId: string } | null>(null)
  const [hiddenTerminalSessionIdByTodo, setHiddenTerminalSessionIdByTodo] = useState<Record<string, string | null>>({})

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

  useEffect(() => { fetchTodos() }, [fetchTodos])

  // ─── 按象限分组 ───

  const todosByQuadrant = useMemo(() => {
    const groups: Record<number, Todo[]> = { 1: [], 2: [], 3: [], 4: [] }
    for (const t of todos) {
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
    form.resetFields()
    form.setFieldsValue({ quadrant: 1, workDir: undefined })
    setDrawerOpen(true)
  }

  const handleEdit = (todo: Todo) => {
    setEditingTodo(todo)
    form.setFieldsValue({
      title: todo.title,
      description: todo.description,
      quadrant: todo.quadrant,
      dueDate: todo.dueDate ? dayjs(todo.dueDate) : null,
      workDir: todo.workDir || undefined,
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
      }

      if (editingTodo) {
        await updateTodo(editingTodo.id, data)
        message.success('已更新')
        setDrawerOpen(false)
        fetchTodos()
      } else {
        await createTodo(data)
        message.success('已创建')
        setDrawerOpen(false)
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

  // ─── 详情 ───

  const openDetail = (todo: Todo) => {
    setDetailTodo(todo)
    setDetailOpen(true)
  }

  // ─── AI 执行 ───

  const handleAiExec = useCallback(async (todo: Todo, tool: AiTool, session?: Todo['aiSessions'][number]) => {
    try {
      const { sessionId } = await startAiExec({
        todoId: todo.id,
        prompt: session?.prompt || buildTodoPrompt(todo),
        tool,
        cwd: session?.cwd || todo.workDir || undefined,
        resumeNativeId: session?.nativeSessionId || undefined,
      })
      setHiddenTerminalSessionIdByTodo(prev => ({ ...prev, [todo.id]: null }))
      setExpandedTerminal({ todoId: todo.id, sessionId })
      fetchTodos()
    } catch (e: any) {
      message.error(e?.message || 'AI 启动失败')
    }
  }, [fetchTodos])

  const handleHideTerminal = useCallback((todoId: string, sessionId: string) => {
    setHiddenTerminalSessionIdByTodo(prev => ({ ...prev, [todoId]: sessionId }))
  }, [])

  const handleShowTerminal = useCallback((todoId: string) => {
    setHiddenTerminalSessionIdByTodo(prev => ({ ...prev, [todoId]: null }))
  }, [])

  // ─── 拖拽 ───

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id))
  }

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveId(null)
    const { active, over } = event
    if (!over) return

    const todoId = String(active.id)
    const overId = String(over.id)
    if (todoId === overId) return

    // 判断目标象限
    let targetQuadrant: Quadrant | null = null
    if (overId.startsWith('quadrant-')) {
      targetQuadrant = Number(overId.replace('quadrant-', '')) as Quadrant
    } else {
      const overTodo = todos.find(t => t.id === overId)
      if (overTodo) targetQuadrant = overTodo.quadrant
    }

    if (!targetQuadrant) return

    const draggedTodo = todos.find(t => t.id === todoId)
    if (!draggedTodo) return

    if (draggedTodo.quadrant !== targetQuadrant) {
      // 跨象限：更新象限，放到目标象限末尾
      const qTodos = todos.filter(t => t.quadrant === targetQuadrant)
      const maxSort = qTodos.length > 0 ? Math.max(...qTodos.map(t => t.sortOrder || 0)) : 0
      const newSort = maxSort + 1024
      setTodos(prev => prev.map(t => t.id === todoId ? { ...t, quadrant: targetQuadrant!, sortOrder: newSort } : t))
      try {
        await updateTodo(todoId, { quadrant: targetQuadrant, sortOrder: newSort })
      } catch (e: any) {
        message.error(e?.message || '移动失败')
        fetchTodos()
      }
    } else {
      // 同象限内排序
      const qTodos = todos.filter(t => t.quadrant === targetQuadrant).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
      const oldIdx = qTodos.findIndex(t => t.id === todoId)
      const newIdx = qTodos.findIndex(t => t.id === overId)
      if (oldIdx === -1 || newIdx === -1 || oldIdx === newIdx) return

      const reordered = arrayMove(qTodos, oldIdx, newIdx)

      // 计算新 sortOrder：取新位置前后邻居的中间值
      const prev = newIdx > 0 ? (reordered[newIdx - 1].sortOrder || 0) : 0
      const next = newIdx < reordered.length - 1 ? (reordered[newIdx + 1].sortOrder || 0) : prev + 2048
      const newSort = Math.round((prev + next) / 2)

      // 如果和邻居重合（间距 < 1），重新编号整个象限
      if (newSort === prev || newSort === next) {
        const updates: { id: string; sortOrder: number }[] = []
        reordered.forEach((t, i) => {
          const so = (i + 1) * 1024
          updates.push({ id: t.id, sortOrder: so })
        })
        setTodos(prevTodos => {
          const soMap = new Map(updates.map(u => [u.id, u.sortOrder]))
          return prevTodos.map(t => soMap.has(t.id) ? { ...t, sortOrder: soMap.get(t.id)! } : t)
        })
        await Promise.all(updates.map(u => updateTodo(u.id, { sortOrder: u.sortOrder })))
      } else {
        setTodos(prevTodos => prevTodos.map(t => t.id === todoId ? { ...t, sortOrder: newSort } : t))
        try {
          await updateTodo(todoId, { sortOrder: newSort })
        } catch (e: any) {
          message.error(e?.message || '排序失败')
          fetchTodos()
        }
      }
    }
  }

  const activeTodo = activeId ? todos.find(t => t.id === activeId) : null

  // ─── 渲染 ───

  return (
    <div style={{ padding: 16 }}>
      {/* 工具栏 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>待办事项</h2>
        <div style={{ flex: 1 }} />
        <Button type="primary" icon={<PlusOutlined />} size="small" onClick={handleCreate}>
          新建
        </Button>
        <Button
          icon={<SettingOutlined />}
          size="small"
          onClick={() => setSettingsOpen(true)}
          title="设置"
        />
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
      </div>

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
                onCardClick={openDetail} onToggleDone={handleToggleDone}
                onAiExec={handleAiExec} onDeleteAiSession={handleDeleteAiSession} onDelete={handleDelete}
                style={{ flex: splitV }}
                expandedTerminal={expandedTerminal}
                setExpandedTerminal={setExpandedTerminal}
                hiddenTerminalSessionIdByTodo={hiddenTerminalSessionIdByTodo}
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
                onCardClick={openDetail} onToggleDone={handleToggleDone}
                onAiExec={handleAiExec} onDeleteAiSession={handleDeleteAiSession} onDelete={handleDelete}
                style={{ flex: 100 - splitV }}
                expandedTerminal={expandedTerminal}
                setExpandedTerminal={setExpandedTerminal}
                hiddenTerminalSessionIdByTodo={hiddenTerminalSessionIdByTodo}
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
                onCardClick={openDetail} onToggleDone={handleToggleDone}
                onAiExec={handleAiExec} onDeleteAiSession={handleDeleteAiSession} onDelete={handleDelete}
                style={{ flex: splitV }}
                expandedTerminal={expandedTerminal}
                setExpandedTerminal={setExpandedTerminal}
                hiddenTerminalSessionIdByTodo={hiddenTerminalSessionIdByTodo}
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
                onCardClick={openDetail} onToggleDone={handleToggleDone}
                onAiExec={handleAiExec} onDeleteAiSession={handleDeleteAiSession} onDelete={handleDelete}
                style={{ flex: 100 - splitV }}
                expandedTerminal={expandedTerminal}
                setExpandedTerminal={setExpandedTerminal}
                hiddenTerminalSessionIdByTodo={hiddenTerminalSessionIdByTodo}
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

      {/* 新建/编辑 Drawer */}
      <Drawer
        title={editingTodo ? '编辑待办' : '新建待办'}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={520}
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
            <Radio.Group>
              {QUADRANT_CONFIG.map(c => (
                <Radio.Button key={c.q} value={c.q} style={{ fontSize: 12 }}>
                  {c.label}
                </Radio.Button>
              ))}
            </Radio.Group>
          </Form.Item>
          <Form.Item name="dueDate" label="截止日期">
            <DatePicker showTime style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Drawer>

      {/* 详情 Drawer */}
      <Drawer
        title={detailTodo?.title || '待办详情'}
        open={detailOpen}
        onClose={() => { setDetailOpen(false); setDetailTodo(null) }}
        width={480}
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
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 13, marginBottom: 16 }}>
              <div><strong>象限：</strong>{QUADRANT_CONFIG.find(c => c.q === detailTodo.quadrant)?.label}</div>
              <div><strong>状态：</strong>{detailTodo.status === 'done' ? '已完成' : '待办'}</div>
              <div><strong>截止：</strong>{formatDate(detailTodo.dueDate) || '无'}</div>
              <div><strong>工作目录：</strong>{detailTodo.workDir || '默认目录'}</div>
            </div>
          </div>
        )}
      </Drawer>

      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}
