import express from 'express'
import { buildReport } from '../stats/report.js'
import { renderMarkdown } from '../stats/markdown.js'

export function createStatsRouter({ db, getPricing }) {
	const router = express.Router()

	function parseRange(req) {
		const s = Number(req.query.since)
		const u = Number(req.query.until)
		if (!Number.isFinite(s) || !Number.isFinite(u) || s >= u) return null
		return { since: s, until: u }
	}

	router.get('/report', (req, res) => {
		const range = parseRange(req)
		if (!range) return res.status(400).json({ ok: false, error: 'invalid_range' })
		const report = buildReport(db, { ...range, pricing: getPricing() })
		res.json({ ok: true, report })
	})

	router.get('/report.md', (req, res) => {
		const range = parseRange(req)
		if (!range) return res.status(400).send('invalid range')
		const report = buildReport(db, { ...range, pricing: getPricing() })
		res.set('Content-Type', 'text/markdown; charset=utf-8')
		res.send(renderMarkdown(report))
	})

	return router
}
