import { useEffect, useMemo, useState } from 'react'
import { Segmented, DatePicker, Empty, Spin, Tag } from 'antd'
import { useTranslation } from 'react-i18next'
import dayjs, { Dayjs } from 'dayjs'
import { getDoneReport, DoneReport, Todo, Quadrant } from '../../api'
import './ReportPanel.css'

type RangeKey = 'today' | 'yesterday' | 'thisWeek' | 'lastWeek' | 'custom'

const QUADRANT_CONFIG: { q: Quadrant; color: string }[] = [
  { q: 1, color: '#ff4d4f' },
  { q: 2, color: '#faad14' },
  { q: 3, color: '#1677ff' },
  { q: 4, color: '#52c41a' },
]
const QUAD_META = new Map(QUADRANT_CONFIG.map(c => [c.q, c]))

function resolveRange(
  key: RangeKey,
  custom: [Dayjs, Dayjs] | undefined,
  labels: Record<'today' | 'yesterday' | 'thisWeek' | 'lastWeek', string>,
): { since: number; until: number; title: string } {
  const now = dayjs()
  if (key === 'today') {
    return { since: now.startOf('day').valueOf(), until: now.endOf('day').valueOf() + 1, title: labels.today }
  }
  if (key === 'yesterday') {
    const y = now.subtract(1, 'day')
    return { since: y.startOf('day').valueOf(), until: y.endOf('day').valueOf() + 1, title: labels.yesterday }
  }
  if (key === 'thisWeek') {
    return { since: now.startOf('week').valueOf(), until: now.endOf('week').valueOf() + 1, title: labels.thisWeek }
  }
  if (key === 'lastWeek') {
    const lw = now.subtract(1, 'week')
    return { since: lw.startOf('week').valueOf(), until: lw.endOf('week').valueOf() + 1, title: labels.lastWeek }
  }
  if (custom && custom.length === 2) {
    return {
      since: custom[0].startOf('day').valueOf(),
      until: custom[1].endOf('day').valueOf() + 1,
      title: `${custom[0].format('MM-DD')} ~ ${custom[1].format('MM-DD')}`,
    }
  }
  return { since: now.startOf('day').valueOf(), until: now.endOf('day').valueOf() + 1, title: labels.today }
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
function buildHeatmap(
  countsByDate: Map<string, number>,
  heatLabels: { today: string; yesterday: string },
): { date: string; count: number; label: string }[] {
  const days: { date: string; count: number; label: string }[] = []
  for (let i = 6; i >= 0; i--) {
    const d = dayjs().subtract(i, 'day')
    const key = d.format('YYYY-MM-DD')
    const label = i === 0 ? heatLabels.today : i === 1 ? heatLabels.yesterday : d.format('M/D')
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

function groupByDay(list: Todo[], dayLabels: { today: (d: string) => string; yesterday: (d: string) => string }): DayGroup[] {
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
    const label = date === today ? dayLabels.today(date) : date === yesterday ? dayLabels.yesterday(date) : date
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
      <span className="report-quadrant-dot" style={{ background: q?.color || 'var(--border-default)' }} />
      <span className="report-todo-title">{todo.title}</span>
      {todo.description ? (
        <span className="report-todo-desc" title={todo.description}>{todo.description}</span>
      ) : null}
    </div>
  )
}

function DayBlock({ group }: { group: DayGroup }) {
  const { t } = useTranslation(['settings'])
  return (
    <div className="report-day-block">
      <div className="report-day-head">
        <span className="report-day-label">{group.label}</span>
        <span className="report-day-count">{t('settings:report.dayDone')} <b>{group.total}</b> {t('settings:report.dayDoneSuffix')}</span>
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

function ReportBody({ active, rangeKey, custom }: { active: boolean; rangeKey: RangeKey; custom?: [Dayjs, Dayjs] }) {
  const { t } = useTranslation(['settings'])
  const [loading, setLoading] = useState(false)
  const [report, setReport] = useState<DoneReport | null>(null)
  const [heatReport, setHeatReport] = useState<DoneReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  const rangeLabels = useMemo(() => ({
    today: t('settings:report.range.today'),
    yesterday: t('settings:report.range.yesterday'),
    thisWeek: t('settings:report.range.thisWeek'),
    lastWeek: t('settings:report.range.lastWeek'),
  }), [t])
  const heatLabels = useMemo(() => ({
    today: t('settings:report.heat.today'),
    yesterday: t('settings:report.heat.yesterday'),
  }), [t])
  const dayLabels = useMemo(() => ({
    today: (date: string) => t('settings:report.dayLabel.today', { date }),
    yesterday: (date: string) => t('settings:report.dayLabel.yesterday', { date }),
  }), [t])

  const { since, until, title } = useMemo(() => resolveRange(rangeKey, custom, rangeLabels), [rangeKey, custom, rangeLabels])

  useEffect(() => {
    if (!active) return
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
      .catch(e => { if (!cancelled) setError(e?.message || t('settings:report.loadFailedShort')) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [active, since, until])

  const countsByDate = useMemo(() => {
    const m = new Map<string, number>()
    if (heatReport) {
      for (const d of heatReport.dailyCounts) m.set(d.date, d.count)
    }
    return m
  }, [heatReport])

  const streak = useMemo(() => computeStreak(countsByDate), [countsByDate])
  const heat = useMemo(() => buildHeatmap(countsByDate, heatLabels), [countsByDate, heatLabels])

  const dayGroups = useMemo(() => (report ? groupByDay(report.list, dayLabels) : []), [report, dayLabels])
  const todayStr = dayjs().format('YYYY-MM-DD')
  const todayCount = countsByDate.get(todayStr) || 0

  return (
    <>
      <div className="report-hero">
        <div className="report-hero-main">
          <div className="report-hero-today">
            {t('settings:report.heroToday')} <span className="report-hero-num">{todayCount}</span> {t('settings:report.heroSuffix')}
          </div>
          {streak >= 3 && (
            <div className="report-streak-badge">{t('settings:report.streak', { count: streak })}</div>
          )}
        </div>
        <div className="report-heatmap">
          {heat.map(cell => (
            <div key={cell.date} className="report-heat-cell" title={t('settings:report.heatTooltip', { date: cell.date, count: cell.count })}>
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
        <span className="report-range-sep">{t('settings:report.sep')}</span>
        <span>{t('settings:report.rangeDoneCount')} <b>{report?.total ?? 0}</b> {t('settings:report.rangeDoneSuffix')}</span>
        {report && report.missedCount > 0 && (
          <>
            <span className="report-range-sep">{t('settings:report.sep')}</span>
            <span className="report-missed-note">{t('settings:report.missed', { count: report.missedCount })}</span>
          </>
        )}
      </div>

      {loading && <div className="report-loading"><Spin /></div>}
      {error && !loading && <Empty description={t('settings:report.loadFailed', { msg: error })} />}
      {!loading && !error && dayGroups.length === 0 && (
        <Empty description={t('settings:report.emptyDays')} />
      )}
      {!loading && !error && dayGroups.length > 0 && (
        <div className="report-days">
          {dayGroups.map(g => <DayBlock key={g.date} group={g} />)}
        </div>
      )}
    </>
  )
}

/**
 * ReportPanel — body of the "完成报表" panel.
 * Mounted inside Tabs; only fetches data when `active` is true.
 */
export function ReportPanel({ active }: { active: boolean }) {
  const { t } = useTranslation(['settings'])
  const [rangeKey, setRangeKey] = useState<RangeKey>('today')
  const [custom, setCustom] = useState<[Dayjs, Dayjs] | undefined>()

  const toolbar = (
    <div className="report-toolbar">
      <Segmented
        value={rangeKey}
        onChange={v => setRangeKey(v as RangeKey)}
        options={[
          { label: t('settings:report.range.today'), value: 'today' },
          { label: t('settings:report.range.yesterday'), value: 'yesterday' },
          { label: t('settings:report.range.thisWeek'), value: 'thisWeek' },
          { label: t('settings:report.range.lastWeek'), value: 'lastWeek' },
          { label: t('settings:report.range.custom'), value: 'custom' },
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

  return (
    <div className="report-root">
      {toolbar}
      <ReportBody active={active} rangeKey={rangeKey} custom={custom} />
    </div>
  )
}
