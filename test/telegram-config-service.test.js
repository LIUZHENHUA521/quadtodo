import { describe, it, expect } from 'vitest'
import { maskBotToken, isMaskedToken, createProbeRegistry } from '../src/telegram-config-service.js'

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

describe('createProbeRegistry', () => {
  it('rejects start when probe already active', () => {
    const reg = createProbeRegistry({ now: () => 0 })
    expect(reg.startProbe(60).ok).toBe(true)
    expect(reg.startProbe(60).ok).toBe(false)
    expect(reg.startProbe(60).reason).toBe('already_active')
  })

  it('clamps duration to [10, 120] seconds', () => {
    const reg = createProbeRegistry({ now: () => 0 })
    const r1 = reg.startProbe(5)
    expect(r1.durationSec).toBe(10)
    reg.stopProbe()
    const r2 = reg.startProbe(999)
    expect(r2.durationSec).toBe(120)
  })

  it('isActive returns false after expiresAt', () => {
    let t = 0
    const reg = createProbeRegistry({ now: () => t })
    reg.startProbe(60)
    t = 30_000
    expect(reg.isActive()).toBe(true)
    t = 60_001
    expect(reg.isActive()).toBe(false)
  })

  it('record buffers hits while active and notifies subscribers', () => {
    let t = 0
    const reg = createProbeRegistry({ now: () => t })
    const seen = []
    reg.startProbe(60)
    const unsub = reg.subscribe((hit) => seen.push(hit))
    reg.record({ chatId: '-100123', chatTitle: 'g1', chatType: 'supergroup', fromUserId: '99', textPreview: 'hi' })
    expect(seen).toHaveLength(1)
    expect(seen[0].chatId).toBe('-100123')
    expect(reg.snapshot().hits).toHaveLength(1)
    unsub()
    reg.record({ chatId: '-100456', chatTitle: 'g2', chatType: 'supergroup', fromUserId: '99', textPreview: 'hi' })
    expect(seen).toHaveLength(1)
    expect(reg.snapshot().hits).toHaveLength(2)
  })

  it('record dropped when probe inactive', () => {
    const reg = createProbeRegistry({ now: () => 0 })
    reg.record({ chatId: '-100123' })
    expect(reg.snapshot().hits).toHaveLength(0)
  })

  it('stopProbe clears state', () => {
    const reg = createProbeRegistry({ now: () => 0 })
    reg.startProbe(60)
    reg.record({ chatId: '-100123', chatTitle: 'g', chatType: 'supergroup' })
    reg.stopProbe()
    expect(reg.isActive()).toBe(false)
    expect(reg.snapshot().hits).toHaveLength(0)
  })
})
