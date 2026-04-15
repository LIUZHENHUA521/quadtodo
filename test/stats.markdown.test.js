import { describe, it, expect } from 'vitest'
import { renderMarkdown } from '../src/stats/markdown.js'

const sampleReport = {
	range: { since: Date.parse('2026-04-08T00:00:00Z'), until: Date.parse('2026-04-15T00:00:00Z'), label: '本周' },
	summary: {
		wallClockMs: 12.1 * 3600_000,
		activeMs: 8.3 * 3600_000,
		tokens: { input: 4_000_000, output: 1_000_000, cacheRead: 8_100_000, cacheCreation: 100_000, total: 13_200_000 },
		cost: { usd: 23.7, cny: 170.6 },
		sessionCount: 47, todoCount: 12, unboundSessionCount: 3,
	},
	topTodos: [
		{ todoId: 'a', title: '修复 bug', quadrant: 1, activeMs: 2.1 * 3600_000, wallClockMs: 3 * 3600_000, tokens: { input: 500000, output: 120000, cacheRead: 0, cacheCreation: 0 }, cost: { usd: 4.2, cny: 30 }, sessionCount: 6, primaryModel: 'claude-sonnet-4-6' },
	],
	byModel: [
		{ key: 'claude-opus-4-6', sessions: 18, tokens: { input: 2_000_000, output: 500_000, cacheRead: 0, cacheCreation: 0 }, cost: { usd: 12.1, cny: 87 } },
		{ key: 'claude-sonnet-4-6', sessions: 29, tokens: { input: 2_000_000, output: 500_000, cacheRead: 0, cacheCreation: 0 }, cost: { usd: 11.6, cny: 83 } },
	],
}

describe('renderMarkdown', () => {
	it('snapshot', () => {
		expect(renderMarkdown(sampleReport)).toMatchSnapshot()
	})

	it('包含关键信息', () => {
		const md = renderMarkdown(sampleReport)
		expect(md).toContain('# quadtodo 周报')
		expect(md).toContain('活跃 8.3h')
		expect(md).toContain('12.1h')
		expect(md).toContain('修复 bug')
		expect(md).toContain('claude-opus-4-6')
		expect(md).toContain('其中 3 场未关联任务')
	})
})
