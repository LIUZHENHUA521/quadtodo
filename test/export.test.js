import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import express from 'express'
import request from 'supertest'
import { openDb } from '../src/db.js'
import { createTodosRouter } from '../src/routes/todos.js'
import { buildTodoExport, renderTodoMarkdown } from '../src/export/todoMarkdown.js'

function mkTmp() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'qt-export-'))
}

function writeClaudeFile(dir, cwd, uuid) {
	const encoded = cwd.replace(/\//g, '-')
	const projDir = path.join(dir, encoded)
	fs.mkdirSync(projDir, { recursive: true })
	const filePath = path.join(projDir, `${uuid}.jsonl`)
	const lines = [
		{ type: 'user', sessionId: uuid, cwd, timestamp: '2026-04-14T10:00:00.000Z', message: { role: 'user', content: '帮我修一下 login 的 bug' } },
		{ type: 'assistant', sessionId: uuid, cwd, timestamp: '2026-04-14T10:00:30.000Z', message: { role: 'assistant', content: '我来看看，问题在 handleLogin 里。' } },
	]
	fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
	return filePath
}

function seedBoundTranscript(db, todoId, { tool = 'claude', nativeId, jsonlPath, startedAt = 1_700_000_000_000, endedAt = 1_700_000_060_000 }) {
	return db.upsertTranscriptFile({
		tool,
		nativeId,
		cwd: '/tmp/proj',
		jsonlPath,
		size: fs.statSync(jsonlPath).size,
		mtime: Date.now(),
		startedAt,
		endedAt,
		firstUserPrompt: '帮我修一下 login 的 bug',
		turnCount: 2,
		inputTokens: 1200,
		outputTokens: 450,
		cacheReadTokens: 5000,
		cacheCreationTokens: 0,
		primaryModel: 'claude-sonnet-4-6',
		activeMs: 60_000,
		boundTodoId: todoId,
	})
}

describe('buildTodoExport', () => {
	let db
	beforeEach(() => { db = openDb(':memory:') })

	it('returns null for missing todo', async () => {
		const r = await buildTodoExport(db, 'nope')
		expect(r).toBeNull()
	})

	it('aggregates todo + comments (no sessions)', async () => {
		const t = db.createTodo({ title: '写周报', description: '本周做了 A B C', quadrant: 2 })
		db.addComment(t.id, '先列提纲')
		db.addComment(t.id, '明天继续')
		const r = await buildTodoExport(db, t.id, { turns: 'none' })
		expect(r.todo.title).toBe('写周报')
		expect(r.comments).toHaveLength(2)
		expect(r.sessions).toHaveLength(0)

		const md = renderTodoMarkdown(r)
		expect(md).toContain('# 写周报')
		expect(md).toContain('## 描述')
		expect(md).toContain('本周做了 A B C')
		expect(md).toContain('## 评论时间线')
		expect(md).toContain('先列提纲')
		expect(md).not.toContain('## AI 会话')
	})

	it('aggregates sessions with tokens + cost and renders summary turns', async () => {
		const tmp = mkTmp()
		try {
			const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
			const fp = writeClaudeFile(tmp, '/tmp/proj', uuid)

			const t = db.createTodo({
				title: '修 login bug',
				quadrant: 1,
				aiSessions: [{
					sessionId: 's1',
					tool: 'claude',
					nativeSessionId: uuid,
					status: 'done',
					startedAt: 1_700_000_000_000,
					completedAt: 1_700_000_060_000,
					prompt: '修 login bug',
				}],
			})
			seedBoundTranscript(db, t.id, { nativeId: uuid, jsonlPath: fp })

			const r = await buildTodoExport(db, t.id, { turns: 'summary', turnLimit: 20 })
			expect(r.sessions).toHaveLength(1)
			const s = r.sessions[0]
			expect(s.file).toBeTruthy()
			expect(s.tokens.input).toBe(1200)
			expect(s.tokens.cacheRead).toBe(5000)
			expect(s.cost.usd).toBeGreaterThan(0)
			expect(Array.isArray(s.turns)).toBe(true)
			expect(s.turns.length).toBeGreaterThan(0)

			const md = renderTodoMarkdown(r)
			expect(md).toContain('## AI 会话')
			expect(md).toContain('CLAUDE')
			expect(md).toContain('claude-sonnet-4-6')
			expect(md).toContain('<details>')
			expect(md).toContain('【用户】')
			expect(md).toContain('handleLogin')
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true })
		}
	})

	it('turns=none omits transcript body but keeps session meta', async () => {
		const tmp = mkTmp()
		try {
			const uuid = 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee'
			const fp = writeClaudeFile(tmp, '/tmp/proj', uuid)
			const t = db.createTodo({
				title: 'A',
				quadrant: 1,
				aiSessions: [{ sessionId: 's1', tool: 'claude', nativeSessionId: uuid, status: 'done', startedAt: 1, completedAt: 2, prompt: 'p' }],
			})
			seedBoundTranscript(db, t.id, { nativeId: uuid, jsonlPath: fp })

			const r = await buildTodoExport(db, t.id, { turns: 'none' })
			expect(r.sessions[0].turns).toBeNull()
			const md = renderTodoMarkdown(r)
			expect(md).toContain('## AI 会话')
			expect(md).not.toContain('<details>')
			expect(md).not.toContain('【用户】')
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true })
		}
	})

	it('session without transcript row shows 未关联 hint', async () => {
		const t = db.createTodo({
			title: 'A',
			quadrant: 1,
			aiSessions: [{ sessionId: 's1', tool: 'claude', nativeSessionId: null, status: 'done', startedAt: 1, completedAt: 2, prompt: 'p' }],
		})
		const r = await buildTodoExport(db, t.id, { turns: 'summary' })
		expect(r.sessions[0].file).toBeNull()
		const md = renderTodoMarkdown(r)
		expect(md).toContain('未关联到 transcript')
	})
})

describe('routes/todos export endpoints', () => {
	let app, db
	beforeEach(() => {
		db = openDb(':memory:')
		app = express()
		app.use(express.json())
		app.use('/api/todos', createTodosRouter({ db }))
	})

	it('GET /:id/export.md returns markdown for existing todo', async () => {
		const t = db.createTodo({ title: '周报导出', quadrant: 2, description: '做了 X' })
		const res = await request(app).get(`/api/todos/${t.id}/export.md?turns=none`)
		expect(res.status).toBe(200)
		expect(res.headers['content-type']).toMatch(/text\/markdown/)
		expect(res.text).toContain('# 周报导出')
		expect(res.text).toContain('做了 X')
	})

	it('GET /:id/export.md returns 404 for unknown id', async () => {
		const res = await request(app).get('/api/todos/nope/export.md')
		expect(res.status).toBe(404)
	})

	it('GET /:id/export.json returns markdown string', async () => {
		const t = db.createTodo({ title: 'A', quadrant: 1 })
		const res = await request(app).get(`/api/todos/${t.id}/export.json?turns=none`)
		expect(res.status).toBe(200)
		expect(res.body.ok).toBe(true)
		expect(res.body.markdown).toContain('# A')
		expect(res.body.todo.id).toBe(t.id)
	})
})
