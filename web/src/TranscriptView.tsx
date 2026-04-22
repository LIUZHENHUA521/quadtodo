import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Input, Button, Spin, Tag, Empty, Tooltip, message } from 'antd'
import { ReloadOutlined, BranchesOutlined, DownOutlined, RightOutlined, SearchOutlined, SendOutlined } from '@ant-design/icons'
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

export default function TranscriptView({ todoId, sessionId, onFork, autoRefreshMs = 0, resumeTarget = null, onSessionRecovered }: Props) {
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
  const scrollRef = useRef<HTMLDivElement>(null)
  const dataRef = useRef<TranscriptResponse | null>(null)

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

  return (
    <div className="tv-wrapper">
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
          placeholder="继续这段会话，Enter 发送，Shift+Enter 换行"
          autoSize={{ minRows: 2, maxRows: 6 }}
          onPressEnter={(e) => {
            if (e.shiftKey) return
            e.preventDefault()
            void handleSendMessage()
          }}
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
    </div>
  )
}
