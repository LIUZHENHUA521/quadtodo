import React from 'react'
import { Button, Tooltip } from 'antd'
import { PlayCircleOutlined, CloseCircleOutlined, BulbOutlined } from '@ant-design/icons'
import type { SessionMeta } from '../store/aiSessionStore'

const QUADRANT_COLOR: Record<number, { main: string; light: string; label: string }> = {
  1: { main: '#ef4444', light: '#fca5a5', label: 'P0' },
  2: { main: '#3b82f6', light: '#93c5fd', label: 'P1' },
  3: { main: '#f59e0b', light: '#fcd34d', label: 'P2' },
  4: { main: '#64748b', light: '#cbd5e1', label: 'P3' },
}

const STATUS_META: Record<string, { cls: string; text: string }> = {
  running: { cls: 'running', text: '运行中' },
  pending_confirm: { cls: 'pending', text: '待确认' },
  done: { cls: 'done', text: '已完成' },
  failed: { cls: 'failed', text: '失败' },
  stopped: { cls: '', text: '已停止' },
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r.toString().padStart(2, '0')}`
}

function fmtRate(bps: number): string {
  if (bps < 1024) return `${bps.toFixed(0)} B/s`
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} K/s`
  return `${(bps / 1024 / 1024).toFixed(2)} M/s`
}

export default function LiveSessionCard({
  session,
  rate,
  onOpenTerminal,
  onStop,
}: {
  session: SessionMeta
  rate: number
  onOpenTerminal?: (sessionId: string, todoId: string) => void
  onStop?: (sessionId: string) => void
}) {
  const q = QUADRANT_COLOR[session.quadrant] || QUADRANT_COLOR[4]
  const statusMeta = STATUS_META[session.status] || STATUS_META.stopped
  const elapsedMs = Date.now() - session.startedAt

  // 进度条：session 进入的前 5 分钟可视化为进度，之后固定满值但保持 shimmer
  const progressCap = 5 * 60 * 1000
  const progressPct = Math.min(100, (elapsedMs / progressCap) * 100)
  const isAlive = session.status === 'running' || session.status === 'pending_confirm'
  const isPending = session.status === 'pending_confirm'
  const style: React.CSSProperties = {
    // @ts-expect-error CSS custom prop
    '--q-color': q.main,
    '--q-color-light': q.light,
  }

  return (
    <div className={`dash-live-card ${isPending ? 'is-pending' : ''}`} style={style}>
      <div className="dash-live-accent" />
      <div className="dash-live-main">
        <div className="dash-live-title-row">
          <span className="dash-live-chip" style={{ color: q.main, background: `${q.main}14` }}>{q.label}</span>
          <span className={`dash-live-chip tool-${session.tool}`}>{session.tool}</span>
          <span className="dash-live-title" title={session.todoTitle}>{session.todoTitle || '(无标题)'}</span>
        </div>
        <div className="dash-live-meta">
          <span className="dash-live-status">
            <span className={`dash-live-dot ${statusMeta.cls}`} />
            {statusMeta.text}
          </span>
          <span>已运行 {fmtDuration(elapsedMs)}</span>
          {session.autoMode && (
            <Tooltip title="自动模式">
              <span style={{ color: '#722ed1' }}>⚡ {session.autoMode}</span>
            </Tooltip>
          )}
        </div>
        <div className={`dash-live-bar ${isAlive ? 'shimmer' : ''}`}>
          <div className="dash-live-bar-fill" style={{ width: `${isAlive ? progressPct : 100}%` }} />
        </div>
      </div>
      <div className="dash-live-right">
        {isAlive && (
          <span className="dash-live-rate">{fmtRate(rate)}</span>
        )}
        <div className="dash-live-actions">
          <Tooltip title="展开终端">
            <Button size="small" type="text" icon={<PlayCircleOutlined />}
              onClick={() => onOpenTerminal?.(session.sessionId, session.todoId)} />
          </Tooltip>
          {isAlive && (
            <Tooltip title={isPending ? '停止（人工终止待确认会话）' : '停止'}>
              <Button size="small" type="text" danger
                icon={isPending ? <BulbOutlined /> : <CloseCircleOutlined />}
                onClick={() => onStop?.(session.sessionId)} />
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  )
}
