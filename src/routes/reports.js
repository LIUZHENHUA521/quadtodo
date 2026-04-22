import express from 'express'

// 把时间戳按"本地日期"分桶（key 形如 '2026-04-22'）
function localDateKey(ts) {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function createReportsRouter({ db }) {
  const router = express.Router()

  router.get('/done', (req, res) => {
    try {
      const since = Number(req.query.since)
      const until = Number(req.query.until)
      if (!Number.isFinite(since) || !Number.isFinite(until) || since >= until) {
        res.status(400).json({ ok: false, error: 'invalid_range' })
        return
      }

      const list = db.listCompletedTodos({ since, until })
      const byDay = new Map()
      for (const t of list) {
        const key = localDateKey(t.completedAt)
        byDay.set(key, (byDay.get(key) || 0) + 1)
      }
      const dailyCounts = [...byDay.entries()]
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => (a.date < b.date ? 1 : -1))

      const missedCount = db.countMissedInRange({ since, until })

      res.json({
        ok: true,
        range: { since, until },
        list,
        dailyCounts,
        missedCount,
        total: list.length,
      })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  return router
}
