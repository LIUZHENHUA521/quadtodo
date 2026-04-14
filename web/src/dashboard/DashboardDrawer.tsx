import React, { useEffect, useState } from 'react'
import { Drawer, Collapse, Modal, Grid } from 'antd'
import { BarChartOutlined, HddOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { useAiSessionStore } from '../store/aiSessionStore'
import KpiStrip from './KpiStrip'
import LiveSessionCard from './LiveSessionCard'
import HistoryStatsTab from './HistoryStatsTab'
import ResourceTab from './ResourceTab'
import './dashboard.css'

const { useBreakpoint } = Grid

function LiveList({ onOpenTerminal, onStop }: {
  onOpenTerminal?: (sessionId: string, todoId: string) => void
  onStop?: (sessionId: string) => void
}) {
  const sessions = useAiSessionStore(s => s.sessions)
  const rates = useAiSessionStore(s => s.outputRates)
  const [, setTick] = useState(0)

  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  const list = [...sessions.values()].sort((a, b) => {
    // pending_confirm 置顶；running 其次；其它按时间倒序
    const rank = (s: typeof a) =>
      s.status === 'pending_confirm' ? 0 : s.status === 'running' ? 1 : 2
    const r = rank(a) - rank(b)
    if (r !== 0) return r
    return b.startedAt - a.startedAt
  })

  if (list.length === 0) {
    return (
      <div className="dash-empty">
        <div className="dash-empty-icon"><ThunderboltOutlined /></div>
        <div>暂无活跃 AI 会话</div>
      </div>
    )
  }

  return (
    <div className="dash-live-list">
      {list.map(s => (
        <LiveSessionCard
          key={s.sessionId}
          session={s}
          rate={rates.get(s.sessionId) || 0}
          onOpenTerminal={onOpenTerminal}
          onStop={onStop}
        />
      ))}
    </div>
  )
}

function DashboardBody({ open, onOpenTerminal, onStop }: {
  open: boolean
  onOpenTerminal?: (sessionId: string, todoId: string) => void
  onStop?: (sessionId: string) => void
}) {
  const [resourceExpanded, setResourceExpanded] = useState(false)
  return (
    <div className="dash-root">
      <KpiStrip />

      <div>
        <div className="dash-section-head">
          <span className="dash-section-title">
            <span className="dot" style={{ background: '#1677ff' }} />
            实时会话
          </span>
        </div>
        <div style={{ marginTop: 8 }}>
          <LiveList onOpenTerminal={onOpenTerminal} onStop={onStop} />
        </div>
      </div>

      <Collapse
        className="dash-collapse"
        bordered={false}
        onChange={(keys) => {
          const arr = Array.isArray(keys) ? keys : [keys]
          setResourceExpanded(arr.includes('resource'))
        }}
        items={[
          {
            key: 'stats',
            label: (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <BarChartOutlined style={{ color: '#6366f1' }} /> 历史统计
              </span>
            ),
            children: <HistoryStatsTab />,
          },
          {
            key: 'resource',
            label: (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <HddOutlined style={{ color: '#10b981' }} /> 资源占用
              </span>
            ),
            children: <ResourceTab active={open && resourceExpanded} />,
          },
        ]}
      />
    </div>
  )
}

export default function DashboardDrawer({
  open,
  onClose,
  onOpenTerminal,
  onStop,
}: {
  open: boolean
  onClose: () => void
  onOpenTerminal?: (sessionId: string, todoId: string) => void
  onStop?: (sessionId: string) => void
}) {
  const screens = useBreakpoint()
  const isMobile = !screens.md

  const title = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 600, color: '#0f172a' }}>
      <ThunderboltOutlined style={{ color: '#3b82f6' }} />
      AI 工作面板
    </span>
  )

  const body = (
    <DashboardBody open={open} onOpenTerminal={onOpenTerminal} onStop={onStop} />
  )

  if (isMobile) {
    return (
      <Modal
        open={open}
        onCancel={onClose}
        title={title}
        footer={null}
        width="100%"
        style={{ top: 0, maxWidth: '100vw', margin: 0, paddingBottom: 0 }}
        styles={{ body: { maxHeight: 'calc(100vh - 60px)', overflowY: 'auto', padding: 12 } }}
        destroyOnClose={false}
      >
        {body}
      </Modal>
    )
  }

  return (
    <Drawer
      title={title}
      placement="right"
      width={520}
      open={open}
      onClose={onClose}
      destroyOnClose={false}
      styles={{ body: { padding: 14, background: '#f8fafc' } }}
    >
      {body}
    </Drawer>
  )
}
