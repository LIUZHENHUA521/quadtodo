import { describe, it, expect } from 'vitest'
import {
  formatTokenCount,
  formatCost,
  extractTurnUsage,
  extractSessionUsageFromLines,
  formatUsageFooter,
  __test__,
} from '../src/usage-footer.js'

describe('formatTokenCount', () => {
  it('< 1000 returns plain integer', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(1)).toBe('1')
    expect(formatTokenCount(999)).toBe('999')
  })
  it('1000-9999 returns 1 decimal k', () => {
    expect(formatTokenCount(1000)).toBe('1.0k')
    expect(formatTokenCount(1234)).toBe('1.2k')
    expect(formatTokenCount(9999)).toBe('10.0k')
  })
  it('10000-999999 returns rounded k', () => {
    expect(formatTokenCount(12345)).toBe('12k')
    expect(formatTokenCount(99500)).toBe('100k')
    expect(formatTokenCount(500000)).toBe('500k')
  })
  it('≥ 1M returns M with 2 decimals', () => {
    expect(formatTokenCount(1_000_000)).toBe('1.00M')
    expect(formatTokenCount(1_234_567)).toBe('1.23M')
    expect(formatTokenCount(50_000_000)).toBe('50.00M')
  })
  it('handles bad inputs gracefully', () => {
    expect(formatTokenCount(null)).toBe('0')
    expect(formatTokenCount(undefined)).toBe('0')
    expect(formatTokenCount(-100)).toBe('0')
    expect(formatTokenCount('1234')).toBe('1.2k')
  })
})

describe('formatMoney (internal)', () => {
  const { formatMoney } = __test__
  it('< 0.001 → "<$0.001"', () => {
    expect(formatMoney(0, '$')).toBe('<$0.001')
    expect(formatMoney(0.0001, '$')).toBe('<$0.001')
  })
  it('0.001..0.01 → 4 decimals', () => {
    expect(formatMoney(0.0042, '$')).toBe('$0.0042')
    expect(formatMoney(0.0099, '$')).toBe('$0.0099')
  })
  it('0.01..1 → 3 decimals', () => {
    expect(formatMoney(0.123, '$')).toBe('$0.123')
    expect(formatMoney(0.999, '$')).toBe('$0.999')
  })
  it('≥ 1 → 2 decimals', () => {
    expect(formatMoney(3.456, '$')).toBe('$3.46')
    expect(formatMoney(1234.5, '$')).toBe('$1234.50')
  })
  it('uses provided symbol (¥)', () => {
    expect(formatMoney(0.5, '¥')).toBe('¥0.500')
  })
})

describe('formatCost', () => {
  it('shows both USD and CNY by default', () => {
    // 0.012 命中 0.01..1 区间 → 3 位小数 → "$0.012"；¥0.086 同理
    expect(formatCost({ usd: 0.012, cny: 0.086 })).toBe('$0.012 (¥0.086)')
  })
  it('omits CNY when showCny=false', () => {
    expect(formatCost({ usd: 0.012, cny: 0.086, showCny: false })).toBe('$0.012')
  })
  it('handles 0 with "<$0.001"', () => {
    expect(formatCost({ usd: 0, cny: 0 })).toBe('<$0.001 (<¥0.001)')
  })
})

describe('extractTurnUsage', () => {
  it('parses raw.message.usage', () => {
    const raw = {
      message: {
        usage: {
          input_tokens: 1234,
          output_tokens: 567,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 100,
        },
        model: 'claude-sonnet-4-20260101',
      },
    }
    expect(extractTurnUsage(raw)).toEqual({
      input: 1234, output: 567, cacheRead: 800, cacheCreation: 100,
      model: 'claude-sonnet-4-20260101',
    })
  })

  it('returns null when raw missing', () => {
    expect(extractTurnUsage(null)).toBeNull()
    expect(extractTurnUsage({})).toBeNull()
    expect(extractTurnUsage({ message: {} })).toBeNull()
  })

  it('coerces missing usage fields to 0', () => {
    const raw = { message: { usage: { input_tokens: 100 } } }
    const u = extractTurnUsage(raw)
    expect(u).toMatchObject({ input: 100, output: 0, cacheRead: 0, cacheCreation: 0, model: null })
  })
})

