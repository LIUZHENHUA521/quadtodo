import { useEffect, useMemo, useState } from 'react'
import { Drawer, Segmented, DatePicker, Empty, Spin, Tag, Modal, Grid } from 'antd'
import { TrophyOutlined } from '@ant-design/icons'
import dayjs, { Dayjs } from 'dayjs'
import { getDoneReport, DoneReport, Todo, Quadrant } from './api'
import './ReportDrawer.css'

const { useBreakpoint } = Grid

type RangeKey = 'today' | 'yesterday' | 'thisWeek' | 'lastWeek' | 'custom'

const QUADRANT_CONFIG: { q: Quadrant; label: string; color: string }[] = [
  { q: 1, label: 'Q1 · 重要且紧急', color: '#ff4d4f' },
  { q: 2, label: 'Q2 · 重要不紧急', color: '#faad14' },
  { q: 3, label: 'Q3 · 紧急不重要', color: '#1677ff' },
  { q: 4, label: 'Q4 · 不重要不紧急', color: '#52c41a' },
]
const QUAD_META = new Map(QUADRANT_CONFIG.map(c => [c.q, c]))

function resolveRange(key: RangeKey, custom?: [Dayjs, Dayjs]): { since: number; until: number; title: string } {
  const now = dayjs()
  if (key === 'today') {
    return { since: now.startOf('day').valueOf(), until: now.endOf('day').valueOf() + 1, title: '今日' }
  }
  if (key === 'yesterday') {
    const y = now.subtract(1, 'day')
    return { since: y.startOf('day').valueOf(), until: y.endOf('day').valueOf() + 1, title: '昨日' }
  }
  if (key === 'thisWeek') {
    return { since: now.startOf('week').valueOf(), until: now.endOf('week').valueOf() + 1, title: '本周' }
  }
  if (key === 'lastWeek') {
    const lw = now.subtract(1, 'week')
    return { since: lw.startOf('week').valueOf(), until: lw.endOf('week').valueOf() + 1, title: '上周' }
  }
  if (custom && custom.length === 2) {
    return {
      since: custom[0].startOf('day').valueOf(),
      until: custom[1].endOf('day').valueOf() + 1,
      title: `${custom[0].format('MM-DD')} ~ ${custom[1].format('MM-DD')}`,
    }
  }
  return { since: now.startOf('day').valueOf(), until: now.endOf('day').valueOf() + 1, title: '今日' }
}

function localDateKey(ts: number) {
  return dayjs(ts).format('YYYY-MM-DD')
}

function computeStreak(countsByDate: Map<string, number>): number {
  let streak = 0
  let cursor = dayjs().startOf('day')
  while (true) {
    const key = cursor.format('YYYY-MM-DD')
    if ((countsByDate.get(key) || 0) > 0) {
      streak += 1
      cursor = cursor.subtract(1, 'day')
    } else {
      break
    }
  }
  return streak
}

// 最近 7 天热力条（含今天）
function buildHeatmap(countsByDate: Map<string, number>): { date: string; count: number; label: string }[] {
  const days: { date: string; count: number; label: string }[] = []
  for (let i = 6; i >= 0; i--) {
    const d = dayjs().subtract(i, 'day')
    const key = d.format('YYYY-MM-DD')
    const label = i === 0 ? '今' : i === 1 ? '昨' : d.format('M/D')
    days.push({ date: key, count: countsByDate.get(key) || 0, label })
  }
  return days
}

function heatLevel(count: number): number {
  if (count === 0) return 0
  if (count <= 2) return 1
  if (count <= 5) return 2
  if (count <= 10) return 3
  return 4
}

interface DayGroup {
  date: string
  label: string
  parents: Todo[]
  childrenByParent: Map<string, Todo[]>
  orphanSubtasks: Todo[]
  countsByQuadrant: Map<Quadrant, number>
  total: number
}

