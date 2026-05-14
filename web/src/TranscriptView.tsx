import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Input, Button, Spin, Tag, Empty, Tooltip, Mentions, Popconfirm } from 'antd'
import { useTranslation } from 'react-i18next'
import { useAppMessages } from './design/useAppMessages'
import {
  ReloadOutlined, BranchesOutlined, SearchOutlined,
  FullscreenOutlined, FullscreenExitOutlined, StopOutlined, PoweroffOutlined,
} from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { diffLines } from 'diff'
import './design/highlight.css'
import { getTranscript, ResumeSessionInput, sendAiInput, startAiExec, stopAiExec, TranscriptResponse, TranscriptTurn, uploadImage } from './api'
import { markdownComponents } from './markdownComponents'
import './TranscriptView.css'
import { deriveAiState, type AiPresentationState } from './design/aiPresentationState'
import { useUnreadStore, isSessionUnread } from './store/unreadStore'
import { useAiSessionStore } from './store/aiSessionStore'

interface Props {
  todoId: string
  sessionId: string
  onFork?: (turnIndex: number, upToTurns: TranscriptTurn[]) => void
  autoRefreshMs?: number
  resumeTarget?: ResumeSessionInput | null
  onSessionRecovered?: (nextSessionId: string) => void
  /** 父容器撑满时由父级控高（flex:1），不显示拖拽手柄 */
  fillHeight?: boolean
  /** 当前会话工作目录 —— 用于拉取 project-local 的 slash 命令 */
  cwd?: string | null
  /** Chat tab 是否可见。不可见时不打开 SSE 长连接，避免占用浏览器同源 6 并发池 */
  active?: boolean
}

interface SlashCommand {
  name: string
  description: string
  scope: 'global' | 'local'
  source: 'user' | 'project' | string  // string = `plugin:xxx`
}

const ROLE_CLS: Record<string, string> = {
  user: 'tv-role-user',
  assistant: 'tv-role-assistant',
  thinking: 'tv-role-thinking',
  tool_use: 'tv-role-tool-use',
  tool_result: 'tv-role-tool-result',
  raw: 'tv-role-raw',
}

// 把 tool_use.content（多半是个 JSON 字符串）解析出便于渲染的结构。
// 解析失败就回退到原始文本，保证不丢信息。
function parseToolInput(raw: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    return null
  } catch {
    return null
  }
}

