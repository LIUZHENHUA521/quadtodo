import { useEffect, useMemo, useState } from 'react'
import { Segmented, DatePicker, Table, Collapse, Empty, Spin } from 'antd'
import { useTranslation } from 'react-i18next'
import { useTheme } from '../../design/ThemeProvider'
import { Line, Pie } from '@ant-design/charts'
import dayjs, { Dayjs } from 'dayjs'
import {
  readPalette, fillTimelineGaps, computeDelta, shiftRangeBackwards,
  rangeLabel, type PaletteSnapshot, type DeltaResult,
} from './statsHelpers'
import './StatsPanel.css'

type Range = 'week' | 'month' | '30d' | 'custom'

interface Cost { usd: number; cny: number }
interface Tokens { input: number; output: number; cacheRead: number; cacheCreation: number; total?: number }
interface TopTodo {
  todoId: string; title: string; quadrant: number
  activeMs: number; wallClockMs: number
  tokens: Tokens; cost: Cost
  sessionCount: number; primaryModel: string | null
}
interface Report {
  range: { since: number; until: number; label: string }
  summary: {
    wallClockMs: number; activeMs: number
    tokens: Tokens; cost: Cost
    sessionCount: number; todoCount: number; unboundSessionCount: number
  }
  topTodos: TopTodo[]
  byTool: any[]; byQuadrant: any[]; byModel: any[]
  timeline: { t: number; wallClockMs: number; activeMs: number; tokens: Tokens; cost: Cost }[]
}

function rangeToMs(r: Range, custom?: [Dayjs, Dayjs]): [number, number] {
  const now = Date.now()
  if (r === 'week')  return [dayjs().startOf('week').valueOf(), now]
  if (r === 'month') return [dayjs().startOf('month').valueOf(), now]
  if (r === '30d')   return [now - 30 * 86400_000, now]
  if (custom && custom.length === 2) return [custom[0].startOf('day').valueOf(), custom[1].endOf('day').valueOf()]
  return [now - 7 * 86400_000, now]
}

const fmtHours = (ms: number) => (ms / 3600_000).toFixed(1) + 'h'
const fmtChartHours = (hours: number) => `${hours.toFixed(1)}h`
const fmtTok = (n: number) => n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : String(n)
const fmtCost = (c: Cost) => `$${c.usd.toFixed(2)} / ¥${c.cny.toFixed(1)}`

function fetchReport(since: number, until: number): Promise<Report | null> {
  return fetch(`/api/stats/report?since=${since}&until=${until}`)
    .then(r => r.json())
    .then(j => (j.ok ? (j.report as Report) : null))
    .catch(() => null)
}

/**
 * StatsPanel — body of the AI usage statistics panel.
 * Designed to live inside a Tabs item; only fetches data when `active` is true.
 */
