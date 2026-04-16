import { parseTranscriptFile } from '../transcripts/scanner.js'
import { estimateCost, DEFAULT_PRICING } from '../pricing.js'

const QUADRANT_LABEL = {
	1: 'Q1 紧急且重要',
	2: 'Q2 重要不紧急',
	3: 'Q3 紧急不重要',
	4: 'Q4 不紧急不重要',
}

const STATUS_LABEL = {
	todo: '待办',
	ai_pending: 'AI 待确认',
	ai_running: 'AI 进行中',
	ai_done: 'AI 已完成',
	done: '已完成',
}

const ROLE_LABEL = {
	user: '用户',
	assistant: 'AI',
	thinking: '思考',
	tool_use: '工具调用',
	tool_result: '工具输出',
	system: '系统',
}

export async function buildTodoExport(db, todoId, { turns = 'summary', turnLimit = 80, pricing = DEFAULT_PRICING } = {}) {
	const todo = db.getTodo(todoId)
	if (!todo) return null
	const comments = db.listComments(todoId)
	const aiSessions = Array.isArray(todo.aiSessions) ? todo.aiSessions : []

	const sessionRows = []
	for (const s of aiSessions) {
		const tool = s?.tool || 'claude'
		const nativeId = s?.nativeSessionId
		let file = null
		if (nativeId) {
			file = db.findTranscriptByNative(nativeId, tool)
		}
		const tokens = file ? {
			input: file.input_tokens || 0,
			output: file.output_tokens || 0,
			cacheRead: file.cache_read_tokens || 0,
			cacheCreation: file.cache_creation_tokens || 0,
		} : { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
		const cost = file?.primary_model
			? estimateCost(tokens, file.primary_model, pricing)
			: { usd: 0, cny: 0 }

		let loadedTurns = null
		if (file && turns !== 'none') {
			try {
				const parsed = await parseTranscriptFile(tool, file.jsonl_path)
				loadedTurns = parsed.turns
			} catch (e) {
				loadedTurns = []
			}
		}

		sessionRows.push({
			session: s,
			file,
			tokens,
			cost,
			turns: loadedTurns,
		})
	}

	return { todo, comments, sessions: sessionRows, generatedAt: Date.now(), turnsMode: turns, turnLimit }
}

function fmtTokens(n) {
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
	if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
	return String(n)
}

function fmtCost(c) {
	if (!c || (!c.usd && !c.cny)) return '—'
	return `$${c.usd.toFixed(2)} / ¥${c.cny.toFixed(1)}`
}

function fmtDateTime(ms) {
	if (!ms) return '—'
	const d = new Date(ms)
	const pad = n => String(n).padStart(2, '0')
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fmtDuration(ms) {
	if (!ms || ms < 0) return '—'
	const s = Math.round(ms / 1000)
	if (s < 60) return `${s}s`
	const m = Math.floor(s / 60)
	const sec = s % 60
	if (m < 60) return `${m}m${sec ? ` ${sec}s` : ''}`
	const h = Math.floor(m / 60)
	return `${h}h ${m % 60}m`
}

function summarizeTurnContent(content, max = 600) {
	const text = String(content || '').trim()
	if (text.length <= max) return text
	return text.slice(0, max) + '…'
}

function pickHighlightTurns(turns, limit) {
	const useful = turns.filter(t => t.role === 'user' || t.role === 'assistant')
	if (useful.length <= limit) return useful
	const head = Math.ceil(limit / 2)
	const tail = limit - head
	return [...useful.slice(0, head), { role: 'separator', content: `… (省略 ${useful.length - limit} 段) …` }, ...useful.slice(-tail)]
}

export function renderTodoMarkdown(report) {
	if (!report) return ''
	const { todo, comments, sessions, turnsMode, turnLimit } = report
	const lines = []
	lines.push(`# ${todo.title}`)
	lines.push('')
	const meta = [
		`**象限**：${QUADRANT_LABEL[todo.quadrant] || todo.quadrant}`,
		`**状态**：${STATUS_LABEL[todo.status] || todo.status}`,
	]
	if (todo.dueDate) meta.push(`**截止**：${fmtDateTime(todo.dueDate)}`)
	if (todo.workDir) meta.push(`**目录**：\`${todo.workDir}\``)
	meta.push(`**创建**：${fmtDateTime(todo.createdAt)}`)
	meta.push(`**更新**：${fmtDateTime(todo.updatedAt)}`)
	lines.push(meta.join(' · '))
	lines.push('')

	if (todo.description?.trim()) {
		lines.push('## 描述')
		lines.push('')
		lines.push(todo.description.trim())
		lines.push('')
	}

	if (comments.length) {
		lines.push('## 评论时间线')
		lines.push('')
		for (const c of comments) {
			lines.push(`- **${fmtDateTime(c.createdAt)}** ${c.content.replace(/\n/g, ' ')}`)
		}
		lines.push('')
	}

	if (sessions.length) {
		const totals = sessions.reduce((acc, r) => {
			acc.input += r.tokens.input
			acc.output += r.tokens.output
			acc.cacheRead += r.tokens.cacheRead
			acc.cacheCreation += r.tokens.cacheCreation
			acc.usd += r.cost.usd
			acc.cny += r.cost.cny
			return acc
		}, { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, usd: 0, cny: 0 })
		const tokenTotal = totals.input + totals.output + totals.cacheRead + totals.cacheCreation

		lines.push('## AI 会话')
		lines.push('')
		lines.push(`共 ${sessions.length} 段 · Token ${fmtTokens(tokenTotal)}（cache 命中 ${fmtTokens(totals.cacheRead)}）· 成本 ${fmtCost(totals)}`)
		lines.push('')

		sessions.forEach((row, idx) => {
			const { session, file, tokens, cost, turns } = row
			const tool = (session?.tool || 'claude').toUpperCase()
			const startedAt = file?.started_at || session?.startedAt
			const endedAt = file?.ended_at || session?.completedAt
			const duration = startedAt && endedAt ? endedAt - startedAt : null
			const activeMs = file?.active_ms

			lines.push(`### 会话 ${idx + 1} · ${tool}`)
			const metaLine = [
				`起始 ${fmtDateTime(startedAt)}`,
				`时长 ${fmtDuration(duration)}`,
			]
			if (activeMs != null) metaLine.push(`活跃 ${fmtDuration(activeMs)}`)
			if (file?.primary_model) metaLine.push(`模型 \`${file.primary_model}\``)
			metaLine.push(`Token ${fmtTokens(tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation)}`)
			metaLine.push(`成本 ${fmtCost(cost)}`)
			lines.push(metaLine.join(' · '))
			lines.push('')

			if (session?.prompt) {
				lines.push('**触发 Prompt：**')
				lines.push('')
				lines.push('> ' + session.prompt.replace(/\n/g, '\n> '))
				lines.push('')
			}

			if (!file) {
				lines.push('_（未关联到 transcript 文件）_')
				lines.push('')
				return
			}

			if (turnsMode === 'none' || !turns) {
				if (file.first_user_prompt) {
					lines.push(`**首条用户消息：** ${file.first_user_prompt}`)
					lines.push('')
				}
				return
			}

			const picked = pickHighlightTurns(turns, turnLimit)
			if (turnsMode === 'summary') {
				lines.push('<details><summary>展开对话节选</summary>')
				lines.push('')
			}
			for (const t of picked) {
				if (t.role === 'separator') {
					lines.push(`*${t.content}*`)
					lines.push('')
					continue
				}
				const label = ROLE_LABEL[t.role] || t.role
				lines.push(`**【${label}】**`)
				lines.push('')
				const body = turnsMode === 'full' ? String(t.content || '') : summarizeTurnContent(t.content)
				lines.push(body)
				lines.push('')
			}
			if (turnsMode === 'summary') {
				lines.push('</details>')
				lines.push('')
			}
		})
	}

	lines.push('---')
	lines.push(`_生成于 ${fmtDateTime(report.generatedAt)} · quadtodo_`)
	return lines.join('\n')
}
