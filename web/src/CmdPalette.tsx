import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Input, Modal, Spin, Tag } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import { searchAll, SearchResultItem, SearchScope } from './api'
import { useIsMobile } from './hooks/useIsMobile'

interface Props {
  open: boolean
  onClose: () => void
  /** 点回车时把命中跳转到对应 todo（打开详情抽屉）。 */
  onJumpToTodo: (todoId: string) => void
}

const ALL_SCOPES: { key: SearchScope; label: string }[] = [
  { key: 'todos', label: '待办' },
  { key: 'comments', label: '评论' },
  { key: 'wiki', label: '记忆' },
  { key: 'ai_sessions', label: 'AI 会话' },
]

const SCOPE_BADGE_COLOR: Record<SearchScope, string> = {
  todos: 'blue',
  comments: 'green',
  wiki: 'purple',
  ai_sessions: 'orange',
}

/**
 * 为了让 dangerouslySetInnerHTML 安全一些，我们只允许后端已有的 `<mark>` 包裹。
 * 其它尖括号全部 escape。
 */
function sanitizeSnippet(raw: string): string {
  const escaped = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return escaped.replace(/&lt;mark&gt;/g, '<mark>').replace(/&lt;\/mark&gt;/g, '</mark>')
}

export default function CmdPalette({ open, onClose, onJumpToTodo }: Props) {
  const isMobile = useIsMobile()
  const [query, setQuery] = useState('')
  const [scopes, setScopes] = useState<SearchScope[]>(
    ALL_SCOPES.map((s) => s.key),
  )
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<SearchResultItem[]>([])
  const [active, setActive] = useState(0)
  const searchSeqRef = useRef(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<any>(null)

  // 打开面板时聚焦输入框
  useEffect(() => {
    if (!open) return
    setActive(0)
    const t = setTimeout(() => inputRef.current?.focus(), 50)
    return () => clearTimeout(t)
  }, [open])

  // 关闭后清空状态
  useEffect(() => {
    if (open) return
    setQuery('')
    setResults([])
    setActive(0)
  }, [open])

  // debounce 搜索
  useEffect(() => {
    if (!open) return
    if (!query.trim()) {
      setResults([])
      return
    }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const seq = ++searchSeqRef.current
    setLoading(true)
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await searchAll({ query: query.trim(), scopes, limit: 30 })
        if (seq !== searchSeqRef.current) return // stale
        setResults(res.results)
        setActive(0)
      } catch (_e) {
        if (seq !== searchSeqRef.current) return
        setResults([])
      } finally {
        if (seq === searchSeqRef.current) setLoading(false)
      }
    }, 150)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query, scopes, open])

  const jumpTo = useCallback(
    (item: SearchResultItem) => {
      onJumpToTodo(item.todoId)
      onClose()
    },
    [onClose, onJumpToTodo],
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (!results.length) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((i) => (i + 1) % results.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((i) => (i - 1 + results.length) % results.length)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        jumpTo(results[active])
      }
    },
    [results, active, jumpTo],
  )

  const toggleScope = useCallback((key: SearchScope) => {
    setScopes((prev) => {
      if (prev.includes(key)) {
        if (prev.length === 1) return prev // 至少保留 1 个
        return prev.filter((s) => s !== key)
      }
      return [...prev, key]
    })
  }, [])

  const scopeChips = useMemo(
    () => (
      <div className="cmdk-scopes">
        {ALL_SCOPES.map((s) => (
          <Tag.CheckableTag
            key={s.key}
            checked={scopes.includes(s.key)}
            onChange={() => toggleScope(s.key)}
          >
            {s.label}
          </Tag.CheckableTag>
        ))}
      </div>
    ),
    [scopes, toggleScope],
  )

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      closable={false}
      destroyOnClose
      width={isMobile ? '100%' : 640}
      className="cmdk-modal"
      styles={{ body: { padding: 0 } }}
    >
      <div className="cmdk-body">
        <Input
          ref={inputRef}
          size="large"
          placeholder="搜索 todos / 评论 / 记忆 / AI 会话…"
          prefix={<SearchOutlined />}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          allowClear
        />
        {scopeChips}
        <div className="cmdk-results">
          {loading && (
            <div className="cmdk-status">
              <Spin size="small" /> 搜索中…
            </div>
          )}
          {!loading && query.trim() && results.length === 0 && (
            <div className="cmdk-status cmdk-empty">没有命中。</div>
          )}
          {!loading && !query.trim() && (
            <div className="cmdk-status cmdk-hint">
              ⌘K 全局搜索。`↑` `↓` 选中，`Enter` 跳转，`Esc` 关闭。
            </div>
          )}
          {results.map((r, idx) => (
            <button
              key={`${r.scope}-${r.todoId}-${r.commentId || r.sessionId || idx}`}
              type="button"
              className={`cmdk-item${idx === active ? ' active' : ''}`}
              onMouseEnter={() => setActive(idx)}
              onClick={() => jumpTo(r)}
            >
              <div className="cmdk-item-headline">
                <Tag color={SCOPE_BADGE_COLOR[r.scope]} className="cmdk-scope-tag">
                  {ALL_SCOPES.find((s) => s.key === r.scope)?.label || r.scope}
                </Tag>
                <span className="cmdk-item-title">
                  {r.todoTitle || r.todoId}
                </span>
                {r.archived && <Tag color="default">已归档</Tag>}
              </div>
              <div
                className="cmdk-item-snippet"
                dangerouslySetInnerHTML={{ __html: sanitizeSnippet(r.snippet) }}
              />
            </button>
          ))}
        </div>
      </div>
    </Modal>
  )
}