export function StatsPanel({ active }: { active: boolean }) {
  const { t } = useTranslation(['settings'])
  const [range, setRange] = useState<Range>('week')
  const [custom, setCustom] = useState<[Dayjs, Dayjs] | undefined>()
  const [report, setReport] = useState<Report | null>(null)
  const [prevReport, setPrevReport] = useState<Report | null>(null)
  const [loading, setLoading] = useState(false)

  const [since, until] = useMemo(() => rangeToMs(range, custom), [range, custom])

  useEffect(() => {
    if (!active) return
    setLoading(true)
    const [pSince, pUntil] = shiftRangeBackwards(since, until)
    Promise.all([fetchReport(since, until), fetchReport(pSince, pUntil)])
      .then(([cur, prev]) => {
        setReport(cur)
        setPrevReport(prev)
      })
      .finally(() => setLoading(false))
  }, [active, since, until])

  return (
    <div className="stats-root">
      <div className="stats-toolbar">
        <Segmented
          value={range}
          onChange={v => setRange(v as Range)}
          options={[
            { label: t('settings:stats.range.week'), value: 'week' },
            { label: t('settings:stats.range.month'), value: 'month' },
            { label: t('settings:stats.range.thirtyDays'), value: '30d' },
            { label: t('settings:stats.range.custom'), value: 'custom' },
          ]}
        />
        {range === 'custom' && (
          <DatePicker.RangePicker onChange={v => v && setCustom(v as [Dayjs, Dayjs])} />
        )}
      </div>

      {loading && <div className="stats-loading"><Spin /></div>}
      {!loading && !report && <Empty description={t('settings:stats.emptyNoData')} />}
      {!loading && report && (
        <ReportBody report={report} prevReport={prevReport} range={range} since={since} until={until} />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Sparkline                                                          */
/* ------------------------------------------------------------------ */

function HeroSparkline({ points, palette }: { points: { t: number; activeMs: number }[]; palette: PaletteSnapshot }) {
  if (points.length < 2) return null
  const w = 100, h = 24
  const xs = points.map((_, i) => (i / (points.length - 1)) * w)
  const max = Math.max(...points.map(p => p.activeMs), 1)
  const ys = points.map(p => h - (p.activeMs / max) * h)
  const linePath = xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${ys[i].toFixed(2)}`).join(' ')
  const areaPath = `${linePath} L${xs[xs.length - 1].toFixed(2)},${h} L${xs[0].toFixed(2)},${h} Z`
  return (
    <svg
      className="stats-hero-spark"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      role="img"
      aria-hidden="true"
      style={{ '--spark-color': palette.accent } as React.CSSProperties}
    >
      <path className="area" d={areaPath} />
      <path className="line" d={linePath} />
    </svg>
  )
}

/* ------------------------------------------------------------------ */
/* Delta pill                                                         */
/* ------------------------------------------------------------------ */

function DeltaPill({ delta, vsText }: { delta: DeltaResult; vsText: string }) {
  const cls = `stats-hero-delta is-${delta.direction}`
  let arrow = '·'
  if (delta.direction === 'up') arrow = '↑'
  else if (delta.direction === 'down') arrow = '↓'
  else if (delta.direction === 'flat') arrow = '→'
  const pctText = delta.pct == null
    ? (delta.direction === 'none' ? '—' : '')
    : `${Math.abs(delta.pct).toFixed(0)}%`
  return (
    <span className={cls}>
      <span>{arrow}{pctText && ' ' + pctText}</span>
      <span className="stats-hero-delta-vs">vs {vsText}</span>
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* Body                                                               */
/* ------------------------------------------------------------------ */

function ReportBody({
  report, prevReport, range, since, until,
}: {
  report: Report
  prevReport: Report | null
  range: Range
  since: number
  until: number
}) {
  const { t } = useTranslation(['settings'])
  const { mode } = useTheme()
  const { summary, topTodos, byQuadrant, byModel, timeline } = report

  // Re-read CSS palette whenever theme changes. Use a small tick to ensure the
  // [data-theme] attribute has been applied before computed style read.
  const [palette, setPalette] = useState<PaletteSnapshot>(() => readPalette())
  useEffect(() => {
    const id = requestAnimationFrame(() => setPalette(readPalette()))
    return () => cancelAnimationFrame(id)
  }, [mode])

  const filledTimeline = useMemo(
    () => fillTimelineGaps(timeline, since, until),
    [timeline, since, until],
  )

  if (summary.sessionCount === 0) {
    return <Empty description={t('settings:stats.emptyNoSession')} />
  }

  // Force chart remount on theme change so internal canvas re-renders with new colors.
  const chartKey = mode

  const lineData = filledTimeline.flatMap(e => [
    { date: dayjs(e.t).format('MM-DD'), type: t('settings:stats.legend.active'), value: e.activeMs / 3600_000 },
    { date: dayjs(e.t).format('MM-DD'), type: t('settings:stats.legend.wallClock'), value: e.wallClockMs / 3600_000 },
  ])

  const pieData = byQuadrant.map((q: any) => ({ type: `Q${q.key}`, value: q.activeMs }))
  const quadrantColors = [palette.q1, palette.q2, palette.q3, palette.q4]

  const activeDelta = computeDelta(summary.activeMs, prevReport?.summary.activeMs)
  const tokenDelta = computeDelta(
    summary.tokens.total ?? 0,
    prevReport?.summary.tokens.total ?? undefined,
    1000, // baseline >= 1K tokens
  )
  const costDelta = computeDelta(
    summary.cost.usd,
    prevReport?.summary.cost.usd,
    0.1, // baseline >= $0.10
  )
  const vsText = rangeLabel(range)

  // ----- chart theme objects -----
  const lineConfig = {
    data: lineData,
    xField: 'date',
    yField: 'value',
    seriesField: 'type',
    colorField: 'type',
    height: 220,
    theme: mode === 'dark' ? 'classicDark' : 'classic',
    scale: {
      color: { range: [palette.accent, palette.q3] },
    },
    axis: {
      x: {
        labelFill: palette.textTertiary,
        line: false,
        tickStroke: palette.borderSubtle,
      },
      y: {
        labelFormatter: fmtChartHours,
        labelFill: palette.textTertiary,
        grid: true,
        gridStroke: palette.borderSubtle,
        gridLineDash: [2, 4],
        line: false,
      },
    },
    legend: {
      color: {
        itemLabelFill: palette.textSecondary,
      },
    },
    style: { lineWidth: 2 },
    point: { shapeField: 'circle', sizeField: 3 },
    tooltip: { items: [{ channel: 'y', valueFormatter: fmtChartHours }] },
  }

  const pieConfig = {
    data: pieData,
    angleField: 'value',
    colorField: 'type',
    height: 220,
    theme: mode === 'dark' ? 'classicDark' : 'classic',
    innerRadius: 0.55,
    scale: { color: { range: quadrantColors } },
    label: {
      text: 'type',
      style: { fill: palette.textPrimary, fontSize: 12, fontWeight: 500 },
    },
    legend: {
      color: {
        itemLabelFill: palette.textSecondary,
      },
    },
    tooltip: {
      items: [
        { channel: 'y', valueFormatter: (v: number) => fmtHours(v) },
      ],
    },
  }

  return (
    <>
      {/* ---------- Hero ---------- */}
      <div className="stats-hero">
        <div className="stats-hero-row">
          <div className="stats-hero-main">
            <div className="stats-hero-label">{t('settings:stats.card.activeDuration')}</div>
            <div className="stats-hero-value">{fmtHours(summary.activeMs)}</div>
            <div className="stats-hero-sub">
              {t('settings:stats.card.wallClockSub', { value: fmtHours(summary.wallClockMs) })}
            </div>
          </div>
          <DeltaPill delta={activeDelta} vsText={vsText} />
        </div>
        <HeroSparkline points={filledTimeline} palette={palette} />
      </div>

      {/* ---------- Secondary cards ---------- */}
      <div className="stats-cards">
        <SecondaryCard
          accent={palette.q2}
          label={t('settings:stats.card.tokenUsage')}
          value={fmtTok(summary.tokens.total || 0)}
          sub={t('settings:stats.card.cacheHit', { value: fmtTok(summary.tokens.cacheRead) })}
          delta={tokenDelta}
        />
        <SecondaryCard
          accent={palette.q3}
          label={t('settings:stats.card.cost')}
          value={fmtCost(summary.cost)}
          sub={t('settings:stats.card.costSub')}
          delta={costDelta}
        />
        <SecondaryCard
          accent={palette.q1}
          label={t('settings:stats.card.sessionTodo')}
          value={`${summary.sessionCount} / ${summary.todoCount}`}
          sub={t('settings:stats.card.unbound', { count: summary.unboundSessionCount })}
        />
      </div>

      {/* ---------- Charts ---------- */}
      <div className="stats-charts">
        <div className="stats-chart-card">
          <div className="stats-chart-title">{t('settings:stats.card.durationTrend')}</div>
          <Line key={chartKey + ':line'} {...lineConfig} />
        </div>
        <div className="stats-chart-card">
          <div className="stats-chart-title">{t('settings:stats.card.quadrantPie')}</div>
          <Pie key={chartKey + ':pie'} {...pieConfig} />
        </div>
      </div>

      {/* ---------- Top 10 ---------- */}
      <div className="stats-table-card">
        <div className="stats-table-title">{t('settings:stats.card.topTodos')}</div>
        <Table<TopTodo>
          className="stats-top-table"
          dataSource={topTodos}
          rowKey="todoId"
          pagination={false}
          size="small"
          scroll={{ x: 'max-content' }}
          columns={[
            { title: t('settings:stats.col.index'), render: (_, __, i) => i + 1, width: 40 },
            { title: t('settings:stats.col.task'), dataIndex: 'title', width: 220, ellipsis: true },
            {
              title: t('settings:stats.col.quadrant'),
              dataIndex: 'quadrant',
              width: 64,
              render: (q: number) => <span className={`stats-quadrant-pill q-${q}`}>Q{q}</span>,
            },
            { title: t('settings:stats.col.active'), render: r => fmtHours(r.activeMs), width: 70 },
            { title: t('settings:stats.col.wallClock'), render: r => fmtHours(r.wallClockMs), width: 70 },
            { title: t('settings:stats.col.token'), render: r => fmtTok(r.tokens.input + r.tokens.output), width: 80 },
            { title: t('settings:stats.col.cost'), render: r => fmtCost(r.cost), width: 120 },
            { title: t('settings:stats.col.session'), dataIndex: 'sessionCount', width: 50 },
          ]}
        />
      </div>

      <Collapse items={[{
        key: 'models', label: t('settings:stats.card.byModel'),
        children: (
          <Table
            className="stats-top-table"
            dataSource={byModel}
            rowKey="key"
            pagination={false}
            size="small"
            scroll={{ x: 'max-content' }}
            columns={[
              { title: t('settings:stats.col.model'), dataIndex: 'key', width: 260, ellipsis: true },
              { title: t('settings:stats.col.session'), dataIndex: 'sessions', width: 60 },
              { title: t('settings:stats.col.token'), render: (r: any) => fmtTok(r.tokens.input + r.tokens.output), width: 90 },
              { title: t('settings:stats.col.cost'), render: (r: any) => fmtCost(r.cost), width: 120 },
            ]}
          />
        ),
      }]} />
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Secondary card                                                     */
/* ------------------------------------------------------------------ */

function SecondaryCard({
  accent, label, value, sub, delta,
}: {
  accent: string
  label: string
  value: string
  sub: string
  delta?: DeltaResult
}) {
  return (
    <div className="stats-card" style={{ ['--stats-card-accent' as any]: accent }}>
      <div className="stats-card-label">{label}</div>
      <div className="stats-card-value">{value}</div>
      <div className="stats-card-sub">{sub}</div>
      {delta && delta.direction !== 'none' && delta.pct != null && (
        <div
          className="stats-card-sub"
          style={{
            marginTop: 6,
            color:
              delta.direction === 'up' ? 'var(--ai-running)'
              : delta.direction === 'down' ? 'var(--ai-error)'
              : 'var(--text-tertiary)',
            fontWeight: 600,
          }}
        >
          {delta.direction === 'up' ? '↑' : delta.direction === 'down' ? '↓' : '→'} {Math.abs(delta.pct).toFixed(0)}%
        </div>
      )}
    </div>
  )
}