function shortPath(p: string): string {
  if (!p) return ''
  // 仅做简单收敛：去掉 home 前缀、保留末两段，前面用 ... 替代
  const homeStripped = p.replace(/^\/Users\/[^/]+\//, '~/')
  const segs = homeStripped.split('/')
  if (segs.length <= 4) return homeStripped
  return `…/${segs.slice(-2).join('/')}`
}

function truncateOneLine(s: string, max = 80): string {
  const line = (s || '').split('\n').find(l => l.trim().length > 0) || ''
  const trimmed = line.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 把 tool_use 的输入按工具名拼成单行签名，例如 Read(file.ts, lines: 240-380) */
function toolSignature(toolName: string | undefined, raw: string): string {
  const name = toolName || 'Tool'
  const input = parseToolInput(raw)
  if (!input) return `${name}(${truncateOneLine(raw, 60)})`
  const fmt = (v: any) => typeof v === 'string' ? v : JSON.stringify(v)
  switch (name) {
    case 'Read': {
      const p = shortPath(input.path || input.file_path || '')
      const off = input.offset, lim = input.limit
      if (off != null && lim != null) return `Read(${p}, lines: ${off}-${off + lim})`
      if (off != null) return `Read(${p}, from: ${off})`
      if (lim != null) return `Read(${p}, limit: ${lim})`
      return `Read(${p})`
    }
    case 'Write':
    case 'Edit':
    case 'StrReplace':
    case 'Delete': {
      const p = shortPath(input.path || input.target_notebook || input.file_path || '')
      return `${name}(${p})`
    }
    case 'Bash':
    case 'Shell': {
      const cmd = truncateOneLine(input.command || '', 80)
      return `${name}(${cmd})`
    }
    case 'Grep': {
      const pat = JSON.stringify(input.pattern ?? '')
      const path = input.path ? `, ${shortPath(input.path)}` : ''
      return `Grep(${pat}${path})`
    }
    case 'Glob':
      return `Glob(${JSON.stringify(input.glob_pattern ?? input.pattern ?? '')})`
    case 'WebSearch':
      return `WebSearch(${JSON.stringify(input.search_term ?? input.query ?? '')})`
    case 'WebFetch':
      return `WebFetch(${input.url || ''})`
    case 'TodoWrite':
      return `TodoWrite(…)`
    case 'Task':
      return `Task(${input.subagent_type || ''}: ${truncateOneLine(input.description || input.prompt || '', 50)})`
    default: {
      const keys = Object.keys(input).slice(0, 2)
      const parts = keys.map(k => `${k}: ${truncateOneLine(fmt(input[k]), 30)}`)
      return `${name}(${parts.join(', ')})`
    }
  }
}

/** 工具结果摘要：取第一行非空内容。出错则用 ✗ 标记。 */
function toolResultSummary(raw: string): { ok: boolean; text: string; lineCount: number } {
  const lines = (raw || '').split('\n')
  const lineCount = lines.filter(l => l.trim().length > 0).length
  const text = truncateOneLine(raw, 100) || '(empty)'
  const ok = !/^(error|exception|traceback|fail|denied)/i.test(text)
  return { ok, text, lineCount }
}


function highlightKeyword(text: string, keyword: string): React.ReactNode {
  if (!keyword) return text
  const lower = text.toLowerCase()
  const kw = keyword.toLowerCase()
  const parts: React.ReactNode[] = []
  let i = 0
  while (i < text.length) {
    const idx = lower.indexOf(kw, i)
    if (idx < 0) { parts.push(text.slice(i)); break }
    if (idx > i) parts.push(text.slice(i, idx))
    parts.push(<mark key={idx} className="tv-highlight">{text.slice(idx, idx + keyword.length)}</mark>)
    i = idx + keyword.length
  }
  return parts
}

interface TurnItemProps {
  turn: TranscriptTurn
  index: number
  keyword: string
  canFork: boolean
  collapsed: boolean
  onFork: (i: number) => void
  onToggleCollapse: (i: number) => void
}

interface TodoItem {
  content: string
  activeForm?: string
  status?: string
}

function tryParseTodoWriteInput(raw: string): TodoItem[] | null {
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const todos = (parsed as { todos?: unknown }).todos
    if (!Array.isArray(todos)) return null
    const list: TodoItem[] = []
    for (const t of todos) {
      if (t && typeof t === 'object' && typeof (t as TodoItem).content === 'string') {
        list.push(t as TodoItem)
      }
    }
    return list.length ? list : null
  } catch {
    return null
  }
}

/**
 * 把两段文本做行级 diff 并渲染成 +/- 高亮块。
 * 大块未改动的连续行做 truncate（每段最多保留首尾各 3 行），其余折叠成 "… N lines …"
 * 避免长文件展示成一屏几百行无意义 context。
 */
function DiffView({ before, after, language }: { before: string; after: string; language?: string }) {
  const { t } = useTranslation(['transcript'])
  const parts = useMemo(() => {
    try {
      return diffLines(before || '', after || '', { newlineIsToken: false })
    } catch {
      return [{ value: after || '', added: true, removed: false }] as any[]
    }
  }, [before, after])

  const rows = useMemo(() => {
    const acc: Array<{ kind: 'add' | 'del' | 'ctx' | 'gap'; text: string; gapCount?: number }> = []
    parts.forEach((part: any) => {
      const text: string = part.value || ''
      const lines = text.split('\n')
      // diffLines 末尾通常带一个空字符串（trailing newline），跳掉
      const arr = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
      if (part.added) {
        arr.forEach(l => acc.push({ kind: 'add', text: l }))
      } else if (part.removed) {
        arr.forEach(l => acc.push({ kind: 'del', text: l }))
      } else {
        // context: 头尾各保留 3 行，中间折叠
        if (arr.length <= 7) {
          arr.forEach(l => acc.push({ kind: 'ctx', text: l }))
        } else {
          arr.slice(0, 3).forEach(l => acc.push({ kind: 'ctx', text: l }))
          acc.push({ kind: 'gap', text: '', gapCount: arr.length - 6 })
          arr.slice(-3).forEach(l => acc.push({ kind: 'ctx', text: l }))
        }
      }
    })
    return acc
  }, [parts])

  return (
    <pre className={`tv-diff${language ? ` language-${language}` : ''}`}>
      {rows.map((r, i) => {
        if (r.kind === 'gap') {
          return (
            <div key={i} className="tv-diff-line tv-diff-gap">
              <span className="tv-diff-marker"> </span>
              <span className="tv-diff-text">{t('transcript:tool.diffGap', { count: r.gapCount })}</span>
            </div>
          )
        }
        const marker = r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '
        return (
          <div key={i} className={`tv-diff-line tv-diff-${r.kind}`}>
            <span className="tv-diff-marker">{marker}</span>
            <span className="tv-diff-text">{r.text || ' '}</span>
          </div>
        )
      })}
    </pre>
  )
}

/** 推断文件后缀对应的高亮 lang 名（仅用于装饰；diff 自身不依赖语法高亮） */
function langFromPath(p: string): string | undefined {
  const ext = (p.split('.').pop() || '').toLowerCase()
  if (!ext) return undefined
  const map: Record<string, string> = {
    ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
    py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
    rb: 'ruby', php: 'php', swift: 'swift', sh: 'bash', bash: 'bash', zsh: 'bash',
    json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml',
    md: 'markdown', html: 'html', css: 'css', scss: 'scss', less: 'less',
    vue: 'vue', sql: 'sql', xml: 'xml',
  }
  return map[ext]
}

function TodoWriteList({ todos, keyword }: { todos: TodoItem[]; keyword: string }) {
  return (
    <ul className="tv-todos">
      {todos.map((t, i) => {
        const status = t.status || 'pending'
        const cls = status === 'completed' ? 'tv-todo-done'
          : status === 'in_progress' ? 'tv-todo-active'
          : 'tv-todo-pending'
        const icon = status === 'completed' ? '✓'
          : status === 'in_progress' ? '▶'
          : '○'
        const text = status === 'in_progress' && t.activeForm ? t.activeForm : t.content
        return (
          <li key={i} className={`tv-todo ${cls}`}>
            <span className="tv-todo-icon" aria-hidden>{icon}</span>
            <span className="tv-todo-text">{highlightKeyword(text, keyword)}</span>
          </li>
        )
      })}
    </ul>
  )
}

const TurnItem = React.memo(function TurnItem({ turn, index, keyword, canFork, collapsed, onFork, onToggleCollapse }: TurnItemProps) {
  const { t } = useTranslation(['transcript', 'common', 'errors'])
  const roleLabelKey =
    turn.role === 'user' ? 'transcript:role.user' :
    turn.role === 'assistant' ? 'transcript:role.assistant' :
    turn.role === 'thinking' ? 'transcript:role.thinking' :
    turn.role === 'tool_use' ? 'transcript:role.toolUse' :
    turn.role === 'tool_result' ? 'transcript:role.toolResult' :
    turn.role === 'raw' ? 'transcript:role.raw' : null
  const meta = {
    label: roleLabelKey ? t(roleLabelKey) : turn.role,
    cls: ROLE_CLS[turn.role] || '',
  }
  const isToolUse = turn.role === 'tool_use'
  const isToolResult = turn.role === 'tool_result'
  const isThinking = turn.role === 'thinking'
  const isRaw = turn.role === 'raw'
  const isUser = turn.role === 'user'
  const isAssistant = turn.role === 'assistant'

  const handleToggle = useCallback(() => onToggleCollapse(index), [onToggleCollapse, index])
  const handleFork = useCallback(() => onFork(index), [onFork, index])

  // —— 工具调用：单行签名 + 折叠的详情。TodoWrite 不折叠，直接展开 checklist。
  // Edit / StrReplace / Write 走专用 diff 视图，比 JSON pre 直观得多
  if (isToolUse) {
    const todos = turn.toolName === 'TodoWrite' ? tryParseTodoWriteInput(turn.content) : null
    const editLike = turn.toolName === 'Edit' || turn.toolName === 'StrReplace' || turn.toolName === 'Write'
    const editInput = editLike ? parseToolInput(turn.content) : null
    const sig = useMemo(() => toolSignature(turn.toolName, turn.content), [turn.toolName, turn.content])

    // Edit / StrReplace：行级 diff（old_string → new_string）
    // Write：把全部内容当 + 行展示
    if (editInput) {
      const path = String(editInput.path || editInput.file_path || editInput.target_notebook || '')
      const lang = langFromPath(path)
      const isWrite = turn.toolName === 'Write'
      const before = isWrite ? '' : String(editInput.old_string ?? '')
      const after = isWrite
        ? String(editInput.contents ?? editInput.content ?? '')
        : String(editInput.new_string ?? '')
      // diff 主体，加一个文件名标题；折叠按钮仍可用（折叠后只剩标题）
      return (
        <div className={`tv-row tv-row-tool ${meta.cls}`} data-turn-index={index}>
          <span className="tv-dot tv-dot-tool" aria-hidden />
          <div className="tv-row-content">
            <button className="tv-tool-sig tv-tool-sig-button tv-edit-head" onClick={handleToggle} title={collapsed ? t('transcript:tool.expandDiff') : t('transcript:tool.collapseDiff')}>
              <span className="tv-tool-name">{turn.toolName}</span>
              <span className="tv-tool-args">({shortPath(path)})</span>
              {editInput.replace_all && <span className="tv-edit-flag">replace_all</span>}
              <span className="tv-tool-caret">{collapsed ? '›' : '⌄'}</span>
            </button>
            {!collapsed && (before || after) && (
              <DiffView before={before} after={after} language={lang} />
            )}
          </div>
        </div>
      )
    }

    return (
      <div className={`tv-row tv-row-tool ${meta.cls}`} data-turn-index={index}>
        <span className="tv-dot tv-dot-tool" aria-hidden />
        <div className="tv-row-content">
          {todos ? (
            <>
              <div className="tv-tool-sig">
                <span className="tv-tool-name">TodoWrite</span>
              </div>
              <TodoWriteList todos={todos} keyword={keyword} />
            </>
          ) : (
            <>
              <button className="tv-tool-sig tv-tool-sig-button" onClick={handleToggle} title={collapsed ? t('transcript:tool.expandDetail') : t('transcript:tool.collapseDetail')}>
                <span className="tv-tool-name">{turn.toolName || 'Tool'}</span>
                <span className="tv-tool-args">{highlightKeyword(sig.replace(/^[^(]*/, ''), keyword)}</span>
                <span className="tv-tool-caret">{collapsed ? '›' : '⌄'}</span>
              </button>
              {!collapsed && (
                <pre className="tv-tool-detail">{highlightKeyword(turn.content, keyword)}</pre>
              )}
            </>
          )}
        </div>
      </div>
    )
  }

  // —— 工具输出：默认显示一行 ✓/✗ 摘要 + 行数；展开看完整 pre
  if (isToolResult) {
    const { ok, text, lineCount } = useMemo(() => toolResultSummary(turn.content), [turn.content])
    return (
      <div className={`tv-row tv-row-toolresult ${meta.cls}`} data-turn-index={index}>
        <span className="tv-dot tv-dot-result" aria-hidden />
        <div className="tv-row-content">
          <button className="tv-result-summary tv-tool-sig-button" onClick={handleToggle} title={collapsed ? t('transcript:tool.expandOutput') : t('transcript:tool.collapseOutput')}>
            <span className={ok ? 'tv-result-ok' : 'tv-result-err'}>{ok ? '✓' : '✗'}</span>
            <span className="tv-result-text">{highlightKeyword(text, keyword)}</span>
            {lineCount > 1 && <span className="tv-result-meta">{t('transcript:tool.lineCount', { count: lineCount })}</span>}
            <span className="tv-tool-caret">{collapsed ? '›' : '⌄'}</span>
          </button>
          {!collapsed && (
            <pre className="tv-tool-detail">{highlightKeyword(turn.content, keyword)}</pre>
          )}
        </div>
      </div>
    )
  }

  // —— 思考：折叠态只显示 "thinking" 药丸，展开看完整文本
  if (isThinking) {
    return (
      <div className={`tv-row tv-row-thinking ${meta.cls}`} data-turn-index={index}>
        <span className="tv-dot tv-dot-thinking" aria-hidden />
        <div className="tv-row-content">
          <button className="tv-thinking-pill tv-tool-sig-button" onClick={handleToggle}>
            <span className="tv-thinking-pill-dot" />
            <span>thinking</span>
            <span className="tv-tool-caret">{collapsed ? '›' : '⌄'}</span>
          </button>
          {!collapsed && (
            <pre className="tv-tool-detail tv-tool-detail-thinking">{highlightKeyword(turn.content, keyword)}</pre>
          )}
        </div>
      </div>
    )
  }

  // —— 原始 PTY 行
  if (isRaw) {
    return (
      <div className={`tv-row tv-row-raw ${meta.cls}`} data-turn-index={index}>
        <span className="tv-dot tv-dot-raw" aria-hidden />
        <div className="tv-row-content">
          <pre className="tv-raw-pre">{highlightKeyword(turn.content, keyword)}</pre>
        </div>
      </div>
    )
  }

  // —— 用户 / AI 消息：极简文本行，无卡片
  const body = (keyword && turn.content.toLowerCase().includes(keyword.toLowerCase()))
    ? <div className="tv-plain">{highlightKeyword(turn.content, keyword)}</div>
    : (
      <div className="tv-md">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {turn.content}
        </ReactMarkdown>
      </div>
    )

  return (
    <div className={`tv-row ${isUser ? 'tv-row-user' : 'tv-row-assistant'} ${meta.cls}`} data-turn-index={index}>
      <span className={`tv-dot ${isUser ? 'tv-dot-user' : 'tv-dot-assistant'}`} aria-hidden />
      <div className="tv-row-content">
        {body}
        <div className="tv-row-meta">
          {turn.timestamp && (
            <span className="tv-turn-time">{new Date(turn.timestamp).toLocaleTimeString()}</span>
          )}
          {canFork && (isUser || isAssistant) && (
            <Tooltip title={t('transcript:fork.tooltip')}>
              <button className="tv-row-fork" onClick={handleFork} aria-label={t('transcript:fork.ariaLabel')}>
                <BranchesOutlined />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  )
})

type LocalTurn = TranscriptTurn & { optimisticId?: string }

const MIN_HEIGHT = 240
const MAX_HEIGHT = 1200

export default function TranscriptView({ todoId, sessionId, onFork, autoRefreshMs = 0, resumeTarget = null, onSessionRecovered, fillHeight, cwd, active = true }: Props) {
  const { t } = useTranslation(['transcript', 'common', 'errors'])
  const { message } = useAppMessages()
  const [data, setData] = useState<TranscriptResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [keyword, setKeyword] = useState('')
  const [searchIdx, setSearchIdx] = useState(0)
  const [collapsedTools, setCollapsedTools] = useState<Record<number, boolean>>({})
  const [allToolsCollapsed, setAllToolsCollapsed] = useState(true)
  const [composer, setComposer] = useState('')
  const [optimisticTurns, setOptimisticTurns] = useState<LocalTurn[]>([])
  // jsonl 只有消息收尾才落盘；服务端推来的 PTY 实时文本不再直接展示，
  // 这里只保留它作为"AI 正在生成"的信号。
  const [liveOutput, setLiveOutput] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [height, setHeight] = useState<number>(() => {
    try {
      // rebrand: localStorage key kept for backward compatibility
      const raw = localStorage.getItem('quadtodo.transcriptHeight')
      const n = raw ? parseInt(raw, 10) : NaN
      if (Number.isFinite(n) && n >= MIN_HEIGHT && n <= MAX_HEIGHT) return n
    } catch { /* ignore */ }
    return 480
  })
  const scrollRef = useRef<HTMLDivElement>(null)
  const dataRef = useRef<TranscriptResponse | null>(null)
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)
  // 中文输入法组字状态。单靠 nativeEvent.isComposing 不够——某些浏览器（如
  // 部分 macOS Chrome + 搜狗/微信输入法）在 compositionend 之前就派发
  // keydown(Enter)，这时 isComposing 已为 false，Enter 会被当成提交。
  // 所以同时维护 composingRef 和"刚结束组字的小窗口"作为兜底。
  const composingRef = useRef(false)
  const composingEndAtRef = useRef(0)
  // Conversation 输入框里粘贴图片时给一个可见占位符 [Image #N]，让用户清楚"图已经收到"
  // —— 否则之前用户只能看到一行轻提示，文字框里没有任何反馈
  const imageCounterRef = useRef(0)
  const composerImagesRef = useRef<Map<string, string>>(new Map())

  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen])

  const onDragStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault()
    const startY = 'touches' in e ? e.touches[0].clientY : e.clientY
    dragRef.current = { startY, startH: height }
    const onMove = (ev: MouseEvent | TouchEvent) => {
      if (!dragRef.current) return
      const y = 'touches' in ev ? ev.touches[0].clientY : (ev as MouseEvent).clientY
      const newH = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, dragRef.current.startH + (y - dragRef.current.startY)))
      setHeight(newH)
    }
    const onUp = () => {
      dragRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.addEventListener('touchmove', onMove)
    document.addEventListener('touchend', onUp)
  }, [height])

  useEffect(() => {
    // rebrand: localStorage key kept for backward compatibility
    try { localStorage.setItem('quadtodo.transcriptHeight', String(height)) } catch { /* ignore */ }
  }, [height])

  useEffect(() => {
    dataRef.current = data
  }, [data])

  const fetchData = useCallback(async (mode: 'reset' | 'incremental' | 'poll' = 'reset') => {
    if (mode === 'reset') setLoading(true)
    try {
      const previous = dataRef.current
      // 'poll' 是后台静默刷新：
      //  - jsonl 源：用 since 做增量，同 'incremental'
      //  - ptylog 源：单个 raw turn 的 content 会持续增长，since 会让服务端 slice 出空数组，必须走全量
      const useIncremental = mode === 'incremental'
        || (mode === 'poll' && previous?.source === 'jsonl')
      const since = useIncremental && previous ? previous.total : undefined
      const r = await getTranscript(todoId, sessionId, since)
      setError(null)
      setData((current) => {
        if (useIncremental && current && since != null) {
          return {
            ...r,
            offset: 0,
            turns: [...current.turns, ...r.turns],
          }
        }
        return r
      })
      if (mode === 'reset' || (previous && r.total > previous.total)) {
        setOptimisticTurns([])
      }
    } catch (e: any) {
      // 静默轮询出错不刷 error，避免闪烁；首屏/手动刷新仍走 error 通道
      if (mode !== 'poll') setError(e?.message || t('transcript:error.loadFailed'))
    } finally {
      if (mode === 'reset') setLoading(false)
    }
  }, [todoId, sessionId, t])

  useEffect(() => {
    dataRef.current = null
    setData(null)
    setError(null)
    setComposer('')
    setOptimisticTurns([])
    setCollapsedTools({})
    setAllToolsCollapsed(true)
    // 关键：session 切换时把"用户在底部"标志位拨回 true。否则上个 session 用户滚上去留下来的
    // false 会让所有自动 scroll-to-bottom 被跳过（即使新 session 还没开始读）。
    isAtBottomRef.current = true
    setUnreadCount(0)
    prevCountRef.current = 0
    setLiveOutput(null)
    imageCounterRef.current = 0
    void fetchData('reset')
  }, [fetchData])

  // SSE 推流订阅（运行中会话），失败 5s 重连一次，仍失败则降级为轮询
  // 关键：仅在 Chat tab 激活时才开 SSE —— 否则每个运行中的 session 永远挂一条 SSE，
  // 叠加 Live 的 WS，很快打满浏览器单源 6 条并发限制，所有新请求 pending。
  useEffect(() => {
    if (!autoRefreshMs || !active) {
      setLiveOutput(null)
      return
    }
    let es: EventSource | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let fallbackTimer: ReturnType<typeof setInterval> | null = null
    let retriedOnce = false
    let disposed = false
    // live-output 事件在 PTY 流式吐字时高频触发（每个 token 一次），直接 setState 会让
    // Conversation 整树高频重渲（含已展开的 diff 块），用户感受为"页面在抖"。
    // 这里做 trailing-edge 节流：每 200ms 至多刷一次最新内容，足以呈现"实时感"且不抖。
    let liveOutputBuffer: string | null = null
    let liveOutputTimer: ReturnType<typeof setTimeout> | null = null
    const flushLiveOutput = () => {
      liveOutputTimer = null
      if (disposed) return
      if (liveOutputBuffer == null) return
      setLiveOutput(liveOutputBuffer)
      liveOutputBuffer = null
    }
    const cancelLiveOutput = () => {
      if (liveOutputTimer) { clearTimeout(liveOutputTimer); liveOutputTimer = null }
      liveOutputBuffer = null
    }

    const closeES = () => {
      if (es) { try { es.close() } catch { /* ignore */ } ; es = null }
    }
    const startFallback = () => {
      if (fallbackTimer || disposed) return
      fallbackTimer = setInterval(() => { void fetchData('poll') }, autoRefreshMs)
    }
    const stopFallback = () => {
      if (fallbackTimer) clearInterval(fallbackTimer)
      fallbackTimer = null
    }
    const handleSnapshot = (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data)
        setData({
          source: payload.source,
          turns: payload.turns,
          total: payload.total,
          offset: 0,
          session: payload.session,
        })
        setOptimisticTurns([])
        cancelLiveOutput()
        setLiveOutput(null)
        retriedOnce = false
        stopFallback()
      } catch { /* ignore */ }
    }
    const handleTurnAdded = (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data)
        setData(current => current ? {
          ...current,
          turns: [...current.turns, ...(payload.turns as TranscriptTurn[])],
          total: payload.total,
        } : current)
        if (payload.turns?.length) {
          setOptimisticTurns([])
          // 真实 turn 收尾了，清掉"实时"伪 turn 避免重复显示；后续还有输出
          // 就会被下一个 live-output 事件再写回来
          cancelLiveOutput()
          setLiveOutput(null)
        }
      } catch { /* ignore */ }
    }
    const handleLiveOutput = (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data)
        if (typeof payload?.content !== 'string') return
        liveOutputBuffer = payload.content
        if (!liveOutputTimer) liveOutputTimer = setTimeout(flushLiveOutput, 200)
      } catch { /* ignore */ }
    }
    const handleStreamUnsupported = () => {
      closeES()
      startFallback()
    }
    const connect = () => {
      if (disposed) return
      closeES()
      try {
        const url = `/api/todos/${todoId}/ai-sessions/${sessionId}/transcript/stream`
        const evt = new EventSource(url)
        es = evt
        evt.addEventListener('snapshot', handleSnapshot as EventListener)
        evt.addEventListener('turn-added', handleTurnAdded as EventListener)
        evt.addEventListener('live-output', handleLiveOutput as EventListener)
        evt.addEventListener('stream-not-supported', handleStreamUnsupported as EventListener)
        evt.onerror = () => {
          if (disposed) return
          closeES()
          if (!retriedOnce) {
            retriedOnce = true
            retryTimer = setTimeout(() => { if (!disposed) connect() }, 5000)
          } else {
            startFallback()
          }
        }
      } catch {
        startFallback()
      }
    }
    connect()
    return () => {
      disposed = true
      closeES()
      if (retryTimer) clearTimeout(retryTimer)
      stopFallback()
      cancelLiveOutput()
      setLiveOutput(null)
    }
  }, [autoRefreshMs, fetchData, todoId, sessionId, active])

  const displayedTurns = useMemo<LocalTurn[]>(() => (
    data ? [...data.turns, ...optimisticTurns] : optimisticTurns
  ), [data, optimisticTurns])

  const matches = useMemo(() => {
    if (!keyword || !displayedTurns.length) return [] as number[]
    const lower = keyword.toLowerCase()
    return displayedTurns.reduce<number[]>((acc, t, i) => {
      if (t.content?.toLowerCase().includes(lower)) acc.push(i)
      return acc
    }, [])
  }, [keyword, displayedTurns])

  const jumpToMatch = useCallback((nextIdx: number) => {
    if (!matches.length) return
    const i = ((nextIdx % matches.length) + matches.length) % matches.length
    setSearchIdx(i)
    const el = scrollRef.current?.querySelector(`[data-turn-index="${matches[i]}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [matches])

  useEffect(() => { if (matches.length) jumpToMatch(0) }, [matches, jumpToMatch])

  // 跟随底部：用户停在底部就粘住最新；滚上去看历史就停止跟随
  const isAtBottomRef = useRef(true)
  const [unreadCount, setUnreadCount] = useState(0)
  const handleBodyScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const atBottom = distanceFromBottom < 40
    isAtBottomRef.current = atBottom
    if (atBottom) setUnreadCount(0)
  }, [])

  // 持续粘底：用 ResizeObserver 监听每个 turn 子节点的尺寸变化（markdown / 代码高亮 / 图片加载都异步，
  // 简单 scrollTop=scrollHeight 会在首帧就算好，之后 markdown 撑高了就"漏出底部空间"看不到最新内容）
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const stickToBottom = () => {
      if (isAtBottomRef.current) el.scrollTop = el.scrollHeight
    }
    const ro = new ResizeObserver(stickToBottom)
    const observed = new WeakSet<Element>()
    const observeChildren = () => {
      for (const c of Array.from(el.children)) {
        if (!observed.has(c)) { ro.observe(c); observed.add(c) }
      }
    }
    observeChildren()
    const mo = new MutationObserver(() => { observeChildren(); stickToBottom() })
    mo.observe(el, { childList: true })
    stickToBottom()
    return () => { ro.disconnect(); mo.disconnect() }
  }, [])

  // "新 turn 必滚到底" + "live output 流式只在底部时跟随"的双策略：
  //   1. displayedTurns.length 增加 → 强制滚到底（mainstream chat UX：ChatGPT/Claude.ai 都这样）
  //      并把 isAtBottomRef 拨回 true（视为"用户想跟"）。
  //   2. liveOutput 变化（流式输出）→ 仅在 isAtBottomRef.current = true 时滚（保留用户阅读旧消息的位置）。
  //
  // 用 useLayoutEffect：在浏览器 paint 之前同步钉底，避免长会话首次进入时用户看见"从顶部慢慢滚下来"。
  // 之后的双 rAF + 120ms setTimeout 仍保留，用来兜底等 markdown/hljs/图片异步撑高后的再次粘底。
  const lastTurnCountRef = useRef(0)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const prevLen = lastTurnCountRef.current
    const currLen = displayedTurns.length
    lastTurnCountRef.current = currLen
    const newTurnAdded = currLen > prevLen
    // 用户在读历史 + 仅 liveOutput 在变 → 不打扰
    if (!newTurnAdded && !isAtBottomRef.current) return

    // 同步钉底（paint 前）—— 第一帧用户就看到底部
    el.scrollTop = el.scrollHeight
    if (newTurnAdded) {
      isAtBottomRef.current = true
      setUnreadCount(0)
    }

    const doScroll = () => {
      const node = scrollRef.current
      if (!node) return
      node.scrollTop = node.scrollHeight
    }
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(doScroll)
    })
    const t = setTimeout(doScroll, 120)
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
      clearTimeout(t)
    }
  }, [displayedTurns, liveOutput])

  // 未读计数：仅在 turn 数增加且用户不在底部时累加；首次 snapshot 不计
  const prevCountRef = useRef(0)
  useEffect(() => {
    const count = displayedTurns.length
    const prevCount = prevCountRef.current
    prevCountRef.current = count
    const added = count - prevCount
    if (added <= 0) return
    if (!isAtBottomRef.current && prevCount > 0) {
      setUnreadCount(n => n + added)
    }
  }, [displayedTurns])

  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    isAtBottomRef.current = true
    setUnreadCount(0)
  }, [])

  // 拉取可用 slash 命令列表（~/.claude 与 <cwd>/.claude 下 commands + skills + 已安装插件）
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([])
  useEffect(() => {
    const qs = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
    fetch(`/api/claude-commands${qs}`)
      .then(r => r.ok ? r.json() : { ok: false })
      .then(d => { if (d?.ok && Array.isArray(d.commands)) setSlashCommands(d.commands) })
      .catch(() => { /* 拿不到命令列表就静默，不影响发送 */ })
  }, [cwd])

  const slashOptions = useMemo(() => (
    slashCommands.map(c => ({
      value: c.name,
      label: (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', maxWidth: 520 }}>
          <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: 'var(--accent-electric)', flexShrink: 0 }}>/{c.name}</span>
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {c.description || t('transcript:slashTag.empty')}
          </span>
          {c.source === 'project' && <Tag color="orange" style={{ fontSize: 10, margin: 0, lineHeight: '16px', height: 16, padding: '0 4px' }}>{t('transcript:slashTag.project')}</Tag>}
          {typeof c.source === 'string' && c.source.startsWith('plugin:') && (
            <Tag color="purple" style={{ fontSize: 10, margin: 0, lineHeight: '16px', height: 16, padding: '0 4px' }}>{t('transcript:slashTag.plugin')}</Tag>
          )}
        </div>
      ),
    }))
  ), [slashCommands, t])

  // 稳定回调传给 memo 化的 TurnItem：不让 turn 列表每次父级重渲时都 re-render
  const displayedTurnsRef = useRef<LocalTurn[]>([])
  useEffect(() => { displayedTurnsRef.current = displayedTurns }, [displayedTurns])
  const allToolsCollapsedRef = useRef<boolean>(allToolsCollapsed)
  useEffect(() => { allToolsCollapsedRef.current = allToolsCollapsed }, [allToolsCollapsed])
  const onForkRef = useRef(onFork)
  useEffect(() => { onForkRef.current = onFork }, [onFork])

  const handleTurnFork = useCallback((i: number) => {
    const fn = onForkRef.current
    if (!fn) return
    fn(i, displayedTurnsRef.current.slice(0, i + 1))
  }, [])
  const handleToggleCollapse = useCallback((i: number) => {
    setCollapsedTools(prev => {
      const fallback = allToolsCollapsedRef.current
      const cur = prev[i] ?? fallback
      return { ...prev, [i]: !cur }
    })
  }, [])

  const resumeSession = useCallback(async () => {
    if (!resumeTarget?.nativeSessionId) {
      throw new Error(t('transcript:error.noResumeId'))
    }
    const { sessionId: nextSessionId } = await startAiExec({
      todoId: resumeTarget.todoId,
      tool: resumeTarget.tool,
      prompt: resumeTarget.prompt,
      cwd: resumeTarget.cwd,
      resumeNativeId: resumeTarget.nativeSessionId,
    })
    onSessionRecovered?.(nextSessionId)
    return nextSessionId
  }, [onSessionRecovered, resumeTarget, t])

  const sendSessionInput = useCallback(async (payload: string, optimisticText?: string) => {
    const optimisticId = optimisticText
      ? `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      : null
    if (optimisticId && optimisticText) {
      setOptimisticTurns(prev => [...prev, {
        role: 'user',
        content: optimisticText,
        timestamp: Date.now(),
        optimisticId,
      }])
    }

    const doSend = async (targetSessionId: string) => {
      await sendAiInput(targetSessionId, payload)
      window.setTimeout(() => { void fetchData('incremental') }, 600)
    }

    try {
      const currentStatus = dataRef.current?.session.status
      if (currentStatus === 'running' || currentStatus === 'idle' || currentStatus === 'pending_confirm') {
        try {
          await doSend(sessionId)
        } catch (e: any) {
          if (e?.message !== 'session_not_found' || !resumeTarget?.nativeSessionId) throw e
          const nextSessionId = await resumeSession()
          await doSend(nextSessionId)
        }
        return
      }

      if (!resumeTarget?.nativeSessionId) {
        throw new Error(t('transcript:error.sessionEndedNoResume'))
      }
      const nextSessionId = await resumeSession()
      await doSend(nextSessionId)
    } catch (e) {
      if (optimisticId) {
        setOptimisticTurns(prev => prev.filter(turn => turn.optimisticId !== optimisticId))
      }
      throw e
    }
  }, [fetchData, resumeSession, resumeTarget, sessionId, t])

  const handleSendMessage = useCallback(async () => {
    const text = composer.trim()
    if (!text) return
    const usedPlaceholders: string[] = []
    const payloadText = Array.from(composerImagesRef.current.entries()).reduce((acc, [placeholder, path]) => {
      if (acc.includes(placeholder)) usedPlaceholders.push(placeholder)
      return acc.replace(new RegExp(escapeRegExp(placeholder), 'g'), `@${path}`)
    }, text)
    setSending(true)
    setComposer('')
    try {
      await sendSessionInput(`${payloadText}\r`, text)
      usedPlaceholders.forEach((placeholder) => composerImagesRef.current.delete(placeholder))
    } catch (e: any) {
      setComposer(text)
      message.error(e?.message || t('transcript:error.sendFailed'))
    } finally {
      setSending(false)
    }
  }, [composer, message, sendSessionInput, t])

  /**
   * 粘贴图片：上传成本地文件，发送时把 [Image #N] 占位符替换成 Claude/Codex
   * 识别的 @<path> 附件语法。
   *
   * 不再直接给 PTY 发 Ctrl+V：Claude Code/Codex 的图片粘贴态会让后续 Enter
   * 偶发变成输入框换行，导致 conversation 里看起来"发送不了"。
   */
  const handleComposerPaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const data = e.clipboardData
    if (!data) return
    const items = data.items
    if (!items) return
    const imageFiles: File[] = []
    for (let i = 0; i < items.length; i++) {
      if (!(items[i].type || '').startsWith('image/')) continue
      const file = items[i].getAsFile()
      if (file) imageFiles.push(file)
    }
    if (!imageFiles.length) return  // 没图：让浏览器粘文字
    const pastedText = data.getData('text/plain') || data.getData('text') || ''
    e.preventDefault()

    let placeholders: string[]
    try {
      placeholders = await Promise.all(imageFiles.map(async (file) => {
        const { path } = await uploadImage(file)
        imageCounterRef.current += 1
        const placeholder = `[Image #${imageCounterRef.current}]`
        composerImagesRef.current.set(placeholder, path)
        return placeholder
      }))
    } catch (err: any) {
      message.error(err?.message || t('transcript:error.uploadImageFailed'))
      return
    }

    // 在 textarea 当前光标位置插入 "{pastedText}{placeholder}"。
    // antd Mentions 内部 textarea 是 e.target；selectionStart/End 可用。
    const ta = e.target as HTMLTextAreaElement
    const selStart = typeof ta.selectionStart === 'number' ? ta.selectionStart : composer.length
    const selEnd = typeof ta.selectionEnd === 'number' ? ta.selectionEnd : composer.length
    const before = composer.slice(0, selStart)
    const after = composer.slice(selEnd)
    const needSepBefore = before.length > 0 && !/\s$/.test(before)
    const insert = `${needSepBefore ? ' ' : ''}${pastedText ? `${pastedText} ` : ''}${placeholders.join(' ')}`
    const next = `${before}${insert}${after}`
    setComposer(next)
    // 把光标移到刚插入内容的末尾。需要等 React 提交后再设置 selection，
    // 否则 antd 内部 onChange 会把 selection 拉回原位置。
    requestAnimationFrame(() => {
      try {
        const newPos = before.length + insert.length
        ta.setSelectionRange?.(newPos, newPos)
        ta.focus()
      } catch { /* ignore */ }
    })
  }, [composer, message, t])

  // Ctrl+C：发 \x03 信号让 Claude 打断当前生成（停止 tool / 文本输出），
  // 会话保持存活，用户可以继续追问。对应终端里手动敲 Ctrl+C 的语义。
  const handleInterrupt = useCallback(async () => {
    try {
      await sendAiInput(sessionId, '\x03')
      message.success(t('transcript:message.interrupted'), 1)
    } catch (e: any) {
      const msg = e?.message === 'session_not_found'
        ? t('transcript:error.interruptSessionEnded')
        : (e?.message || t('transcript:error.interruptFailed'))
      message.error(msg)
    }
  }, [sessionId, message, t])

  // 结束会话：kill 掉 PTY 进程。和中断不同，结束后需要 resume 才能再聊。
  const handleEndSession = useCallback(async () => {
    try {
      await stopAiExec(sessionId)
      message.success(t('transcript:message.sessionEnded'), 1.5)
    } catch (e: any) {
      const msg = e?.message === 'session_not_found'
        ? t('transcript:error.endAlreadyEnded')
        : (e?.message || t('transcript:error.endFailed'))
      message.error(msg)
    }
  }, [sessionId, message, t])

  const toggleAllTools = () => {
    const next = !allToolsCollapsed
    setAllToolsCollapsed(next)
    if (!displayedTurns.length) return
    const map: Record<number, boolean> = {}
    // 显式覆写所有 tool/result/thinking（含 Edit-like，让"折叠工具"按钮把 diff 一并折叠）
    displayedTurns.forEach((t, i) => {
      if (t.role === 'tool_use' || t.role === 'tool_result' || t.role === 'thinking') map[i] = next
    })
    setCollapsedTools(map)
  }

  const transcriptSessionId = data?.session?.sessionId ?? null
  const transcriptLiveSession = useAiSessionStore((s) =>
    transcriptSessionId ? s.sessions.get(transcriptSessionId) : undefined,
  )
  const transcriptLastSeen = useUnreadStore((s) =>
    transcriptSessionId ? s.lastSeenAt.get(transcriptSessionId) : undefined,
  )
  const transcriptUnread = isSessionUnread(
    transcriptLiveSession?.lastTurnDoneAt,
    transcriptLastSeen,
  )
  // live session 比 fetched data.session 新；data.session 在 transcript fetch 那一刻
  // 是 snapshot，可能没赶上后续 running → done 切换。live 优先，data 兜底（fetch 完成
  // 但 live store 还没 poll 到的边角窗口）。
  const transcriptState = deriveAiState(
    transcriptLiveSession?.status ?? data?.session?.status,
    transcriptUnread,
    transcriptLiveSession?.awaitingReply ?? false,
  )

  const wrapperClassName = [
    'tv-wrapper',
    fullscreen ? 'tv-wrapper--fullscreen' : '',
    fillHeight ? 'tv-wrapper--fill' : '',
  ].filter(Boolean).join(' ')

  const wrapperStyle: React.CSSProperties = fullscreen
    ? {}
    : fillHeight
      ? {}
      : { height }

  const sessionCwd = data?.session && (data.session as any).cwd ? String((data.session as any).cwd) : (cwd || null)

  return (
    <div className={wrapperClassName} style={wrapperStyle}>
      <div className="tv-toolbar">
        <Input
          size="small"
          allowClear
          variant="borderless"
          prefix={<SearchOutlined style={{ color: 'var(--text-tertiary)' }} />}
          placeholder={t('transcript:toolbar.searchPlaceholder')}
          value={keyword}
          onChange={(e) => { setKeyword(e.target.value); setSearchIdx(0) }}
          style={{ flex: 1, minWidth: 120 }}
        />
        {keyword && (
          <>
            <span className="tv-match-count">{matches.length ? `${searchIdx + 1}/${matches.length}` : '0'}</span>
            <Button size="small" type="text" disabled={!matches.length} onClick={() => jumpToMatch(searchIdx - 1)}>↑</Button>
            <Button size="small" type="text" disabled={!matches.length} onClick={() => jumpToMatch(searchIdx + 1)}>↓</Button>
          </>
        )}
        <Button size="small" type="text" onClick={toggleAllTools}>
          {allToolsCollapsed ? t('transcript:toolbar.expandAll') : t('transcript:toolbar.collapseAll')}
        </Button>
        <Button size="small" type="text" icon={<ReloadOutlined />} onClick={() => { void fetchData('reset') }} loading={loading} />
        <Tooltip title={fullscreen ? t('transcript:toolbar.exitFullscreen') : t('transcript:toolbar.fullscreen')}>
          <Button
            size="small"
            type="text"
            icon={fullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
            onClick={() => setFullscreen(v => !v)}
          />
        </Tooltip>
      </div>
      <div className="tv-body" ref={scrollRef} onScroll={handleBodyScroll}>
        {loading && !data && <div style={{ textAlign: 'center', padding: 24 }}><Spin /></div>}
        {error && <div className="tv-error">{error}</div>}
        {!loading && !error && data && data.turns.length === 0 && (() => {
          const status = data.session.status
          // 活跃态(running/pending_confirm)由下方 tv-thinking 块负责渲染"AI 思考中"等提示;
          // idle 是 PTY 已起但还没产出的中间态,这里补一个"AI 启动中"指示,避免空屏被误读为"找不到记录"。
          if (status === 'running' || status === 'pending_confirm') return null
          if (status === 'idle') {
            return (
              <div className="tv-thinking" aria-live="polite">
                <span className="tv-thinking-label">{t('transcript:emptyStarting')}</span>
                <span className="tv-thinking-dots" aria-hidden="true">
                  <i /><i /><i />
                </span>
              </div>
            )
          }
          return <Empty description={t('transcript:empty')} />
        })()}
        {displayedTurns.map((t, i) => {
          // Edit/StrReplace/Write 默认展开（用户最常想直接看 diff），其他工具默认折叠
          const isEditLike = t.role === 'tool_use' && (t.toolName === 'Edit' || t.toolName === 'StrReplace' || t.toolName === 'Write')
          const defaultCollapsed = isEditLike ? false : allToolsCollapsed
          return (
            <TurnItem
              key={t.optimisticId || `${t.role}-${t.timestamp || 0}-${i}`}
              turn={t}
              index={i}
              keyword={keyword}
              canFork={!!onFork}
              collapsed={collapsedTools[i] ?? defaultCollapsed}
              onFork={handleTurnFork}
              onToggleCollapse={handleToggleCollapse}
            />
          )
        })}
        {(() => {
          const status = data?.session.status
          // 等待用户确认是独立状态，始终提示一下
          if (status === 'pending_confirm' && transcriptState === 'pending') {
            return (
              <div className="tv-thinking" aria-live="polite">
                <span className="tv-thinking-label">{t('transcript:thinking.waitingConfirm')}</span>
                <span className="tv-thinking-dots" aria-hidden="true">
                  <i /><i /><i />
                </span>
              </div>
            )
          }
          // "AI 思考中"只在真正等 AI 回复时才显示：
          //   session 在跑 + 最后一条 turn 是 user 发来的消息（还没有 assistant
          //   产出）。如果 PTY 正在推 liveOutput，则 tool_use/tool_result/thinking
          //   也视为活跃生成；assistant 仍不显示，避免回复结束后 loading 挂住。
          //   sending 兜底覆盖发送到 optimistic turn 刷新前那一瞬。
          if (status !== 'running') return null
          const lastTurn = displayedTurns[displayedTurns.length - 1]
          const liveActiveRoles = new Set(['user', 'tool_use', 'tool_result', 'thinking'])
          const waiting = sending || !lastTurn || lastTurn.role === 'user' || (!!liveOutput && liveActiveRoles.has(lastTurn.role))
          if (!waiting) return null
          return (
            <div className="tv-thinking" aria-live="polite">
              <span className="tv-thinking-label">{t('transcript:thinking.aiThinking')}</span>
              <span className="tv-thinking-dots" aria-hidden="true">
                <i /><i /><i />
              </span>
            </div>
          )
        })()}
      </div>
      {unreadCount > 0 && (
        <button className="tv-unread-pill" onClick={jumpToLatest}>
          {t('transcript:unreadPill', { count: unreadCount })}
        </button>
      )}
      {(() => {
        const canInterrupt = transcriptState === 'running' || data?.session.status === 'pending_confirm'
        const status = data?.session.status
        const statusDotCls =
          transcriptState === 'pending' ? 'tv-statusbar-dot--warn' :
          transcriptState === 'running' ? 'tv-statusbar-dot--running' :
          status === 'failed' ? 'tv-statusbar-dot--err' :
          'tv-statusbar-dot--idle'
        const statusText =
          transcriptState === 'pending' ? t('transcript:status.pending') :
          transcriptState === 'running' ? (sending ? t('transcript:status.sending') : t('transcript:status.running')) :
          status === 'failed' ? t('transcript:status.failed') :
          status === 'stopped' ? t('transcript:status.stopped') :
          status === 'done' ? t('transcript:status.idle') : t('transcript:status.idle')
        const sourceText = data?.source === 'jsonl' ? t('transcript:source.jsonl') : data?.source === 'ptylog' ? t('transcript:source.ptylog') : t('transcript:source.noData')
        return (
          <div className="tv-statusbar">
            <span className={`tv-statusbar-dot ${statusDotCls}`} />
            <span className="tv-statusbar-text">{statusText}</span>
            <span className="tv-statusbar-sep">·</span>
            <span className="tv-statusbar-text tv-statusbar-mute">{sourceText}</span>
            {sessionCwd && (
              <>
                <span className="tv-statusbar-sep">·</span>
                <span className="tv-statusbar-text tv-statusbar-mute" title={sessionCwd}>{t('transcript:statusbar.worktree', { path: shortPath(sessionCwd) })}</span>
              </>
            )}
            <div style={{ flex: 1 }} />
            <Tooltip title={canInterrupt ? t('transcript:statusbar.interruptEnabled') : t('transcript:statusbar.interruptDisabled')}>
              <button
                className="tv-statusbar-btn"
                disabled={!canInterrupt}
                onClick={() => { void handleInterrupt() }}
              >
                <StopOutlined /> {t('transcript:statusbar.interrupt')}
              </button>
            </Tooltip>
            <Popconfirm
              title={t('transcript:endConfirm.title')}
              description={t('transcript:endConfirm.description')}
              okText={t('transcript:endConfirm.okText')}
              okButtonProps={{ danger: true }}
              cancelText={t('transcript:endConfirm.cancelText')}
              onConfirm={() => { void handleEndSession() }}
              disabled={!canInterrupt}
            >
              <Tooltip title={canInterrupt ? t('transcript:statusbar.endEnabled') : t('transcript:statusbar.endDisabled')}>
                <button className="tv-statusbar-btn tv-statusbar-btn--danger" disabled={!canInterrupt}>
                  <PoweroffOutlined /> {t('transcript:statusbar.end')}
                </button>
              </Tooltip>
            </Popconfirm>
          </div>
        )
      })()}
      <div
        className="tv-composer"
        onCompositionStart={() => { composingRef.current = true }}
        onCompositionEnd={() => {
          composingRef.current = false
          composingEndAtRef.current = performance.now()
        }}
      >
        <span className="tv-composer-prompt" aria-hidden>›</span>
        <Mentions
          value={composer}
          onChange={(v) => setComposer(v)}
          prefix="/"
          variant="borderless"
          options={slashOptions}
          placeholder={data?.session.status === 'pending_confirm'
            ? t('transcript:composer.placeholderPending')
            : t('transcript:composer.placeholderDefault')}
          autoSize={{ minRows: 1, maxRows: 8 }}
          filterOption={(input, option) => {
            const v = String(option?.value || '').toLowerCase()
            return v.includes(input.toLowerCase())
          }}
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={() => {
            composingRef.current = false
            composingEndAtRef.current = performance.now()
          }}
          onPressEnter={(e) => {
            // 下拉打开时 Mentions 内部会拦截 Enter 做选项确认，不会走到这里
            if (e.shiftKey) return
            // 组字中：不论 React 合成事件还是原生 flag，任一命中都不发送
            const native = e.nativeEvent as KeyboardEvent
            if (composingRef.current || native?.isComposing || native?.keyCode === 229) return
            // 有些浏览器在 compositionend 前就派 keydown(Enter)，composingRef 已经
            // 被提前 reset；给 80ms 保护窗口吃掉这种"选完候选词后紧跟的 Enter"
            if (performance.now() - composingEndAtRef.current < 80) return
            e.preventDefault()
            void handleSendMessage()
          }}
          onPaste={handleComposerPaste}
        />
        <button
          className="tv-composer-send"
          disabled={!composer.trim() || sending}
          onClick={() => { void handleSendMessage() }}
          title={t('transcript:composer.sendTooltip')}
        >
          {t('transcript:composer.sendLabel')}
        </button>
      </div>
      {!fullscreen && !fillHeight && (
        <div
          className="tv-resize-handle"
          onMouseDown={onDragStart}
          onTouchStart={onDragStart}
          title={t('transcript:resize.tooltip')}
        >
          <div className="tv-resize-grip" />
        </div>
      )}
      {fullscreen && (
        <div className="tv-fullscreen-hint">{t('transcript:fullscreenHint')}</div>
      )}
    </div>
  )
}
