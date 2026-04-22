import { useCallback, useEffect, useMemo, useState } from 'react'
import { Drawer, Tag, Button, Spin, message, Empty, Tooltip, Popconfirm, Space } from 'antd'
import { StopOutlined, ReloadOutlined, BranchesOutlined, CheckCircleOutlined, WarningOutlined, DeleteOutlined, MergeCellsOutlined } from '@ant-design/icons'
import SessionViewer from '../SessionViewer'
import {
  getPipelineRun, stopPipelineRun, mergePipelineRun, cleanupPipelineRun, acceptPipelineRun, extendPipelineRun,
  PipelineRun, PipelineAgentInstance, PipelineMessage, PipelineTemplate,
  TodoStatus,
} from '../api'
import './PipelineRunDrawer.css'

interface Props {
  open: boolean
  runId: string | null
  todoId: string | null
  template: PipelineTemplate | null
  todoStatus: TodoStatus
  cwd?: string | null
  onClose: () => void
  onSessionRecovered?: (nextSessionId: string) => void
}

function findLatestWriterBranch(run: PipelineRun): string {
  const writers = (run.agents || []).filter(a => a.branch)
  if (!writers.length) return '(no writer)'
  const latest = writers.reduce((best, a) => (a.round > (best?.round ?? -1) ? a : best), writers[0])
  return latest.branch || '(no branch)'
}

function statusMeta(s: PipelineAgentInstance['status']) {
  if (s === 'running') return { color: 'processing', label: '运行中' }
  if (s === 'done') return { color: 'success', label: '已完成' }
  if (s === 'stopped') return { color: 'warning', label: '已停止' }
  if (s === 'failed') return { color: 'error', label: '失败' }
  return { color: 'default', label: '待启动' }
}

function runStatusMeta(s: PipelineRun['status']) {
  if (s === 'running') return { color: 'processing', label: '运行中' }
  if (s === 'done') return { color: 'success', label: '已完成' }
  if (s === 'stopped') return { color: 'warning', label: '已停止' }
  if (s === 'failed') return { color: 'error', label: '失败' }
  return { color: 'default', label: s }
}

