import { useEffect, useMemo, useState } from 'react'
import { Segmented, DatePicker, Card, Table, Collapse, Button, Empty, Spin } from 'antd'
import { useTranslation } from 'react-i18next'
import { useAppMessages } from '../../design/useAppMessages'
import { Line, Pie } from '@ant-design/charts'
import dayjs, { Dayjs } from 'dayjs'

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

/**
 * StatsPanel — body of the AI usage statistics panel.
 * Designed to live inside a Tabs item; only fetches data when `active` is true.
 */
export function StatsPanel({ active }: { active: boolean }) {
  const { t } = useTranslation(['settings'])
  const { message } = useAppMessages()
  const [range, setRange] = useState<Range>('week')
  const [custom, setCustom] = useState<[Dayjs, Dayjs] | undefined>()
  const [report, setReport] = useState<Report | null>(null)
  const [loading, setLoading] = useState(false)

  const [since, until] = useMemo(() => rangeToMs(range, custom), [range, custom])

  useEffect(() => {
    if (!active) return
    setLoading(true)
    fetch(`/api/stats/report?since=${since}&until=${until}`)
      .then(r => r.json())
      .then(j => { if (j.ok) setReport(j.report) })
      .finally(() => setLoading(false))
  }, [active, since, until])

  async function copyMd() {
    const r = await fetch(`/api/stats/report.md?since=${since}&until=${until}`)
    const md = await r.text()
    await navigator.clipboard.writeText(md)
    message.success(t('settings:stats.copiedMd'))
  }
  function downloadMd() {
    window.open(`/api/stats/report.md?since=${since}&until=${until}`, '_blank')
  }

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 16 }}>
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
        <div style={{ marginLeft: 'auto', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <Button onClick={copyMd}>{t('settings:stats.copyMd')}</Button>
          <Button onClick={downloadMd}>{t('settings:stats.downloadMd')}</Button>
        </div>
      </div>

      {loading && <Spin />}
      {!loading && !report && <Empty description={t('settings:stats.emptyNoData')} />}
      {!loading && report && <ReportBody report={report} />}
    </div>
  )
}

function ReportBody({ report }: { report: Report }) {
  const { t } = useTranslation(['settings'])
  const { summary, topTodos, byQuadrant, byModel, timeline } = report
  if (summary.sessionCount === 0) {
    return <Empty description={t('settings:stats.emptyNoSession')} />
  }
  const lineData = timeline.flatMap(e => [
    { date: new Date(e.t).toISOString().slice(0, 10), type: t('settings:stats.legend.active'), value: e.activeMs / 3600_000 },
    { date: new Date(e.t).toISOString().slice(0, 10), type: t('settings:stats.legend.wallClock'), value: e.wallClockMs / 3600_000 },
  ])
  const pieData = byQuadrant.map(q => ({ type: `Q${q.key}`, value: q.activeMs }))

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
        <Card size="small" title={t('settings:stats.card.activeDuration')}><h2>{fmtHours(summary.activeMs)}</h2><small>{t('settings:stats.card.wallClockSub', { value: fmtHours(summary.wallClockMs) })}</small></Card>
        <Card size="small" title={t('settings:stats.card.tokenUsage')}><h2>{fmtTok(summary.tokens.total || 0)}</h2><small>{t('settings:stats.card.cacheHit', { value: fmtTok(summary.tokens.cacheRead) })}</small></Card>
        <Card size="small" title={t('settings:stats.card.cost')}><h2>{fmtCost(summary.cost)}</h2><small>{t('settings:stats.card.costSub')}</small></Card>
        <Card size="small" title={t('settings:stats.card.sessionTodo')}><h2>{summary.sessionCount} / {summary.todoCount}</h2><small>{t('settings:stats.card.unbound', { count: summary.unboundSessionCount })}</small></Card>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12, margin: '16px 0' }}>
        <Card size="small" title={t('settings:stats.card.durationTrend')}><Line data={lineData} xField="date" yField="value" seriesField="type" height={220} axis={{ y: { labelFormatter: fmtChartHours } }} tooltip={{ items: [{ channel: 'y', valueFormatter: fmtChartHours }] }} /></Card>
        <Card size="small" title={t('settings:stats.card.quadrantPie')}><Pie data={pieData} angleField="value" colorField="type" height={220} /></Card>
      </div>

      <Card size="small" title={t('settings:stats.card.topTodos')} style={{ marginBottom: 12 }}>
        <Table<TopTodo>
          dataSource={topTodos}
          rowKey="todoId"
          pagination={false}
          scroll={{ x: 'max-content' }}
          columns={[
            { title: t('settings:stats.col.index'), render: (_, __, i) => i + 1, width: 40 },
            { title: t('settings:stats.col.task'), dataIndex: 'title', width: 240, ellipsis: true },
            { title: t('settings:stats.col.quadrant'), dataIndex: 'quadrant', width: 60 },
            { title: t('settings:stats.col.active'), render: r => fmtHours(r.activeMs), width: 70 },
            { title: t('settings:stats.col.wallClock'), render: r => fmtHours(r.wallClockMs), width: 70 },
            { title: t('settings:stats.col.token'), render: r => fmtTok(r.tokens.input + r.tokens.output), width: 80 },
            { title: t('settings:stats.col.cost'), render: r => fmtCost(r.cost), width: 120 },
            { title: t('settings:stats.col.session'), dataIndex: 'sessionCount', width: 50 },
          ]}
        />
      </Card>

      <Collapse items={[{
        key: 'models', label: t('settings:stats.card.byModel'),
        children: (
          <Table
            dataSource={byModel}
            rowKey="key"
            pagination={false}
            scroll={{ x: 'max-content' }}
            columns={[
              { title: t('settings:stats.col.model'), dataIndex: 'key', width: 260, ellipsis: true },
              { title: t('settings:stats.col.session'), dataIndex: 'sessions', width: 60 },
              { title: t('settings:stats.col.token'), render: (r: any) => fmtTok(r.tokens.input + r.tokens.output), width: 90 },
              { title: t('settings:stats.col.cost'), render: (r: any) => fmtCost(r.cost), width: 120 },
            ]}
          />
        )
      }]} />
    </>
  )
}
