import React, { useEffect, useState } from 'react'
import { Segmented, Statistic, Row, Col, Card, Spin, Empty } from 'antd'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import { getSessionStats, type SessionStats } from '../api'

type Range = 'today' | 'week' | 'month'

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  if (h > 0) return `${h}h${m}m`
  if (m > 0) return `${m}m${r}s`
  return `${r}s`
}

function formatBucket(t: number, range: Range): string {
  const d = new Date(t)
  if (range === 'today') return `${d.getHours()}:00`
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export default function HistoryStatsTab() {
  const [range, setRange] = useState<Range>('today')
  const [loading, setLoading] = useState(false)
  const [stats, setStats] = useState<SessionStats | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    getSessionStats(range)
      .then(r => { if (!cancelled) setStats(r.stats) })
      .catch(() => { if (!cancelled) setStats(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [range])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Segmented
        value={range}
        onChange={(v) => setRange(v as Range)}
        options={[
          { label: '今日', value: 'today' },
          { label: '本周', value: 'week' },
          { label: '本月', value: 'month' },
        ]}
        block
      />

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
      ) : !stats || stats.total === 0 ? (
        <Empty description="暂无数据" />
      ) : (
        <>
          <Row gutter={8}>
            <Col span={8}><Card size="small"><Statistic title="总会话" value={stats.total} /></Card></Col>
            <Col span={8}><Card size="small"><Statistic title="总耗时" value={formatMs(stats.totalDurationMs)} /></Card></Col>
            <Col span={8}><Card size="small"><Statistic title="平均耗时" value={formatMs(stats.avgDurationMs)} /></Card></Col>
          </Row>

          <Card size="small" title="状态分布">
            <Row>
              <Col span={8}><Statistic title="完成" value={stats.byStatus.done} valueStyle={{ color: '#52c41a' }} /></Col>
              <Col span={8}><Statistic title="失败" value={stats.byStatus.failed} valueStyle={{ color: '#ff4d4f' }} /></Col>
              <Col span={8}><Statistic title="停止" value={stats.byStatus.stopped} valueStyle={{ color: '#8c8c8c' }} /></Col>
            </Row>
          </Card>

          <Card size="small" title="工具分布">
            <Row>
              <Col span={12}><Statistic title="Claude" value={stats.byTool.claude} /></Col>
              <Col span={12}><Statistic title="Codex" value={stats.byTool.codex} /></Col>
            </Row>
          </Card>

          <Card size="small" title="象限分布">
            <Row>
              <Col span={6}><Statistic title="P0" value={stats.byQuadrant[1]} valueStyle={{ color: '#f5222d' }} /></Col>
              <Col span={6}><Statistic title="P1" value={stats.byQuadrant[2]} valueStyle={{ color: '#1677ff' }} /></Col>
              <Col span={6}><Statistic title="P2" value={stats.byQuadrant[3]} valueStyle={{ color: '#faad14' }} /></Col>
              <Col span={6}><Statistic title="P3" value={stats.byQuadrant[4]} valueStyle={{ color: '#8c8c8c' }} /></Col>
            </Row>
          </Card>

          {stats.timeline.length > 0 && (
            <Card size="small" title="时间线">
              <div style={{ width: '100%', height: 180 }}>
                <ResponsiveContainer>
                  <BarChart data={stats.timeline.map(p => ({ ...p, label: formatBucket(p.t, range) }))}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="label" fontSize={10} />
                    <YAxis fontSize={10} allowDecimals={false} />
                    <Tooltip />
                    <Bar dataKey="count" fill="#1677ff" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
