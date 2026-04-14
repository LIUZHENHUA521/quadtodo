import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Input, Button, Spin, Tag, Empty, Tooltip, message } from 'antd'
import { ReloadOutlined, BranchesOutlined, DownOutlined, RightOutlined, SearchOutlined } from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import hljs from 'highlight.js'
import 'highlight.js/styles/github.css'
import { getTranscript, TranscriptResponse, TranscriptTurn } from './api'
import './TranscriptView.css'

interface Props {
  todoId: string
  sessionId: string
  onFork?: (turnIndex: number, upToTurns: TranscriptTurn[]) => void
  autoRefreshMs?: number
}

const ROLE_META: Record<string, { label: string; cls: string }> = {
  user: { label: '我', cls: 'tv-role-user' },
  assistant: { label: 'AI', cls: 'tv-role-assistant' },
  thinking: { label: '思考', cls: 'tv-role-thinking' },
  tool_use: { label: '工具调用', cls: 'tv-role-tool-use' },
  tool_result: { label: '工具输出', cls: 'tv-role-tool-result' },
  raw: { label: '日志', cls: 'tv-role-raw' },
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

export default function TranscriptView({ todoId, sessionId, onFork, autoRefreshMs = 0 }: Props) {
  const [data, setData] = useState<TranscriptResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [keyword, setKeyword] = useState('')
  const [searchIdx, setSearchIdx] = useState(0)
  const [collapsedTools, setCollapsedTools] = useState<Record<number, boolean>>({})
  const [allToolsCollapsed, setAllToolsCollapsed] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await getTranscript(todoId, sessionId)
      setData(r)
    } catch (e: any) {
      setError(e?.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [todoId, sessionId])

  useEffect(() => { fetchData() }, [fetchData])
  useEffect(() => {
    if (!autoRefreshMs) return
    const t = setInterval(fetchData, autoRefreshMs)
    return () => clearInterval(t)
  }, [autoRefreshMs, fetchData])

  const matches = useMemo(() => {
    if (!keyword || !data) return [] as number[]
    const lower = keyword.toLowerCase()
    return data.turns.reduce<number[]>((acc, t, i) => {
      if (t.content?.toLowerCase().includes(lower)) acc.push(i)
      return acc
    }, [])
  }, [keyword, data])

  const jumpToMatch = useCallback((nextIdx: number) => {
    if (!matches.length) return
    const i = ((nextIdx % matches.length) + matches.length) % matches.length
    setSearchIdx(i)
    const el = scrollRef.current?.querySelector(`[data-turn-index="${matches[i]}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [matches])

  useEffect(() => { if (matches.length) jumpToMatch(0) }, [matches, jumpToMatch])

  const toggleAllTools = () => {
    const next = !allToolsCollapsed
    setAllToolsCollapsed(next)
    if (!data) return
    const map: Record<number, boolean> = {}
    data.turns.forEach((t, i) => {
      if (t.role === 'tool_use' || t.role === 'tool_result' || t.role === 'thinking') map[i] = next
    })
    setCollapsedTools(map)
  }

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
        <Button size="small" icon={<ReloadOutlined />} onClick={fetchData} loading={loading} />
        {data && <Tag color={data.source === 'jsonl' ? 'green' : data.source === 'ptylog' ? 'orange' : 'default'}>
          {data.source === 'jsonl' ? '结构化' : data.source === 'ptylog' ? '日志降级' : '无数据'}
        </Tag>}
      </div>
      <div className="tv-body" ref={scrollRef}>
        {loading && !data && <div style={{ textAlign: 'center', padding: 24 }}><Spin /></div>}
        {error && <div className="tv-error">{error}</div>}
        {!loading && !error && data && data.turns.length === 0 && (
          <Empty description="没有找到会话记录（JSONL 文件和 PTY 日志都不存在）" />
        )}
        {data?.turns.map((t, i) => (
          <TurnItem
            key={i}
            turn={t}
            index={i}
            keyword={keyword}
            onFork={onFork ? (idx) => onFork(idx, data.turns.slice(0, idx + 1)) : undefined}
            collapsedTools={collapsedTools[i] ?? allToolsCollapsed}
            toggleTool={() => setCollapsedTools(prev => ({ ...prev, [i]: !(prev[i] ?? allToolsCollapsed) }))}
          />
        ))}
      </div>
    </div>
  )
}
