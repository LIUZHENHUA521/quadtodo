import { describe, it, expect } from 'vitest'
import { redact } from '../src/wiki/redact.js'

describe('wiki/redact', () => {
  it('returns same string when nothing to redact', () => {
    expect(redact('hello world')).toBe('hello world')
  })

  it('redacts Anthropic/OpenAI sk- keys', () => {
    const out = redact('use sk-ant-api03-abcdefghij1234567890XYZ0 for auth')
    expect(out).not.toContain('sk-ant-api03-abcdefghij1234567890XYZ0')
    expect(out).toContain('[REDACTED]')
  })

  it('redacts AWS access key id', () => {
    expect(redact('AKIAIOSFODNN7EXAMPLE')).toContain('[REDACTED]')
  })

  it('redacts github personal token', () => {
    expect(redact('ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ01234567')).toContain('[REDACTED]')
  })

  it('redacts Google API key', () => {
    expect(redact('AIzaSyA-abcdefghijklmnopqrstuvwxyz12345')).toContain('[REDACTED]')
  })

  it('redacts env-style SECRET_KEY= line', () => {
    const out = redact('SECRET_KEY=super-secret-value-123')
    expect(out).toMatch(/SECRET_KEY\s*=\s*\[REDACTED\]/)
  })

  it('redacts api_key: "..." inline', () => {
    const out = redact('api_key: "abc123xyz789"')
    expect(out).not.toContain('abc123xyz789')
    expect(out).toContain('[REDACTED]')
  })

  it('does not redact ordinary text that happens to contain "key"', () => {
    expect(redact('the key to success is persistence')).toBe('the key to success is persistence')
  })

  it('handles non-string input safely', () => {
    expect(redact(null)).toBe('')
    expect(redact(undefined)).toBe('')
    expect(redact(42)).toBe('42')
  })
})