describe('extractSessionUsageFromLines', () => {
  function mkAssistantLine(usage, model = 'claude-sonnet-4-20260101', ts = '2026-05-01T00:00:00Z') {
    return JSON.stringify({
      type: 'assistant',
      timestamp: ts,
      message: { role: 'assistant', usage, model },
    })
  }

  it('sums tokens across multiple assistant messages', () => {
    const lines = [
      mkAssistantLine({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200, cache_creation_input_tokens: 30 }),
      mkAssistantLine({ input_tokens: 200, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 50 }),
      JSON.stringify({ type: 'user', message: { role: 'user' } }),   // 不算
    ]
    const s = extractSessionUsageFromLines(lines)
    expect(s.input).toBe(300)
    expect(s.output).toBe(130)
    expect(s.cacheRead).toBe(200)
    expect(s.cacheCreation).toBe(80)
    expect(s.turnCount).toBe(2)
    expect(s.primaryModel).toBe('claude-sonnet-4')   // 日期后缀已被 normalizeModel 剥掉
  })

  it('empty lines → all zeros, turnCount=0', () => {
    const s = extractSessionUsageFromLines([])
    expect(s.input).toBe(0)
    expect(s.output).toBe(0)
    expect(s.turnCount).toBe(0)
  })

  it('ignores malformed json lines', () => {
    const lines = [
      'not-json',
      mkAssistantLine({ input_tokens: 100, output_tokens: 50 }),
      '{broken',
    ]
    const s = extractSessionUsageFromLines(lines)
    expect(s.input).toBe(100)
    expect(s.turnCount).toBe(1)
  })
})

describe('formatUsageFooter', () => {
  const sampleTurn = {
    input: 1234, output: 350, cacheRead: 800, cacheCreation: 200,
    model: 'claude-sonnet-4-20260101',
  }
  const sampleSession = {
    input: 50000, output: 12000, cacheRead: 30000, cacheCreation: 5000,
    primaryModel: 'claude-sonnet-4', turnCount: 12,
  }

  it('renders both lines with divider when both turn + session present', () => {
    const out = formatUsageFooter({ turn: sampleTurn, session: sampleSession })
    expect(out).toContain('💸')
    expect(out).toContain('turn:')
    expect(out).toContain('session:')
    expect(out).toContain('in 1.2k')
    expect(out).toContain('out 350')
    expect(out).toContain('cache 1.0k')   // 800+200=1000
    expect(out).toContain('12 turns')
    expect(out).toContain('$')
    expect(out).toContain('¥')          // showCny default true
    expect(out.split('\n')).toHaveLength(3)   // divider + 2 lines
  })

  it('skips ¥ when showCny=false', () => {
    const out = formatUsageFooter({ turn: sampleTurn, session: sampleSession, showCny: false })
    expect(out).not.toContain('¥')
    expect(out).toContain('$')
  })

  it('skips turn line when all turn tokens are 0', () => {
    const out = formatUsageFooter({
      turn: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      session: sampleSession,
    })
    expect(out).not.toContain('turn:')
    expect(out).toContain('session:')
  })

  it('skips session line when all session tokens are 0', () => {
    const out = formatUsageFooter({
      turn: sampleTurn,
      session: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, turnCount: 0 },
    })
    expect(out).toContain('turn:')
    expect(out).not.toContain('session:')
  })

  it('returns empty string when both turn + session empty/null', () => {
    expect(formatUsageFooter({})).toBe('')
    expect(formatUsageFooter({ turn: null, session: null })).toBe('')
    expect(formatUsageFooter({
      turn: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      session: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    })).toBe('')
  })

  it('omits cache fragment when both cache values are 0', () => {
    const turn = { input: 100, output: 50, cacheRead: 0, cacheCreation: 0, model: 'claude-sonnet-4' }
    const out = formatUsageFooter({ turn })
    expect(out).toContain('in 100')
    expect(out).toContain('out 50')
    expect(out).not.toContain('cache')
  })

  it('omits turnCount tag when turnCount=0', () => {
    const session = { input: 100, output: 50, cacheRead: 0, cacheCreation: 0, primaryModel: 'claude-sonnet-4', turnCount: 0 }
    const out = formatUsageFooter({ session })
    expect(out).toContain('session:')
    expect(out).not.toContain('turns')
  })

  it('uses opus pricing when model matches claude-opus-4-*', () => {
    // opus is more expensive than sonnet → cost 应该更高
    const sonnetOut = formatUsageFooter({
      turn: { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0, model: 'claude-sonnet-4' },
      showCny: false,
    })
    const opusOut = formatUsageFooter({
      turn: { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0, model: 'claude-opus-4' },
      showCny: false,
    })
    // sonnet input = $3/M, opus input = $15/M
    expect(sonnetOut).toContain('$3.00')
    expect(opusOut).toContain('$15.00')
  })

  it('falls back to default pricing when model is null/unknown', () => {
    const out = formatUsageFooter({
      turn: { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0, model: null },
      showCny: false,
    })
    expect(out).toContain('$3.00')   // DEFAULT_PRICING.default.input = 3
  })

  it('honors custom pricing override', () => {
    const out = formatUsageFooter({
      turn: { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0, model: null },
      showCny: false,
      pricing: { default: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, models: {}, cnyRate: 7 },
    })
    expect(out).toContain('$1.00')
  })
})
