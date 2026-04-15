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
    const c = estimateCost({ input: 2_000_000, output: 0, cacheRead: 0, cacheCreation: 0 }, 'gpt-5-codex', pricing)
    expect(c.usd).toBeCloseTo(pricing.default.input * 2, 2)
  })

  it('null model 也回落 default', () => {
    const c = estimateCost({ input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 }, null, pricing)
    expect(c.usd).toBeCloseTo(pricing.default.input, 2)
  })
})
