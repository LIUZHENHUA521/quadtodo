import React, { useEffect, useState } from 'react'
import { Empty, Progress, Typography, Tag } from 'antd'
import { useAiSessionStore } from '../store/aiSessionStore'
import { getResourceSnapshot } from '../api'

const QUADRANT_COLOR: Record<number, string> = { 1: 'red', 2: 'blue', 3: 'gold', 4: 'default' }

function formatBytes(b: number): string {
  if (b < 1024) return `${b}B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}K`
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)}M`
  return `${(b / 1024 / 1024 / 1024).toFixed(2)}G`
}

export default function ResourceTab({ active }: { active: boolean }) {
  const resources = useAiSessionStore(s => s.resources)
  const history = useAiSessionStore(s => s.resourceHistory)
  const sessions = useAiSessionStore(s => s.sessions)
  const setResources = useAiSessionStore(s => s.setResources)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!active) return
    let cancelled = false
    async function poll() {
      try {
        const list = await getResourceSnapshot()
        if (!cancelled) { setResources(list); setErr(null) }
      } catch (e) {
        if (!cancelled) setErr((e as Error).message)
      }
    }
    poll()
    const t = setInterval(poll, 2000)
    return () => { cancelled = true; clearInterval(t) }
  }, [active, setResources])

  const list = [...resources.values()]

  if (err) return <Typography.Text type="danger">{err}</Typography.Text>
  if (!list.length) return <Empty description="无活跃进程" style={{ marginTop: 40 }} />

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {list.map(r => {
        const s = sessions.get(r.sessionId)
        const hist = history.get(r.sessionId) || []
        const peak = Math.max(0, ...hist)
        return (
          <div key={r.sessionId} style={{
            border: '1px solid #f0f0f0', borderRadius: 8, padding: 10,
          }}>
            <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
              {s && <Tag color={QUADRANT_COLOR[s.quadrant]}>P{s.quadrant - 1}</Tag>}
              <Tag>{r.tool}</Tag>
              <Typography.Text strong ellipsis style={{ maxWidth: 200 }}>{r.todoTitle}</Typography.Text>
            </div>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>PID {r.pid}</div>
            <div style={{ marginBottom: 4 }}>
              <Typography.Text style={{ fontSize: 12 }}>CPU {r.cpu.toFixed(1)}%（峰值 {peak.toFixed(1)}%）</Typography.Text>
              <Progress percent={Math.min(100, r.cpu)} size="small" showInfo={false} strokeColor={r.cpu > 80 ? '#ff4d4f' : '#1677ff'} />
            </div>
            <Typography.Text style={{ fontSize: 12 }}>内存 {formatBytes(r.memory)}</Typography.Text>
          </div>
        )
      })}
    </div>
  )
}
