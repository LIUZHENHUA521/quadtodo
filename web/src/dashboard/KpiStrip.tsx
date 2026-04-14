import React, { useEffect, useState } from 'react'
import { getSessionStats, type SessionStats } from '../api'
import { useAiSessionStore } from '../store/aiSessionStore'

interface Kpi {
  key: 'running' | 'pending' | 'done' | 'avg'
  label: string
  value: string | number
  suffix?: string
  spark?: number[]
  accent: string
}

function Sparkline({ values, color }: { values: number[]; color: string }) {
  if (!values || values.length === 0) return <svg className="dash-kpi-spark" />
  const max = Math.max(1, ...values)
  const w = 72, h = 18
  const step = values.length > 1 ? w / (values.length - 1) : w
  const pts = values.map((v, i) => {
    const x = i * step
    const y = h - (v / max) * (h - 2) - 1
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  return (
    <svg className="dash-kpi-spark" viewBox={`0 0 ${w} ${h}`} width="100%" height="18" preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <polyline points={`0,${h} ${pts} ${w},${h}`} fill={color} opacity="0.12" />
    </svg>
  )
}

function formatMsShort(ms: number): string {
  if (!ms) return '0s'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h${m % 60}m`
}

export default function KpiStrip() {
  const sessions = useAiSessionStore(s => s.sessions)
  const [stats, setStats] = useState<SessionStats | null>(null)

  useEffect(() => {
    let cancelled = false
    getSessionStats('today').then(r => { if (!cancelled) setStats(r.stats) }).catch(() => {})
    const t = setInterval(() => {
      getSessionStats('today').then(r => { if (!cancelled) setStats(r.stats) }).catch(() => {})
    }, 30_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  const runningList = [...sessions.values()].filter(s => s.status === 'running')
  const pendingList = [...sessions.values()].filter(s => s.status === 'pending_confirm')
  const runningCount = runningList.length
  const pendingCount = pendingList.length
  const doneToday = stats?.byStatus?.done ?? 0
  const avgMs = stats?.avgDurationMs ?? 0

  const spark = (stats?.timeline ?? []).map(p => p.count)

  const tiles: Kpi[] = [
    { key: 'running', label: '运行中', value: runningCount, accent: '#3b82f6', spark },
    { key: 'pending', label: '待确认', value: pendingCount, accent: '#f59e0b' },
    { key: 'done',    label: '今日完成', value: doneToday, accent: '#10b981', spark },
    { key: 'avg',     label: '平均耗时', value: formatMsShort(avgMs), accent: '#6366f1' },
  ]

  return (
    <div className="dash-kpi-strip">
      {tiles.map(t => (
        <div key={t.key} className={`dash-kpi-tile accent-${t.key}`}>
          <div className="dash-kpi-label">{t.label}</div>
          <div className="dash-kpi-value">
            {t.value}{t.suffix && <span className="dash-kpi-suffix">{t.suffix}</span>}
          </div>
          {t.spark && t.spark.length > 1 && <Sparkline values={t.spark} color={t.accent} />}
        </div>
      ))}
    </div>
  )
}
