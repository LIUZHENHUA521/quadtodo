import { describe, it, expect } from 'vitest'
import { estimateCost, DEFAULT_PRICING } from '../src/pricing.js'

describe('estimateCost', () => {
	const pricing = DEFAULT_PRICING

	it('sonnet 按 glob 命中', () => {
		const c = estimateCost(
			{ input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreation: 0 },
			'claude-sonnet-4-6',
			pricing,
		)
		expect(c.usd).toBeCloseTo(3 + 15, 2)
		expect(c.cny).toBeCloseTo((3 + 15) * pricing.cnyRate, 2)
	})

	it('opus 按 glob 命中', () => {
		const c = estimateCost(
			{ input: 0, output: 1_000_000, cacheRead: 0, cacheCreation: 0 },
			'claude-opus-4-6',
			pricing,
		)
		expect(c.usd).toBeCloseTo(75, 2)
	})

	it('未知模型回落 default', () => {
		const c = estimateCost({ input: 2_000_000, output: 0, cacheRead: 0, cacheCreation: 0 }, 'mistral-large-2411', pricing)
		expect(c.usd).toBeCloseTo(pricing.default.input * 2, 2)
	})

	it('gpt-5-codex 命中 gpt-5* 而不是 default', () => {
		const rate = pricing.models['gpt-5*']
		expect(rate).toBeDefined()
		const c = estimateCost(
			{ input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreation: 0 },
			'gpt-5-codex',
			pricing,
		)
		expect(c.usd).toBeCloseTo(rate.input + rate.output, 2)
		// 不应等于 default (input 3 + output 15 = 18)；除非 GPT 价表碰巧一致才需重测
		if (rate.input !== pricing.default.input || rate.output !== pricing.default.output) {
			expect(c.usd).not.toBeCloseTo(pricing.default.input + pricing.default.output, 2)
		}
	})

	it('gpt-4.1-mini 命中 gpt-4.1*', () => {
		const rate = pricing.models['gpt-4.1*']
		expect(rate).toBeDefined()
		const c = estimateCost(
			{ input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 },
			'gpt-4.1-mini',
			pricing,
		)
		expect(c.usd).toBeCloseTo(rate.input, 2)
	})

	it('gpt-4o-mini 命中 gpt-4o-mini* 而不是 gpt-4o*（顺序敏感）', () => {
		const miniRate = pricing.models['gpt-4o-mini*']
		const fullRate = pricing.models['gpt-4o*']
		expect(miniRate).toBeDefined()
		expect(fullRate).toBeDefined()
		const c = estimateCost(
			{ input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 },
			'gpt-4o-mini',
			pricing,
		)
		expect(c.usd).toBeCloseTo(miniRate.input, 4)
		// mini 必须比完整 4o 便宜，否则配置一定写反了
		expect(miniRate.input).toBeLessThan(fullRate.input)
	})

	it('null model 也回落 default', () => {
		const c = estimateCost({ input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 }, null, pricing)
		expect(c.usd).toBeCloseTo(pricing.default.input, 2)
	})

	it('cacheRead + cacheCreation 计价生效', () => {
		const c = estimateCost(
			{ input: 0, output: 0, cacheRead: 1_000_000, cacheCreation: 1_000_000 },
			'claude-sonnet-4-6',
			pricing,
		)
		// sonnet: cacheRead = 0.30, cacheWrite = 3.75
		expect(c.usd).toBeCloseTo(0.30 + 3.75, 2)
		expect(c.cny).toBeCloseTo((0.30 + 3.75) * pricing.cnyRate, 2)
	})

	it('pricing.cnyRate 覆盖生效', () => {
		const custom = {
			...DEFAULT_PRICING,
			default: { ...DEFAULT_PRICING.default },
			models: { ...DEFAULT_PRICING.models },
			cnyRate: 7.5,
		}
		const c = estimateCost(
			{ input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 },
			'claude-sonnet-4-6',
			custom,
		)
		expect(c.usd).toBeCloseTo(3, 2)
		expect(c.cny).toBeCloseTo(3 * 7.5, 2)
	})
})
