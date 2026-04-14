import React, { useEffect, useState } from 'react'
import { Empty, Tag, Typography, Button, Space } from 'antd'
import { useAiSessionStore } from '../store/aiSessionStore'
import { PlayCircleOutlined, CloseCircleOutlined } from '@ant-design/icons'

const QUADRANT_COLOR: Record<number, string> = { 1: 'red', 2: 'blue', 3: 'gold', 4: 'default' }
const STATUS_COLOR: Record<string, string> = {
  running: 'processing',
  pending_confirm: 'warning',
  done: 'success',
  failed: 'error',
  stopped: 'default',
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r.toString().padStart(2, '0')}`
}

export default function LiveGlanceTab({ onOpenTerminal, onStop }: {
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

  const list = [...sessions.values()].sort((a, b) => b.startedAt - a.startedAt)

  if (!list.length) {
    return <Empty description="当前没有 AI 会话" style={{ marginTop: 40 }} />
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {list.map(s => {
        const rate = rates.get(s.sessionId) || 0
        const elapsed = Date.now() - s.startedAt
        return (
          <div key={s.sessionId} style={{
            border: '1px solid #f0f0f0', borderRadius: 8, padding: 10,
            background: s.status === 'running' ? '#fafffb' : '#fafafa',
          }}>
            <Space size={6} wrap>
              <Tag color={STATUS_COLOR[s.status] || 'default'}>{s.status}</Tag>
              <Tag color={QUADRANT_COLOR[s.quadrant]}>P{s.quadrant - 1}</Tag>
              <Tag>{s.tool}</Tag>
              {s.autoMode && <Tag color="purple">{s.autoMode}</Tag>}
              <Typography.Text strong ellipsis style={{ maxWidth: 220 }}>{s.todoTitle}</Typography.Text>
            </Space>
            <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
              已运行 {formatDuration(elapsed)} · {rate.toFixed(0)} B/s
            </div>
            <Space size={4} style={{ marginTop: 6 }}>
              <Button size="small" icon={<PlayCircleOutlined />} onClick={() => onOpenTerminal?.(s.sessionId, s.todoId)}>展开终端</Button>
              {s.status === 'running' || s.status === 'pending_confirm' ? (
                <Button size="small" danger icon={<CloseCircleOutlined />} onClick={() => onStop?.(s.sessionId)}>停止</Button>
              ) : null}
            </Space>
          </div>
        )
      })}
    </div>
  )
}
