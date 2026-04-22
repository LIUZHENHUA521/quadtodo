import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Input, Button, Spin, Tag, Empty, Tooltip, message } from 'antd'
import {
  ReloadOutlined, BranchesOutlined, DownOutlined, RightOutlined, SearchOutlined, SendOutlined,
  FullscreenOutlined, FullscreenExitOutlined,
} from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import hljs from 'highlight.js'
import 'highlight.js/styles/github.css'
import { getTranscript, ResumeSessionInput, sendAiInput, startAiExec, TranscriptResponse, TranscriptTurn } from './api'
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

function TurnItem({ turn, index, keyword, onFork, collapsedTools, toggleTool }: {
  turn: TranscriptTurn
  index: number
  keyword: string
  onFork?: (i: number) => void
  collapsedTools: boolean
  toggleTool: () => void
}) {
  const meta = ROLE_META[turn.role] || { label: turn.role, cls: '' }
  const isTool = turn.role === 'tool_use' || turn.role === 'tool_result' || turn.role === 'thinking'
  const isRaw = turn.role === 'raw'

  const body = (() => {
    if (isTool) {
      if (collapsedTools) return null
      return (
        <pre className="tv-tool-pre">{highlightKeyword(turn.content, keyword)}</pre>
      )
    }
    if (isRaw) return <pre className="tv-raw-pre">{highlightKeyword(turn.content, keyword)}</pre>
    if (keyword) {
      // Markdown + 高亮难以同时支持，先做关键词高亮的 fallback 纯文本视图
      if (turn.content.toLowerCase().includes(keyword.toLowerCase())) {
        return <div className="tv-plain">{highlightKeyword(turn.content, keyword)}</div>
      }
    }
    return (
      <div className="tv-md">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: CodeBlock as any }}>
          {turn.content}
        </ReactMarkdown>
      </div>
    )
  })()

  return (
    <div className={`tv-turn ${meta.cls}`} data-turn-index={index}>
      <div className="tv-turn-header">
        <Tag className="tv-turn-tag">{meta.label}{turn.toolName ? ` · ${turn.toolName}` : ''}</Tag>
        {turn.timestamp && (
          <span className="tv-turn-time">{new Date(turn.timestamp).toLocaleTimeString()}</span>
        )}
        {isTool && (
          <Button size="small" type="text" icon={collapsedTools ? <RightOutlined /> : <DownOutlined />} onClick={toggleTool}>
            {collapsedTools ? '展开' : '折叠'}
          </Button>
        )}
        <div style={{ flex: 1 }} />
        {onFork && !isTool && !isRaw && (
          <Tooltip title="从这里 Fork 新会话">
            <Button size="small" type="text" icon={<BranchesOutlined />} onClick={() => onFork(index)} />
          </Tooltip>
        )}
      </div>
      {body}
    </div>
  )
}

type LocalTurn = TranscriptTurn & { optimisticId?: string }

const MIN_HEIGHT = 240
const MAX_HEIGHT = 1200

export default function TranscriptView({ todoId, sessionId, onFork, autoRefreshMs = 0, resumeTarget = null, onSessionRecovered, fillHeight }: Props) {
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

  const fetchData = useCallback(async (mode: 'reset' | 'incremental' = 'reset') => {
    if (mode === 'reset') setLoading(true)
    try {
      const previous = dataRef.current
      const since = mode === 'incremental' && previous ? previous.total : undefined
      const r = await getTranscript(todoId, sessionId, since)
      setError(null)
      setData((current) => {
        if (mode === 'incremental' && current && since != null) {
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
      setError(e?.message || '加载失败')
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
    void fetchData('reset')
  }, [fetchData])

  useEffect(() => {
    if (!autoRefreshMs) return
    const t = setInterval(() => { void fetchData('incremental') }, autoRefreshMs)
    return () => clearInterval(t)
  }, [autoRefreshMs, fetchData])

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
      <div className="tv-body" ref={scrollRef}>
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
            onFork={onFork ? (idx) => onFork(idx, displayedTurns.slice(0, idx + 1)) : undefined}
            collapsedTools={collapsedTools[i] ?? allToolsCollapsed}
            toggleTool={() => setCollapsedTools(prev => ({ ...prev, [i]: !(prev[i] ?? allToolsCollapsed) }))}
          />
        ))}
      </div>
      <div className="tv-composer">
        <Input.TextArea
          value={composer}
          onChange={(e) => setComposer(e.target.value)}
          placeholder="继续这段会话，Enter 发送，Shift+Enter 换行，Cmd/Ctrl+V 粘贴图片"
          autoSize={{ minRows: 2, maxRows: 6 }}
          onPressEnter={(e) => {
            if (e.shiftKey) return
            e.preventDefault()
            void handleSendMessage()
          }}
          onPaste={handleComposerPaste}
        />
        <div className="tv-composer-actions">
          <span className="tv-composer-hint">
            {data?.session.status === 'pending_confirm' ? '当前等待确认，可直接发回车或补充说明。' : '支持在这里继续追问，必要时会自动恢复历史会话。'}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
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
