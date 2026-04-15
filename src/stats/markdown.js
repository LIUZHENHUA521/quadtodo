function fmtHours(ms) {
	return (ms / 3600_000).toFixed(1) + 'h'
}

function fmtTokens(n) {
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
	if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
	return String(n)
}

function fmtDate(ms) {
	const d = new Date(ms)
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function fmtCost(c) {
	return `$${c.usd.toFixed(2)} / ¥${c.cny.toFixed(1)}`
}

export function renderMarkdown(r) {
	const { range, summary, topTodos, byModel } = r
	const lines = []
	const title = range.label === '本月' ? '月报' : '周报'
	lines.push(`# quadtodo ${title} · ${fmtDate(range.since)} ~ ${fmtDate(range.until)}`)
	lines.push('')
	lines.push(`AI 活跃 ${fmtHours(summary.activeMs)}（墙钟 ${fmtHours(summary.wallClockMs)}）· ${summary.sessionCount} 场会话 · 覆盖 ${summary.todoCount} 个任务`)
	lines.push(`Token ${fmtTokens(summary.tokens.total)}（cache 命中 ${fmtTokens(summary.tokens.cacheRead)}）· 成本 ${fmtCost(summary.cost)}`)
	if (summary.unboundSessionCount > 0) {
		lines.push(`> 其中 ${summary.unboundSessionCount} 场未关联任务`)
	}
	lines.push('')
	lines.push('## Top 10 任务')
	topTodos.forEach((t, i) => {
		lines.push(`${i + 1}. ${t.title} — 活跃 ${fmtHours(t.activeMs)} · ${fmtCost(t.cost)} · ${t.sessionCount} 场`)
	})
	lines.push('')
	lines.push('## 按模型')
	for (const m of byModel) {
		lines.push(`- ${m.key}: ${m.sessions} 场 · ${fmtTokens(m.tokens.input + m.tokens.output)} tok · ${fmtCost(m.cost)}`)
	}
	return lines.join('\n')
}
