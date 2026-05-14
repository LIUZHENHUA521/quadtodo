import { describe, it, expect } from 'vitest'
import { resolveTool } from '../src/dispatch.js'

const cfg = {
  dispatch: {
    lark: { default: 'claude', perUser: { 'lark_user_a': 'codex' } },
    telegram: { default: 'codex', perChat: { '12345': 'claude' } },
  },
}

describe('resolveTool', () => {
  it('returns override when provided', () => {
    expect(resolveTool({ channel: 'lark', userId: 'lark_user_a', override: 'claude' }, cfg)).toBe('claude')
  })

  it('perUser hits before channel default (lark)', () => {
    expect(resolveTool({ channel: 'lark', userId: 'lark_user_a' }, cfg)).toBe('codex')
  })

  it('channel default when perUser miss', () => {
    expect(resolveTool({ channel: 'lark', userId: 'lark_user_b' }, cfg)).toBe('claude')
  })

  it('perChat hits (telegram)', () => {
    expect(resolveTool({ channel: 'telegram', chatId: '12345' }, cfg)).toBe('claude')
  })

  it('unknown channel falls back to "claude"', () => {
    expect(resolveTool({ channel: 'openclaw' }, cfg)).toBe('claude')
  })

  it('falls back to "claude" when dispatch missing', () => {
    expect(resolveTool({ channel: 'lark' }, {})).toBe('claude')
  })
})
