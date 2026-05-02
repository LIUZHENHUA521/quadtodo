import { describe, it, expect } from 'vitest'
import { maskBotToken, isMaskedToken } from '../src/telegram-config-service.js'

describe('maskBotToken', () => {
  it('returns null for null/empty', () => {
    expect(maskBotToken(null)).toBeNull()
    expect(maskBotToken('')).toBeNull()
    expect(maskBotToken(undefined)).toBeNull()
  })

  it('masks token keeping last 4 chars', () => {
    expect(maskBotToken('7846123456:AAH9xK_abcdefg1234')).toBe('tg_***1234')
  })

  it('handles short token gracefully', () => {
    expect(maskBotToken('abc')).toBe('tg_***abc')
  })
})

describe('isMaskedToken', () => {
  it('detects mask format', () => {
    expect(isMaskedToken('tg_***1234')).toBe(true)
    expect(isMaskedToken('tg_***ab')).toBe(true)
    expect(isMaskedToken('7846123456:AAH9xK_abc')).toBe(false)
    expect(isMaskedToken('')).toBe(false)
    expect(isMaskedToken(null)).toBe(false)
  })
})