export default function PipelineRunDrawer({ open, runId, todoId, template, todoStatus, cwd, onClose, onSessionRecovered }: Props) {
  const [run, setRun] = useState<PipelineRun | null>(null)
  const [loading, setLoading] = useState(false)
  const [stopping, setStopping] = useState(false)

  const refresh = useCallback(async () => {
    if (!runId) return
    try {
      setLoading(true)
      const r = await getPipelineRun(runId)
      setRun(r)
    } catch (e: any) {
      if (e?.message !== 'not_found') message.error(e?.message || '拉取 pipeline 状态失败')
    } finally {
      setLoading(false)
    }
  }, [runId])

  useEffect(() => {
    if (!open || !runId) return
    void refresh()
    const t = setInterval(() => { void refresh() }, 2000)
    return () => clearInterval(t)
  }, [open, runId, refresh])

  const handleStop = useCallback(async () => {
    if (!runId) return
    try {
      setStopping(true)
      const r = await stopPipelineRun(runId)
      setRun(r)
      message.success('已停止 pipeline')
    } catch (e: any) {
      message.error(e?.message || '停止失败')
    } finally {
      setStopping(false)
    }
  }, [runId])

  const [busy, setBusy] = useState<string | null>(null)
  const handleMerge = useCallback(async (strategy: 'squash' | 'merge') => {
    if (!runId) return
    try {
      setBusy('merge')
      const r = await mergePipelineRun(runId, strategy)
      setRun(r)
      message.success(`已 ${strategy === 'squash' ? 'squash ' : ''}合并到 ${r.baseBranch || 'base branch'}`)
    } catch (e: any) { message.error(e?.message || '合并失败') }
    finally { setBusy(null) }
  }, [runId])

  const handleCleanup = useCallback(async () => {
    if (!runId) return
    try {
      setBusy('cleanup')
      const r = await cleanupPipelineRun(runId)
      message.success(`已清理 ${r.removed} 个 worktree`)
      void refresh()
    } catch (e: any) { message.error(e?.message || '清理失败') }
    finally { setBusy(null) }
  }, [runId, refresh])

  const handleAccept = useCallback(async () => {
    if (!runId) return
    try {
      setBusy('accept')
      const r = await acceptPipelineRun(runId)
      setRun(r)
      message.success('已接受当前成果')
    } catch (e: any) { message.error(e?.message || '操作失败') }
    finally { setBusy(null) }
  }, [runId])

  const handleExtend = useCallback(async () => {
    if (!runId) return
    try {
      setBusy('extend')
      const r = await extendPipelineRun(runId)
      setRun(r)
      message.success('已追加 1 轮，继续中')
    } catch (e: any) { message.error(e?.message || '扩展失败') }
    finally { setBusy(null) }
  }, [runId])

  const activeAgents = useMemo(() => {
    // Per role, show only the latest-round agent for pane rendering
    if (!run) return []
    const byRole = new Map<string, PipelineAgentInstance>()
    for (const a of run.agents) {
      const exist = byRole.get(a.role)
      if (!exist || a.round > exist.round) byRole.set(a.role, a)
    }
    if (!template) return [...byRole.values()]
    return template.roles
      .map(r => byRole.get(r.key))
      .filter((x): x is PipelineAgentInstance => !!x)
  }, [run, template])

  const title = template
    ? <span><BranchesOutlined style={{ marginRight: 6 }} />Pipeline · {template.name}</span>
    : 'Pipeline'

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={title}
      width="90vw"
      destroyOnClose
      extra={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {run && <Tag color={runStatusMeta(run.status).color}>{runStatusMeta(run.status).label}</Tag>}
          {run?.iterationCount ? <Tag>第 {run.iterationCount + 1} 轮 / 上限 {template?.maxIterations}</Tag> : null}
          <Button size="small" icon={<ReloadOutlined />} onClick={refresh} loading={loading} />
          {run?.status === 'running' && (
            <Popconfirm title="确定要停止 pipeline 吗？所有运行中的 agent 都会被终止。" onConfirm={handleStop}>
              <Button size="small" danger icon={<StopOutlined />} loading={stopping}>停止</Button>
            </Popconfirm>
          )}
        </div>
      }
    >
      {!run && loading && <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>}
      {run && (
        <div className="pr-wrapper">
          {/* 状态条 */}
          <div className="pr-status-bar">
            {template?.roles.map((r, i) => {
              const inst = activeAgents.find(a => a.role === r.key)
              const meta = statusMeta(inst?.status ?? 'idle')
              return (
                <div key={r.key} className="pr-status-chip">
                  <Tag color={meta.color}>{r.name}</Tag>
                  <span className="pr-status-round">{inst ? `第 ${inst.round} 轮 · ${meta.label}` : '待启动'}</span>
                  {i < template.roles.length - 1 && <span className="pr-status-arrow">→</span>}
                </div>
              )
            })}
          </div>

          {/* Pipeline 通过 - 合并 / 清理 / 关闭 */}
          {run.status === 'done' && (
            <div className="pr-action-panel pr-action-panel--ok">
              <div className="pr-action-panel-head">
                <CheckCircleOutlined style={{ color: '#52c41a' }} />
                <span className="pr-action-panel-title">Pipeline 通过 — 下一步</span>
                <span className="pr-action-panel-sub">
                  审阅员已 approved，代码在 <code>{findLatestWriterBranch(run)}</code>
                </span>
              </div>
              <Space wrap>
                <Button type="primary" icon={<MergeCellsOutlined />}
                  loading={busy === 'merge'}
                  onClick={() => handleMerge('squash')}
                >Squash 合并到 {run.baseBranch || 'base'}</Button>
                <Button icon={<MergeCellsOutlined />}
                  loading={busy === 'merge'}
                  onClick={() => handleMerge('merge')}
                >Merge commit 合并</Button>
                <Popconfirm title="确定要删除所有 worktree 吗？未合并的改动会丢失。" onConfirm={handleCleanup}>
                  <Button icon={<DeleteOutlined />} loading={busy === 'cleanup'} danger>清理 worktree</Button>
                </Popconfirm>
                <Button onClick={onClose}>仅关闭（保留 worktree）</Button>
              </Space>
            </div>
          )}

          {/* iteration 上限触发 - 再来一轮 / 接受 / 放弃 */}
          {run.status === 'stopped' && (run.messages || []).some(m => m.kind === 'limit') && (
            <div className="pr-action-panel pr-action-panel--warn">
              <div className="pr-action-panel-head">
                <WarningOutlined style={{ color: '#faad14' }} />
                <span className="pr-action-panel-title">已达 iteration 上限（maxIterations={template?.maxIterations ?? '?'}）</span>
                <span className="pr-action-panel-sub">代码员 ↔ 审阅员仍未收敛，请选：</span>
              </div>
              <Space wrap>
                <Button type="primary" loading={busy === 'extend'} onClick={handleExtend}>+ 1 轮 继续</Button>
                <Button loading={busy === 'accept'} onClick={handleAccept}>标记为通过（接受当前代码）</Button>
                <Popconfirm title="确定放弃并清理所有 worktree 吗？" onConfirm={handleCleanup}>
                  <Button danger icon={<DeleteOutlined />} loading={busy === 'cleanup'}>放弃并清理</Button>
                </Popconfirm>
              </Space>
            </div>
          )}

          {/* 其他 stopped / failed 状态下也提供清理按钮 */}
          {run.status === 'stopped' && !(run.messages || []).some(m => m.kind === 'limit') && (
            <div className="pr-action-panel pr-action-panel--warn">
              <div className="pr-action-panel-head">
                <WarningOutlined style={{ color: '#faad14' }} />
                <span className="pr-action-panel-title">Pipeline 已停止</span>
              </div>
              <Space wrap>
                <Popconfirm title="确定清理所有 worktree？" onConfirm={handleCleanup}>
                  <Button icon={<DeleteOutlined />} loading={busy === 'cleanup'} danger>清理 worktree</Button>
                </Popconfirm>
              </Space>
            </div>
          )}

          {/* 元信息 */}
          <div className="pr-meta">
            base：
            <code className="pr-inline-code">{run.baseBranch || 'detached'}@{(run.baseSha || '').slice(0, 8)}</code>
            {' · '}
            worktree 根：
            <code className="pr-inline-code">.quadtodo-worktrees/{run.id}/</code>
          </div>

          {/* N-pane agents */}
          <div className={`pr-panes pr-panes-n${activeAgents.length}`}>
            {activeAgents.length === 0 && (
              <Empty description="暂无 agent，状态可能正在切换" />
            )}
            {activeAgents.map(agent => {
              const role = template?.roles.find(r => r.key === agent.role)
              return (
                <div key={`${agent.role}-${agent.round}`} className="pr-pane">
                  <div className="pr-pane-header">
                    <Tag>{role?.name || agent.role}</Tag>
                    <span className="pr-pane-round">第 {agent.round} 轮</span>
                    <Tooltip title={agent.worktreePath || ''}>
                      <code className="pr-inline-code pr-pane-branch">{agent.branch || '(attach to writer)'}</code>
                    </Tooltip>
                    <div style={{ flex: 1 }} />
                    <Tag color={statusMeta(agent.status).color}>{statusMeta(agent.status).label}</Tag>
                  </div>
                  <div className="pr-pane-body">
                    <SessionViewer
                      sessionId={agent.sessionId}
                      todoId={todoId || ''}
                      status={todoStatus}
                      cwd={agent.worktreePath || cwd || null}
                      onClose={() => { /* no-op: closed via drawer */ }}
                      onSessionRecovered={onSessionRecovered}
                      fillHeight
                    />
                  </div>
                </div>
              )
            })}
          </div>

          {/* 时间轴 */}
          <Timeline messages={run.messages} />
        </div>
      )}
    </Drawer>
  )
}

