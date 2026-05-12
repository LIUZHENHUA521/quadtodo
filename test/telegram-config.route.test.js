import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createTelegramConfigRouter } from '../src/routes/telegram-config.js'
import { createProbeRegistry } from '../src/telegram-config-service.js'
import * as telegramBot from '../src/telegram-bot.js'

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

  it('tests saved token even when the long-poll bot is not running', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, result: { id: 24680, username: 'savedBot', first_name: 'Saved' } }),
    }))
    const app = makeApp({
      getConfig: () => ({ telegram: { botToken: 'SAVED_TOKEN' } }),
      getTelegramBot: () => null,
      fetchFn,
    })

    const r = await request(app).post('/api/config/telegram/test').send({})

    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, botId: 24680, botUsername: 'savedBot', source: 'agentquad' })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url] = fetchFn.mock.calls[0]
    expect(String(url)).toContain('/botSAVED_TOKEN/getMe')
  })

  it('tests saved token directly when bot exists', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, result: { id: 12345, username: 'lzhTodoBot', first_name: 'lzh todo' } }),
    }))
    const fakeBot = { getMe: vi.fn() }
    const app = makeApp({
      getConfig: () => ({ telegram: { botToken: 'XXX' } }),
      getTelegramBot: () => fakeBot,
      fetchFn,
    })
    const r = await request(app).post('/api/config/telegram/test').send({})
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, botId: 12345, botUsername: 'lzhTodoBot' })
    expect(fakeBot.getMe).not.toHaveBeenCalled()
  })

  it('returns errorReason when saved token getMe fails', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ ok: false, description: '401 Unauthorized' }),
    }))
    const app = makeApp({
      getConfig: () => ({ telegram: { botToken: 'BAD' } }),
      getTelegramBot: () => null,
      fetchFn,
    })
    const r = await request(app).post('/api/config/telegram/test').send({})
    expect(r.body).toMatchObject({ ok: false, errorReason: '401 Unauthorized' })
  })

  // 回归：之前默认走 Node 全局 fetch，导致国内/受限网络环境下用户在设置页点测试
  // 一直看到 "fetch failed"。getProxyFetch() 会读 HTTPS_PROXY，跟真实 bot 一致。
  it('uses proxy-aware fetch (telegramBot.getProxyFetch) when no fetchFn is injected', async () => {
    const proxyFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, result: { id: 99, username: 'proxyBot', first_name: 'Proxy' } }),
    }))
    const spy = vi.spyOn(telegramBot, 'getProxyFetch').mockResolvedValue(proxyFetch)
    try {
      const app = makeApp({
        getConfig: () => ({ telegram: { botToken: 'SAVED' } }),
        getTelegramBot: () => null,
        // 注意：故意不传 fetchFn
      })
      const r = await request(app).post('/api/config/telegram/test').send({})
      expect(r.body).toMatchObject({ ok: true, botId: 99, botUsername: 'proxyBot', source: 'agentquad' })
      expect(spy).toHaveBeenCalled()
      expect(proxyFetch).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })

  // 回归：Node fetch 失败时 e.message 只有光秃秃的 "fetch failed"，
  // 真正有用的网络原因藏在 e.cause.message。前端不能光看 "fetch failed" 没法排查。
  it('surfaces underlying cause when fetch throws TypeError: fetch failed', async () => {
    const fetchFn = vi.fn(async () => {
      const err = new TypeError('fetch failed')
      err.cause = new Error('Connect Timeout Error (attempted addresses: 1.2.3.4:443, timeout: 10000ms)')
      throw err
    })
    const app = makeApp({
      getConfig: () => ({ telegram: { botToken: 'X' } }),
      getTelegramBot: () => null,
      fetchFn,
    })
    const r = await request(app).post('/api/config/telegram/test').send({})
    expect(r.body.ok).toBe(false)
    expect(r.body.errorReason).toContain('fetch failed')
    expect(r.body.errorReason).toContain('Connect Timeout')
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
