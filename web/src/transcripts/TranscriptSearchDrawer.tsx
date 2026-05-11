import React, { useEffect, useMemo, useState } from 'react'
import { Drawer, Input, Select, Button, Tag, Space, message, Modal, Empty, Spin, Typography, Tooltip } from 'antd'
import { ReloadOutlined, LinkOutlined, DisconnectOutlined, SearchOutlined, CopyOutlined } from '@ant-design/icons'
import {
  scanTranscripts, searchTranscripts, bindTranscript, unbindTranscript, previewTranscript,
  getTranscriptStats, listTodos, type TranscriptFile, type Todo, type AiTool,
} from '../api'
import { buildResumeCommand, type ResumeTool } from './resumeCommand'

type Props = {
  open: boolean
  onClose: () => void
  /** Preselect a todo (for "find for this todo" entry) */
  preselectTodoId?: string | null
  /** Prefill query string (e.g. todo.title) */
  initialQuery?: string
  /** Prefill cwd filter */
  initialCwd?: string
  /** 绑定/解绑成功后通知外层刷新 todo 列表 */
  onBindingChanged?: () => void
}

function formatTs(ts: number | null | undefined) {
  if (!ts) return '-'
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const ellipsisTagStyle: React.CSSProperties = {
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const resultHeaderStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 4,
  width: '100%',
  minWidth: 0,
}

const boundTagSlotStyle: React.CSSProperties = {
  flex: '1 1 180px',
  minWidth: 0,
  maxWidth: '100%',
}

function roleStyle(role: string): { color: string; tagColor?: string } {
  switch (role) {
    case 'user': return { color: '#1677ff', tagColor: 'blue' }
    case 'assistant': return { color: '#52c41a', tagColor: 'green' }
    case 'tool_use': return { color: '#fa8c16', tagColor: 'orange' }
    case 'tool_result': return { color: '#bfbfbf', tagColor: 'default' }
    default: return { color: '#bfbfbf' }
  }
}

export default function TranscriptSearchDrawer({ open, onClose, preselectTodoId, initialQuery, initialCwd, onBindingChanged }: Props) {
  const [q, setQ] = useState('')
  const [tool, setTool] = useState<AiTool | ''>('')
  const [cwd, setCwd] = useState('')
  const [unboundOnly, setUnboundOnly] = useState(false)
  const [items, setItems] = useState<TranscriptFile[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [unboundCount, setUnboundCount] = useState(0)
  const [todos, setTodos] = useState<Todo[]>([])
  const [bindTargetFile, setBindTargetFile] = useState<TranscriptFile | null>(null)
  const [bindTodoId, setBindTodoId] = useState<string>('')
  const [previewFile, setPreviewFile] = useState<TranscriptFile | null>(null)
  const [previewTurns, setPreviewTurns] = useState<{ role: string; content: string }[]>([])
  const [previewTotal, setPreviewTotal] = useState(0)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewLoadingMore, setPreviewLoadingMore] = useState(false)
  const [expandedTurns, setExpandedTurns] = useState<Set<number>>(new Set())

  const PREVIEW_PAGE_SIZE = 500
  const TURN_COLLAPSE_CHARS = 1500

  async function doSearch() {
    setLoading(true)
    try {
      const r = await searchTranscripts({
        q: q || undefined,
        tool: tool || undefined,
        cwd: cwd || undefined,
        unboundOnly,
        limit: 50,
      })
      setItems(r.items)
      setTotal(r.total)
    } catch (e) { message.error((e as Error).message) }
    finally { setLoading(false) }
  }

  async function doScan() {
    setScanning(true)
    try {
      const r = await scanTranscripts()
      message.success(`扫描完成：新增 ${r.newFiles} · 索引 ${r.indexed} · 自动挂回 ${r.autoBound}`)
      await refreshStats()
      await doSearch()
    } catch (e) { message.error((e as Error).message) }
    finally { setScanning(false) }
  }

  async function refreshStats() {
    try { const s = await getTranscriptStats(); setUnboundCount(s.unboundCount) } catch {}
  }

  useEffect(() => {
    if (!open) return
    if (initialQuery !== undefined) setQ(initialQuery || '')
    if (initialCwd !== undefined) setCwd(initialCwd || '')
    ;(async () => {
      await refreshStats()
      try { const t = await listTodos({}); setTodos(t) } catch {}
    })()
  }, [open, initialQuery, initialCwd])

  useEffect(() => {
    if (open) doSearch()
  }, [open, q, tool, cwd, unboundOnly])

  useEffect(() => {
    if (bindTargetFile && preselectTodoId) setBindTodoId(preselectTodoId)
  }, [bindTargetFile, preselectTodoId])

  async function submitBind(force = false) {
    if (!bindTargetFile || !bindTodoId) return
    try {
      const r = await bindTranscript(bindTargetFile.id, bindTodoId, force)
      if (r.conflict) {
        const other = todos.find(t => t.id === r.currentTodoId)
        Modal.confirm({
          title: '该会话已挂在另一个 todo',
          content: `当前挂在《${other?.title || r.currentTodoId}》，是否移动到目标 todo？`,
          okText: '移动',
          onOk: async () => submitBind(true),
        })
        return
      }
      message.success('已绑定')
      setBindTargetFile(null)
      setBindTodoId('')
      await doSearch()
      await refreshStats()
      onBindingChanged?.()
    } catch (e) { message.error((e as Error).message) }
  }

  async function handleUnbind(f: TranscriptFile) {
    try {
      await unbindTranscript(f.id)
      message.success('已解绑')
      await doSearch()
      await refreshStats()
      onBindingChanged?.()
    } catch (e) { message.error((e as Error).message) }
  }

  async function handlePreview(f: TranscriptFile) {
    setPreviewFile(f)
    setPreviewLoading(true)
    setPreviewTurns([])
    setPreviewTotal(0)
    setExpandedTurns(new Set())
    try {
      const r = await previewTranscript(f.id, 0, PREVIEW_PAGE_SIZE)
      setPreviewTurns(r.turns)
      setPreviewTotal(r.totalTurns)
    } catch (e) {
      message.error((e as Error).message)
      setPreviewFile(null)
    }
    finally { setPreviewLoading(false) }
  }

  async function loadMorePreview() {
    if (!previewFile) return
    setPreviewLoadingMore(true)
    try {
      const r = await previewTranscript(previewFile.id, previewTurns.length, PREVIEW_PAGE_SIZE)
      setPreviewTurns(prev => [...prev, ...r.turns])
      setPreviewTotal(r.totalTurns)
    } catch (e) { message.error((e as Error).message) }
    finally { setPreviewLoadingMore(false) }
  }

  function toggleTurnExpand(idx: number) {
    setExpandedTurns(prev => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  const COPY_SUPPORTED_TOOLS: ResumeTool[] = ['claude', 'codex', 'cursor']

  function canCopyResume(f: TranscriptFile): boolean {
    return !!f.native_id && (COPY_SUPPORTED_TOOLS as string[]).includes(f.tool)
  }

  function copyDisabledReason(f: TranscriptFile): string {
    if (!f.native_id) return '该记录无 native session id'
    if (!(COPY_SUPPORTED_TOOLS as string[]).includes(f.tool)) return '暂不支持该工具'
    return ''
  }

  async function handleCopyResume(f: TranscriptFile) {
    try {
      const { command, warnings } = buildResumeCommand({
        tool: f.tool as ResumeTool,
        native_id: f.native_id as string,
        cwd: f.cwd,
      })
      await navigator.clipboard.writeText(command)
      const display = command.length > 80 ? command.slice(0, 80) + '…' : command
      message.success(`已复制：${display}`)
      if (warnings.includes('cwd_missing')) {
        message.warning('未识别 cwd，请先 cd 到原工作目录')
      }
    } catch (e) {
      message.error('复制失败，请手动复制')
    }
  }

  const todoOptions = useMemo(() => todos.map(t => ({ label: t.title, value: t.id })), [todos])

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        title={<span><SearchOutlined /> 历史会话找回</span>}
        placement="right"
        width={640}
        destroyOnClose={false}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <Tag color={unboundCount > 0 ? 'warning' : 'default'}>未挂回 {unboundCount}</Tag>
            <Button size="small" icon={<ReloadOutlined spin={scanning} />} onClick={doScan} loading={scanning}>重新扫描</Button>
            <div style={{ flex: 1 }} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>命中 {total}</Typography.Text>
          </div>

          <Input.Search
            placeholder="关键词搜索（全文）"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            allowClear
          />
          <Space wrap>
            <Select
              size="small" style={{ width: 120 }} value={tool} allowClear placeholder="工具"
              onChange={(v) => setTool(v || '')}
              options={[{ value: 'claude', label: 'Claude' }, { value: 'codex', label: 'Codex' }, { value: 'cursor', label: 'Cursor' }]}
            />
            <Input size="small" style={{ width: 240 }} placeholder="cwd 精确匹配" value={cwd} onChange={(e) => setCwd(e.target.value)} allowClear />
            <Button size="small" type={unboundOnly ? 'primary' : 'default'} onClick={() => setUnboundOnly(v => !v)}>仅未挂回</Button>
          </Space>

          <Spin spinning={loading}>
            {items.length === 0 ? <Empty description="无结果" /> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {items.map(f => {
                  const boundTodo = f.bound_todo_id ? todos.find(t => t.id === f.bound_todo_id) : null
                  const boundTodoTitle = boundTodo ? `已挂到《${boundTodo.title}》` : ''
                  return (
                    <div key={f.id} style={{ border: '1px solid #f0f0f0', borderRadius: 6, padding: 10, minWidth: 0 }}>
                      <div style={resultHeaderStyle}>
                        <Tag>{f.tool}</Tag>
                        {boundTodo ? (
                          <span style={boundTagSlotStyle}>
                            <Tooltip title={boundTodoTitle}>
                              <Tag color="success" style={ellipsisTagStyle}>{boundTodoTitle}</Tag>
                            </Tooltip>
                          </span>
                        ) : (
                          <Tag color="warning">未挂回</Tag>
                        )}
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {formatTs(f.started_at)} · {f.turn_count} 轮
                        </Typography.Text>
                      </div>
                      <div style={{ fontSize: 12, color: '#888', marginTop: 4, wordBreak: 'break-all' }}>
                        cwd: {f.cwd || '-'}
                      </div>
                      <div style={{ marginTop: 6, fontSize: 13, color: '#333' }}>
                        {f.first_user_prompt ? (f.first_user_prompt.length > 140 ? f.first_user_prompt.slice(0, 140) + '…' : f.first_user_prompt) : <i>(无首条用户消息)</i>}
                      </div>
                      {f.snippet && (
                        <div
                          style={{ marginTop: 4, fontSize: 12, color: '#666' }}
                          dangerouslySetInnerHTML={{ __html: f.snippet }}
                        />
                      )}
                      <Space size={4} style={{ marginTop: 8 }}>
                        <Button size="small" onClick={() => handlePreview(f)}>预览</Button>
                        <Button size="small" type="primary" icon={<LinkOutlined />} onClick={() => { setBindTargetFile(f); setBindTodoId(preselectTodoId || '') }}>
                          {boundTodo ? '改挂…' : '绑定到 todo…'}
                        </Button>
                        {boundTodo && (
                          <Button size="small" danger icon={<DisconnectOutlined />} onClick={() => handleUnbind(f)}>解绑</Button>
                        )}
                        <Tooltip title={canCopyResume(f) ? undefined : copyDisabledReason(f)}>
                          <Button
                            size="small"
                            icon={<CopyOutlined />}
                            disabled={!canCopyResume(f)}
                            onClick={() => handleCopyResume(f)}
                          >
                            复制恢复命令
                          </Button>
                        </Tooltip>
                      </Space>
                    </div>
                  )
                })}
              </div>
            )}
          </Spin>
        </Space>
      </Drawer>

      <Modal
        open={!!bindTargetFile}
        title="绑定到 todo"
        onCancel={() => { setBindTargetFile(null); setBindTodoId('') }}
        onOk={() => submitBind(false)}
        okButtonProps={{ disabled: !bindTodoId }}
      >
        <Select
          showSearch
          style={{ width: '100%' }}
          placeholder="选择 todo"
          value={bindTodoId || undefined}
          onChange={setBindTodoId}
          filterOption={(input, option) => String(option?.label || '').toLowerCase().includes(input.toLowerCase())}
          options={todoOptions}
        />
      </Modal>

      <Modal
        open={!!previewFile}
        title={
          <Space size={8}>
            <span>Transcript 预览</span>
            {previewTotal > 0 && (
              <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 'normal' }}>
                已加载 {previewTurns.length} / 共 {previewTotal} 轮
              </Typography.Text>
            )}
          </Space>
        }
        onCancel={() => {
          setPreviewFile(null)
          setPreviewTurns([])
          setPreviewTotal(0)
          setExpandedTurns(new Set())
        }}
        footer={null}
        width={720}
      >
        <Spin spinning={previewLoading}>
          <div style={{ maxHeight: 480, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {!previewLoading && previewTurns.length === 0 ? (
              <Empty description="该会话暂无可展示内容" />
            ) : (
              <>
                {previewTurns.map((t, i) => {
                  const expanded = expandedTurns.has(i)
                  const overflowed = t.content.length > TURN_COLLAPSE_CHARS
                  const display = !expanded && overflowed ? t.content.slice(0, TURN_COLLAPSE_CHARS) : t.content
                  const { color: borderColor, tagColor } = roleStyle(t.role)
                  return (
                    <div key={i} style={{ borderLeft: `3px solid ${borderColor}`, padding: '4px 8px' }}>
                      <Tag color={tagColor}>{t.role}</Tag>
                      <pre style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0', fontSize: 12 }}>
                        {display}
                        {!expanded && overflowed && '…'}
                      </pre>
                      {overflowed && (
                        <Button
                          size="small"
                          type="link"
                          style={{ padding: 0, marginTop: 2, fontSize: 12 }}
                          onClick={() => toggleTurnExpand(i)}
                        >
                          {expanded ? '收起' : `展开（${t.content.length - TURN_COLLAPSE_CHARS} 字隐藏）`}
                        </Button>
                      )}
                    </div>
                  )
                })}
                {previewTotal > previewTurns.length && (
                  <div style={{ textAlign: 'center', padding: 8 }}>
                    <Button size="small" loading={previewLoadingMore} onClick={loadMorePreview}>
                      加载更多 {Math.min(PREVIEW_PAGE_SIZE, previewTotal - previewTurns.length)} 条
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </Spin>
      </Modal>
    </>
  )
}
