import { afterEach, describe, expect, it, vi } from 'vitest'
import { testTelegram } from '../web/src/api.ts'

describe('testTelegram', () => {
  const realFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('sends a provided unsaved token for one-off testing', async () => {
    globalThis.fetch = vi.fn(async () => ({
      json: async () => ({ ok: true, source: 'input', botId: 123 }),
    }))

    const result = await testTelegram({ botToken: '123456:ABCDEF' })

    expect(result).toMatchObject({ ok: true, source: 'input', botId: 123 })
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/config/telegram/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botToken: '123456:ABCDEF' }),
    })
  })
})
