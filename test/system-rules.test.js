import { describe, it, expect } from 'vitest'
import { applySystemRules, getAskUserSystemRule } from '../src/system-rules.js'

describe('applySystemRules', () => {
  it('default: returns original prompt verbatim (trimmed)', () => {
    const out = applySystemRules('  任务: 修一个 bug  ')
    expect(out).toBe('任务: 修一个 bug')
    expect(out).not.toContain('ask_user MCP')
  })

  it('enforce=true: rule prepended with separator', () => {
    const out = applySystemRules('任务: 修一个 bug', { enforce: true })
    expect(out).toContain('ask_user MCP')        // rule 内容
    expect(out).toContain('---')                  // 分隔符
    expect(out).toContain('任务: 修一个 bug')      // 原文
    expect(out.indexOf('ask_user MCP')).toBeLessThan(out.indexOf('任务: 修一个 bug'))
  })

  it('enforce=false: returns original prompt verbatim (trimmed)', () => {
    const out = applySystemRules('  原始 prompt  ', { enforce: false })
    expect(out).toBe('原始 prompt')
    expect(out).not.toContain('ask_user MCP')
  })

  it('empty prompt + enforce=true → returns just the rule', () => {
    const out = applySystemRules('', { enforce: true })
    expect(out).toContain('ask_user MCP')
    expect(out).not.toContain('---')               // 没有 trailing separator
  })

  it('empty prompt + default enforce → returns empty string', () => {
    expect(applySystemRules('')).toBe('')
    expect(applySystemRules(null)).toBe('')
  })

  it('empty prompt + enforce=false → returns empty string', () => {
    expect(applySystemRules('', { enforce: false })).toBe('')
    expect(applySystemRules(null, { enforce: false })).toBe('')
  })

  it('rule mentions both ✅/✏️ and (a)/(b)/(c) anti-patterns', () => {
    const rule = getAskUserSystemRule()
    expect(rule).toContain('✅')
    expect(rule).toContain('✏️')
    expect(rule).toContain('(a)')
    expect(rule).toContain('ask_user')
    expect(rule).toContain('options')
  })
})
