import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  Button, Space, Tag, Drawer, Form, Input, DatePicker, Empty, Image,
  Radio, Popconfirm, Spin, Tooltip, Select, Switch, Segmented, Modal,
} from 'antd'
import { useTranslation } from 'react-i18next'
import { useAppMessages } from './design/useAppMessages'
import {
  PlusOutlined,
  DeleteOutlined, CheckOutlined,
  ClockCircleOutlined, SearchOutlined,
  PlayCircleOutlined, SettingOutlined, CopyOutlined,
  CodeOutlined, DesktopOutlined, SendOutlined, EditOutlined,
  FileTextOutlined, ExportOutlined,
  BookOutlined, LineChartOutlined, TrophyOutlined,
  MenuOutlined, WarningOutlined,
} from '@ant-design/icons'
import { Plus as PlusIcon, Menu as MenuIcon } from 'lucide-react'
import { useIsMobile } from './hooks/useIsMobile'
import { useComments } from './hooks/useComments'
import { useRecurringRule } from './hooks/useRecurringRule'
import { useWorkDirPicker } from './hooks/useWorkDirPicker'
import {
  DndContext, closestCenter, PointerSensor, TouchSensor,
  useSensor, useSensors, DragOverlay, DragStartEvent,
  DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import dayjs from 'dayjs'
import {
  listTodos, createTodo, updateTodo, deleteTodo,
  startAiExec, deleteTodoAiSession,
  openTraeCN, openTerminal, openNativeAiResume,
  listLiveSessions,
  listTemplates, PromptTemplate,
  createRecurringRule,
  editorLabel, isEditorKind, type EditorKind,
  RecurringFrequency, RecurringRule,
  Todo, Quadrant, AiTool,
  runWiki, getWikiPending,
  uploadImage,
  stopAiExec,
  ApiError,
} from './api'
import { renderAppliedTemplates } from './promptRender'
import SettingsDrawer from './SettingsDrawer'
import { StatsReportsDrawer } from './components/StatsReportsDrawer'
import TelegramSyncButton from './TelegramSyncButton'
import WikiDrawer from './WikiDrawer'
import ExportDialog from './ExportDialog'
import TemplateDrawer from './TemplateDrawer'
import { WelcomeModal } from './onboarding/WelcomeModal'
import { useWelcomeDismissed } from './onboarding/useWelcomeDismissed'
import ForkDialog from './ForkDialog'
import TranscriptSearchDrawer from './transcripts/TranscriptSearchDrawer'
import { useAiSessionStore } from './store/aiSessionStore'
import { useTodoSnapshotStore } from './store/todoSnapshotStore'
import {
  buildUnreadSessionItems,
  type UnreadSessionItem,
} from './replyHub'
import { getTranscriptStats } from './api'
import { useUnreadStore, isSessionUnread } from './store/unreadStore'
import { useDrawerStackStore } from './store/drawerStackStore'
import { useDrawerStack } from './hooks/useDrawerStack'
import { useDispatchStore } from './store/dispatchStore'
import { useAppConfigStore } from './store/appConfigStore'
import { TopbarDispatch } from './components/TopbarDispatch'
import { BoardFilterPill } from './components/BoardFilterPill/BoardFilterPill'
import { QuadrantBoard, QuadrantZone } from './components/QuadrantBoard'
import {
  StatusBoard,
  backlogTodos as filterBacklogTodos,
  flattenSessions,
  sessionsByColumn,
} from './components/StatusBoard'
import { SortableTodoCard } from './components/TodoCard'
import './TodoManage.css'

const { TextArea } = Input

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

export function formatDueDate(ts: number | null | undefined): { label: string | null; overdue: boolean } {
  // Returns `label: null` when the todo has no due date; callers translate the
  // empty placeholder via t('todo:detail.dueEmpty') so the helper stays UI-free.
  if (!ts) return { label: null, overdue: false }
  return { label: dayjs(ts).format('MM-DD HH:mm'), overdue: ts < Date.now() }
}

function buildTodoPrompt(todo: Todo, templates: PromptTemplate[] = [], t: (k: any, o?: any) => string) {
  const templatePrefix = renderAppliedTemplates(todo, templates)
  const base = `${t('todo:prompt.header')}

${t('todo:prompt.titleLabel')}: ${todo.title}
${t('todo:prompt.descLabel')}: ${todo.description || t('todo:prompt.descEmpty')}

${t('todo:prompt.hintUnderstand')}
${t('todo:prompt.hintAfter')}`
  return templatePrefix ? `${templatePrefix}\n\n---\n\n${base}` : base
}

export type StatusChipKey = 'running' | 'pendingInteract' | 'pendingAccept' | 'done' | 'todo'

export function currentStatusLabel(status: Todo['status']): { key: StatusChipKey; className: string } {
  if (status === 'ai_running') return { key: 'running', className: 'status-chip-running' }
  if (status === 'ai_pending') return { key: 'pendingInteract', className: 'status-chip-pending' }
  if (status === 'ai_done') return { key: 'pendingAccept', className: 'status-chip-done' }
  if (status === 'done') return { key: 'done', className: 'status-chip-complete' }
  return { key: 'todo', className: 'status-chip-idle' }
}

export function todoDndId(todo: Todo) {
  return todo.parentId ? `subtodo:${todo.id}` : todo.id
}

function parseTodoDndId(id: string) {
  if (id.startsWith('subtodo:')) {
    return { todoId: id.slice('subtodo:'.length), kind: 'subtodo' as const }
  }
  return { todoId: id, kind: 'todo' as const }
}


// ─── 主页面 ───

export default function TodoManage() {
  const { message, modal } = useAppMessages()
  const { t } = useTranslation(['todo', 'errors', 'common'])
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
  // Board filter lives in dispatchStore so the CommandPalette / topbar can
  // drive it without TodoManage props. Map dispatchStore's 'all' → '' to keep
  // the existing TodoManage convention used throughout this file.
  const filterStatusRaw = useDispatchStore((s) => s.boardFilter)
  const setBoardFilter = useDispatchStore((s) => s.setBoardFilter)
  const filterStatus: 'todo' | 'done' | '' = filterStatusRaw === 'all' ? '' : filterStatusRaw
  const setFilterStatus = (next: 'todo' | 'done' | '') => setBoardFilter(next === '' ? 'all' : next)
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
      message.success(t('todo:message.attachUploaded', { name: path.split('/').pop() }))
    } catch (err) {
      message.error(t('errors:uploadFailed', { msg: (err as Error).message }))
    }
  }, [form, t])

  // 详情
  const [detailTodo, setDetailTodo] = useState<Todo | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [memorizing, setMemorizing] = useState(false)
  const [todoCoverage, setTodoCoverage] = useState<Record<string, boolean>>({})  // todoId → already applied

  // Recurring-rule subsystem (Modal + detail-drawer rule, extracted M4 cleanup)
  const {
    detailRule,
    loadDetailRule,
    describeRule,
    ruleModalOpen,
    ruleForm,
    openRuleEdit,
    closeRuleEdit,
    saveRule,
    stopRule,
  } = useRecurringRule()

  // Comments subsystem (extracted to dedicated hook in M4 cleanup)
  const {
    comments,
    loading: commentsLoading,
    text: commentText,
    setText: setCommentText,
    submitting: commentSubmitting,
    submit: submitComment,
    remove: removeComment,
  } = useComments(detailTodo?.id ?? null, { active: detailOpen })

  // 设置 (4 drawers lifted to dispatchStore in M2 T9)
  const settingsOpen = useDispatchStore((s) => s.settings)
  const wikiOpen = useDispatchStore((s) => s.wiki)
  // Note: `stats` + `report` flags are now consumed by <StatsReportsDrawer/>.
  const openDrawer = useDispatchStore((s) => s.openDrawer)
  const closeDrawer = useDispatchStore((s) => s.closeDrawer)
  const templateDrawerOpen = useDispatchStore((s) => s.template)
  const [transcriptDrawerOpen, setTranscriptDrawerOpen] = useState(false)
  const [toolMissing, setToolMissing] = useState<null | { tool: string; bin: string; fix: string }>(null)
  const [, setUnboundTranscripts] = useState(0)
  const isMobile = useIsMobile()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [viewMode] = useState<'list' | 'priority'>('list')
  const setLiveSessions = useAiSessionStore(s => s.setSessions)
  // WorkDir picker subsystem (extracted to dedicated hook in M4 cleanup).
  // Note: depends on `form` + `drawerOpen`, both declared earlier in this component.
  const onWorkDirLoadError = useCallback((e: unknown) => {
    message.error((e as any)?.message || t('errors:readDirFailed'))
  }, [message, t])
  const {
    workDirOptions,
    workDirRoot,
    workDirLoading,
    pickingWorkDir,
    pickWorkDir,
  } = useWorkDirPicker(form, drawerOpen, { onLoadError: onWorkDirLoadError })

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
  // stats + report are merged into a single StatsReportsDrawer (M4-T2);
  // that component owns its own useDrawerStack('statsReports', ...) registration.
  useDrawerStack('wiki', wikiOpen, () => closeDrawer('wiki'))
  useDrawerStack('template', templateDrawerOpen, () => closeDrawer('template'))
  useDrawerStack('transcript', transcriptDrawerOpen, () => setTranscriptDrawerOpen(false))
  // M2 T9: react to dispatchStore signals (jump-to-todo + request-new-todo from CommandPalette)
  const jumpToTodoId = useDispatchStore((s) => s.jumpToTodoId)
  const setJumpTo = useDispatchStore((s) => s.setJumpTo)
  const newTodoSignal = useDispatchStore((s) => s.signals.newTodo === true)
  const recoverSignal = useDispatchStore((s) => s.signals.recover === true)
  const refreshTodosSignal = useDispatchStore((s) => s.signals.refreshTodos === true)
  const consumeSignal = useDispatchStore((s) => s.consumeSignal)

  const resolveDefaultAppliedTemplateIds = useCallback((): string[] => {
    // 1. settings 里配的"默认套用模板"是首选来源；过滤掉已被删除的模板 id。
    const configured = useAppConfigStore.getState().defaultAppliedTemplateIds
    if (configured && configured.length) {
      const valid = configured.filter(id => templates.some(t => t.id === id))
      if (valid.length) return valid
    }
    // 2. 老用户没配过：沿用历史行为，默认勾选方案顾问（原 Brainstorm）。
    const brainstorm = templates.find(t => t.builtin && t.name === '方案顾问（脑爆）')
    return brainstorm ? [brainstorm.id] : []
  }, [templates])

  const openCreateDrawer = useCallback((parent: Todo | null = null) => {
    setEditingTodo(null)
    setParentForCreate(parent)
    form.resetFields()
    // 单选 agentId 初值：settings 里"默认套用模板"取第一个；老用户没配过则不预选。
    const defaultIds = resolveDefaultAppliedTemplateIds()
    const defaultAgentId = defaultIds[0] || null
    form.setFieldsValue({
      // quadrant / recurring / autoStartAi 已退役
      workDir: parent?.workDir || undefined,
      agentId: defaultAgentId,
    })
    setDrawerOpen(true)
  }, [resolveDefaultAppliedTemplateIds, form])

  useEffect(() => {
    if (!jumpToTodoId) return
    const el = document.querySelector(`[data-todo-id="${jumpToTodoId}"]`) as HTMLElement | null
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.classList.add('todo-card-flash')
      window.setTimeout(() => el.classList.remove('todo-card-flash'), 1200)
      setJumpTo(null)
      return
    }
    // Card isn't in the DOM — the board filter is hiding it (e.g. ⌘K jumped to a
    // done todo while filter is 'todo'). Widen to 'all' and let this effect retry
    // once the refetched list renders. Bail out if we're already on 'all'/'done'
    // and still can't find it, to avoid an infinite loop.
    if (lastFetchedFilter !== filterStatus) return
    if (filterStatus === 'todo') {
      setFilterStatus('')
      return
    }
    setJumpTo(null)
  }, [jumpToTodoId, todos, filterStatus, lastFetchedFilter, setJumpTo])

  useEffect(() => {
    if (!newTodoSignal) return
    openCreateDrawer()
    consumeSignal('newTodo')
  }, [newTodoSignal, openCreateDrawer, consumeSignal])

  useEffect(() => {
    if (!recoverSignal) return
    setTranscriptDrawerOpen(true)
    consumeSignal('recover')
  }, [recoverSignal, consumeSignal])

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

  // 把 todos 同步进 snapshot store，给 SessionFocus / TopbarDispatch 这些兄弟组件用作
  // live session 缺失时的 fallback。
  const setTodoSnapshot = useTodoSnapshotStore(s => s.setTodos)
  useEffect(() => { setTodoSnapshot(todos) }, [todos, setTodoSnapshot])

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

  // Open the SessionFocus overlay for this todo+session. The function name is kept so the many
  // internal callers (attention rail, fork, AI exec, native terminal, etc.) need no further churn —
  // see M3-T2 cleanup notes.
  const handleOpenTerminalInDock = useCallback((todo: Todo, sessionId: string) => {
    useDispatchStore.getState().openFocus(todo.id, sessionId)
  }, [])

  const handleFocusSessionById = useCallback((todoId: string, sessionId: string) => {
    const todo = todos.find(t => t.id === todoId)
    if (todo) handleOpenTerminalInDock(todo, sessionId)
  }, [todos, handleOpenTerminalInDock])

  const handleStopSession = useCallback(async (sessionId: string) => {
    // 乐观更新：先把 live store 翻 'stopped'，看板的 mergeLiveSession + deriveColumnFor
    // 立刻把卡片移出"运行中/待确认"列；不等后端 stop 往返 + 3s poll，避免点完 Cancel
    // 卡片还杵在原地的延迟感。失败时后端真状态会通过 3s poll 兜底回来。
    try {
      useAiSessionStore.getState().updateSessionStatus(sessionId, 'stopped', Date.now())
    } catch { /* live store 没这条记录无所谓，后端 stopped 事件会兜底 */ }
    stopAiExec(sessionId).catch((e: any) => {
      message.warning(`停止失败：${e?.message || 'unknown'}`)
    })
    useDispatchStore.getState().signal('refreshTodos')
  }, [message])

  /**
   * "× Close" idle session：
   *   1) 乐观更新 —— 立刻把 live store 里这条 session 翻到 'done' 状态，
   *      StatusBoard 的派生算法会马上把它从板上移除，用户点完没延迟感。
   *   2) 后端 stop 同步发出（不 await，让 PTY 异步死掉就行）。
   *   3) 弹个简洁的 Modal.confirm：要不要顺手把关联的待办也勾完成？
   *      —— 勾了的话走 updateTodo({status:'done'})，后端会把那个 todo
   *         下还活着的其它 session 一并关掉（routes/todos.js 已有逻辑）。
   */
  const handleCloseIdleSession = useCallback((session: Todo['aiSessions'][number], parent: Todo) => {
    // 1. 乐观：先翻 live store 状态，board 立刻反应
    try {
      useAiSessionStore.getState().updateSessionStatus(session.sessionId, 'done', Date.now())
    } catch { /* live store 没这条记录也没关系，后端 done 事件会兜底 */ }
    // 2. 后端 stop —— 失败 toast 提示，但不回滚乐观状态（用户已经看到关闭了）
    stopAiExec(session.sessionId).catch((e: any) => {
      message.warning(`关闭失败：${e?.message || 'unknown'}`)
    })
    useDispatchStore.getState().signal('refreshTodos')
    // 3. 顺便问一句"待办也完成？"
    if (parent.status === 'done' || parent.status === 'missed') return  // 待办本来就已完成 / missed，不弹
    modal.confirm({
      title: '同时把待办标记为完成？',
      content: parent.title,
      okText: '完成待办',
      cancelText: '只关 session',
      okButtonProps: { type: 'primary' },
      onOk: async () => {
        try {
          await updateTodo(parent.id, { status: 'done' })
          useDispatchStore.getState().signal('refreshTodos')
        } catch (e: any) {
          message.error(`标记完成失败：${e?.message || 'unknown'}`)
        }
      },
    })
  }, [message, modal])

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

  // splitV/splitH 状态由 <QuadrantBoard /> 内部维护

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
      message.error(e?.message || t('errors:network'))
    }
    setLoading(false)
  }, [filterStatus, keyword, t])

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

  // App-level config (e.g. defaultPermissionMode) is read once at startup so
  // new sessions can inherit the saved 托管模式 when localStorage is empty.
  useEffect(() => { void useAppConfigStore.getState().load() }, [])

  // CommandPalette's "恢复到待办" mutates a todo via the API directly, so the
  // board needs an explicit refetch hint to pick up the new status.
  useEffect(() => {
    if (!refreshTodosSignal) return
    consumeSignal('refreshTodos')
    fetchTodos()
  }, [refreshTodosSignal, consumeSignal, fetchTodos])

  // ─── 按象限分组 ───

  const todosByQuadrant = useMemo(() => {
    const groups: Record<number, Todo[]> = { 1: [], 2: [], 3: [], 4: [] }
    for (const t of todos) {
      if (t.parentId) continue
      const q = t.quadrant || 4
      if (groups[q]) groups[q].push(t)
    }
    // Sort each quadrant according to the active filter:
    //   'done'  → most recently completed first (completedAt DESC, with updatedAt fallback for legacy rows)
    //   'todo'  → manual sortOrder DESC（最新创建 / 手动置顶在最上）
    //   ''(all) → undone block (sortOrder DESC) on top, then done block (completedAt DESC)
    const doneRank = (t: Todo) => t.completedAt || t.updatedAt || 0
    for (const q of Object.keys(groups)) {
      const arr = groups[Number(q)]
      if (filterStatus === 'done') {
        arr.sort((a, b) => doneRank(b) - doneRank(a))
      } else if (filterStatus === 'todo') {
        arr.sort((a, b) => (b.sortOrder || 0) - (a.sortOrder || 0))
      } else {
        arr.sort((a, b) => {
          const aDone = a.status === 'done' ? 1 : 0
          const bDone = b.status === 'done' ? 1 : 0
          if (aDone !== bDone) return aDone - bDone
          if (aDone === 1) return doneRank(b) - doneRank(a)
          return (b.sortOrder || 0) - (a.sortOrder || 0)
        })
      }
    }
    return groups
  }, [todos, filterStatus])

  // ─── 按优先级扁平化（用于「优先级」视图） ───
  const priorityList = useMemo(() => {
    const flat: Todo[] = []
    for (const q of [1, 2, 3, 4] as const) {
      flat.push(...(todosByQuadrant[q] || []))
    }
    return flat
  }, [todosByQuadrant])

  // ─── CRUD ───

  const handleCreate = () => {
    openCreateDrawer()
  }

  const handleCreateSubtodo = (todo: Todo) => {
    openCreateDrawer(todo)
  }

  const handleEdit = (todo: Todo) => {
    setParentForCreate(null)
    setEditingTodo(todo)
    form.resetFields()
    form.setFieldsValue({
      title: todo.title,
      description: todo.description,
      // quadrant 已退役：不读 / 不写
      dueDate: todo.dueDate ? dayjs(todo.dueDate) : null,
      workDir: todo.workDir || undefined,
      brainstorm: !!todo.brainstorm,
      // 旧数据可能含多个 templateIds：编辑时只展示第一个，保存时也只保留这一个
      agentId: (todo.appliedTemplateIds || [])[0] || null,
    })
    setDrawerOpen(true)
  }

  const handlePickWorkDir = useCallback(async () => {
    try {
      await pickWorkDir()
    } catch (e: any) {
      message.error(e?.message || t('errors:pickDirFailed'))
    }
  }, [pickWorkDir, message, t])

  const handleSave = async () => {
    try {
      const values = await form.validateFields()
      // 单选 agentId（可空）。选了 = 立即派活（autoStart 隐式 true）；不选 = 只建 todo。
      const agentId: string | null = values.agentId || null
      const data = {
        title: values.title,
        description: values.description || '',
        dueDate: values.dueDate ? values.dueDate.valueOf() : null,
        workDir: values.workDir || null,
        brainstorm: !!values.brainstorm,
        appliedTemplateIds: agentId ? [agentId] : [],
        parentId: parentForCreate?.id ?? undefined,
      }

      if (editingTodo) {
        await updateTodo(editingTodo.id, { ...data, parentId: editingTodo.parentId })
        message.success(t('todo:message.updated'))
        setDrawerOpen(false)
        setEditingTodo(null)
        setParentForCreate(null)
        fetchTodos()
      } else {
        const newTodo = await createTodo(data)
        message.success(parentForCreate ? t('todo:message.subtodoCreated') : t('todo:message.created'))
        setDrawerOpen(false)
        setEditingTodo(null)
        setParentForCreate(null)
        if (agentId) {
          // 指派了 agent → 立即用 settings 配的默认工具启动会话。
          const tool = (useAppConfigStore.getState().defaultAiTool || 'claude') as AiTool
          await handleAiExec(newTodo, tool)
        } else {
          fetchTodos()
        }
      }
    } catch (e: any) {
      if (e?.message) message.error(e.message)
    }
  }

  const handleToggleDone = async (todo: Todo) => {
    const newStatus = todo.status === 'done' ? 'todo' : 'done'
    const liveCount = newStatus === 'done'
      ? (todo.aiSessions || []).filter((s) => s.status === 'running' || s.status === 'idle' || s.status === 'pending_confirm').length
      : 0
    const doUpdate = async () => {
      try {
        // 标 done 之前先把这条 todo 名下所有 session 的 lastSeenAt 顶到当前，
        // 这样顶栏「待确认」pill 立刻减一——后端 pty.stop 是异步的，session.status
        // 翻到 'stopped' 走 WS 还有几百毫秒延迟，期间默认 'todo' filter 视图下
        // todo 已经从列表里消失，没法靠 replyHub 的 doneTodoIds 兜底过滤。
        if (newStatus === 'done') {
          const markSeen = useUnreadStore.getState().markSeen
          const now = Date.now()
          const seen = new Set<string>()
          for (const s of todo.aiSessions || []) {
            if (s?.sessionId) seen.add(s.sessionId)
          }
          if (todo.aiSession?.sessionId) seen.add(todo.aiSession.sessionId)
          for (const sid of seen) markSeen(sid, now)
        }
        await updateTodo(todo.id, { status: newStatus })
        fetchTodos()
      } catch (e: any) {
        message.error(e?.message || t('errors:opFailed'))
      }
    }
    if (liveCount > 0) {
      modal.confirm({
        title: t('todo:confirm.runningTitle'),
        content: t('todo:confirm.runningContent', { count: liveCount }),
        okText: t('todo:confirm.runningOk'),
        cancelText: t('common:cancel'),
        onOk: doUpdate,
      })
      return
    }
    await doUpdate()
  }

  const handleDelete = async (todo: Todo) => {
    try {
      await deleteTodo(todo.id)
      message.success(t('todo:message.deleted'))
      fetchTodos()
    } catch (e: any) {
      message.error(e?.message || t('errors:deleteFailed'))
    }
  }

  const handleDeleteAiSession = useCallback(async (todo: Todo, session: Todo['aiSessions'][number], currentSessionId?: string | null) => {
    try {
      const nextTodo = await deleteTodoAiSession(todo.id, session.sessionId)
      message.success(t('todo:message.historyDeleted'))
      if (currentSessionId === session.sessionId) {
        const nextSession = nextTodo.aiSessions[0]
        if (nextSession) {
          handleOpenTerminalInDock(todo, nextSession.sessionId)
        }
      }
      fetchTodos()
    } catch (e: any) {
      message.error(e?.message || t('errors:deleteHistoryFailed'))
    }
  }, [fetchTodos, handleOpenTerminalInDock, t])

  // ─── 重复规则 ───
  // Most logic now lives in useRecurringRule(). The wrappers below preserve
  // the original toast UX (message.success/error) which the hook intentionally
  // does not own.

  const handleRuleSave = useCallback(async () => {
    try {
      const res = await saveRule()
      if (res.status === 'invalid') { message.error(res.reason); return }
      if (res.status === 'noop') return
      message.success(t('todo:message.ruleUpdated'))
    } catch (e: any) {
      message.error(e?.message || t('errors:ruleSaveFailed'))
    }
  }, [saveRule, t])

  const handleStopRule = useCallback(async (ruleId: string) => {
    try {
      await stopRule(ruleId)
      message.success(t('todo:message.ruleStopped'))
    } catch (e: any) {
      message.error(e?.message || t('errors:ruleStopFailed'))
    }
  }, [stopRule, t])

  // ─── 详情 ───

  const openDetail = (todo: Todo) => {
    setDetailTodo(todo)
    setDetailOpen(true)
    loadDetailRule(todo.recurringRuleId || null)
    // Comments are loaded by useComments() once detailOpen + detailTodo.id flip.
  }

  const handleMemorize = useCallback(async (todo: Todo, force = false) => {
    if (memorizing) return
    const already = todoCoverage[todo.id]
    if (already && !force) {
      modal.confirm({
        title: t('todo:confirm.memorizedTitle'),
        content: t('todo:confirm.memorizedContent'),
        onOk: () => handleMemorize(todo, true),
      })
      return
    }
    setMemorizing(true)
    try {
      const res = await runWiki({ todoIds: [todo.id], dryRun: false })
      message.success(t('todo:message.memorizeOk', { count: res.sourcesWritten }))
      setTodoCoverage((prev) => ({ ...prev, [todo.id]: true }))
    } catch (e: any) {
      message.error(t('errors:memorizeFailed', { msg: e.message }))
    } finally { setMemorizing(false) }
  }, [memorizing, todoCoverage, t])

  useEffect(() => {
    if (!detailTodo) return
    getWikiPending().then((list) => {
      const isPending = list.some((p) => p.id === detailTodo.id)
      setTodoCoverage((prev) => ({ ...prev, [detailTodo.id]: !isPending && detailTodo.status === 'done' }))
    }).catch(() => { /* silent */ })
  }, [detailTodo?.id])

  const handleAddComment = async () => {
    try {
      await submitComment()
    } catch (e: any) {
      message.error(e?.message || t('errors:addCommentFailed'))
    }
  }

  const handleDeleteComment = async (commentId: string) => {
    try {
      await removeComment(commentId)
    } catch (e: any) {
      message.error(e?.message || t('errors:deleteCommentFailed'))
    }
  }

  // ─── AI 执行 ───

  const handleAiExec = useCallback(async (todo: Todo, tool: AiTool, session?: Todo['aiSessions'][number]) => {
    try {
      const prompt = session?.prompt || buildTodoPrompt(todo, templates, t)
      // 读取托管模式：浏览器内手动覆盖 (localStorage) > 设置里的全局默认 (config) > undefined。
      // 这样新启动/恢复会话时能直接通过原生 CLI 标志生效，不依赖运行时的正则兜底。
      let permissionMode: string | null = null
      try { permissionMode = localStorage.getItem('quadtodo.autoMode') } catch { /* ignore */ }
      if (!permissionMode) permissionMode = useAppConfigStore.getState().defaultPermissionMode
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
      message.error(e?.message || t('errors:aiStartFailed'))
    }
  }, [fetchTodos, templates, handleOpenTerminalInDock, t])

  // Expose handleAiExec to CommandPalette via dispatchStore. Register once on
  // mount; use refs so palette clicks always pick up the latest closure +
  // todos without re-registering on every render.
  const handleAiExecRef = useRef(handleAiExec)
  const todosForAiRef = useRef(todos)
  useEffect(() => { handleAiExecRef.current = handleAiExec }, [handleAiExec])
  useEffect(() => { todosForAiRef.current = todos }, [todos])
  useEffect(() => {
    const fn = (todoId: string, tool: AiTool) => {
      const todo = todosForAiRef.current.find(t => t.id === todoId)
      if (!todo) {
        message.error(t('errors:todoNotFound'))
        return
      }
      void handleAiExecRef.current(todo, tool)
    }
    useDispatchStore.getState().registerStartAiSession(fn)
    return () => { useDispatchStore.getState().unregisterStartAiSession() }
  }, [message, t])

  const handleRequestFork = useCallback((todo: Todo, sessionId: string) => {
    setForkTarget({ todo, sessionId })
  }, [])

  const handleForkConfirm = useCallback(async (r: { prompt: string; targetTodoId: string; tool: AiTool; cwd: string | null }) => {
    setForkTarget(null)
    try {
      let permissionMode: string | null = null
      try { permissionMode = localStorage.getItem('quadtodo.autoMode') } catch { /* ignore */ }
      if (!permissionMode) permissionMode = useAppConfigStore.getState().defaultPermissionMode
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
      message.success(t('todo:message.forkOk'))
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 424 && e.body?.code === 'tool_missing') {
        setToolMissing({ tool: e.body.tool, bin: e.body.bin, fix: e.body.fix })
        return
      }
      message.error(e?.message || t('errors:forkStartFailed'))
    }
  }, [fetchTodos, todos, handleOpenTerminalInDock, t])

  // ─── 拖拽 ───

  const handleDragStart = (event: DragStartEvent) => {
    const { todoId } = parseTodoDndId(String(event.active.id))
    setActiveId(todoId)
  }

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveId(null)
    const { active, over } = event
    if (!over) return

    // Done-only view is sorted by completedAt, so manual sortOrder writes would
    // be invisible after the next render. Block the drop with a friendly hint.
    if (filterStatus === 'done') {
      message.info(t('todo:message.doneViewDragBlocked'))
      return
    }

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
        message.error(e?.message || t('errors:subtodoSortFailed'))
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
      message.info(t('todo:message.crossQuadrantBlocked'))
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
        message.error(e?.message || t('errors:moveFailed'))
        fetchTodos()
      }
      return
    }

    if (!overParsed) return
    // Display is DESC by sortOrder (newest on top), so qTodos must mirror that:
    // index 0 is the highest sortOrder, indices grow downward.
    const qTodos = todos.filter(t => t.quadrant === targetQuadrant && !t.parentId).sort((a, b) => (b.sortOrder || 0) - (a.sortOrder || 0))
    const oldIdx = qTodos.findIndex(t => t.id === draggedTodo.id)
    const newIdx = qTodos.findIndex(t => t.id === overParsed.todoId)
    if (oldIdx === -1 || newIdx === -1 || oldIdx === newIdx) return

    const reordered = arrayMove(qTodos, oldIdx, newIdx)
    // In a DESC list, the neighbor above (newIdx-1) has a HIGHER sortOrder,
    // the neighbor below (newIdx+1) has a LOWER sortOrder. The midpoint math
    // is direction-agnostic: it just needs prev != next.
    const aboveSort = newIdx > 0 ? (reordered[newIdx - 1].sortOrder || 0) : 0
    const belowSort = newIdx < reordered.length - 1 ? (reordered[newIdx + 1].sortOrder || 0) : 0
    // Top slot: place above the current max (max + 1024).
    // Bottom slot: place below the current min (min - 1024, but never below 1).
    let newSort: number
    if (newIdx === 0) {
      newSort = (reordered[1]?.sortOrder || 0) + 1024
    } else if (newIdx === reordered.length - 1) {
      newSort = Math.max(1, (reordered[newIdx - 1]?.sortOrder || 0) - 1024)
    } else {
      newSort = Math.round((aboveSort + belowSort) / 2)
    }
    const prev = aboveSort
    const next = belowSort

    if (newSort === prev || newSort === next) {
      const updates: { id: string; sortOrder: number }[] = []
      // DESC display: top item (i=0) must get the HIGHEST sortOrder.
      reordered.forEach((t, i) => {
        updates.push({ id: t.id, sortOrder: (reordered.length - i) * 1024 })
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
        message.error(e?.message || t('errors:sortFailed'))
        fetchTodos()
      }
    }
  }

  const handleOpenTrae = useCallback(async (todo: Todo, editorArg?: EditorKind) => {
    let editor: EditorKind = editorArg ?? 'trae-cn'
    if (!editorArg) {
      try {
        const saved = localStorage.getItem('quadtodo.editor')
        if (isEditorKind(saved)) editor = saved
      } catch {}
    }
    try { localStorage.setItem('quadtodo.editor', editor) } catch {}
    const cwd = todo.workDir || undefined
    const label = editorLabel(editor)
    try {
      await openTraeCN(cwd || '', editor)
      message.success(t('todo:message.openedEditor', { label }))
    } catch (e: any) {
      message.error(e?.message || t('errors:openEditorFailed', { label }))
    }
  }, [t])

  const handleOpenTerminal = useCallback(async (todo: Todo) => {
    const cwd = todo.workDir || undefined
    try {
      const { sessionId } = await openTerminal(cwd || '')
      handleOpenTerminalInDock(todo, sessionId)
    } catch (e: any) {
      message.error(e?.message || t('errors:openTerminalFailed'))
    }
  }, [handleOpenTerminalInDock, t])

  const handleOpenNativeResume = useCallback(async (todo: Todo, session: Todo['aiSessions'][number]) => {
    const cwd = session.cwd || todo.workDir || undefined
    const nativeSessionId = session.nativeSessionId
    if (!nativeSessionId) {
      message.error(t('errors:missingNativeSessionId'))
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
        message.warning(t('todo:message.localResumeNoRoute'))
      } else if (warnings.includes('hooks_not_installed') || warnings.includes('hook_script_missing')) {
        message.warning(t('todo:message.localResumeNoHooks'))
      } else {
        message.success(t('todo:message.localResumeOk'))
      }
    } catch (e: any) {
      message.error(e?.message || t('errors:localResumeFailed'))
    }
  }, [fetchTodos, t])

  const [exportTarget, setExportTarget] = useState<Todo | null>(null)
  const handleExport = useCallback((todo: Todo) => {
    setExportTarget(todo)
  }, [])

  const activeTodo = activeId ? todos.find(t => t.id === activeId) : null

  const closeDetail = () => {
    setDetailOpen(false)
    setDetailTodo(null)
    loadDetailRule(null)
  }

  // ─── 渲染 ───

  return (
    <div className="todo-manage-shell">
      <div className="todo-manage__main">
      {!isMobile && (
        <TopbarDispatch
          unreadItems={unreadItems}
          onJump={handleOpenAttentionItem}
          onFocusSession={handleFocusSessionById}
          onStopSession={handleStopSession}
        />
      )}
      {isMobile && (
        <div className="todo-sticky-header">
          {/* 顶部工具行：BoardFilterPill 复用桌面下拉筛选 + 新建/菜单图标按钮。
              移动端不再提供搜索框，搜索请用桌面端 ⌘K 命令面板。 */}
          <div className="todo-mobile-toolbar">
            <BoardFilterPill />
            <div style={{ flex: 1 }} />
            <Tooltip title={t('todo:board.create')}>
              <button
                type="button"
                className="topbar-icon-btn"
                onClick={handleCreate}
                aria-label={t('todo:board.create')}
                data-testid="mobile-new-btn"
              >
                <PlusIcon size={18} />
              </button>
            </Tooltip>
            <Tooltip title={t('todo:board.menuTooltip')}>
              <button
                type="button"
                className="topbar-icon-btn"
                onClick={() => setMobileMenuOpen(true)}
                aria-label={t('todo:board.menu')}
                data-testid="mobile-menu-btn"
              >
                <MenuIcon size={18} />
              </button>
            </Tooltip>
          </div>
        </div>
      )}
      {/* Mounted invisibly so the CommandPalette "Telegram sync" command can trigger
          its preview/sync flow via dispatchStore.signal('telegramSync') (M4-T4). */}
      <div style={{ display: 'none' }}>
        <TelegramSyncButton />
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
                      agents={templates}
                      onCreateSubtodo={handleCreateSubtodo}
                      onClick={openDetail}
                      onToggleDone={handleToggleDone}
                      onAiExec={handleAiExec}
                      onRequestFork={handleRequestFork}
                      onDeleteAiSession={handleDeleteAiSession}
                      onDelete={handleDelete}
                      onOpenTrae={handleOpenTrae}
                      onOpenTerminal={handleOpenTerminal}
                      onOpenNativeResume={handleOpenNativeResume}
                      onExport={handleExport}
                      isNarrow={isNarrow}
                      onRefresh={fetchTodos}
                      highlightTodoId={highlightTodoId}
                    />
                  ))}
                  {priorityList.length === 0 && (
                    <div className="todo-drop-placeholder">{t('todo:board.emptyPlaceholder')}</div>
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
          {(() => {
            // StatusBoard：4 列看板
            //   Backlog（TodoCard）—— 手动 Done 才离开
            //   In Progress / Needs Input / Idle（SessionCard）—— 按 session.status 派生
            const showDone = filterStatus === 'done' || filterStatus === ''
            const backlogAll = filterBacklogTodos(todos, showDone)
            // Backlog 列内按 sortOrder（'todo' filter，新→旧）或 completedAt desc（'done' filter）排序
            const doneRank = (x: Todo) => x.completedAt || x.updatedAt || 0
            const backlogSorted = [...backlogAll].sort((a, b) => {
              if (filterStatus === 'done') return doneRank(b) - doneRank(a)
              if (filterStatus === 'todo') return (b.sortOrder || 0) - (a.sortOrder || 0)
              const aDone = a.status === 'done' ? 1 : 0
              const bDone = b.status === 'done' ? 1 : 0
              if (aDone !== bDone) return aDone - bDone
              if (aDone === 1) return doneRank(b) - doneRank(a)
              return (b.sortOrder || 0) - (a.sortOrder || 0)
            })
            const dndIds = backlogSorted.map((x) => todoDndId(x))

            // 右 3 列：从所有 todos 拍平 sessions。
            // - 注入 liveSessionsMap：让 WebSocket / 3s-poll 推过来的 status 实时
            //   覆盖 REST 拉到的 snapshot，状态变化无需刷新页面也会重新分桶。
            // - 注入 unread 判定：idle + 用户还没看 = 留"需确认"；idle + 已读 = 进"已空闲"。
            const isUnreadPred = (s: import('./api').AiSession) =>
              isSessionUnread(s.lastTurnDoneAt, lastSeenMap.get(s.sessionId))
            const sessionsCol = sessionsByColumn(
              flattenSessions(todos),
              isUnreadPred,
              liveSessionsMap,
            )

            const renderBacklogTodo = (todo: Todo) => (
              <SortableTodoCard
                todo={todo}
                children={childrenByParentId[todo.id] || []}
                childHitIds={childHitIdsByParentId[todo.id]}
                agents={templates}
                onCreateSubtodo={handleCreateSubtodo}
                onClick={openDetail}
                onToggleDone={handleToggleDone}
                onAiExec={handleAiExec}
                onRequestFork={handleRequestFork}
                onDeleteAiSession={handleDeleteAiSession}
                onDelete={handleDelete}
                onOpenTrae={handleOpenTrae}
                onOpenTerminal={handleOpenTerminal}
                onOpenNativeResume={handleOpenNativeResume}
                onExport={handleExport}
                isNarrow={isNarrow}
                onRefresh={fetchTodos}
                highlightTodoId={highlightTodoId}
              />
            )

            return (
              <StatusBoard
                backlogTodos={backlogSorted}
                backlogDndIds={dndIds}
                renderBacklogItem={renderBacklogTodo}
                sessions={sessionsCol}
                agents={templates}
                onOpenSession={(s, parent) => handleOpenTerminalInDock(parent, s.sessionId)}
                onOpenParent={(parent) => openDetail(parent)}
                onCancelSession={(s) => { handleStopSession(s.sessionId).catch(() => {}) }}
                onConfirmSession={(s, parent) => handleOpenTerminalInDock(parent, s.sessionId)}
                onCloseIdle={(s, parent) => handleCloseIdleSession(s, parent)}
                onReopenIdle={(s, parent) => handleOpenTerminalInDock(parent, s.sessionId)}
              />
            )
          })()}
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
        title={editingTodo ? t('todo:drawer.editTitle') : parentForCreate ? t('todo:drawer.createSubtodoTitle', { title: parentForCreate.title }) : t('todo:drawer.createTitle')}
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false)
          setEditingTodo(null)
          setParentForCreate(null)
          form.resetFields()
        }}
        width={640}
        extra={
          <Button type="primary" onClick={handleSave}>{t('common:save')}</Button>
        }
      >
        <Form form={form} layout="vertical" size="small">
          <Form.Item name="title" label={t('todo:form.titleLabel')} rules={[{ required: true, message: t('todo:form.titleRequired') }]}>
            <Input placeholder={t('todo:form.titlePlaceholder')} />
          </Form.Item>
          <Form.Item name="description" label={t('todo:form.descLabel')} extra={t('todo:form.descExtra')}>
            <TextArea
              ref={descTextAreaRef}
              rows={3}
              placeholder={t('todo:form.descPlaceholder')}
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
          {/* 指派 Agent — 单选，可选；选了即代表"创建后立即派他干活"（autoStart=true）。
              不选 = 仅创建 todo，等用户手动 Start。所以原先的"创建后自动启动 AI" 开关
              和"启用模板"开关一并退役。
              下拉里置顶一个"自由模式"显式 item，跟 TodoCard 的派活下拉对齐——
              比让用户去摸 allowClear 的 × 直观得多。点它走 normalize 把表单值还原成
              undefined，Select 仍显示 placeholder，提交时进 else 分支不起会话。 */}
          <Form.Item
            name="agentId"
            label={t('todo:form.agentLabel')}
            extra={t('todo:form.agentExtra')}
            normalize={(v) => (v === '__noAgent__' ? undefined : v)}
          >
            <Select
              allowClear
              placeholder={templates.length ? t('todo:form.agentPlaceholder') : t('todo:form.appliedTemplatesEmpty')}
              options={[
                {
                  value: '__noAgent__',
                  // 自由模式 label 留纯字符串：search filter 不会因为 JSX 崩；
                  // 视觉上的"特殊性"用 optionRender 单独处理。
                  label: t('todo:card.dispatchNoAgent', { defaultValue: '自由模式（不指派 agent）' }),
                },
                ...templates.map(tpl => ({ value: tpl.id, label: tpl.builtin ? t('todo:form.templateBuiltinLabel', { name: tpl.name }) : tpl.name })),
              ]}
              optionRender={(option) => option.value === '__noAgent__'
                ? <span style={{ fontStyle: 'italic', opacity: 0.85 }}>{option.label as string}</span>
                : (option.label as React.ReactNode)
              }
              // 自由模式 item 始终展示在顶部，不参与文字过滤
              filterOption={(input, option) => {
                if (option?.value === '__noAgent__') return true
                return String(option?.label ?? '').toLowerCase().includes(input.toLowerCase())
              }}
              showSearch
            />
          </Form.Item>
          <Form.Item
            label={t('todo:form.workDirLabel')}
            extra={workDirRoot ? t('todo:form.workDirRootHint', { root: workDirRoot }) : t('todo:form.workDirRootMissing')}
          >
            <Space.Compact block>
              <Form.Item name="workDir" noStyle>
                <Input allowClear placeholder={t('todo:form.workDirPlaceholder')} />
              </Form.Item>
              <Button loading={pickingWorkDir} onClick={handlePickWorkDir}>{t('todo:form.pickWorkDir')}</Button>
            </Space.Compact>
            <div style={{ marginTop: 8 }}>
              <Select
                allowClear
                showSearch
                loading={workDirLoading}
                placeholder={t('todo:form.workDirSubfolderPlaceholder')}
                options={workDirOptions}
                optionFilterProp="label"
                value={workDirOptions.some(item => item.value === selectedWorkDir) ? selectedWorkDir : undefined}
                onChange={(value) => form.setFieldValue('workDir', value)}
              />
            </div>
          </Form.Item>
          {/* 重复待办：UI 已退役（与基础新建场景重复）；DB / 后端 recurring-rules 路由仍保留，
              老规则照常出 instance。需要重新建议规则时，从 CommandPalette / MCP 创建。 */}
          <Form.Item name="dueDate" label={t('todo:form.dueDateLabel')}>
            <DatePicker showTime style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Drawer>

      {/* 详情 Drawer */}
      <Drawer
        title={detailTodo?.title || t('todo:drawer.detailTitle')}
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
                message.success(t('todo:message.accepted'))
                closeDetail()
                fetchTodos()
              }}>{t('todo:detail.accept')}</Button>
            )}
            {/* 沉淀到记忆按钮暂时隐藏，待 wiki 重新设计后再开放
            {detailTodo && (
              <Button
                size="small" type="text"
                onClick={() => handleMemorize(detailTodo)}
                loading={memorizing}
              >
                {todoCoverage[detailTodo.id] ? t('todo:detail.memorized') : t('todo:detail.memorize')}
              </Button>
            )}
            */}
            {detailTodo && (
              <Button size="small" icon={<EditOutlined />} onClick={() => { closeDetail(); handleEdit(detailTodo) }}>{t('common:edit')}</Button>
            )}
          </Space>
        }
      >
        {detailTodo && (() => {
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
                <span className={`todo-detail-chip todo-detail-chip--status ${status.className}`}>
                  <span className="todo-detail-chip__label">{t('todo:detail.statusLabel')}</span>
                  <span className="todo-detail-chip__value">{t(`todo:status.${status.key}`)}</span>
                </span>
                <span className="todo-detail-chip todo-detail-chip--level">
                  <span className="todo-detail-chip__label">{t('todo:detail.levelLabel')}</span>
                  <span className="todo-detail-chip__value">{detailTodo.parentId ? t('todo:detail.levelSubtodo') : t('todo:detail.levelTop')}</span>
                </span>
                <Tooltip title={t('todo:detail.dueTooltip')}>
                  <button
                    type="button"
                    className={`todo-detail-chip todo-detail-chip--due ${due.overdue ? 'is-overdue' : ''}`}
                    onClick={handleChipClick}
                  >
                    {due.overdue && <WarningOutlined />}
                    <span className="todo-detail-chip__label">{t('todo:detail.dueLabel')}</span>
                    <span className="todo-detail-chip__value">{due.label ?? t('todo:detail.dueEmpty')}</span>
                  </button>
                </Tooltip>
                <Tooltip title={t('todo:detail.workDirTooltip')}>
                  <button
                    type="button"
                    className="todo-detail-chip todo-detail-chip--workdir"
                    onClick={() => {
                      const v = detailTodo.workDir || ''
                      if (!v) return
                      navigator.clipboard?.writeText(v).then(
                        () => message.success(t('todo:message.workDirCopied')),
                        () => message.error(t('errors:copyFailed')),
                      )
                    }}
                  >
                    <span className="todo-detail-chip__label">{t('todo:detail.workDirLabel')}</span>
                    <code className="todo-detail-chip__value">{detailTodo.workDir || t('todo:detail.workDirDefault')}</code>
                    <CopyOutlined />
                  </button>
                </Tooltip>
              </div>

              {/* Section B — recurring rule banner */}
              {detailRule && (
                <div className="todo-detail-recurring">
                  <Space size="small" wrap>
                    <Tag color={detailRule.active ? 'green' : 'default'}>{detailRule.active ? t('todo:detail.recurringActive') : t('todo:detail.recurringStopped')}</Tag>
                    <span className="todo-detail-recurring__text">{describeRule(detailRule)}</span>
                  </Space>
                  {detailRule.active && (
                    <Space size="small">
                      <Button size="small" onClick={() => openRuleEdit(detailRule)}>{t('todo:detail.editRule')}</Button>
                      <Popconfirm title={t('todo:detail.stopRuleConfirm')} onConfirm={() => handleStopRule(detailRule.id)}>
                        <Button size="small" danger>{t('todo:detail.stopRule')}</Button>
                      </Popconfirm>
                    </Space>
                  )}
                </div>
              )}

              {/* Section C — description card */}
              <div className="todo-detail-description">
                {!hasText && !hasImage && (
                  <p className="todo-detail-description__empty">{t('todo:detail.emptyDescription')}</p>
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
                <div className="todo-detail-comments__header">{t('todo:detail.commentsHeader', { count: comments.length })}</div>

                <div className="todo-detail-comments__composer">
                  <Input.TextArea
                    value={commentText}
                    onChange={e => setCommentText(e.target.value)}
                    placeholder={t('todo:detail.commentPlaceholder')}
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
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('todo:detail.commentEmpty')} />
                  )}
                  <div className="todo-detail-comments__list">
                    {comments.map(c => (
                      <div key={c.id} className="todo-detail-comment">
                        <div className="todo-detail-comment__avatar">✍️</div>
                        <div className="todo-detail-comment__body">
                          <div className="todo-detail-comment__meta">
                            <span className="todo-detail-comment__time">{dayjs(c.createdAt).format('YYYY-MM-DD HH:mm')}</span>
                            <Popconfirm title={t('todo:detail.commentDeleteConfirm')} onConfirm={() => handleDeleteComment(c.id)}>
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
        title={t('todo:drawer.ruleModalTitle')}
        open={ruleModalOpen}
        onCancel={closeRuleEdit}
        onOk={handleRuleSave}
        okText={t('common:save')}
        cancelText={t('common:cancel')}
        destroyOnClose
      >
        <Form form={ruleForm} layout="vertical" size="small">
          <Form.Item name="title" label={t('todo:form.titleLabel')} rules={[{ required: true, message: t('todo:form.titleRequired') }]}>
            <Input placeholder={t('todo:form.ruleTitlePlaceholder')} />
          </Form.Item>
          <Form.Item name="description" label={t('todo:form.descLabel')}>
            <TextArea rows={2} placeholder={t('todo:form.ruleDescPlaceholder')} />
          </Form.Item>
          <Form.Item name="frequency" label={t('todo:form.frequencyLabel')}>
            <Segmented
              options={[
                { label: t('todo:form.frequencyDaily'), value: 'daily' },
                { label: t('todo:form.frequencyWeekly'), value: 'weekly' },
                { label: t('todo:form.frequencyMonthly'), value: 'monthly' },
              ]}
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(p, n) => p.frequency !== n.frequency}>
            {({ getFieldValue }) => {
              const freq = getFieldValue('frequency') as RecurringFrequency
              if (freq === 'weekly') {
                return (
                  <Form.Item name="weekdays" label={t('todo:form.weekdaysLabel')}>
                    <Select
                      mode="multiple"
                      options={[
                        { value: 1, label: t('todo:form.weekday.mon') },
                        { value: 2, label: t('todo:form.weekday.tue') },
                        { value: 3, label: t('todo:form.weekday.wed') },
                        { value: 4, label: t('todo:form.weekday.thu') },
                        { value: 5, label: t('todo:form.weekday.fri') },
                        { value: 6, label: t('todo:form.weekday.sat') },
                        { value: 0, label: t('todo:form.weekday.sun') },
                      ]}
                    />
                  </Form.Item>
                )
              }
              if (freq === 'monthly') {
                return (
                  <Form.Item name="monthDays" label={t('todo:form.monthDaysLabel')}>
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
          <div style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>{t('todo:form.ruleHint')}</div>
        </Form>
      </Modal>

      {/* 移动端菜单：承载被折叠的次级工具按钮 */}
      <Drawer
        title={t('todo:mobileMenu.title')}
        placement="right"
        open={mobileMenuOpen}
        onClose={() => setMobileMenuOpen(false)}
      >
        <div className="mobile-menu-actions">
          <Button
            icon={<SearchOutlined />}
            onClick={() => { setMobileMenuOpen(false); setTranscriptDrawerOpen(true) }}
            block
          >{t('todo:mobileMenu.recoverTranscript')}</Button>
          <Button
            icon={<FileTextOutlined />}
            onClick={() => { setMobileMenuOpen(false); openDrawer('template') }}
            block
          >{t('todo:mobileMenu.promptTemplate')}</Button>
          <Button
            icon={<TrophyOutlined />}
            onClick={() => { setMobileMenuOpen(false); openDrawer('report') }}
            block
          >{t('todo:mobileMenu.dailyReport')}</Button>
          {/* 记忆 wiki 入口暂时隐藏，待重新设计后再开放
          <Button
            icon={<BookOutlined />}
            onClick={() => { setMobileMenuOpen(false); openDrawer('wiki') }}
            block
          >{t('todo:mobileMenu.wiki')}</Button>
          */}
          <Button
            icon={<LineChartOutlined />}
            onClick={() => { setMobileMenuOpen(false); openDrawer('stats') }}
            block
          >{t('todo:mobileMenu.stats')}</Button>
          <Button
            icon={<SettingOutlined />}
            onClick={() => { setMobileMenuOpen(false); openDrawer('settings') }}
            block
          >{t('todo:mobileMenu.settings')}</Button>
        </div>
      </Drawer>

      <SettingsDrawer open={settingsOpen} onClose={() => closeDrawer('settings')} />
      <WikiDrawer open={wikiOpen} onClose={() => closeDrawer('wiki')} />
      <StatsReportsDrawer />
      <ExportDialog
        todo={exportTarget}
        open={!!exportTarget}
        onClose={() => setExportTarget(null)}
      />
      <TemplateDrawer
        open={templateDrawerOpen}
        onClose={() => closeDrawer('template')}
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
      <Modal
        open={!!toolMissing}
        onCancel={() => setToolMissing(null)}
        title={toolMissing ? t('todo:toolMissing.title', { tool: toolMissing.tool }) : ''}
        footer={[
          <Button
            key="copy"
            type="primary"
            onClick={() => {
              if (toolMissing) {
                navigator.clipboard.writeText(toolMissing.fix)
                message.success(t('todo:message.copied'))
              }
            }}
          >
            {t('todo:toolMissing.copyCommand')}
          </Button>,
          <Button key="close" onClick={() => setToolMissing(null)}>{t('common:close')}</Button>,
        ]}
      >
        {toolMissing && (
          <>
            <p>{t('todo:toolMissing.notFound')} <code>{toolMissing.bin}</code>。{t('todo:toolMissing.runInTerminal')}</p>
            <pre style={{
              fontFamily: 'ui-monospace, monospace',
              background: '#f5f5f5',
              padding: 12,
              borderRadius: 0,
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
