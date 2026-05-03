import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { createOpenClawBridge, __test__ as bridgeInternal } from '../src/openclaw-bridge.js'

function makeFakeProc({ exitCode = 0, stdout = '', stderr = '', errorAfterMs = null } = {}) {
  const proc = new EventEmitter()
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = vi.fn()
  setImmediate(() => {
    if (errorAfterMs != null) {
      setTimeout(() => proc.emit('error', new Error('boom')), errorAfterMs)
      return
    }
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout))
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr))
    setImmediate(() => proc.emit('close', exitCode))
  })
  return proc
}

function makeBridge({ openclaw, spawnImpl }) {
  return createOpenClawBridge({
    getConfig: () => ({ openclaw }),
    spawnFn: spawnImpl,
    logger: { warn() {}, info() {} },
  })
}

describe('openclaw-bridge.postText', () => {
  let calls = []
  beforeEach(() => { calls = [] })

  function spy(opts) {
    return (bin, args, options) => {
      calls.push({ bin, args, options })
      return makeFakeProc(opts || {})
    }
  }

  it('returns disabled when config.enabled=false', async () => {
    const bridge = makeBridge({
      openclaw: { enabled: false, targetUserId: 'u1' },
      spawnImpl: spy({ stdout: '{}' }),
    })
    const r = await bridge.postText({ message: 'hi' })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('disabled')
    expect(calls).toHaveLength(0)
  })

  it('returns misconfigured when targetUserId missing', async () => {
    const bridge = makeBridge({
      openclaw: { enabled: true, targetUserId: '' },
      spawnImpl: spy({ stdout: '{}' }),
    })
    const r = await bridge.postText({ message: 'hi' })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('misconfigured')
  })

  it('shells out to openclaw message send with correct args', async () => {
    const bridge = makeBridge({
      openclaw: { enabled: true, targetUserId: 'peer-x@im.wechat', channel: 'openclaw-weixin' },
      spawnImpl: spy({ stdout: '{"ok":1}' }),
    })
    const r = await bridge.postText({ message: 'hello' })
    expect(r.ok).toBe(true)
    expect(r.payload).toEqual({ ok: 1 })
    expect(calls).toHaveLength(1)
    expect(calls[0].bin).toBe('openclaw')
    const args = calls[0].args
    expect(args).toContain('message')
    expect(args).toContain('send')
    expect(args).toContain('--channel')
    expect(args).toContain('openclaw-weixin')
    expect(args).toContain('--target')
    expect(args).toContain('peer-x@im.wechat')
    expect(args).toContain('--message')
    expect(args).toContain('hello')
    expect(args).toContain('--json')
  })

  it('respects rate limit', async () => {
    const bridge = makeBridge({
      openclaw: {
        enabled: true,
        targetUserId: 'peer-x',
        askUser: { rateLimitPerMin: 2 },
      },
      spawnImpl: spy({ stdout: '{}' }),
    })
    const r1 = await bridge.postText({ message: 'a' })
    const r2 = await bridge.postText({ message: 'b' })
    const r3 = await bridge.postText({ message: 'c' })
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    expect(r3.ok).toBe(false)
    expect(r3.reason).toBe('rate_limited')
  })

  it('returns cli_failed on non-zero exit', async () => {
    const bridge = makeBridge({
      openclaw: { enabled: true, targetUserId: 'peer-x' },
      spawnImpl: spy({ exitCode: 2, stderr: 'auth fail' }),
    })
    const r = await bridge.postText({ message: 'hi' })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('cli_failed')
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toContain('auth fail')
  })

  it('uses session route when sessionId provided', async () => {
    const bridge = makeBridge({
      openclaw: { enabled: true, targetUserId: 'config-default@im.wechat' },
      spawnImpl: spy({ stdout: '{}' }),
    })
    bridge.registerSessionRoute('s-1', { targetUserId: 'session-target@im.wechat', account: 'acc-1' })
    await bridge.postText({ sessionId: 's-1', message: 'hi' })
    const args = calls[0].args
    expect(args).toContain('session-target@im.wechat')
    expect(args).toContain('--account')
    expect(args).toContain('acc-1')
    // and not the config default
    expect(args).not.toContain('config-default@im.wechat')
  })

  it('falls back to config target when no session route', async () => {
    const bridge = makeBridge({
      openclaw: { enabled: true, targetUserId: 'config-default@im.wechat' },
      spawnImpl: spy({ stdout: '{}' }),
    })
    await bridge.postText({ sessionId: 's-unknown', message: 'hi' })
    const args = calls[0].args
    expect(args).toContain('config-default@im.wechat')
  })

  it('auto-appends @im.wechat suffix when target lacks it (openclaw-weixin)', async () => {
    const bridge = makeBridge({
      openclaw: { enabled: true, targetUserId: 'o9cq80wQ', channel: 'openclaw-weixin' },
      spawnImpl: spy({ stdout: '{"ok":1}' }),
    })
    const r = await bridge.postText({ message: 'hi' })
    expect(r.ok).toBe(true)
    const args = calls[0].args
    const tIdx = args.indexOf('--target')
    expect(args[tIdx + 1]).toBe('o9cq80wQ@im.wechat')
  })

  it('does NOT append suffix if target already has @ in it', async () => {
    const bridge = makeBridge({
      openclaw: { enabled: true, targetUserId: 'someone@other.example', channel: 'openclaw-weixin' },
      spawnImpl: spy({ stdout: '{}' }),
    })
    await bridge.postText({ message: 'hi' })
    const args = calls[0].args
    const tIdx = args.indexOf('--target')
    expect(args[tIdx + 1]).toBe('someone@other.example')
  })

  it('does NOT append suffix for unknown channels', async () => {
    const bridge = makeBridge({
      openclaw: { enabled: true, targetUserId: 'plain-id', channel: 'discord' },
      spawnImpl: spy({ stdout: '{}' }),
    })
    await bridge.postText({ message: 'hi' })
    const args = calls[0].args
    const tIdx = args.indexOf('--target')
    expect(args[tIdx + 1]).toBe('plain-id')
  })

  it('registerSessionRoute persists threadId + topicName (not dropped)', async () => {
    const bridge = createOpenClawBridge({
      getConfig: () => ({ openclaw: { enabled: true, channel: 'telegram', targetUserId: '-1001' } }),
      spawnFn: spy({ stdout: '{}' }),
      logger: { warn() {}, info() {} },
      loadTelegramToken: () => 'TKN',
      telegramSender: async (args) => ({ ok: true, payload: { messageId: '1' }, _capture: args }),
    })
    bridge.registerSessionRoute('sess-X', {
      targetUserId: '-1001',
      threadId: 42,
      topicName: '#tabc 修复 X',
    })
    const route = bridge.resolveRoute('sess-X')
    expect(route.threadId).toBe(42)
    expect(route.topicName).toBe('#tabc 修复 X')
  })

  it('telegram fast-path: passes threadId from session route to sender', async () => {
    const captured = []
    const bridge = createOpenClawBridge({
      getConfig: () => ({ openclaw: { enabled: true, channel: 'telegram' } }),
      spawnFn: spy({ stdout: '{}' }),
      logger: { warn() {}, info() {} },
      loadTelegramToken: () => 'TKN',
      telegramSender: async (args) => { captured.push(args); return { ok: true, payload: {} } },
    })
    bridge.registerSessionRoute('s-T', {
      targetUserId: '-1003985889503',
      threadId: 41,
      topicName: '#tabc test',
    })
    await bridge.postText({ sessionId: 's-T', message: 'hi' })
    expect(captured).toHaveLength(1)
    expect(captured[0].chatId).toBe('-1003985889503')
    expect(captured[0].threadId).toBe(41)   // ← 关键：threadId 从 route 透传到 sender
  })

  it('telegram fast-path: uses HTTPS Bot API instead of CLI when token available', async () => {
    const sentViaApi = []
    const bridge = createOpenClawBridge({
      getConfig: () => ({ openclaw: { enabled: true, targetUserId: '1234567', channel: 'telegram' } }),
      spawnFn: spy({ stdout: '{"ok":1}' }),
      logger: { warn() {}, info() {} },
      loadTelegramToken: () => 'FAKE_TOKEN',
      telegramSender: async (args) => {
        sentViaApi.push(args)
        return { ok: true, payload: { messageId: 'tg-42' } }
      },
    })
    const r = await bridge.postText({ message: 'hi' })
    expect(r.ok).toBe(true)
    expect(r.fast).toBe(true)
    expect(sentViaApi).toHaveLength(1)
    expect(sentViaApi[0].token).toBe('FAKE_TOKEN')
    expect(sentViaApi[0].chatId).toBe('1234567')
    expect(sentViaApi[0].text).toBe('hi')
    // threadId 没显式传时，应该是 null（没有 sessionRoute）
    expect(sentViaApi[0].threadId).toBeNull()
    expect(calls).toHaveLength(0)  // 没走 CLI
  })

  it('telegram fast-path: falls back to CLI when token unavailable', async () => {
    const bridge = createOpenClawBridge({
      getConfig: () => ({ openclaw: { enabled: true, targetUserId: '1234567', channel: 'telegram' } }),
      spawnFn: spy({ stdout: '{}' }),
      logger: { warn() {}, info() {} },
      loadTelegramToken: () => null,
      telegramSender: async () => ({ ok: false, reason: 'no_token' }),
    })
    const r = await bridge.postText({ message: 'hi' })
    expect(r.ok).toBe(true)
    expect(calls).toHaveLength(1)
    // CLI 收到的 target 是 string
    const t = calls[0].args[calls[0].args.indexOf('--target') + 1]
    expect(t).toBe('1234567')
  })

  it('telegram fast-path: falls back to CLI when API call fails', async () => {
    const bridge = createOpenClawBridge({
      getConfig: () => ({ openclaw: { enabled: true, targetUserId: '1234567', channel: 'telegram' } }),
      spawnFn: spy({ stdout: '{}' }),
      logger: { warn() {}, info() {} },
      loadTelegramToken: () => 'FAKE_TOKEN',
      telegramSender: async () => ({ ok: false, reason: 'telegram_api_error', detail: 'forbidden' }),
    })
    const r = await bridge.postText({ message: 'hi' })
    expect(r.ok).toBe(true)
    expect(calls).toHaveLength(1)  // fallback 到 CLI
  })

  // ─── Layer 1: refuse-to-General guard（防止 sessionId-routed 静默落 General） ───
  it('telegram fast-path: refuses send when sessionId given but no registered route (would leak to General)', async () => {
    const sentViaApi = []
    const bridge = createOpenClawBridge({
      getConfig: () => ({ openclaw: { enabled: true, targetUserId: '-1001999', channel: 'telegram' } }),
      spawnFn: spy({ stdout: '{}' }),
      logger: { warn() {}, info() {} },
      loadTelegramToken: () => 'FAKE_TOKEN',
      telegramSender: async (args) => {
        sentViaApi.push(args)
        return { ok: true, payload: { messageId: 'leak-1' } }
      },
    })
    // sessionId 给了，但没 registerSessionRoute → fallback 走 oc.targetUserId
    const r = await bridge.postText({ sessionId: 'orphan-sid', message: 'hi' })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('no_thread_id_route_missing')
    expect(sentViaApi).toHaveLength(0)  // 一条都不发
    expect(calls).toHaveLength(0)
  })

  it('telegram fast-path: NO sessionId case still works (broadcast to default chat)', async () => {
    const sentViaApi = []
    const bridge = createOpenClawBridge({
      getConfig: () => ({ openclaw: { enabled: true, targetUserId: '-1001999', channel: 'telegram' } }),
      spawnFn: spy({ stdout: '{}' }),
      logger: { warn() {}, info() {} },
      loadTelegramToken: () => 'FAKE_TOKEN',
      telegramSender: async (args) => {
        sentViaApi.push(args)
        return { ok: true, payload: {} }
      },
    })
    // 不传 sessionId → 显式 broadcast，应该允许
    const r = await bridge.postText({ message: 'broadcast' })
    expect(r.ok).toBe(true)
    expect(sentViaApi).toHaveLength(1)
    expect(sentViaApi[0].threadId).toBeNull()
  })

  it('telegram fast-path: registered route still works (正常路径不受新 guard 影响)', async () => {
    const sentViaApi = []
    const bridge = createOpenClawBridge({
      getConfig: () => ({ openclaw: { enabled: true, channel: 'telegram' } }),
      spawnFn: spy({ stdout: '{}' }),
      logger: { warn() {}, info() {} },
      loadTelegramToken: () => 'FAKE_TOKEN',
      telegramSender: async (args) => {
        sentViaApi.push(args)
        return { ok: true, payload: {} }
      },
    })
    bridge.registerSessionRoute('sid-good', { targetUserId: '-1001999', threadId: 88, channel: 'telegram' })
    const r = await bridge.postText({ sessionId: 'sid-good', message: 'hi' })
    expect(r.ok).toBe(true)
    expect(sentViaApi[0].threadId).toBe(88)
  })

  it('hasExplicitRoute returns true only after registerSessionRoute', () => {
    const bridge = createOpenClawBridge({
      getConfig: () => ({ openclaw: { enabled: true, targetUserId: 'peer' } }),
      spawnFn: spy({ stdout: '{}' }),
      logger: { warn() {}, info() {} },
    })
    expect(bridge.hasExplicitRoute('s1')).toBe(false)
    bridge.registerSessionRoute('s1', { targetUserId: 'peer', threadId: 1 })
    expect(bridge.hasExplicitRoute('s1')).toBe(true)
    bridge.clearSessionRoute('s1', 'unit-test')
    expect(bridge.hasExplicitRoute('s1')).toBe(false)
    // null/empty/undefined 不会 false-positive
    expect(bridge.hasExplicitRoute(null)).toBe(false)
    expect(bridge.hasExplicitRoute('')).toBe(false)
    expect(bridge.hasExplicitRoute(undefined)).toBe(false)
  })

  it('clearSessionRoute logs reason when actually deleting (diagnostic)', () => {
    const infoLines = []
    const bridge = createOpenClawBridge({
      getConfig: () => ({ openclaw: { enabled: true, targetUserId: 'peer' } }),
      spawnFn: spy({ stdout: '{}' }),
      logger: { warn() {}, info: (msg) => infoLines.push(msg) },
    })
    bridge.registerSessionRoute('sid-X', { targetUserId: 'peer', threadId: 9 })
    bridge.clearSessionRoute('sid-X', 'topic-closed')
    expect(infoLines.some((l) => l.includes('sid=sid-X') && l.includes('reason=topic-closed'))).toBe(true)
    // 第二次清同一个 sid（已经不在 map）→ 不再打 log（避免重复噪声）
    infoLines.length = 0
    bridge.clearSessionRoute('sid-X', 'whatever')
    expect(infoLines).toHaveLength(0)
  })

  it('telegram fast-path: refuses CLI fallback when threadId set (would leak to General)', async () => {
    const apiCalls = []
    const cliCalls = []
    const bridge = createOpenClawBridge({
      getConfig: () => ({ openclaw: { enabled: true, targetUserId: '-1001999', channel: 'telegram' } }),
      spawnFn: (...args) => { cliCalls.push(args); return spy({ stdout: '{}' })(...args) },
      logger: { warn() {}, info() {} },
      loadTelegramToken: () => 'FAKE_TOKEN',
      telegramSender: async (args) => {
        apiCalls.push(args)
        return { ok: false, reason: 'fetch_error', detail: 'network down' }
      },
    })
    bridge.registerSessionRoute('sess-z', { targetUserId: '-1001999', threadId: 710, topicName: '#t-z' })
    const r = await bridge.postText({ sessionId: 'sess-z', message: 'hi' })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('fetch_error')
    // 重试 1 次 = 2 次 API 调用，但 CLI 一次都没碰
    expect(apiCalls.length).toBeGreaterThanOrEqual(1)
    expect(cliCalls).toHaveLength(0)
  })

  it('telegram fast-path: retries once on fetch_error before giving up', async () => {
    let attempts = 0
    const bridge = createOpenClawBridge({
      getConfig: () => ({ openclaw: { enabled: true, targetUserId: '-1001999', channel: 'telegram' } }),
      spawnFn: spy({ stdout: '{}' }),
      logger: { warn() {}, info() {} },
      loadTelegramToken: () => 'FAKE_TOKEN',
      telegramSender: async () => {
        attempts++
        if (attempts === 1) return { ok: false, reason: 'fetch_error', detail: 'transient' }
        return { ok: true, payload: { message_id: 5 } }
      },
    })
    bridge.registerSessionRoute('sess-r', { targetUserId: '-1001999', threadId: 711, topicName: '#t-r' })
    const r = await bridge.postText({ sessionId: 'sess-r', message: 'hi' })
    expect(r.ok).toBe(true)
    expect(attempts).toBe(2)   // 第一次失败，第二次成功
  }, 5000)

  it('telegram fast-path: telegram_api_error (non-transient) is NOT retried', async () => {
    let attempts = 0
    const bridge = createOpenClawBridge({
      getConfig: () => ({ openclaw: { enabled: true, targetUserId: '-1001999', channel: 'telegram' } }),
      spawnFn: spy({ stdout: '{}' }),
      logger: { warn() {}, info() {} },
      loadTelegramToken: () => 'FAKE_TOKEN',
      telegramSender: async () => {
        attempts++
        return { ok: false, reason: 'telegram_api_error', detail: 'forbidden' }
      },
    })
    bridge.registerSessionRoute('sess-x', { targetUserId: '-1001999', threadId: 712, topicName: '#t-x' })
    const r = await bridge.postText({ sessionId: 'sess-x', message: 'hi' })
    expect(r.ok).toBe(false)
    expect(attempts).toBe(1)   // 业务错误不重试
  })

  it('describe reports status snapshot', () => {
    const bridge = makeBridge({
      openclaw: {
        enabled: true,
        targetUserId: 'peer',
        askUser: { rateLimitPerMin: 6 },
      },
      spawnImpl: spy({ stdout: '{}' }),
    })
    const d = bridge.describe()
    expect(d.enabled).toBe(true)
    expect(d.targetUserIdSet).toBe(true)
    expect(d.rateLimit.perMin).toBe(6)
    expect(d).not.toHaveProperty('tokenEnvSet')
  })
})

