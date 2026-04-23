import { describe, it, expect, beforeEach } from 'vitest'
import { openDb } from '../src/db.js'
import { buildReport } from '../src/stats/report.js'
import { DEFAULT_PRICING } from '../src/pricing.js'

function seed(db, rows) {
	for (const r of rows) {
		db.upsertTranscriptFile({
			tool: r.tool || 'claude',
			nativeId: r.id, cwd: '/tmp',
			jsonlPath: `/tmp/${r.id}.jsonl`,
			size: 1, mtime: r.endedAt,
			startedAt: r.startedAt, endedAt: r.endedAt,
			firstUserPrompt: 'x', turnCount: 1,
			inputTokens: r.input, outputTokens: r.output,
			cacheReadTokens: 0, cacheCreationTokens: 0,
			primaryModel: r.model, activeMs: r.active,
			boundTodoId: r.todoId ?? null,
		})
	}
}

describe('buildReport', () => {
	let db
	beforeEach(() => { db = openDb(':memory:') })

	it('summary 汇总 + topTodos 排序', () => {
		db.createTodo({ title: 'A', quadrant: 1 })
		const a = db.listTodos()[0]
		db.createTodo({ title: 'B', quadrant: 2 })
		const b = db.listTodos()[1]
		seed(db, [
			{ id: 's1', startedAt: 1000, endedAt: 2000, active: 600_000, input: 100_000, output: 20_000, model: 'claude-sonnet-4-6', todoId: a.id },
			{ id: 's2', startedAt: 3000, endedAt: 4000, active: 300_000, input: 50_000,  output: 10_000, model: 'claude-sonnet-4-6', todoId: a.id },
			{ id: 's3', startedAt: 5000, endedAt: 6000, active: 900_000, input: 1_000_000, output: 200_000, model: 'claude-opus-4-6', todoId: b.id },
			{ id: 's4', startedAt: 7000, endedAt: 8000, active: 100_000, input: 1000, output: 500, model: 'claude-sonnet-4-6', todoId: null },
		])
		db.insertSessionLog({ id: 's1', todoId: a.id, tool: 'claude', quadrant: 1, status: 'done', startedAt: 1000, completedAt: 2000 })
		db.insertSessionLog({ id: 's2', todoId: a.id, tool: 'claude', quadrant: 1, status: 'done', startedAt: 3000, completedAt: 4000 })
		db.insertSessionLog({ id: 's3', todoId: b.id, tool: 'claude', quadrant: 2, status: 'done', startedAt: 5000, completedAt: 6000 })
		db.insertSessionLog({ id: 's4', todoId: 'unbound', tool: 'claude', quadrant: 4, status: 'done', startedAt: 7000, completedAt: 8000 })

		const report = buildReport(db, { since: 0, until: 9000, pricing: DEFAULT_PRICING })
		expect(report.summary.sessionCount).toBe(4)
		expect(report.summary.todoCount).toBe(2)
		expect(report.summary.unboundSessionCount).toBe(1)
		expect(report.summary.activeMs).toBe(600_000 + 300_000 + 900_000 + 100_000)
		expect(report.summary.tokens.input).toBe(1_151_000)
		expect(report.summary.cost.usd).toBeGreaterThan(0)

		// topTodos by activeMs desc
		expect(report.topTodos[0].todoId).toBe(b.id)  // 900k
		expect(report.topTodos[1].todoId).toBe(a.id)  // 600k+300k=900k... actually equal, take by title order — just check inclusion
		const ids = report.topTodos.map(t => t.todoId)
		expect(ids).toContain(a.id)
		expect(ids).toContain(b.id)

		expect(report.range.label).toBe('自定义')
		expect(report.byTool.find(x => x.key === 'claude').sessions).toBeGreaterThan(0)
		expect(report.byQuadrant.map(x => x.key)).toEqual(expect.arrayContaining([1, 2]))
		expect(report.byModel.find(x => x.key === 'claude-opus-4-6')).toBeTruthy()
		expect(report.timeline.length).toBeGreaterThan(0)
	})

	it('range.label for 7-day window = 本周', () => {
		const day = 86400_000
		const r = buildReport(db, { since: 0, until: 7 * day, pricing: DEFAULT_PRICING })
		expect(r.range.label).toBe('本周')
	})

	it('空 DB 返回 empty summary', () => {
		const r = buildReport(db, { since: 0, until: 1000, pricing: DEFAULT_PRICING })
		expect(r.summary.sessionCount).toBe(0)
		expect(r.topTodos).toEqual([])
	})

	it('混合模型时各维度按 primary_model 分别计价后再汇总', () => {
		db.createTodo({ title: 'A', quadrant: 1 })
		const a = db.listTodos()[0]
		db.createTodo({ title: 'B', quadrant: 2 })
		const b = db.listTodos()[1]
		seed(db, [
			// Sonnet: 100k in + 20k out = 0.3 + 0.3 = $0.60
			{ id: 's1', startedAt: 1000, endedAt: 2000, active: 100, input: 100_000, output: 20_000, model: 'claude-sonnet-4-6', todoId: a.id },
			// Opus: 1M in + 200k out = 15 + 15 = $30.00
			{ id: 's2', startedAt: 3000, endedAt: 4000, active: 200, input: 1_000_000, output: 200_000, model: 'claude-opus-4-6', todoId: b.id },
			// Haiku: 500k in + 100k out = 0.5 + 0.5 = $1.00
			{ id: 's3', startedAt: 5000, endedAt: 6000, active: 300, input: 500_000, output: 100_000, model: 'claude-haiku-4-5', todoId: b.id },
		])

		const r = buildReport(db, { since: 0, until: 9000, pricing: DEFAULT_PRICING })

		// summary.cost 必须是三段成本相加，不是 合计token × sonnet单价
		expect(r.summary.cost.usd).toBeCloseTo(31.60, 6)
		// CNY = USD × 7.2
		expect(r.summary.cost.cny).toBeCloseTo(31.60 * 7.2, 6)

		// byModel 各行用各自模型的单价，不再全部按 default 计
		const opus = r.byModel.find(x => x.key === 'claude-opus-4-6')
		const sonnet = r.byModel.find(x => x.key === 'claude-sonnet-4-6')
		const haiku = r.byModel.find(x => x.key === 'claude-haiku-4-5')
		expect(opus.cost.usd).toBeCloseTo(30, 6)
		expect(sonnet.cost.usd).toBeCloseTo(0.6, 6)
		expect(haiku.cost.usd).toBeCloseTo(1, 6)

		// topTodos: b 包含 opus + haiku 两个 session，必须各自算再求和 = 31
		const todoB = r.topTodos.find(x => x.todoId === b.id)
		expect(todoB.cost.usd).toBeCloseTo(31, 6)
		const todoA = r.topTodos.find(x => x.todoId === a.id)
		expect(todoA.cost.usd).toBeCloseTo(0.6, 6)

		// byTool: claude 桶包含全部三个 session
		const byToolClaude = r.byTool.find(x => x.key === 'claude')
		expect(byToolClaude.cost.usd).toBeCloseTo(31.60, 6)

		// byQuadrant: Q2 包含 opus + haiku
		const q2 = r.byQuadrant.find(x => x.key === 2)
		expect(q2.cost.usd).toBeCloseTo(31, 6)
	})
})
