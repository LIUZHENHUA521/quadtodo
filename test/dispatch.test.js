import { describe, it, expect } from 'vitest'
import { resolveTool } from '../src/dispatch.js'

const cfg = {
  defaultTool: 'claude',
  dispatch: {
    lark: { default: 'claude', perUser: { 'lark_user_a': 'codex' } },
    telegram: { default: 'codex', perChat: { '12345': 'claude' } },
    web: { default: 'claude' },
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

  it('global defaultTool when no dispatch entry', () => {
    expect(resolveTool({ channel: 'unknown' }, cfg)).toBe('claude')
  })

  it('falls back to "claude" when defaultTool missing', () => {
    expect(resolveTool({ channel: 'web' }, {})).toBe('claude')
  })

  it('back-compat: missing dispatch section → defaultTool', () => {
    expect(resolveTool({ channel: 'lark' }, { defaultTool: 'codex' })).toBe('codex')
  })
})
