import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Input, Button, Spin, Tag, Empty, Tooltip, Mentions, Popconfirm, message } from 'antd'
import {
  ReloadOutlined, BranchesOutlined, DownOutlined, RightOutlined, SearchOutlined, SendOutlined,
  FullscreenOutlined, FullscreenExitOutlined, StopOutlined, PoweroffOutlined,
} from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import hljs from 'highlight.js'
import 'highlight.js/styles/github.css'
import { getTranscript, ResumeSessionInput, sendAiInput, startAiExec, stopAiExec, TranscriptResponse, TranscriptTurn } from './api'
import './TranscriptView.css'

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

const ROLE_META: Record<string, { label: string; cls: string }> = {
  user: { label: '我', cls: 'tv-role-user' },
  assistant: { label: 'AI', cls: 'tv-role-assistant' },
  thinking: { label: '思考', cls: 'tv-role-thinking' },
  tool_use: { label: '工具调用', cls: 'tv-role-tool-use' },
  tool_result: { label: '工具输出', cls: 'tv-role-tool-result' },
  raw: { label: '日志', cls: 'tv-role-raw' },
}

function sessionStatusMeta(status?: string) {
  if (status === 'running') return { color: 'processing', text: '运行中' }
  if (status === 'pending_confirm') return { color: 'error', text: '待交互' }
  if (status === 'done') return { color: 'success', text: '已完成' }
  if (status === 'failed') return { color: 'error', text: '失败' }
  if (status === 'stopped') return { color: 'warning', text: '已停止' }
  return { color: 'default', text: status || '未知' }
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

function CodeBlock({ inline, className, children }: any) {
  const code = String(children).replace(/\n$/, '')
  if (inline) return <code className="tv-inline-code">{children}</code>
  const lang = /language-(\w+)/.exec(className || '')?.[1]
  let html = ''
  try {
    html = lang && hljs.getLanguage(lang)
      ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
      : hljs.highlightAuto(code).value
  } catch {
    html = code
  }
  return (
    <pre className="tv-code-pre hljs">
      <code dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  )
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

const TurnItem = React.memo(function TurnItem({ turn, index, keyword, canFork, collapsed, onFork, onToggleCollapse }: TurnItemProps) {
  const meta = ROLE_META[turn.role] || { label: turn.role, cls: '' }
  const isTool = turn.role === 'tool_use' || turn.role === 'tool_result' || turn.role === 'thinking'
  const isRaw = turn.role === 'raw'

  // markdown / 代码高亮仅在内容或关键词变化时重跑，切 tab / 追加新 turn 时不做无谓计算
  const body = useMemo(() => {
    if (isTool) {
      if (collapsed) return null
      return <pre className="tv-tool-pre">{highlightKeyword(turn.content, keyword)}</pre>
    }
    if (isRaw) return <pre className="tv-raw-pre">{highlightKeyword(turn.content, keyword)}</pre>
    if (keyword && turn.content.toLowerCase().includes(keyword.toLowerCase())) {
      return <div className="tv-plain">{highlightKeyword(turn.content, keyword)}</div>
    }
    return (
      <div className="tv-md">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: CodeBlock as any }}>
          {turn.content}
        </ReactMarkdown>
      </div>
    )
  }, [turn.content, turn.role, keyword, collapsed, isTool, isRaw])

  const handleToggle = useCallback(() => onToggleCollapse(index), [onToggleCollapse, index])
  const handleFork = useCallback(() => onFork(index), [onFork, index])

  return (
    <div className={`tv-turn ${meta.cls}`} data-turn-index={index}>
      <div className="tv-turn-header">
        <Tag className="tv-turn-tag">{meta.label}{turn.toolName ? ` · ${turn.toolName}` : ''}</Tag>
        {turn.timestamp && (
          <span className="tv-turn-time">{new Date(turn.timestamp).toLocaleTimeString()}</span>
        )}
        {isTool && (
          <Button size="small" type="text" icon={collapsed ? <RightOutlined /> : <DownOutlined />} onClick={handleToggle}>
            {collapsed ? '展开' : '折叠'}
          </Button>
        )}
        <div style={{ flex: 1 }} />
        {canFork && !isTool && !isRaw && (
          <Tooltip title="从这里 Fork 新会话">
            <Button size="small" type="text" icon={<BranchesOutlined />} onClick={handleFork} />
          </Tooltip>
        )}
      </div>
      {body}
    </div>
  )
})