describe('sendViaTelegramAPI parse-fail fallback', () => {
  const realFetch = globalThis.fetch
  const realProxy = process.env.HTTPS_PROXY
  const realProxyLower = process.env.https_proxy

  beforeEach(() => {
    delete process.env.HTTPS_PROXY
    delete process.env.https_proxy
    delete process.env.HTTP_PROXY
    delete process.env.http_proxy
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    if (realProxy) process.env.HTTPS_PROXY = realProxy
    if (realProxyLower) process.env.https_proxy = realProxyLower
  })

  it('plain fallback preserves message_thread_id (no leak to General)', async () => {
    const calls = []
    globalThis.fetch = vi.fn(async (url, opts) => {
      const body = JSON.parse(opts.body)
      calls.push({ url, body })
      // 第一次（V2）→ 故意返回 parse 错；第二次（plain）→ 成功
      if (calls.length === 1) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ ok: false, description: "Bad Request: can't parse entities" }),
        }
      }
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 42 } }) }
    })

    const r = await bridgeInternal.sendViaTelegramAPI({
      token: 't',
      chatId: '-100123',
      threadId: 408,
      text: '**bold**',
      logger: { warn() {}, info() {} },
    })
    expect(r.ok).toBe(true)
    expect(calls).toHaveLength(2)
    // 关键断言：plain 兜底也带了 thread_id
    expect(calls[1].body.message_thread_id).toBe(408)
    expect(calls[1].body.parse_mode).toBeUndefined()
    // 还有 V2 head 诊断日志已经打了（通过 logger.info）—— 这里只验证回退路径
  })

  it('plain fallback without threadId still works (broadcast-style send)', async () => {
    const calls = []
    globalThis.fetch = vi.fn(async (url, opts) => {
      const body = JSON.parse(opts.body)
      calls.push({ url, body })
      if (calls.length === 1) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ ok: false, description: "can't parse entities" }),
        }
      }
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }
    })

    const r = await bridgeInternal.sendViaTelegramAPI({
      token: 't',
      chatId: '-100123',
      threadId: null,
      text: '*x*',
      logger: { warn() {}, info() {} },
    })
    expect(r.ok).toBe(true)
    expect(calls[1].body.message_thread_id).toBeUndefined()
  })

  it('logs V2 head with rawLen / v2Len for diagnostic', async () => {
    const lines = []
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 1 } }),
    }))
    await bridgeInternal.sendViaTelegramAPI({
      token: 't',
      chatId: '-100123',
      threadId: 9,
      text: '## hello\n**world**',
      logger: { info: (m) => lines.push(m), warn() {} },
    })
    const head = lines.find((l) => l.includes('V2 head'))
    expect(head).toBeTruthy()
    expect(head).toMatch(/rawLen=\d+/)
    expect(head).toMatch(/v2Len=\d+/)
  })
})