function Timeline({ messages }: { messages: PipelineMessage[] }) {
  if (!messages?.length) return null
  return (
    <div className="pr-timeline">
      <div className="pr-timeline-title">消息流（{messages.length}）</div>
      <div className="pr-timeline-body">
        {messages.map((m, i) => {
          const time = new Date(m.at).toLocaleTimeString()
          const arrow = m.to === '__run__' ? '' : `→ ${m.to}`
          const cls =
            m.kind === 'handoff' && m.verdict === 'rejected' ? 'pr-tl-rejected'
            : m.kind === 'handoff' && m.verdict === 'approved' ? 'pr-tl-approved'
            : m.kind === 'finalize' ? 'pr-tl-finalize'
            : m.kind === 'limit' ? 'pr-tl-limit'
            : ''
          return (
            <div key={i} className={`pr-tl-item ${cls}`}>
              <span className="pr-tl-time">{time}</span>
              <Tag className="pr-tl-kind">{m.kind}</Tag>
              <span className="pr-tl-who">
                <code>{m.from}</code> {arrow && <span>{arrow}</span>}
              </span>
              {m.verdict && <Tag color={m.verdict === 'approved' ? 'success' : m.verdict === 'rejected' ? 'error' : 'default'}>{m.verdict}</Tag>}
              {m.reason && <span className="pr-tl-reason">{m.reason}</span>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