type LocalTurn = TranscriptTurn & { optimisticId?: string }

const MIN_HEIGHT = 240
const MAX_HEIGHT = 1200

export default function TranscriptView({ todoId, sessionId, onFork, autoRefreshMs = 0, resumeTarget = null, onSessionRecovered, fillHeight, cwd, active = true }: Props) {
  const [data, setData] = useState<TranscriptResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [keyword, setKeyword] = useState('')
  const [searchIdx, setSearchIdx] = useState(0)
  const [collapsedTools, setCollapsedTools] = useState<Record<number, boolean>>({})
  const [allToolsCollapsed, setAllToolsCollapsed] = useState(false)
  const [composer, setComposer] = useState('')
  const [optimisticTurns, setOptimisticTurns] = useState<LocalTurn[]>([])
  // jsonl 只有消息收尾才落盘，Chat 续聊 tab 过去只能等全文返回才显示；
  // 服务端现在会推 PTY 实时渲染文本，展示为列表最末的"实时"伪 turn
  const [liveOutput, setLiveOutput] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [height, setHeight] = useState<number>(() => {
    try {
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
      if (mode !== 'poll') setError(e?.message || '加载失败')
    } finally {
      if (mode === 'reset') setLoading(false)
    }
  }, [todoId, sessionId])

  useEffect(() => {
    dataRef.current = null
    setData(null)
    setError(null)
    setComposer('')
    setOptimisticTurns([])
    setCollapsedTools({})
    setAllToolsCollapsed(false)
    setLiveOutput(null)
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
          setLiveOutput(null)
        }
      } catch { /* ignore */ }
    }
    const handleLiveOutput = (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data)
        if (typeof payload?.content === 'string') setLiveOutput(payload.content)
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
          <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: '#1677ff', flexShrink: 0 }}>/{c.name}</span>
          <span style={{ fontSize: 11, color: '#888', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {c.description || '—'}
          </span>
          {c.source === 'project' && <Tag color="orange" style={{ fontSize: 10, margin: 0, lineHeight: '16px', height: 16, padding: '0 4px' }}>项目</Tag>}
          {typeof c.source === 'string' && c.source.startsWith('plugin:') && (
            <Tag color="purple" style={{ fontSize: 10, margin: 0, lineHeight: '16px', height: 16, padding: '0 4px' }}>插件</Tag>
          )}
        </div>
      ),
    }))
  ), [slashCommands])

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
      throw new Error('当前会话没有可恢复的原生会话 ID')
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
  }, [onSessionRecovered, resumeTarget])

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
      if (currentStatus === 'running' || currentStatus === 'pending_confirm') {
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
        throw new Error('当前会话已结束，且没有可恢复的原生会话 ID')
      }
      const nextSessionId = await resumeSession()
      await doSend(nextSessionId)
    } catch (e) {
      if (optimisticId) {
        setOptimisticTurns(prev => prev.filter(turn => turn.optimisticId !== optimisticId))
      }
      throw e
    }
  }, [fetchData, resumeSession, resumeTarget, sessionId])

  const handleSendMessage = useCallback(async () => {
    const text = composer.trim()
    if (!text) return
    setSending(true)
    setComposer('')
    try {
      await sendSessionInput(`${text}\r`, text)
    } catch (e: any) {
      setComposer(text)
      message.error(e?.message || '发送失败')
    } finally {
      setSending(false)
    }
  }, [composer, sendSessionInput])

  /** 粘贴图片：走 Live 同一机制 —— 发 Ctrl+V (0x16) 给 PTY，Claude Code 自己读 OS 剪贴板 */
  const handleComposerPaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (!items) return
    let hasImage = false
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) { hasImage = true; break }
    }
    if (!hasImage) return
    e.preventDefault()
    try {
      await sendAiInput(sessionId, '\x16')
      message.success('已粘贴图片到 Claude（将随下一条消息一起提交）', 1.5)
    } catch (err: any) {
      const msg = err?.message === 'session_not_found'
        ? '会话已结束：请先发一条消息激活/恢复会话后再粘贴图片'
        : (err?.message || '粘贴图片失败')
      message.error(msg)
    }
  }, [sessionId])

  const handleSendEnter = useCallback(async () => {
    setSending(true)
    try {
      await sendSessionInput('\r')
    } catch (e: any) {
      message.error(e?.message || '发送回车失败')
    } finally {
      setSending(false)
    }
  }, [sendSessionInput])

  // Ctrl+C：发 \x03 信号让 Claude 打断当前生成（停止 tool / 文本输出），
  // 会话保持存活，用户可以继续追问。对应终端里手动敲 Ctrl+C 的语义。
  const handleInterrupt = useCallback(async () => {
    try {
      await sendAiInput(sessionId, '\x03')
      message.success('已发送中断（Ctrl+C）', 1)
    } catch (e: any) {
      const msg = e?.message === 'session_not_found'
        ? '会话已结束，无法中断'
        : (e?.message || '中断失败')
      message.error(msg)
    }
  }, [sessionId])

  // 结束会话：kill 掉 PTY 进程。和中断不同，结束后需要 resume 才能再聊。
  const handleEndSession = useCallback(async () => {
    try {
      await stopAiExec(sessionId)
      message.success('会话已结束', 1.5)
    } catch (e: any) {
      const msg = e?.message === 'session_not_found'
        ? '会话已经结束了'
        : (e?.message || '结束会话失败')
      message.error(msg)
    }
  }, [sessionId])

  const toggleAllTools = () => {
    const next = !allToolsCollapsed
    setAllToolsCollapsed(next)
    if (!displayedTurns.length) return
    const map: Record<number, boolean> = {}
    displayedTurns.forEach((t, i) => {
      if (t.role === 'tool_use' || t.role === 'tool_result' || t.role === 'thinking') map[i] = next
    })
    setCollapsedTools(map)
  }

  const statusMeta = sessionStatusMeta(data?.session.status)

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

  return (
    <div className={wrapperClassName} style={wrapperStyle}>
      <div className="tv-toolbar">
        <Input
          size="small"
          allowClear
          prefix={<SearchOutlined />}
          placeholder="搜索对话..."
          value={keyword}
          onChange={(e) => { setKeyword(e.target.value); setSearchIdx(0) }}
          style={{ flex: 1, minWidth: 120 }}
        />
        {keyword && (
          <>
            <span className="tv-match-count">{matches.length ? `${searchIdx + 1}/${matches.length}` : '0'}</span>
            <Button size="small" disabled={!matches.length} onClick={() => jumpToMatch(searchIdx - 1)}>↑</Button>
            <Button size="small" disabled={!matches.length} onClick={() => jumpToMatch(searchIdx + 1)}>↓</Button>
          </>
        )}
        <Button size="small" onClick={toggleAllTools}>
          {allToolsCollapsed ? '展开工具' : '折叠工具'}
        </Button>
        <Button size="small" icon={<ReloadOutlined />} onClick={() => { void fetchData('reset') }} loading={loading} />
        {data && <Tag color={data.source === 'jsonl' ? 'green' : data.source === 'ptylog' ? 'orange' : 'default'}>
          {data.source === 'jsonl' ? '结构化' : data.source === 'ptylog' ? '日志降级' : '无数据'}
        </Tag>}
        {data && <Tag color={statusMeta.color}>{statusMeta.text}</Tag>}
        <Tooltip title={fullscreen ? '退出全屏 (Esc)' : '全屏'}>
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
        {!loading && !error && data && data.turns.length === 0 && (
          <Empty description="没有找到会话记录（JSONL 文件和 PTY 日志都不存在）" />
        )}
        {displayedTurns.map((t, i) => (
          <TurnItem
            key={t.optimisticId || `${t.role}-${t.timestamp || 0}-${i}`}
            turn={t}
            index={i}
            keyword={keyword}
            canFork={!!onFork}
            collapsed={collapsedTools[i] ?? allToolsCollapsed}
            onFork={handleTurnFork}
            onToggleCollapse={handleToggleCollapse}
          />
        ))}
        {liveOutput && (
          <div className="tv-turn tv-role-raw tv-turn-live">
            <div className="tv-turn-header">
              <Tag className="tv-turn-tag" color="processing">实时</Tag>
              <span className="tv-live-pulse">生成中</span>
            </div>
            <pre className="tv-raw-pre">{liveOutput}</pre>
          </div>
        )}
        {!liveOutput
          && (data?.session.status === 'running' || data?.session.status === 'pending_confirm')
          && (
            <div className="tv-thinking" aria-live="polite">
              <span className="tv-thinking-label">
                {data?.session.status === 'pending_confirm' ? '等待确认' : 'AI 思考中'}
              </span>
              <span className="tv-thinking-dots" aria-hidden="true">
                <i /><i /><i />
              </span>
            </div>
          )}
      </div>
      {unreadCount > 0 && (
        <button className="tv-unread-pill" onClick={jumpToLatest}>
          ↓ {unreadCount} 条新消息
        </button>
      )}
      <div
        className="tv-composer"
        // 组字事件会冒泡到这里，即便 Antd Mentions 某些版本没把 onCompositionStart/End
        // 直接透传给内部 textarea，也能稳定拿到。双写一份同名 props 给 Mentions 作为
        // 保险：某些环境下外层 div 没拿到的情况还能兜住。
        onCompositionStart={() => { composingRef.current = true }}
        onCompositionEnd={() => {
          composingRef.current = false
          composingEndAtRef.current = performance.now()
        }}
      >
        <Mentions
          value={composer}
          onChange={(v) => setComposer(v)}
          prefix="/"
          options={slashOptions}
          placeholder="继续这段会话，Enter 发送 / Shift+Enter 换行 / 输入 / 查看命令 / Cmd+V 粘贴图片"
          autoSize={{ minRows: 2, maxRows: 6 }}
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
        <div className="tv-composer-actions">
          <span className="tv-composer-hint">
            {data?.session.status === 'pending_confirm' ? '当前等待确认，可直接发回车或补充说明。' : '支持在这里继续追问，必要时会自动恢复历史会话。'}
          </span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(() => {
              const canInterrupt = data?.session.status === 'running' || data?.session.status === 'pending_confirm'
              return (
                <>
                  <Tooltip title={canInterrupt ? '发送 Ctrl+C 打断当前生成，会话保留，可继续追问' : '会话未在运行，无需打断'}>
                    <Button
                      icon={<StopOutlined />}
                      disabled={!canInterrupt}
                      onClick={() => { void handleInterrupt() }}
                    >
                      中断
                    </Button>
                  </Tooltip>
                  <Popconfirm
                    title="结束会话"
                    description="将终止 PTY 进程，之后需要再发消息才会 resume 新会话。"
                    okText="结束"
                    okButtonProps={{ danger: true }}
                    cancelText="取消"
                    onConfirm={() => { void handleEndSession() }}
                    disabled={!canInterrupt}
                  >
                    <Tooltip title={canInterrupt ? '终止 PTY 进程' : '会话已不在运行，无需结束'}>
                      <Button danger disabled={!canInterrupt} icon={<PoweroffOutlined />}>结束会话</Button>
                    </Tooltip>
                  </Popconfirm>
                </>
              )
            })()}
            <Button onClick={() => { void handleSendEnter() }} loading={sending}>
              发送回车
            </Button>
            <Button type="primary" icon={<SendOutlined />} onClick={() => { void handleSendMessage() }} loading={sending} disabled={!composer.trim()}>
              继续对话
            </Button>
          </div>
        </div>
      </div>
      {!fullscreen && !fillHeight && (
        <div
          className="tv-resize-handle"
          onMouseDown={onDragStart}
          onTouchStart={onDragStart}
          title="拖动调整高度"
        >
          <div className="tv-resize-grip" />
        </div>
      )}
      {fullscreen && (
        <div className="tv-fullscreen-hint">按 Esc 或点击右上角退出全屏</div>
      )}
    </div>
  )
}
