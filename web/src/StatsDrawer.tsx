import { useEffect, useMemo, useState } from 'react'
import { Drawer, Segmented, DatePicker, Card, Table, Collapse, Button, message, Empty, Spin } from 'antd'
import { LineChartOutlined } from '@ant-design/icons'
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
const fmtTok = (n: number) => n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : String(n)
const fmtCost = (c: Cost) => `$${c.usd.toFixed(2)} / ¥${c.cny.toFixed(1)}`

export default function StatsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [range, setRange] = useState<Range>('week')
  const [custom, setCustom] = useState<[Dayjs, Dayjs] | undefined>()
  const [report, setReport] = useState<Report | null>(null)
  const [loading, setLoading] = useState(false)

  const [since, until] = useMemo(() => rangeToMs(range, custom), [range, custom])

  useEffect(() => {
    if (!open) return
    setLoading(true)
    fetch(`/api/stats/report?since=${since}&until=${until}`)
      .then(r => r.json())
      .then(j => { if (j.ok) setReport(j.report) })
      .finally(() => setLoading(false))
  }, [open, since, until])

  async function copyMd() {
    const r = await fetch(`/api/stats/report.md?since=${since}&until=${until}`)
    const md = await r.text()
    await navigator.clipboard.writeText(md)
    message.success('已复制 Markdown')
  }
  function downloadMd() {
    window.open(`/api/stats/report.md?since=${since}&until=${until}`, '_blank')
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={720}
      title={<span><LineChartOutlined style={{ marginRight: 6 }} />AI 使用统计</span>}
    >
      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <Segmented
          value={range}
          onChange={v => setRange(v as Range)}
          options={[
            { label: '本周', value: 'week' },
            { label: '本月', value: 'month' },
            { label: '近 30 天', value: '30d' },
            { label: '自定义', value: 'custom' },
          ]}
        />
        {range === 'custom' && (
          <DatePicker.RangePicker onChange={v => v && setCustom(v as [Dayjs, Dayjs])} />
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <Button onClick={copyMd}>📋 复制 Markdown</Button>
          <Button onClick={downloadMd}>💾 下载 .md</Button>
        </div>
      </div>

      {loading && <Spin />}
      {!loading && !report && <Empty description="无数据" />}
      {!loading && report && <ReportBody report={report} />}
    </Drawer>
  )
}

function ReportBody({ report }: { report: Report }) {
  const { summary, topTodos, byQuadrant, byModel, timeline } = report
  if (summary.sessionCount === 0) {
    return <Empty description="该时段没有绑定到 todo 的 AI 会话，先去跑几个 AI 任务吧～" />
  }
  const lineData = timeline.flatMap(e => [
    { date: new Date(e.t).toISOString().slice(0, 10), type: '活跃', value: e.activeMs / 3600_000 },
    { date: new Date(e.t).toISOString().slice(0, 10), type: '墙钟', value: e.wallClockMs / 3600_000 },
  ])
  const pieData = byQuadrant.map(q => ({ type: `Q${q.key}`, value: q.activeMs }))

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
        <Card size="small" title="AI 活跃时长"><h2>{fmtHours(summary.activeMs)}</h2><small>墙钟 {fmtHours(summary.wallClockMs)}</small></Card>
        <Card size="small" title="Token 消耗"><h2>{fmtTok(summary.tokens.total || 0)}</h2><small>cache 命中 {fmtTok(summary.tokens.cacheRead)}</small></Card>
        <Card size="small" title="估算成本"><h2>{fmtCost(summary.cost)}</h2><small>按当前价目表</small></Card>
        <Card size="small" title="会话 / 任务"><h2>{summary.sessionCount} / {summary.todoCount}</h2><small>未关联 {summary.unboundSessionCount}</small></Card>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, margin: '16px 0' }}>
        <Card size="small" title="时长趋势"><Line data={lineData} xField="date" yField="value" seriesField="type" height={220} /></Card>
        <Card size="small" title="象限占比（活跃时长）"><Pie data={pieData} angleField="value" colorField="type" height={220} /></Card>
      </div>

      <Card size="small" title="Top 10 任务" style={{ marginBottom: 12 }}>
        <Table<TopTodo>
          dataSource={topTodos}
          rowKey="todoId"
          pagination={false}
          columns={[
            { title: '#', render: (_, __, i) => i + 1, width: 40 },
            { title: '任务', dataIndex: 'title' },
            { title: '象限', dataIndex: 'quadrant', width: 60 },
            { title: '活跃', render: r => fmtHours(r.activeMs), width: 70 },
            { title: '墙钟', render: r => fmtHours(r.wallClockMs), width: 70 },
            { title: 'Token', render: r => fmtTok(r.tokens.input + r.tokens.output), width: 80 },
            { title: '成本', render: r => fmtCost(r.cost) },
            { title: '会话', dataIndex: 'sessionCount', width: 50 },
          ]}
        />
      </Card>

      <Collapse items={[{
        key: 'models', label: '按模型',
        children: (
          <Table
            dataSource={byModel}
            rowKey="key"
            pagination={false}
            columns={[
              { title: '模型', dataIndex: 'key' },
              { title: '会话', dataIndex: 'sessions', width: 60 },
              { title: 'Token', render: (r: any) => fmtTok(r.tokens.input + r.tokens.output) },
              { title: '成本', render: (r: any) => fmtCost(r.cost) },
            ]}
          />
        )
      }]} />
    </>
  )
}