function groupByDay(list: Todo[]): DayGroup[] {
  const byDate = new Map<string, Todo[]>()
  for (const t of list) {
    if (!t.completedAt) continue
    const key = localDateKey(t.completedAt)
    const arr = byDate.get(key) || []
    arr.push(t)
    byDate.set(key, arr)
  }
  const groups: DayGroup[] = []
  const sortedKeys = [...byDate.keys()].sort((a, b) => (a < b ? 1 : -1))
  for (const date of sortedKeys) {
    const dayTodos = byDate.get(date)!
    const inDayIds = new Set(dayTodos.map(t => t.id))
    const parents: Todo[] = []
    const childrenByParent = new Map<string, Todo[]>()
    const orphanSubtasks: Todo[] = []
    for (const t of dayTodos) {
      if (!t.parentId) {
        parents.push(t)
      } else if (inDayIds.has(t.parentId)) {
        const arr = childrenByParent.get(t.parentId) || []
        arr.push(t)
        childrenByParent.set(t.parentId, arr)
      } else {
        orphanSubtasks.push(t)
      }
    }
    parents.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
    orphanSubtasks.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
    for (const [, arr] of childrenByParent) {
      arr.sort((a, b) => (a.completedAt || 0) - (b.completedAt || 0))
    }
    const countsByQuadrant = new Map<Quadrant, number>()
    for (const t of dayTodos) {
      countsByQuadrant.set(t.quadrant, (countsByQuadrant.get(t.quadrant) || 0) + 1)
    }
    const today = dayjs().format('YYYY-MM-DD')
    const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD')
    const label = date === today ? `今天 ${date}` : date === yesterday ? `昨天 ${date}` : date
    groups.push({ date, label, parents, childrenByParent, orphanSubtasks, countsByQuadrant, total: dayTodos.length })
  }
  return groups
}

function TodoRow({ todo, indent }: { todo: Todo; indent?: boolean }) {
  const q = QUAD_META.get(todo.quadrant)
  const time = todo.completedAt ? dayjs(todo.completedAt).format('HH:mm') : ''
  return (
    <div className={`report-todo-row${indent ? ' report-todo-row-sub' : ''}`}>
      <span className="report-todo-time">{time}</span>
      <span className="report-quadrant-dot" style={{ background: q?.color || '#ccc' }} />
      <span className="report-todo-title">{todo.title}</span>
      {todo.description ? (
        <span className="report-todo-desc" title={todo.description}>{todo.description}</span>
      ) : null}
    </div>
  )
}

function DayBlock({ group }: { group: DayGroup }) {
  return (
    <div className="report-day-block">
      <div className="report-day-head">
        <span className="report-day-label">{group.label}</span>
        <span className="report-day-count">完成 <b>{group.total}</b> 件</span>
        <div style={{ flex: 1 }} />
        <div className="report-day-quad-counts">
          {QUADRANT_CONFIG.map(c => {
            const n = group.countsByQuadrant.get(c.q) || 0
            if (!n) return null
            return (
              <Tag key={c.q} color={c.color} style={{ marginRight: 4 }}>
                Q{c.q} × {n}
              </Tag>
            )
          })}
        </div>
      </div>
      <div className="report-day-body">
        {group.parents.map(p => (
          <div key={p.id}>
            <TodoRow todo={p} />
            {(group.childrenByParent.get(p.id) || []).map(c => (
              <TodoRow key={c.id} todo={c} indent />
            ))}
          </div>
        ))}
        {group.orphanSubtasks.map(c => (
          <TodoRow key={c.id} todo={c} />
        ))}
      </div>
    </div>
  )
}

