import { estimateCost } from '../pricing.js'

function addTokens(a, b) {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheCreation: a.cacheCreation + b.cacheCreation,
	}
}

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }

function fileTokens(f) {
	return {
		input: f.input_tokens || 0,
		output: f.output_tokens || 0,
		cacheRead: f.cache_read_tokens || 0,
		cacheCreation: f.cache_creation_tokens || 0,
	}
}

function costOf(tokens, model, pricing) {
	return estimateCost(tokens, model, pricing)
}

function pickBucketSize(since, until) {
	return (until - since) > 7 * 86400_000 ? 86400_000 : 3600_000
}

export function buildReport(db, { since, until = Date.now(), pricing, topN = 10 }) {
	const raw = db.raw
	const files = raw.prepare(`
		SELECT * FROM transcript_files
		WHERE started_at IS NOT NULL AND started_at >= ? AND started_at < ?
	`).all(since, until)

	const logs = raw.prepare(`
		SELECT * FROM ai_session_log
		WHERE completed_at >= ? AND completed_at < ?
	`).all(since, until)

	// summary
	let totalTokens = { ...ZERO }
	let totalActive = 0
	let totalWall = 0
	const coveredTodos = new Set()
	let unbound = 0
	for (const f of files) {
		totalTokens = addTokens(totalTokens, fileTokens(f))
		totalActive += f.active_ms || 0
		if (f.bound_todo_id) coveredTodos.add(f.bound_todo_id)
		else unbound++
	}
	for (const l of logs) totalWall += l.duration_ms || 0

	const totalCost = costOf(totalTokens, null, pricing)

	// topTodos: group files by bound_todo_id
	const todoAgg = new Map()
	for (const f of files) {
		if (!f.bound_todo_id) continue
		const bucket = todoAgg.get(f.bound_todo_id) || {
			todoId: f.bound_todo_id, activeMs: 0, tokens: { ...ZERO }, sessions: 0, models: new Map(),
		}
		bucket.activeMs += f.active_ms || 0
		bucket.tokens = addTokens(bucket.tokens, fileTokens(f))
		bucket.sessions += 1
		if (f.primary_model) bucket.models.set(f.primary_model, (bucket.models.get(f.primary_model) || 0) + 1)
		todoAgg.set(f.bound_todo_id, bucket)
	}
	// wall clock per todo from ai_session_log
	const todoWall = new Map()
	for (const l of logs) {
		todoWall.set(l.todo_id, (todoWall.get(l.todo_id) || 0) + (l.duration_ms || 0))
	}

	const todos = db.listTodos()
	const todoById = new Map(todos.map(t => [t.id, t]))

	const topTodos = [...todoAgg.values()]
		.map(b => {
			const t = todoById.get(b.todoId)
			const topModel = [...b.models.entries()].sort((a, c) => c[1] - a[1])[0]?.[0] || null
			return {
				todoId: b.todoId,
				title: t?.title || '(已删除)',
				quadrant: t?.quadrant || 0,
				activeMs: b.activeMs,
				wallClockMs: todoWall.get(b.todoId) || 0,
				tokens: b.tokens,
				cost: costOf(b.tokens, topModel, pricing),
				sessionCount: b.sessions,
				primaryModel: topModel,
			}
		})
		.sort((a, b) => {
			if (b.activeMs !== a.activeMs) return b.activeMs - a.activeMs
			const aTok = a.tokens.input + a.tokens.output + a.tokens.cacheRead + a.tokens.cacheCreation
			const bTok = b.tokens.input + b.tokens.output + b.tokens.cacheRead + b.tokens.cacheCreation
			return bTok - aTok
		})
		.slice(0, topN)

	// byTool / byQuadrant / byModel
	const byTool = aggregateBy(files, logs, f => f.tool, l => l.tool, pricing)
	const byQuadrant = aggregateBy(files, logs,
		f => { const t = todoById.get(f.bound_todo_id); return t ? t.quadrant : null },
		l => l.quadrant, pricing)
	const byModel = aggregateBy(files, [], f => f.primary_model || '(unknown)', () => null, pricing, { includeWall: false })

	// timeline
	const bucketSize = pickBucketSize(since, until)
	const timelineMap = new Map()
	for (const f of files) {
		const b = Math.floor((f.started_at || since) / bucketSize) * bucketSize
		const cur = timelineMap.get(b) || { t: b, wallClockMs: 0, activeMs: 0, tokens: { ...ZERO } }
		cur.activeMs += f.active_ms || 0
		cur.tokens = addTokens(cur.tokens, fileTokens(f))
		timelineMap.set(b, cur)
	}
	for (const l of logs) {
		const b = Math.floor(l.completed_at / bucketSize) * bucketSize
		const cur = timelineMap.get(b) || { t: b, wallClockMs: 0, activeMs: 0, tokens: { ...ZERO } }
		cur.wallClockMs += l.duration_ms || 0
		timelineMap.set(b, cur)
	}
	const timeline = [...timelineMap.values()]
		.sort((a, b) => a.t - b.t)
		.map(e => ({ ...e, cost: costOf(e.tokens, null, pricing) }))

	return {
		range: { since, until, label: rangeLabel(since, until) },
		summary: {
			wallClockMs: totalWall,
			activeMs: totalActive,
			tokens: { ...totalTokens, total: totalTokens.input + totalTokens.output + totalTokens.cacheRead + totalTokens.cacheCreation },
			cost: totalCost,
			// transcripts 是 AI 活动的权威来源；ai_session_log 仅覆盖经过 PTY runner 的会话
			sessionCount: files.length,
			todoCount: coveredTodos.size,
			unboundSessionCount: unbound,
		},
		topTodos,
		byTool,
		byQuadrant,
		byModel,
		timeline,
	}
}

function aggregateBy(files, logs, keyF, keyL, pricing, { includeWall = true } = {}) {
	const m = new Map()
	for (const f of files) {
		const k = keyF(f)
		if (k == null) continue
		const cur = m.get(k) || { key: k, sessions: 0, activeMs: 0, wallClockMs: 0, tokens: { ...ZERO } }
		cur.sessions += 1
		cur.activeMs += f.active_ms || 0
		cur.tokens = addTokens(cur.tokens, fileTokens(f))
		m.set(k, cur)
	}
	if (includeWall) {
		for (const l of logs) {
			const k = keyL(l)
			if (k == null) continue
			const cur = m.get(k) || { key: k, sessions: 0, activeMs: 0, wallClockMs: 0, tokens: { ...ZERO } }
			cur.wallClockMs += l.duration_ms || 0
			m.set(k, cur)
		}
	}
	return [...m.values()].map(e => ({ ...e, cost: estimateCost(e.tokens, null, pricing) }))
}

function rangeLabel(since, until) {
	const days = Math.round((until - since) / 86400_000)
	if (days === 7) return '本周'
	if (days === 30) return '近 30 天'
	if (days >= 28 && days <= 31) return '本月'
	return '自定义'
}
