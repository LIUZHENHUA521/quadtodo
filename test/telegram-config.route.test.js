import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTelegramConfigRouter } from '../src/routes/telegram-config.js'
import { createProbeRegistry } from '../src/telegram-config-service.js'

// 隔离 HOME，避免 readBotTokenWithSource 读到本机 ~/.openclaw/openclaw.json 的真实 token
let originalHome
let tmpHome
beforeAll(() => {
  originalHome = process.env.HOME
  tmpHome = mkdtempSync(join(tmpdir(), 'qt-tg-cfg-'))
  process.env.HOME = tmpHome
})
afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  try { rmSync(tmpHome, { recursive: true, force: true }) } catch {}
})

function makeApp({ getConfig, getTelegramBot, probeRegistry = null, fetchFn }) {
  const app = express()
  app.use(express.json())
  app.use('/api/config/telegram', createTelegramConfigRouter({ getConfig, getTelegramBot, probeRegistry, fetchFn }))
  return app
}

describe('POST /api/config/telegram/test', () => {
  it('returns ok=false when no token', async () => {
    const app = makeApp({
      getConfig: () => ({ telegram: {} }),
      getTelegramBot: () => null,
    })
    const r = await request(app).post('/api/config/telegram/test').send({})
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: false, errorReason: 'token_missing' })
  })

  it('tests provided unsaved token without requiring a running bot', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, result: { id: 67890, username: 'draftBot', first_name: 'Draft' } }),
    }))
    const app = makeApp({
      getConfig: () => ({ telegram: {} }),
      getTelegramBot: () => null,
      fetchFn,
    })

    const r = await request(app).post('/api/config/telegram/test').send({ botToken: '123456:ABCDEF' })

    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, botId: 67890, botUsername: 'draftBot', source: 'input' })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchFn.mock.calls[0]
    expect(String(url)).toContain('/bot123456:ABCDEF/getMe')
    expect(opts).toMatchObject({ method: 'POST' })
  })

  it('does not treat masked token input as a real token', async () => {
    const fetchFn = vi.fn()
    const app = makeApp({
      getConfig: () => ({ telegram: {} }),
      getTelegramBot: () => null,
      fetchFn,
    })

    const r = await request(app).post('/api/config/telegram/test').send({ botToken: 'tg_***1234' })

    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: false, errorReason: 'token_missing', source: 'missing' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('calls getMe via getTelegramBot when bot exists', async () => {
    const fakeBot = { getMe: async () => ({ id: 12345, username: 'lzhTodoBot', first_name: 'lzh todo' }) }
    const app = makeApp({
      getConfig: () => ({ telegram: { botToken: 'XXX' } }),
      getTelegramBot: () => fakeBot,
    })
    const r = await request(app).post('/api/config/telegram/test').send({})
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, botId: 12345, botUsername: 'lzhTodoBot' })
  })

  it('returns errorReason when getMe throws', async () => {
    const fakeBot = { getMe: async () => { throw new Error('401 Unauthorized') } }
    const app = makeApp({
      getConfig: () => ({ telegram: { botToken: 'BAD' } }),
      getTelegramBot: () => fakeBot,
    })
    const r = await request(app).post('/api/config/telegram/test').send({})
    expect(r.body).toMatchObject({ ok: false, errorReason: '401 Unauthorized' })
  })
})

describe('POST /api/config/telegram/probe-chat-id', () => {
  it('starts probe and returns durationSec + expiresAt', async () => {
    const probeListeners = []
    const fakeBot = { setProbeListener: (fn) => probeListeners.push(fn) }
    const reg = createProbeRegistry({ now: () => 1000 })
    const app = makeApp({
      getConfig: () => ({ telegram: {} }),
      getTelegramBot: () => fakeBot,
      probeRegistry: reg,
    })
    const r = await request(app).post('/api/config/telegram/probe-chat-id').send({ durationSec: 60 })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, durationSec: 60 })
    expect(reg.isActive()).toBe(true)
    expect(probeListeners).toHaveLength(1)
  })

  it('returns conflict when probe already active', async () => {
    const reg = createProbeRegistry({ now: () => 1000 })
    reg.startProbe(60)
    const app = makeApp({
      getConfig: () => ({ telegram: {} }),
      getTelegramBot: () => ({ setProbeListener: () => {} }),
      probeRegistry: reg,
    })
    const r = await request(app).post('/api/config/telegram/probe-chat-id').send({ durationSec: 60 })
    expect(r.body).toMatchObject({ ok: false, reason: 'already_active' })
  })

  it('returns ok=false when bot not running', async () => {
    const reg = createProbeRegistry({ now: () => 1000 })
    const app = makeApp({
      getConfig: () => ({ telegram: { enabled: false } }),
      getTelegramBot: () => null,
      probeRegistry: reg,
    })
    const r = await request(app).post('/api/config/telegram/probe-chat-id').send({ durationSec: 60 })
    expect(r.body).toMatchObject({ ok: false, reason: 'bot_not_running' })
  })
})