function ReportBody({ rangeKey, custom }: { rangeKey: RangeKey; custom?: [Dayjs, Dayjs] }) {
  const [loading, setLoading] = useState(false)
  const [report, setReport] = useState<DoneReport | null>(null)
  const [heatReport, setHeatReport] = useState<DoneReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { since, until, title } = useMemo(() => resolveRange(rangeKey, custom), [rangeKey, custom])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const now = dayjs()
    const heatSince = now.subtract(6, 'day').startOf('day').valueOf()
    const heatUntil = now.endOf('day').valueOf() + 1
    Promise.all([
      getDoneReport(since, until),
      getDoneReport(heatSince, heatUntil),
    ])
      .then(([main, heat]) => {
        if (cancelled) return
        setReport(main)
        setHeatReport(heat)
      })
      .catch(e => { if (!cancelled) setError(e?.message || '加载失败') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [since, until])

  const countsByDate = useMemo(() => {
    const m = new Map<string, number>()
    if (heatReport) {
      for (const d of heatReport.dailyCounts) m.set(d.date, d.count)
    }
    return m
  }, [heatReport])

  const streak = useMemo(() => computeStreak(countsByDate), [countsByDate])
  const heat = useMemo(() => buildHeatmap(countsByDate), [countsByDate])

  const dayGroups = useMemo(() => (report ? groupByDay(report.list) : []), [report])
  const todayStr = dayjs().format('YYYY-MM-DD')
  const todayCount = countsByDate.get(todayStr) || 0

  return (
    <>
      <div className="report-hero">
        <div className="report-hero-main">
          <div className="report-hero-today">
            今天已完成 <span className="report-hero-num">{todayCount}</span> 件事 🎉
          </div>
          {streak >= 3 && (
            <div className="report-streak-badge">🔥 连续 {streak} 天</div>
          )}
        </div>
        <div className="report-heatmap">
          {heat.map(cell => (
            <div key={cell.date} className="report-heat-cell" title={`${cell.date} · 完成 ${cell.count} 件`}>
              <div className={`report-heat-square report-heat-l${heatLevel(cell.count)}`}>
                {cell.count > 0 ? cell.count : ''}
              </div>
              <div className="report-heat-label">{cell.label}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="report-range-summary">
        <span>{title}</span>
        <span className="report-range-sep">·</span>
        <span>完成 <b>{report?.total ?? 0}</b> 件</span>
        {report && report.missedCount > 0 && (
          <>
            <span className="report-range-sep">·</span>
            <span className="report-missed-note">过期 {report.missedCount} 条</span>
          </>
        )}
      </div>

      {loading && <div className="report-loading"><Spin /></div>}
      {error && !loading && <Empty description={`加载失败：${error}`} />}
      {!loading && !error && dayGroups.length === 0 && (
        <Empty description="这段时间还没打勾——去完成点什么吧 💪" />
      )}
      {!loading && !error && dayGroups.length > 0 && (
        <div className="report-days">
          {dayGroups.map(g => <DayBlock key={g.date} group={g} />)}
        </div>
      )}
    </>
  )
}

export default function ReportDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const screens = useBreakpoint()
  const isMobile = !screens.md
  const [rangeKey, setRangeKey] = useState<RangeKey>('today')
  const [custom, setCustom] = useState<[Dayjs, Dayjs] | undefined>()

  const title = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 600 }}>
      <TrophyOutlined style={{ color: '#f59f00' }} />
      完成报表
    </span>
  )

  const toolbar = (
    <div className="report-toolbar">
      <Segmented
        value={rangeKey}
        onChange={v => setRangeKey(v as RangeKey)}
        options={[
          { label: '今日', value: 'today' },
          { label: '昨日', value: 'yesterday' },
          { label: '本周', value: 'thisWeek' },
          { label: '上周', value: 'lastWeek' },
          { label: '自定义', value: 'custom' },
        ]}
      />
      {rangeKey === 'custom' && (
        <DatePicker.RangePicker
          size="small"
          style={{ marginLeft: 8 }}
          onChange={v => v && v[0] && v[1] && setCustom([v[0], v[1]])}
        />
      )}
    </div>
  )

  const body = open ? (
    <div className="report-root">
      {toolbar}
      <ReportBody rangeKey={rangeKey} custom={custom} />
    </div>
  ) : null

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
      >
        {body}
      </Modal>
    )
  }

  return (
    <Drawer
      title={title}
      placement="right"
      width={640}
      open={open}
      onClose={onClose}
      styles={{ body: { padding: 16, background: '#f8fafc' } }}
    >
      {body}
    </Drawer>
  )
}
