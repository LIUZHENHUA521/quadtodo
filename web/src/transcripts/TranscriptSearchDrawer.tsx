import React, { useEffect, useMemo, useState } from 'react'
import { Drawer, Input, Select, Button, Tag, Space, message, Modal, Empty, Spin, Typography } from 'antd'
import { ReloadOutlined, LinkOutlined, DisconnectOutlined, SearchOutlined } from '@ant-design/icons'
import {
  scanTranscripts, searchTranscripts, bindTranscript, unbindTranscript, previewTranscript,
  getTranscriptStats, listTodos, type TranscriptFile, type Todo, type AiTool,
} from '../api'

type Props = {
  open: boolean
  onClose: () => void
  /** Preselect a todo (for "find for this todo" entry) */
  preselectTodoId?: string | null
  /** Prefill query string (e.g. todo.title) */
  initialQuery?: string
  /** Prefill cwd filter */
  initialCwd?: string
}

function formatTs(ts: number | null | undefined) {
  if (!ts) return '-'
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export default function TranscriptSearchDrawer({ open, onClose, preselectTodoId, initialQuery, initialCwd }: Props) {
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
  const [previewLoading, setPreviewLoading] = useState(false)

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
    } catch (e) { message.error((e as Error).message) }
  }

  async function handleUnbind(f: TranscriptFile) {
    try {
      await unbindTranscript(f.id)
      message.success('已解绑')
      await doSearch()
      await refreshStats()
    } catch (e) { message.error((e as Error).message) }
  }

  async function handlePreview(f: TranscriptFile) {
    setPreviewFile(f)
    setPreviewLoading(true)
    try {
      const r = await previewTranscript(f.id, 0, 80)
      setPreviewTurns(r.turns)
    } catch (e) { message.error((e as Error).message) }
    finally { setPreviewLoading(false) }
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
              options={[{ value: 'claude', label: 'Claude' }, { value: 'codex', label: 'Codex' }]}
            />
            <Input size="small" style={{ width: 240 }} placeholder="cwd 精确匹配" value={cwd} onChange={(e) => setCwd(e.target.value)} allowClear />
            <Button size="small" type={unboundOnly ? 'primary' : 'default'} onClick={() => setUnboundOnly(v => !v)}>仅未挂回</Button>
          </Space>

          <Spin spinning={loading}>
            {items.length === 0 ? <Empty description="无结果" /> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {items.map(f => {
                  const boundTodo = f.bound_todo_id ? todos.find(t => t.id === f.bound_todo_id) : null
                  return (
                    <div key={f.id} style={{ border: '1px solid #f0f0f0', borderRadius: 6, padding: 10 }}>
                      <Space size={4} wrap>
                        <Tag>{f.tool}</Tag>
                        {boundTodo ? (
                          <Tag color="success">已挂到《{boundTodo.title}》</Tag>
                        ) : (
                          <Tag color="warning">未挂回</Tag>
                        )}
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {formatTs(f.started_at)} · {f.turn_count} 轮
                        </Typography.Text>
                      </Space>
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
        title="Transcript 预览"
        onCancel={() => { setPreviewFile(null); setPreviewTurns([]) }}
        footer={null}
        width={720}
      >
        <Spin spinning={previewLoading}>
          <div style={{ maxHeight: 480, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {previewTurns.map((t, i) => (
              <div key={i} style={{ borderLeft: `3px solid ${t.role === 'user' ? '#1677ff' : '#52c41a'}`, padding: '4px 8px' }}>
                <Tag>{t.role}</Tag>
                <pre style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0', fontSize: 12 }}>{t.content.length > 2000 ? t.content.slice(0, 2000) + '…' : t.content}</pre>
              </div>
            ))}
          </div>
        </Spin>
      </Modal>
    </>
  )
}
