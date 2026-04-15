import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from '../src/server.js'

function mkServer() {
	const root = mkdtempSync(join(tmpdir(), 'qt-'))
	return createServer({
		dbFile: ':memory:',
		logDir: root,
		configRootDir: root,
		tools: {
			claude: { bin: 'claude', command: 'claude', args: [] },
			codex: { bin: 'codex', command: 'codex', args: [] },
		},
	})
}

describe('GET /api/stats/report', () => {
	it('返回 summary + topTodos + byTool', async () => {
		const srv = mkServer()
		const res = await request(srv.app).get('/api/stats/report?since=0&until=9999999999999')
		expect(res.status).toBe(200)
		expect(res.body.ok).toBe(true)
		expect(res.body.report).toHaveProperty('summary')
		expect(res.body.report).toHaveProperty('topTodos')
		expect(res.body.report).toHaveProperty('byTool')
		expect(res.body.report).toHaveProperty('byModel')
		expect(res.body.report).toHaveProperty('timeline')
		await srv.close()
	})

	it('.md 端点返回 Markdown', async () => {
		const srv = mkServer()
		const res = await request(srv.app).get('/api/stats/report.md?since=0&until=9999999999999')
		expect(res.status).toBe(200)
		expect(res.headers['content-type']).toMatch(/text\/markdown/)
		expect(res.text).toMatch(/# quadtodo/)
		await srv.close()
	})

	it('400 若 since/until 非法', async () => {
		const srv = mkServer()
		const res = await request(srv.app).get('/api/stats/report?since=abc&until=xyz')
		expect(res.status).toBe(400)
		await srv.close()
	})
})
