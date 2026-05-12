import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  Button, Space, Tag, Drawer, Form, Input, DatePicker, Empty, Image,
  Radio, Popconfirm, Spin, Tooltip, Dropdown, Select, Switch, Segmented, Modal,
} from 'antd'
import { useAppMessages } from './design/useAppMessages'
import {
  PlusOutlined,
  DeleteOutlined, CheckOutlined,
  ClockCircleOutlined, SearchOutlined,
  PlayCircleOutlined, SettingOutlined, CopyOutlined,
  CodeOutlined, DesktopOutlined, SendOutlined, EditOutlined,
  DownOutlined, RightOutlined,
  FileTextOutlined, ExportOutlined,
  BookOutlined, LineChartOutlined, TrophyOutlined, BranchesOutlined,
  MenuOutlined, MoreOutlined, WarningOutlined,
} from '@ant-design/icons'
import { useIsMobile } from './hooks/useIsMobile'
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
  openTraeCN, openTerminal, openNativeAiResume, updateSessionLabel,
  listComments, addComment, deleteComment,
  listLiveSessions,
  listTemplates, PromptTemplate,
  createRecurringRule, getRecurringRule, updateRecurringRule, deactivateRecurringRule,
  RecurringFrequency, RecurringRule,
  Todo, Quadrant, AiTool, Comment,
  runWiki, getWikiPending,
  uploadImage,
  ApiError,
} from './api'
import { renderAppliedTemplates } from './promptRender'
import SettingsDrawer from './SettingsDrawer'
import StatsDrawer from './StatsDrawer'
import TelegramSyncButton from './TelegramSyncButton'
import WikiDrawer from './WikiDrawer'
import ExportDialog from './ExportDialog'
import TemplateDrawer from './TemplateDrawer'
import { WelcomeModal } from './onboarding/WelcomeModal'
import { useWelcomeDismissed } from './onboarding/useWelcomeDismissed'
import ForkDialog from './ForkDialog'
import ReportDrawer from './ReportDrawer'
import TranscriptSearchDrawer from './transcripts/TranscriptSearchDrawer'
import { useAiSessionStore } from './store/aiSessionStore'
import {
  buildUnreadSessionItems,
  type UnreadSessionItem,
} from './replyHub'
import { getTranscriptStats, listPipelineTemplates, listPipelineRunsForTodo, startPipelineRun, PipelineTemplate, PipelineRun } from './api'
import PipelineRunDrawer from './pipeline/PipelineRunDrawer'
import AttentionRail from './dock/AttentionRail'
import { useTerminalDockStore } from './store/terminalDockStore'
import { useUnreadStore, isSessionUnread } from './store/unreadStore'
import { useDrawerStackStore } from './store/drawerStackStore'
import { useDrawerStack } from './hooks/useDrawerStack'
import { useDispatchStore } from './store/dispatchStore'
import { TopbarDispatch } from './components/TopbarDispatch'
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

function formatSessionTime(ts?: number | null) {
  if (!ts) return ''
  return dayjs(ts).format('MM/DD HH:mm')
}

// ─── Description parser: split text into text/image segments ───
// Matches "@/abs/path.{png,jpg,jpeg,gif,webp}". The extension must NOT be
// followed by another word character (so .pngabc doesn't get swallowed), but
// any other character is treated as a terminator — whitespace, CJK ideographs,
// ASCII punctuation, end of string, or another @ starting the next path. This
// keeps the parser robust for back-to-back paths and Chinese-flanked paths
// alike. The matched path is removed from surrounding text so the chip-style
// preview replaces the raw string in the rendered card.
const DESC_IMAGE_RE = /@(\/[^\s@]+?\.(?:png|jpe?g|gif|webp))(?![A-Za-z0-9_])/gi

export type DescSegment =
  | { type: 'text'; value: string }
  | { type: 'image'; path: string }

export function parseDescription(text: string | null | undefined): DescSegment[] {
  const src = text || ''
  if (!src) return []
  const out: DescSegment[] = []
  let last = 0
  // Fresh regex instance so module-level /g state doesn't bleed between calls.
  const re = new RegExp(DESC_IMAGE_RE.source, DESC_IMAGE_RE.flags)
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const before = src.slice(last, m.index)
    if (before) out.push({ type: 'text', value: before })
    out.push({ type: 'image', path: m[1] })
    last = m.index + m[0].length
  }
  const tail = src.slice(last)
  if (tail) out.push({ type: 'text', value: tail })
  // Trim leftover whitespace on text segments so a removed path doesn't leave
  // long runs of spaces or blank lines.
  return out.map((s) =>
    s.type === 'text'
      ? { type: 'text' as const, value: s.value.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n') }
      : s,
  )
}

export function formatDueDate(ts: number | null | undefined): { label: string; overdue: boolean } {
  if (!ts) return { label: '无', overdue: false }
  return { label: dayjs(ts).format('MM-DD HH:mm'), overdue: ts < Date.now() }
}

function toolDisplayName(tool: AiTool) {
  if (tool === 'claude') return 'Claude Code'
  if (tool === 'codex') return 'Codex'
  if (tool === 'cursor') return 'Cursor'
  return tool
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
  onDeleteAiSession: (todo: Todo, session: Todo['aiSessions'][number], currentSessionId?: string | null) => void
  onUpdateSessionLabel: (todo: Todo, session: Todo['aiSessions'][number], label: string) => void
  onDelete: (t: Todo) => void
  onOpenTrae: (todo: Todo, editor?: 'trae-cn' | 'trae' | 'cursor') => void
  onOpenTerminal: (todo: Todo) => void
  onOpenNativeResume: (todo: Todo, session: Todo['aiSessions'][number]) => void
  onCopyPrompt: (todo: Todo) => void
  onExport: (todo: Todo) => void
  onOpenSessionInDock: (todo: Todo, sessionId: string) => void
  isNarrow: boolean
  onRequestFork: (todo: Todo, sessionId: string) => void
  onRefresh: () => void
  highlightTodoId?: string | null
}

type HistoryDockStatus = 'closed' | 'active' | 'background' | 'popout'

const DOCK_STATUS_TIP: Record<Exclude<HistoryDockStatus, 'closed'>, string> = {
  active: '已在 AI 终端中打开（活动 tab）',
  background: '已在 AI 终端中打开（后台 tab）',
  popout: '已弹出为独立窗口',
}

// AI session 的"已结束"状态——只在这些状态下显示"未正常结束"标签，
// 避免 running / pending_confirm 期间因为 nativeId 还没到位而误报。
const TERMINAL_AI_STATUSES = new Set<string>(['done', 'failed', 'stopped'])

function dockStatusOf(
  sessionId: string,
  openTabIds: Set<string>,
  activeTabId: string | null,
  splitSecondaryTabId: string | null,
  poppedOutTabIds: Set<string>,
): HistoryDockStatus {
  if (!openTabIds.has(sessionId)) return 'closed'
  if (poppedOutTabIds.has(sessionId)) return 'popout'
  if (sessionId === activeTabId || sessionId === splitSecondaryTabId) return 'active'
  return 'background'
}

function SortableTodoCard({ todo, children = [], childHitIds, isSubtodo = false, onCreateSubtodo, onClick, onToggleDone, onAiExec, onDeleteAiSession, onUpdateSessionLabel, onDelete, onOpenTrae, onOpenTerminal, onOpenNativeResume, onCopyPrompt, onExport, onOpenSessionInDock, isNarrow, onRequestFork, onRefresh, highlightTodoId }: SortableTodoCardProps) {
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

  const dockOpenTabs = useTerminalDockStore(s => s.openTabs)
  const dockActiveTabId = useTerminalDockStore(s => s.activeTabId)
  const dockSplitSecondaryTabId = useTerminalDockStore(s => s.splitSecondaryTabId)
  const dockPoppedOutTabIds = useTerminalDockStore(s => s.poppedOutTabIds)
  const dockSetActive = useTerminalDockStore(s => s.setActive)
  const dockToggleCollapsed = useTerminalDockStore(s => s.toggleCollapsed)
  const dockDockTab = useTerminalDockStore(s => s.dock)
  const dockIsCollapsed = useTerminalDockStore(s => s.isCollapsed)
  const dockOpenTabIdSet = useMemo(() => new Set(dockOpenTabs.map(t => t.id)), [dockOpenTabs])
  const dockPoppedSet = useMemo(() => new Set(dockPoppedOutTabIds), [dockPoppedOutTabIds])
  const lastSeenMap = useUnreadStore(s => s.lastSeenAt)
  const liveSessionsMap = useAiSessionStore(s => s.sessions)

  const focusSessionInDock = useCallback((sid: string) => {
    if (!dockOpenTabIdSet.has(sid)) return false
    if (dockPoppedSet.has(sid)) dockDockTab(sid)
    dockSetActive(sid)
    if (dockIsCollapsed) dockToggleCollapsed()
    return true
  }, [dockOpenTabIdSet, dockPoppedSet, dockDockTab, dockSetActive, dockIsCollapsed, dockToggleCollapsed])

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
          </div>
        </div>

        <div className="todo-card-footer">
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
                  onAiExec(todo, value as AiTool)
                  return
                }
                const target = historySessions.find(item => item.sessionId === value)
                if (!target) return
                if (action === 'open') {
                  onOpenSessionInDock(todo, target.sessionId)
                  return
                }
                if (action === 'resume') {
                  onAiExec(todo, target.tool, target)
                }
              },
            }}
            trigger={['click']}
          >
            <Button size="small" icon={<PlayCircleOutlined />} className="todo-primary-action">AI 终端</Button>
          </Dropdown>
          {todo.aiSession?.sessionId && (
            <Tooltip title="Open in Focus Mode (full-screen)">
              <Button
                size="small"
                className="todo-primary-action"
                onClick={() => {
                  const sid = todo.aiSession?.sessionId
                  if (sid) {
                    useDispatchStore.getState().openFocus(todo.id, sid)
                  }
                }}
              >
                ⇆
              </Button>
            </Tooltip>
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
        </div>

        {hasHistory && (
          <div className="todo-history-box" onClick={(e) => e.stopPropagation()}>
            <div className="todo-history-title">历史会话 ({historySessions.length})</div>
            <div className="todo-history-list">
              {historySessions.map((session) => {
                const isPrimarySession = session.sessionId === dockActiveTabId
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
                const dockStatus = dockStatusOf(
                  session.sessionId,
                  dockOpenTabIdSet,
                  dockActiveTabId,
                  dockSplitSecondaryTabId,
                  dockPoppedSet,
                )
                const isOpenInDock = dockStatus !== 'closed'
                // 未读优先取 live session（in-memory，最新），其次 historical（持久化值）
                const liveTurnDoneAt = liveSessionsMap.get(session.sessionId)?.lastTurnDoneAt ?? null
                const turnDoneAt = liveTurnDoneAt || session.lastTurnDoneAt || null
                const sessionUnread = isSessionUnread(turnDoneAt, lastSeenMap.get(session.sessionId))
                return (
                  <button
                    key={session.sessionId}
                    type="button"
                    className={`todo-history-item ${isPrimarySession ? 'is-primary-session' : ''} ${isOpenInDock ? `dock-${dockStatus}` : ''}`}
                    onClick={() => {
                      // 如果用户正在拖蓝选中里面的 session id / 命令文字，就别触发展开
                      if (typeof window !== 'undefined' && window.getSelection()?.toString()) return
                      onOpenSessionInDock(todo, session.sessionId)
                    }}
                  >
                    {(sessionUnread || isOpenInDock) && (() => {
                      // 一个点位多重含义：有未读时优先显示红色（更紧急），其次才是 dock 状态色
                      const dotKind = sessionUnread ? 'unread' : dockStatus
                      const tip = sessionUnread
                        ? '此 AI 会话有新回复未读'
                        : DOCK_STATUS_TIP[dockStatus as Exclude<HistoryDockStatus, 'closed'>]
                      return (
                        <Tooltip title={tip}>
                          <span
                            className={`todo-history-dock-dot is-${dotKind}`}
                            aria-label={tip}
                          />
                        </Tooltip>
                      )
                    })()}
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
                              if (isOpenInDock) {
                                focusSessionInDock(session.sessionId)
                              } else {
                                onAiExec(todo, session.tool, session)
                              }
                            }}
                            title={isOpenInDock ? '该会话已在 AI 终端中打开，点击切到该 tab' : '恢复该会话（重新挂载到 AI 终端）'}
                          >
                            {isOpenInDock ? '切到该 tab' : '恢复'}
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
                      onOpenSessionInDock={onOpenSessionInDock}
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

      {/* 内嵌 AI 终端已迁移到 TerminalDock（Task 5） */}
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
  onDeleteAiSession: (todo: Todo, session: Todo['aiSessions'][number], currentSessionId?: string | null) => void
  onUpdateSessionLabel: (todo: Todo, session: Todo['aiSessions'][number], label: string) => void
  onDelete: (t: Todo) => void
  onOpenTrae: (todo: Todo, editor?: 'trae-cn' | 'trae' | 'cursor') => void
  onOpenTerminal: (todo: Todo) => void
  onOpenNativeResume: (todo: Todo, session: Todo['aiSessions'][number]) => void
  onCopyPrompt: (todo: Todo) => void
  onExport: (todo: Todo) => void
  style?: React.CSSProperties
  onOpenSessionInDock: (todo: Todo, sessionId: string) => void
  isNarrow: boolean
  onRequestFork: (todo: Todo, sessionId: string) => void
  onRefresh: () => void
  highlightTodoId?: string | null
}

function QuadrantZone({ config, todos, childrenByParentId, childHitIdsByParentId, onCreateSubtodo, onCardClick, onToggleDone, onAiExec, onDeleteAiSession, onUpdateSessionLabel, onDelete, onOpenTrae, onOpenTerminal, onOpenNativeResume, onCopyPrompt, onExport, style, onOpenSessionInDock, isNarrow, onRequestFork, onRefresh, highlightTodoId }: QuadrantZoneProps) {
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
            onDeleteAiSession={onDeleteAiSession}
            onUpdateSessionLabel={onUpdateSessionLabel}
            onDelete={onDelete}
            onOpenTrae={onOpenTrae}
            onOpenTerminal={onOpenTerminal}
            onOpenNativeResume={onOpenNativeResume}
            onCopyPrompt={onCopyPrompt}
            onExport={onExport}
            onOpenSessionInDock={onOpenSessionInDock}
            isNarrow={isNarrow}
            onRefresh={onRefresh}
            highlightTodoId={highlightTodoId}
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
  const { message, modal } = useAppMessages()
  // 数据
  const [todos, setTodos] = useState<Todo[]>([])
  const [welcomeDismissed, setWelcomeDismissed] = useWelcomeDismissed()
  const [loading, setLoading] = useState(false)
  const [lastFetchedFilter, setLastFetchedFilter] = useState<'todo' | 'done' | ''>('todo')
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

  // 图片粘贴/拖拽到"详细描述" textarea：上传到本地，把 `@<path>` 插入光标位置。
  // Claude Code 启动时识别 `@<path>` 自动 attach 图片当 vision input。
  const descTextAreaRef = React.useRef<any>(null)
  const handlePasteOrDropImage = useCallback(async (file: File) => {
    if (!file?.type?.startsWith('image/')) return
    try {
      const { path } = await uploadImage(file)
      const insert = `@${path} `
      const cur = form.getFieldValue('description') || ''
      // 尽量在光标处插入；拿不到光标就 append 到末尾
      const ta: HTMLTextAreaElement | null =
        descTextAreaRef.current?.resizableTextArea?.textArea ||
        descTextAreaRef.current?.input ||
        null
      let nextValue: string
      let cursorAfter: number | null = null
      if (ta && typeof ta.selectionStart === 'number') {
        const start = ta.selectionStart
        const end = ta.selectionEnd ?? start
        nextValue = cur.slice(0, start) + insert + cur.slice(end)
        cursorAfter = start + insert.length
      } else {
        nextValue = (cur ? cur + ' ' : '') + insert
      }
      form.setFieldsValue({ description: nextValue })
      // 恢复光标 / 聚焦
      if (ta && cursorAfter !== null) {
        requestAnimationFrame(() => {
          try {
            ta.selectionStart = ta.selectionEnd = cursorAfter as number
            ta.focus()
          } catch {}
        })
      }
      message.success(`已 attach: ${path.split('/').pop()}`)
    } catch (err) {
      message.error(`上传失败: ${(err as Error).message}`)
    }
  }, [form])

  // 详情
  const [detailTodo, setDetailTodo] = useState<Todo | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailRule, setDetailRule] = useState<RecurringRule | null>(null)
  const [memorizing, setMemorizing] = useState(false)
  // Pipeline state
  const [pipelineTemplates, setPipelineTemplates] = useState<PipelineTemplate[]>([])
  const [pipelineDrawerOpen, setPipelineDrawerOpen] = useState(false)
  const [pipelineActiveRun, setPipelineActiveRun] = useState<PipelineRun | null>(null)
  const [pipelineActiveTemplate, setPipelineActiveTemplate] = useState<PipelineTemplate | null>(null)
  const [pipelineActiveTodo, setPipelineActiveTodo] = useState<Todo | null>(null)
  const [pipelineStarting, setPipelineStarting] = useState(false)
  useEffect(() => {
    listPipelineTemplates().then(setPipelineTemplates).catch(() => { /* silent */ })
  }, [])

  const handleStartPipeline = useCallback(async (todo: Todo) => {
    if (!pipelineTemplates.length) { message.warning('没有可用的 pipeline 模板'); return }
    if (!todo.workDir) { message.error('当前任务未配置工作目录（workDir），无法创建 worktree'); return }
    // If there's an existing running pipeline, reuse it
    try {
      const runs = await listPipelineRunsForTodo(todo.id)
      const running = runs.find(r => r.status === 'running')
      if (running) {
        const tpl = pipelineTemplates.find(t => t.id === running.templateId) || pipelineTemplates[0]
        setPipelineActiveRun(running)
        setPipelineActiveTemplate(tpl)
        setPipelineActiveTodo(todo)
        setPipelineDrawerOpen(true)
        return
      }
    } catch { /* fall through to start new */ }

    // Only 1 built-in template for now — use it directly
    const tpl = pipelineTemplates[0]
    setPipelineStarting(true)
    try {
      const run = await startPipelineRun(todo.id, tpl.id)
      setPipelineActiveRun(run)
      setPipelineActiveTemplate(tpl)
      setPipelineActiveTodo(todo)
      setPipelineDrawerOpen(true)
      message.success(`已启动 pipeline：${tpl.name}`)
    } catch (e: any) {
      message.error(e?.message || '启动 pipeline 失败')
    } finally {
      setPipelineStarting(false)
    }
  }, [pipelineTemplates])
  const [todoCoverage, setTodoCoverage] = useState<Record<string, boolean>>({})  // todoId → already applied

  // 重复规则编辑 Modal
  const [ruleModalOpen, setRuleModalOpen] = useState(false)
  const [ruleEditing, setRuleEditing] = useState<RecurringRule | null>(null)
  const [ruleForm] = Form.useForm()
  const [comments, setComments] = useState<Comment[]>([])
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [commentText, setCommentText] = useState('')
  const [commentSubmitting, setCommentSubmitting] = useState(false)

  // 设置 (4 drawers lifted to dispatchStore in M2 T9)
  const settingsOpen = useDispatchStore((s) => s.settings)
  const statsOpen = useDispatchStore((s) => s.stats)
  const wikiOpen = useDispatchStore((s) => s.wiki)
  const reportOpen = useDispatchStore((s) => s.report)
  const openDrawer = useDispatchStore((s) => s.openDrawer)
  const closeDrawer = useDispatchStore((s) => s.closeDrawer)
  const [templateDrawerOpen, setTemplateDrawerOpen] = useState(false)
  const [transcriptDrawerOpen, setTranscriptDrawerOpen] = useState(false)
  const [toolMissing, setToolMissing] = useState<null | { tool: string; bin: string; fix: string }>(null)
  const [, setUnboundTranscripts] = useState(0)
  const isMobile = useIsMobile()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [viewMode] = useState<'list' | 'priority'>('list')
  const setLiveSessions = useAiSessionStore(s => s.setSessions)
  const [workDirOptions, setWorkDirOptions] = useState<{ label: string; value: string }[]>([])
  const [workDirRoot, setWorkDirRoot] = useState<string>('')
  const [workDirLoading, setWorkDirLoading] = useState(false)
  const [pickingWorkDir, setPickingWorkDir] = useState(false)

  const [highlightTodoId, setHighlightTodoId] = useState<string | null>(null)
  const [pendingJumpTodoId, setPendingJumpTodoId] = useState<string | null>(null)
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [forkTarget, setForkTarget] = useState<{ todo: Todo; sessionId: string } | null>(null)
  const [isNarrow, setIsNarrow] = useState<boolean>(() => typeof window !== 'undefined' ? window.innerWidth < 900 : false)
  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth < 900)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Drawer stack ESC handling: when ≥ 1 drawer is open, ESC closes only the topmost.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const { topKey, registered } = useDrawerStackStore.getState()
      const top = topKey()
      if (top && registered[top]) {
        e.stopImmediatePropagation()
        e.preventDefault()
        registered[top]()
      }
    }
    // Use capture phase so we beat antd Drawer's own keyboard handler.
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [])

  // Wire each drawer into the shared drawer stack so ESC can close just the topmost.
  useDrawerStack('settings', settingsOpen, () => closeDrawer('settings'))
  useDrawerStack('stats', statsOpen, () => closeDrawer('stats'))
  useDrawerStack('wiki', wikiOpen, () => closeDrawer('wiki'))
  useDrawerStack('report', reportOpen, () => closeDrawer('report'))
  useDrawerStack('template', templateDrawerOpen, () => setTemplateDrawerOpen(false))
  useDrawerStack('transcript', transcriptDrawerOpen, () => setTranscriptDrawerOpen(false))
  useDrawerStack('pipeline', pipelineDrawerOpen, () => setPipelineDrawerOpen(false))

  // M2 T9: react to dispatchStore signals (jump-to-todo + request-new-todo from CommandPalette)
  const jumpToTodoId = useDispatchStore((s) => s.jumpToTodoId)
  const setJumpTo = useDispatchStore((s) => s.setJumpTo)
  const requestNewTodo = useDispatchStore((s) => s.requestNewTodo)
  const consumeRequestNewTodo = useDispatchStore((s) => s.consumeRequestNewTodo)

  useEffect(() => {
    if (!jumpToTodoId) return
    const el = document.querySelector(`[data-todo-id="${jumpToTodoId}"]`) as HTMLElement | null
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.classList.add('todo-card-flash')
      window.setTimeout(() => el.classList.remove('todo-card-flash'), 1200)
    }
    setJumpTo(null)
  }, [jumpToTodoId, setJumpTo])

  useEffect(() => {
    if (!requestNewTodo) return
    // Reuse the existing new-todo entry (local state at line ~738).
    setDrawerOpen(true)
    consumeRequestNewTodo()
  }, [requestNewTodo, consumeRequestNewTodo])

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

  const liveSessionsMap = useAiSessionStore(s => s.sessions)
  const lastSeenMap = useUnreadStore(s => s.lastSeenAt)
  const unreadItems = useMemo(() => buildUnreadSessionItems({
    todos,
    liveSessions: [...liveSessionsMap.values()],
    lastSeenMap,
  }), [todos, liveSessionsMap, lastSeenMap])

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

  const dockActivate = useTerminalDockStore(s => s.activate)
  const handleOpenTerminalInDock = useCallback((todo: Todo, sessionId: string) => {
    dockActivate(todo.id, sessionId, todo.title)
  }, [dockActivate])

  const handleOpenAttentionItem = useCallback((item: UnreadSessionItem) => {
    setKeyword('')
    setFilterStatus('todo')
    const todo = todos.find(t => t.id === item.todoId)
    if (todo) handleOpenTerminalInDock(todo, item.sessionId)
    setHighlightTodoId(item.todoId)
    setPendingJumpTodoId(item.todoId)

    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
    highlightTimerRef.current = setTimeout(() => {
      setHighlightTodoId(null)
      highlightTimerRef.current = null
    }, 3000)
  }, [todos, handleOpenTerminalInDock])

  useEffect(() => {
    if (!pendingJumpTodoId) return
    if (lastFetchedFilter !== filterStatus) return
    if (todos.find(t => t.id === pendingJumpTodoId)) {
      const targetId = pendingJumpTodoId
      window.setTimeout(() => {
        document.getElementById(`todo-card-${targetId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }, 80)
      setPendingJumpTodoId(null)
      return
    }
    if (filterStatus === 'todo') {
      setFilterStatus('')
      return
    }
    setPendingJumpTodoId(null)
  }, [todos, pendingJumpTodoId, filterStatus, lastFetchedFilter])

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
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
      setLastFetchedFilter(filterStatus)
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

  // ─── 按优先级扁平化（用于「优先级」视图） ───
  const priorityList = useMemo(() => {
    const flat: Todo[] = []
    for (const q of [1, 2, 3, 4] as const) {
      flat.push(...(todosByQuadrant[q] || []))
    }
    return flat
  }, [todosByQuadrant])

  // ─── CRUD ───

  const findBrainstormTemplate = () => templates.find(t => t.builtin && t.name === 'Brainstorm（脑爆）')

  const handleCreate = () => {
    setEditingTodo(null)
    setParentForCreate(null)
    form.resetFields()
    const brainstormTpl = findBrainstormTemplate()
    form.setFieldsValue({
      quadrant: 1,
      workDir: undefined,
      recurring: false,
      recurringFrequency: 'daily',
      recurringWeekdays: [1, 2, 3, 4, 5],
      recurringMonthDays: [1],
      useTemplates: !!brainstormTpl,
      appliedTemplateIds: brainstormTpl ? [brainstormTpl.id] : [],
    })
    setDrawerOpen(true)
  }

  const handleCreateSubtodo = (todo: Todo) => {
    setEditingTodo(null)
    setParentForCreate(todo)
    form.resetFields()
    const brainstormTpl = findBrainstormTemplate()
    form.setFieldsValue({
      quadrant: todo.quadrant,
      workDir: todo.workDir || undefined,
      useTemplates: !!brainstormTpl,
      appliedTemplateIds: brainstormTpl ? [brainstormTpl.id] : [],
    })
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
          handleOpenTerminalInDock(todo, nextSession.sessionId)
        }
      }
      fetchTodos()
    } catch (e: any) {
      message.error(e?.message || '删除历史会话失败')
    }
  }, [fetchTodos, handleOpenTerminalInDock])

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

  const handleMemorize = useCallback(async (todo: Todo, force = false) => {
    if (memorizing) return
    const already = todoCoverage[todo.id]
    if (already && !force) {
      modal.confirm({
        title: '这条已经沉淀过',
        content: '重新沉淀会再跑一次 claude（消耗 token）。确认吗？',
        onOk: () => handleMemorize(todo, true),
      })
      return
    }
    setMemorizing(true)
    try {
      const res = await runWiki({ todoIds: [todo.id], dryRun: false })
      message.success(`已沉淀到记忆：写了 ${res.sourcesWritten} 个 source`)
      setTodoCoverage((prev) => ({ ...prev, [todo.id]: true }))
    } catch (e: any) {
      message.error(`沉淀失败：${e.message}`)
    } finally { setMemorizing(false) }
  }, [memorizing, todoCoverage])

  useEffect(() => {
    if (!detailTodo) return
    getWikiPending().then((list) => {
      const isPending = list.some((p) => p.id === detailTodo.id)
      setTodoCoverage((prev) => ({ ...prev, [detailTodo.id]: !isPending && detailTodo.status === 'done' }))
    }).catch(() => { /* silent */ })
  }, [detailTodo?.id])

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
      const prompt = session?.prompt || buildTodoPrompt(todo, templates)
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
      handleOpenTerminalInDock(todo, sessionId)
      fetchTodos()
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 424 && e.body?.code === 'tool_missing') {
        setToolMissing({ tool: e.body.tool, bin: e.body.bin, fix: e.body.fix })
        return
      }
      message.error(e?.message || 'AI 启动失败')
    }
  }, [fetchTodos, templates, handleOpenTerminalInDock])

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
      const targetTodo = todos.find(t => t.id === r.targetTodoId)
      if (targetTodo) handleOpenTerminalInDock(targetTodo, sessionId)
      fetchTodos()
      message.success('Fork 成功，新会话已启动')
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 424 && e.body?.code === 'tool_missing') {
        setToolMissing({ tool: e.body.tool, bin: e.body.bin, fix: e.body.fix })
        return
      }
      message.error(e?.message || 'Fork 启动失败')
    }
  }, [fetchTodos, todos, handleOpenTerminalInDock])

  // ─── Dock 集成 ───

  const resolveTabContext = useCallback((tab: { id: string; todoId: string }) => {
    const todo = todos.find(t => t.id === tab.todoId)
    if (!todo) return { cwd: null, resumeTarget: null }
    const sess = (todo.aiSessions || []).find(s => s.sessionId === tab.id)
    const resumeTarget = sess?.nativeSessionId ? {
      todoId: todo.id,
      tool: sess.tool,
      prompt: sess.prompt,
      cwd: sess.cwd || todo.workDir || undefined,
      nativeSessionId: sess.nativeSessionId,
    } : null
    return {
      cwd: todo.workDir || sess?.cwd || null,
      resumeTarget,
    }
  }, [todos])

  const handleDockSessionRecovered = useCallback((_todoId: string, _next: string) => {
    fetchTodos()
  }, [fetchTodos])

  const handleDockSessionSwitch = useCallback((_todoId: string, _next: string) => {
    fetchTodos()
  }, [fetchTodos])

  const handleDockDone = useCallback((_todoId: string, _sessionId: string) => {
    fetchTodos()
  }, [fetchTodos])

  const handleDockFork = useCallback((todoId: string, sessionId: string) => {
    const todo = todos.find(t => t.id === todoId)
    if (!todo) return
    setForkTarget({ todo, sessionId })
  }, [todos])

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

    if (viewMode === 'priority' && draggedTodo.quadrant !== targetQuadrant) {
      message.info('优先级模式下不支持跨优先级拖拽，请到看板视图调整')
      return
    }

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
      handleOpenTerminalInDock(todo, sessionId)
    } catch (e: any) {
      message.error(e?.message || '启动终端失败')
    }
  }, [handleOpenTerminalInDock])

  const handleOpenNativeResume = useCallback(async (todo: Todo, session: Todo['aiSessions'][number]) => {
    const cwd = session.cwd || todo.workDir || undefined
    const nativeSessionId = session.nativeSessionId
    if (!nativeSessionId) {
      message.error('当前会话缺少原生 session ID，无法在本地继续')
      return
    }
    try {
      const result = await openNativeAiResume({
        cwd: cwd || '',
        tool: session.tool,
        nativeSessionId,
        todoId: todo.id,
        sessionId: session.sessionId,
      })
      await fetchTodos()
      const warnings = result.warnings || []
      if (warnings.includes('route_missing')) {
        message.warning('已在本地 Terminal 中继续；当前会话未绑定 IM 路由（飞书/Telegram），不会同步消息')
      } else if (warnings.includes('hooks_not_installed') || warnings.includes('hook_script_missing')) {
        message.warning('已在本地 Terminal 中继续；Claude Code hooks 未安装或脚本缺失，IM 推送可能不可用')
      } else {
        message.success('已在本地 Terminal 中继续当前会话，IM 将接收后续回复')
      }
    } catch (e: any) {
      message.error(e?.message || '本地继续失败')
    }
  }, [fetchTodos])

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

  const closeDetail = () => {
    setDetailOpen(false)
    setDetailTodo(null)
    setDetailRule(null)
  }

  // ─── 渲染 ───

  return (
    <div className="todo-manage-shell">
      <AttentionRail
        items={unreadItems}
        onActivate={handleOpenAttentionItem}
      />
      <div className="todo-manage__main" style={{ padding: '0 16px 16px' }}>
      {!isMobile && <TopbarDispatch />}
      <div className="todo-sticky-header">
      {/* 工具栏 + 筛选（同一行） */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 12 }}>
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
        <Button type="primary" icon={<PlusOutlined />} size="small" onClick={handleCreate}>
          新建
        </Button>
        {isMobile ? (
          <Button
            icon={<MenuOutlined />}
            size="small"
            onClick={() => setMobileMenuOpen(true)}
            title="更多"
          >菜单</Button>
        ) : (
          <>
            <Button
              icon={<SearchOutlined />}
              size="small"
              onClick={() => setTranscriptDrawerOpen(true)}
              title="历史会话找回"
            >找回</Button>
            <Dropdown
              menu={{
                items: [
                  {
                    key: 'telegram',
                    label: (
                      <div onClick={(e) => e.stopPropagation()}>
                        <TelegramSyncButton />
                      </div>
                    ),
                  },
                  { type: 'divider' as const },
                  {
                    key: 'template',
                    icon: <FileTextOutlined />,
                    label: '模板',
                    onClick: () => setTemplateDrawerOpen(true),
                  },
                ],
              }}
              trigger={['click']}
              placement="bottomRight"
            >
              <Button icon={<MoreOutlined />} size="small" title="更多">更多</Button>
            </Dropdown>
          </>
        )}
      </div>

      </div>

      {viewMode === 'priority' ? (
        <Spin spinning={loading}>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <div className="todo-priority-board">
              <SortableContext
                items={priorityList.map(t => todoDndId(t))}
                strategy={verticalListSortingStrategy}
              >
                <div className="todo-priority-list">
                  {priorityList.map((t) => (
                    <SortableTodoCard
                      key={t.id}
                      todo={t}
                      children={childrenByParentId[t.id] || []}
                      childHitIds={childHitIdsByParentId[t.id]}
                      onCreateSubtodo={handleCreateSubtodo}
                      onClick={openDetail}
                      onToggleDone={handleToggleDone}
                      onAiExec={handleAiExec}
                      onRequestFork={handleRequestFork}
                      onDeleteAiSession={handleDeleteAiSession}
                      onUpdateSessionLabel={handleUpdateSessionLabel}
                      onDelete={handleDelete}
                      onOpenTrae={handleOpenTrae}
                      onOpenTerminal={handleOpenTerminal}
                      onOpenNativeResume={handleOpenNativeResume}
                      onCopyPrompt={handleCopyPrompt}
                      onExport={handleExport}
                      onOpenSessionInDock={handleOpenTerminalInDock}
                      isNarrow={isNarrow}
                      onRefresh={fetchTodos}
                      highlightTodoId={highlightTodoId}
                    />
                  ))}
                  {priorityList.length === 0 && (
                    <div className="todo-drop-placeholder">暂无待办</div>
                  )}
                </div>
              </SortableContext>
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
                onAiExec={handleAiExec} onRequestFork={handleRequestFork} onDeleteAiSession={handleDeleteAiSession} onUpdateSessionLabel={handleUpdateSessionLabel} onDelete={handleDelete}
                onOpenTrae={handleOpenTrae} onOpenTerminal={handleOpenTerminal} onOpenNativeResume={handleOpenNativeResume} onCopyPrompt={handleCopyPrompt} onExport={handleExport}
                style={{ flex: splitV }}
                onOpenSessionInDock={handleOpenTerminalInDock}
                isNarrow={isNarrow}
                onRefresh={fetchTodos}
                highlightTodoId={highlightTodoId}
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
                onAiExec={handleAiExec} onRequestFork={handleRequestFork} onDeleteAiSession={handleDeleteAiSession} onUpdateSessionLabel={handleUpdateSessionLabel} onDelete={handleDelete}
                onOpenTrae={handleOpenTrae} onOpenTerminal={handleOpenTerminal} onOpenNativeResume={handleOpenNativeResume} onCopyPrompt={handleCopyPrompt} onExport={handleExport}
                style={{ flex: 100 - splitV }}
                onOpenSessionInDock={handleOpenTerminalInDock}
                isNarrow={isNarrow}
                onRefresh={fetchTodos}
                highlightTodoId={highlightTodoId}
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
                onAiExec={handleAiExec} onRequestFork={handleRequestFork} onDeleteAiSession={handleDeleteAiSession} onUpdateSessionLabel={handleUpdateSessionLabel} onDelete={handleDelete}
                onOpenTrae={handleOpenTrae} onOpenTerminal={handleOpenTerminal} onOpenNativeResume={handleOpenNativeResume} onCopyPrompt={handleCopyPrompt} onExport={handleExport}
                style={{ flex: splitV }}
                onOpenSessionInDock={handleOpenTerminalInDock}
                isNarrow={isNarrow}
                onRefresh={fetchTodos}
                highlightTodoId={highlightTodoId}
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
                onAiExec={handleAiExec} onRequestFork={handleRequestFork} onDeleteAiSession={handleDeleteAiSession} onUpdateSessionLabel={handleUpdateSessionLabel} onDelete={handleDelete}
                onOpenTrae={handleOpenTrae} onOpenTerminal={handleOpenTerminal} onOpenNativeResume={handleOpenNativeResume} onCopyPrompt={handleCopyPrompt} onExport={handleExport}
                style={{ flex: 100 - splitV }}
                onOpenSessionInDock={handleOpenTerminalInDock}
                isNarrow={isNarrow}
                onRefresh={fetchTodos}
                highlightTodoId={highlightTodoId}
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
          <Form.Item name="description" label="描述" extra="可粘贴或拖拽图片，自动上传并以 @path 形式 attach 到任务（AI 启动时自动识别）">
            <TextArea
              ref={descTextAreaRef}
              rows={3}
              placeholder="详细描述（可选） · 粘贴 / 拖拽图片自动 attach"
              onPaste={(e) => {
                const items = Array.from(e.clipboardData?.items || [])
                const imageItem = items.find((it) => it.kind === 'file' && it.type.startsWith('image/'))
                if (!imageItem) return
                e.preventDefault()
                const file = imageItem.getAsFile()
                if (file) handlePasteOrDropImage(file)
              }}
              onDrop={(e) => {
                const file = Array.from(e.dataTransfer?.files || []).find((f) => f.type.startsWith('image/'))
                if (!file) return
                e.preventDefault()
                handlePasteOrDropImage(file)
              }}
            />
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
        onClose={closeDetail}
        width={720}
        rootClassName="todo-detail-drawer"
        extra={
          <Space size={4}>
            {detailTodo?.status === 'ai_done' && (
              <Button size="small" type="primary" icon={<CheckOutlined />} onClick={async () => {
                if (!detailTodo) return
                await updateTodo(detailTodo.id, { status: 'done' })
                message.success('已验收')
                closeDetail()
                fetchTodos()
              }}>验收通过</Button>
            )}
            {detailTodo && (
              <Tooltip title="coder ↔ reviewer 自动循环，每个 agent 独立 worktree">
                <Button
                  size="small" type="text"
                  icon={<BranchesOutlined />}
                  loading={pipelineStarting}
                  onClick={() => detailTodo && handleStartPipeline(detailTodo)}
                >Pipeline</Button>
              </Tooltip>
            )}
            {detailTodo && (
              <Button
                size="small" type="text"
                onClick={() => handleMemorize(detailTodo)}
                loading={memorizing}
              >
                {todoCoverage[detailTodo.id] ? '已沉淀' : '沉淀'}
              </Button>
            )}
            {detailTodo && (
              <Button size="small" icon={<EditOutlined />} onClick={() => { closeDetail(); handleEdit(detailTodo) }}>编辑</Button>
            )}
          </Space>
        }
      >
        {detailTodo && (() => {
          const quad = QUADRANT_CONFIG.find(c => c.q === detailTodo.quadrant)
          const due = formatDueDate(detailTodo.dueDate)
          const status = currentStatusLabel(detailTodo.status)
          const segments = parseDescription(detailTodo.description)
          const textValue = segments
            .filter((s): s is { type: 'text'; value: string } => s.type === 'text')
            .map(s => s.value)
            .join('')
            .trim()
          const imageSegments = segments
            .filter((s): s is { type: 'image'; path: string } => s.type === 'image')
          const hasText = textValue.length > 0
          const hasImage = imageSegments.length > 0

          const handleChipClick = () => { closeDetail(); handleEdit(detailTodo) }

          return (
            <div className="todo-detail">
              {/* Section A — meta chips */}
              <div className="todo-detail-meta">
                <Tooltip title="点击编辑象限">
                  <button type="button" className="todo-detail-chip todo-detail-chip--quadrant" onClick={handleChipClick}>
                    <span className="todo-detail-chip__dot" style={{ background: quad?.color }} />
                    <span className="todo-detail-chip__label">象限</span>
                    <span className="todo-detail-chip__value">{quad?.label}</span>
                  </button>
                </Tooltip>
                <span className={`todo-detail-chip todo-detail-chip--status ${status.className}`}>
                  <span className="todo-detail-chip__label">状态</span>
                  <span className="todo-detail-chip__value">{status.text}</span>
                </span>
                <span className="todo-detail-chip todo-detail-chip--level">
                  <span className="todo-detail-chip__label">层级</span>
                  <span className="todo-detail-chip__value">{detailTodo.parentId ? '子待办' : '顶级待办'}</span>
                </span>
                <Tooltip title="点击编辑截止时间">
                  <button
                    type="button"
                    className={`todo-detail-chip todo-detail-chip--due ${due.overdue ? 'is-overdue' : ''}`}
                    onClick={handleChipClick}
                  >
                    {due.overdue && <WarningOutlined />}
                    <span className="todo-detail-chip__label">截止</span>
                    <span className="todo-detail-chip__value">{due.label}</span>
                  </button>
                </Tooltip>
                <Tooltip title="点击复制路径">
                  <button
                    type="button"
                    className="todo-detail-chip todo-detail-chip--workdir"
                    onClick={() => {
                      const v = detailTodo.workDir || ''
                      if (!v) return
                      navigator.clipboard?.writeText(v).then(
                        () => message.success('已复制工作目录'),
                        () => message.error('复制失败'),
                      )
                    }}
                  >
                    <span className="todo-detail-chip__label">工作目录</span>
                    <code className="todo-detail-chip__value">{detailTodo.workDir || '默认目录'}</code>
                    <CopyOutlined />
                  </button>
                </Tooltip>
              </div>

              {/* Section B — recurring rule banner */}
              {detailRule && (
                <div className="todo-detail-recurring">
                  <Space size="small" wrap>
                    <Tag color={detailRule.active ? 'green' : 'default'}>{detailRule.active ? '重复中' : '已停止'}</Tag>
                    <span className="todo-detail-recurring__text">{describeRule(detailRule)}</span>
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

              {/* Section C — description card */}
              <div className="todo-detail-description">
                {!hasText && !hasImage && (
                  <p className="todo-detail-description__empty">无描述</p>
                )}
                {hasText && (
                  <p className="todo-detail-description__text">{textValue}</p>
                )}
                {hasImage && (
                  <Image.PreviewGroup>
                    <div className="todo-detail-description__images">
                      {imageSegments.map((s, i) => (
                        <Image
                          key={`${s.path}-${i}`}
                          src={`/api/uploads/file?path=${encodeURIComponent(s.path)}`}
                          alt=""
                          className="todo-detail-description__image"
                        />
                      ))}
                    </div>
                  </Image.PreviewGroup>
                )}
              </div>

              {/* Section D — comments */}
              <div className="todo-detail-comments">
                <div className="todo-detail-comments__header">评论 ({comments.length})</div>

                <div className="todo-detail-comments__composer">
                  <Input.TextArea
                    value={commentText}
                    onChange={e => setCommentText(e.target.value)}
                    placeholder="添加评论..."
                    autoSize={{ minRows: 1, maxRows: 4 }}
                    onPressEnter={e => {
                      const ke = e as React.KeyboardEvent
                      if (!ke.shiftKey) { e.preventDefault(); handleAddComment() }
                    }}
                  />
                  <Button
                    type="primary"
                    icon={<SendOutlined />}
                    loading={commentSubmitting}
                    disabled={!commentText.trim()}
                    onClick={handleAddComment}
                  />
                </div>

                <Spin spinning={commentsLoading}>
                  {comments.length === 0 && !commentsLoading && (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无评论" />
                  )}
                  <div className="todo-detail-comments__list">
                    {comments.map(c => (
                      <div key={c.id} className="todo-detail-comment">
                        <div className="todo-detail-comment__avatar">✍️</div>
                        <div className="todo-detail-comment__body">
                          <div className="todo-detail-comment__meta">
                            <span className="todo-detail-comment__time">{dayjs(c.createdAt).format('YYYY-MM-DD HH:mm')}</span>
                            <Popconfirm title="删除该评论？" onConfirm={() => handleDeleteComment(c.id)}>
                              <Button type="text" size="small" danger icon={<DeleteOutlined />} className="todo-detail-comment__delete" />
                            </Popconfirm>
                          </div>
                          <div className="todo-detail-comment__text">{c.content}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </Spin>
              </div>
            </div>
          )
        })()}
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

      {/* 移动端菜单：承载被折叠的次级工具按钮 */}
      <Drawer
        title="菜单"
        placement="right"
        open={mobileMenuOpen}
        onClose={() => setMobileMenuOpen(false)}
      >
        <div className="mobile-menu-actions">
          <Button
            icon={<SearchOutlined />}
            onClick={() => { setMobileMenuOpen(false); setTranscriptDrawerOpen(true) }}
            block
          >找回历史会话</Button>
          <Button
            icon={<FileTextOutlined />}
            onClick={() => { setMobileMenuOpen(false); setTemplateDrawerOpen(true) }}
            block
          >Prompt 模板</Button>
          <Button
            icon={<TrophyOutlined />}
            onClick={() => { setMobileMenuOpen(false); openDrawer('report') }}
            block
          >每日报表</Button>
          <Button
            icon={<BookOutlined />}
            onClick={() => { setMobileMenuOpen(false); openDrawer('wiki') }}
            block
          >记忆</Button>
          <Button
            icon={<LineChartOutlined />}
            onClick={() => { setMobileMenuOpen(false); openDrawer('stats') }}
            block
          >统计</Button>
          <Button
            icon={<SettingOutlined />}
            onClick={() => { setMobileMenuOpen(false); openDrawer('settings') }}
            block
          >设置</Button>
        </div>
      </Drawer>

      <SettingsDrawer open={settingsOpen} onClose={() => closeDrawer('settings')} />
      <StatsDrawer open={statsOpen} onClose={() => closeDrawer('stats')} />
      <WikiDrawer open={wikiOpen} onClose={() => closeDrawer('wiki')} />
      <ReportDrawer open={reportOpen} onClose={() => closeDrawer('report')} />
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
      <PipelineRunDrawer
        open={pipelineDrawerOpen}
        runId={pipelineActiveRun?.id ?? null}
        todoId={pipelineActiveTodo?.id ?? null}
        template={pipelineActiveTemplate}
        todoStatus={pipelineActiveTodo?.status ?? 'ai_running'}
        cwd={pipelineActiveTodo?.workDir ?? null}
        onClose={() => {
          setPipelineDrawerOpen(false)
          setPipelineActiveRun(null)
          setPipelineActiveTemplate(null)
          setPipelineActiveTodo(null)
          fetchTodos()
        }}
      />
      <Modal
        open={!!toolMissing}
        onCancel={() => setToolMissing(null)}
        title={toolMissing ? `AI 工具 ${toolMissing.tool} 未安装` : ''}
        footer={[
          <Button
            key="copy"
            type="primary"
            onClick={() => {
              if (toolMissing) {
                navigator.clipboard.writeText(toolMissing.fix)
                message.success('已复制到剪贴板')
              }
            }}
          >
            复制命令
          </Button>,
          <Button key="close" onClick={() => setToolMissing(null)}>关闭</Button>,
        ]}
      >
        {toolMissing && (
          <>
            <p>未找到可执行文件 <code>{toolMissing.bin}</code>。请在终端运行：</p>
            <pre style={{
              fontFamily: 'ui-monospace, monospace',
              background: '#f5f5f5',
              padding: 12,
              borderRadius: 4,
              userSelect: 'all',
            }}>{toolMissing.fix}</pre>
          </>
        )}
      </Modal>
      <WelcomeModal
        open={!welcomeDismissed}
        onClose={() => setWelcomeDismissed(true)}
      />
      </div>
    </div>
  )
}
