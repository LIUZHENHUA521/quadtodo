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
      getConfig: () => ({
        openclaw: { enabled: true, channel: 'telegram', targetUserId: '-1001' },
        telegram: { botToken: 'TKN' },
      }),
      spawnFn: spy({ stdout: '{}' }),
      logger: { warn() {}, info() {} },
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

  it('registerSessionRoute preserves lark rootMessageId threadId and app link', async () => {
    const bridge = createOpenClawBridge({
      getConfig: () => ({ openclaw: { enabled: true, channel: 'lark', targetUserId: 'oc_1' } }),
      spawnFn: spy({ stdout: '{}' }),
      logger: { warn() {}, info() {} },
    })
    bridge.registerSessionRoute('s-lark', {
      channel: 'lark',
      targetUserId: 'oc_1',
      threadId: 'omt_1',
      rootMessageId: 'om_root',
      topicName: '#lark-topic',
      messageAppLink: 'https://example.feishu.cn/message/app-link',
    })
    const route = bridge.resolveRoute('s-lark')
    expect(route.channel).toBe('lark')
    expect(route.targetUserId).toBe('oc_1')
    expect(route.threadId).toBe('omt_1')
    expect(route.rootMessageId).toBe('om_root')
    expect(route.topicName).toBe('#lark-topic')
    expect(route.messageAppLink).toBe('https://example.feishu.cn/message/app-link')
  })

  it('postText sends lark session messages via larkBot.replyInThread', async () => {
    const sent = []
    const bridge = createOpenClawBridge({
      getConfig: () => ({ openclaw: { enabled: true, channel: 'lark' } }),
      spawnFn: spy({ stdout: '{}' }),
      logger: { warn() {}, info() {} },
      larkBot: {
        replyInThread: async (args) => {
          sent.push(args)
          return { ok: true, payload: { messageId: 'om_reply' } }
        },
      },
    })
    bridge.registerSessionRoute('s-lark', {
      channel: 'lark',
      targetUserId: 'oc_1',
      threadId: 'omt_1',
      rootMessageId: 'om_root',
    })
    const r = await bridge.postText({ sessionId: 's-lark', message: 'AI output' })
    expect(r).toEqual({ ok: true, payload: { messageId: 'om_reply' }, fast: true })
    expect(sent).toEqual([{ rootMessageId: 'om_root', text: 'AI output' }])
    expect(calls).toHaveLength(0)
  })

  it('postText sends a lark interactive card when replyMarkup carries qt:perm: buttons', async () => {
    const cardCalls = []
    const replyCalls = []
    const bridge = createOpenClawBridge({
      getConfig: () => ({ openclaw: { enabled: true, channel: 'lark' } }),
      spawnFn: spy({ stdout: '{}' }),
      logger: { warn() {}, info() {} },
      larkBot: {
        replyInThread: async (args) => {
          replyCalls.push(args)
          return { ok: true, payload: { message_id: 'om_text_should_not_send' } }
        },
        replyWithCard: async (args) => {
          cardCalls.push(args)
          return { ok: true, payload: { message_id: 'om_card' } }
        },
      },
    })
    bridge.registerSessionRoute('s-lark-card', {
      channel: 'lark',
      targetUserId: 'oc_1',
      threadId: 'omt_1',
      rootMessageId: 'om_root',
    })
    const r = await bridge.postText({
      sessionId: 's-lark-card',
      message: '请允许 git push',
      replyMarkup: {
        inline_keyboard: [[
          { text: 'Allow', callback_data: 'qt:perm:abcd:allow' },
          { text: 'Deny', callback_data: 'qt:perm:abcd:deny' },
        ]],
      },
    })

    expect(r.ok).toBe(true)
    expect(r.card).toBe(true)
    expect(replyCalls).toEqual([])  // 没走纯文本路径
    expect(cardCalls).toHaveLength(1)
    expect(cardCalls[0].rootMessageId).toBe('om_root')
    expect(cardCalls[0].card.elements.find((el) => el.tag === 'action').actions).toHaveLength(2)
  })

  it('postText falls back to plain text reply when the lark card send fails', async () => {
    const cardCalls = []
    const replyCalls = []
    const bridge = createOpenClawBridge({
      getConfig: () => ({ openclaw: { enabled: true, channel: 'lark' } }),
      spawnFn: spy({ stdout: '{}' }),
      logger: { warn() {}, info() {} },
      larkBot: {
        replyInThread: async (args) => {
          replyCalls.push(args)
          return { ok: true, payload: { message_id: 'om_text' } }
        },
        replyWithCard: async (args) => {
          cardCalls.push(args)
          return { ok: false, reason: 'lark_send_card_failed', detail: 'card boom' }
        },
      },
    })
    bridge.registerSessionRoute('s-lark-card-fb', {
      channel: 'lark',
      targetUserId: 'oc_1',
      rootMessageId: 'om_root',
    })
    const r = await bridge.postText({
      sessionId: 's-lark-card-fb',
      message: '请允许某操作',
      replyMarkup: { inline_keyboard: [[{ text: 'Allow', callback_data: 'qt:perm:xyz:allow' }]] },
    })

    expect(cardCalls).toHaveLength(1)
    expect(replyCalls).toEqual([{ rootMessageId: 'om_root', text: '请允许某操作' }])
    expect(r.ok).toBe(true)
    expect(r.card).toBeUndefined()
  })

  it('postText drops the message when lark replyInThread fails (does not fallback to chat send)', async () => {
    // thread root 失效（用户撤回）→ 不要把 PTY 输出泼到群主消息流。
    const replyCalls = []
    const sendCalls = []
    const bridge = createOpenClawBridge({
      getConfig: () => ({ openclaw: { enabled: true, channel: 'lark' } }),
      spawnFn: spy({ stdout: '{}' }),
      logger: { warn() {}, info() {} },
      larkBot: {
        replyInThread: async (args) => {
          replyCalls.push(args)
          return { ok: false, reason: 'lark_reply_failed', detail: 'The message was withdrawn.' }
        },
        sendMessage: async (args) => {
          sendCalls.push(args)
          return { ok: true, payload: { message_id: 'om_should_not_be_sent' } }
        },
      },
    })
    bridge.registerSessionRoute('s-lark-fb', {
      channel: 'lark',
      targetUserId: 'oc_1',
      threadId: 'omt_1',
      rootMessageId: 'om_withdrawn',
    })
    const r = await bridge.postText({ sessionId: 's-lark-fb', message: 'AI output' })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('lark_reply_failed')
    expect(r.detail).toBe('The message was withdrawn.')
    expect(replyCalls).toEqual([{ rootMessageId: 'om_withdrawn', text: 'AI output' }])
    expect(sendCalls).toEqual([])  // 不再 fallback
  })

  it('postText still routes to lark when openclaw.enabled=false (lark / openclaw are independent gates)', async () => {
    // 回归：早期 postText 在第一行就 if (!isEnabled()) return disabled，
    // 导致 openclaw.enabled=false（用户只用飞书、不用微信 CLI）时，
    // Claude Code Stop hook 触发后 lark 分支根本走不到，飞书永远收不到 AI 回复。
    const sent = []
    const bridge = createOpenClawBridge({
      getConfig: () => ({
        openclaw: { enabled: false },          // ← 关键：openclaw CLI 关闭
        lark: { enabled: true, chatId: 'oc_1' },
      }),
      spawnFn: spy({ stdout: '{}' }),
      logger: { warn() {}, info() {} },
      larkBot: {
        replyInThread: async (args) => {
          sent.push(args)
          return { ok: true, payload: { messageId: 'om_reply' } }
        },
      },
    })
    bridge.registerSessionRoute('s-lark-no-oc', {
      channel: 'lark',
      targetUserId: 'oc_1',
      threadId: 'omt_1',
      rootMessageId: 'om_root',
    })
    const r = await bridge.postText({ sessionId: 's-lark-no-oc', message: 'AI output' })
    expect(r.ok).toBe(true)
    expect(r.reason).toBeUndefined()
    expect(sent).toEqual([{ rootMessageId: 'om_root', text: 'AI output' }])
    expect(calls).toHaveLength(0)             // 不应 spawn openclaw CLI
  })

  it('postText refuses lark route without rootMessageId', async () => {
    const sent = []
    const bridge = createOpenClawBridge({
      getConfig: () => ({ openclaw: { enabled: true, channel: 'lark' } }),
      spawnFn: spy({ stdout: '{}' }),
      logger: { warn() {}, info() {} },
      larkBot: {
        replyInThread: async (args) => {
          sent.push(args)
          return { ok: true, payload: {} }
        },
      },
    })
    bridge.registerSessionRoute('s-lark', {
      channel: 'lark',
      targetUserId: 'oc_1',
      threadId: 'omt_1',
    })
    const r = await bridge.postText({ sessionId: 's-lark', message: 'AI output' })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('lark_root_message_missing')
    expect(sent).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  it('findSessionByRoute can match lark by threadId or rootMessageId', async () => {
    const bridge = createOpenClawBridge({
      getConfig: () => ({ openclaw: { enabled: true, channel: 'lark', targetUserId: 'oc_1' } }),
      spawnFn: spy({ stdout: '{}' }),
      logger: { warn() {}, info() {} },
    })
    bridge.registerSessionRoute('s-lark', {
      channel: 'lark',
      targetUserId: 'oc_1',
      threadId: 'omt_1',
      rootMessageId: 'om_root',
    })
    expect(bridge.findSessionByRoute({ channel: 'lark', chatId: 'oc_1', threadId: 'omt_1' })).toBe('s-lark')
    expect(bridge.findSessionByRoute({ channel: 'lark', chatId: 'oc_1', rootMessageId: 'om_root' })).toBe('s-lark')
  })

  it('findSessionByRoute does not fall back to thread matching when lark rootMessageId is wrong', async () => {
    const bridge = createOpenClawBridge({
      getConfig: () => ({ openclaw: { enabled: true, channel: 'lark', targetUserId: 'oc_1' } }),
      spawnFn: spy({ stdout: '{}' }),
      logger: { warn() {}, info() {} },
    })
    bridge.registerSessionRoute('s-lark', {
      channel: 'lark',
      targetUserId: 'oc_1',
      rootMessageId: 'om_root',
    })
    bridge.registerSessionRoute('s-lark-other', {
      channel: 'lark',
      targetUserId: 'oc_1',
      rootMessageId: 'om_other',
    })

    expect(bridge.findSessionByRoute({ channel: 'lark', chatId: 'oc_1', rootMessageId: 'wrong' })).toBeNull()
    expect(bridge.findSessionByRoute({ channel: 'lark', chatId: 'oc_1', rootMessageId: 'om_other' })).toBe('s-lark-other')
  })

  it('telegram fast-path: passes threadId from session route to sender', async () => {
    const captured = []
    const bridge = createOpenClawBridge({
      getConfig: () => ({
        openclaw: { enabled: true, channel: 'telegram' },
        telegram: { botToken: 'TKN' },
      }),
      spawnFn: spy({ stdout: '{}' }),
      logger: { warn() {}, info() {} },
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
      getConfig: () => ({
        openclaw: { enabled: true, targetUserId: '1234567', channel: 'telegram' },
        telegram: { botToken: 'FAKE_TOKEN' },
      }),
      spawnFn: spy({ stdout: '{"ok":1}' }),
      logger: { warn() {}, info() {} },
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

  it('telegram fast-path: uses telegram.botToken from quadtodo config', async () => {
    const sentViaApi = []
    const bridge = createOpenClawBridge({
      getConfig: () => ({
        telegram: { botToken: 'QUADTODO_TOKEN' },
        openclaw: { enabled: true, channel: 'telegram' },
      }),
      spawnFn: spy({ stdout: '{}' }),
      logger: { warn() {}, info() {} },
      telegramSender: async (args) => {
        sentViaApi.push(args)
        return { ok: true, payload: { messageId: 'tg-99' } }
      },
    })
    bridge.registerSessionRoute('sid-config-token', { targetUserId: '-1001999', threadId: 162, channel: 'telegram' })
    const r = await bridge.postText({ sessionId: 'sid-config-token', message: 'hi' })
    expect(r.ok).toBe(true)
    expect(r.fast).toBe(true)
    expect(sentViaApi).toHaveLength(1)
    expect(sentViaApi[0].token).toBe('QUADTODO_TOKEN')
    expect(sentViaApi[0].chatId).toBe('-1001999')
    expect(sentViaApi[0].threadId).toBe(162)
    expect(calls).toHaveLength(0)
  })

  it('telegram fast-path: falls back to CLI when token unavailable', async () => {
    const bridge = createOpenClawBridge({
      getConfig: () => ({ openclaw: { enabled: true, targetUserId: '1234567', channel: 'telegram' } }),
      spawnFn: spy({ stdout: '{}' }),
      logger: { warn() {}, info() {} },
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
      getConfig: () => ({
        openclaw: { enabled: true, targetUserId: '1234567', channel: 'telegram' },
        telegram: { botToken: 'FAKE_TOKEN' },
      }),
      spawnFn: spy({ stdout: '{}' }),
      logger: { warn() {}, info() {} },
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
      getConfig: () => ({
        openclaw: { enabled: true, targetUserId: '-1001999', channel: 'telegram' },
        telegram: { botToken: 'FAKE_TOKEN' },
      }),
      spawnFn: spy({ stdout: '{}' }),
      logger: { warn() {}, info() {} },
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
      getConfig: () => ({
        openclaw: { enabled: true, targetUserId: '-1001999', channel: 'telegram' },
        telegram: { botToken: 'FAKE_TOKEN' },
      }),
      spawnFn: spy({ stdout: '{}' }),
      logger: { warn() {}, info() {} },
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
      getConfig: () => ({
        openclaw: { enabled: true, channel: 'telegram' },
        telegram: { botToken: 'FAKE_TOKEN' },
      }),
      spawnFn: spy({ stdout: '{}' }),
      logger: { warn() {}, info() {} },
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

  it('findSessionByShortId returns a registered route whose suffix matches', () => {
    const bridge = createOpenClawBridge({
      getConfig: () => ({ openclaw: { enabled: true, targetUserId: 'peer' } }),
      spawnFn: spy({ stdout: '{}' }),
      logger: { warn() {}, info() {} },
    })
    bridge.registerSessionRoute('ai-session-abcd', { targetUserId: 'peer', threadId: 1 })
    expect(bridge.findSessionByShortId('abcd')).toBe('ai-session-abcd')
  })

  it('findSessionByShortId returns null for missing short id', () => {
    const bridge = createOpenClawBridge({
      getConfig: () => ({ openclaw: { enabled: true, targetUserId: 'peer' } }),
      spawnFn: spy({ stdout: '{}' }),
      logger: { warn() {}, info() {} },
    })
    bridge.registerSessionRoute('ai-session-abcd', { targetUserId: 'peer', threadId: 1 })
    expect(bridge.findSessionByShortId('zzzz')).toBeNull()
  })

  it('findSessionByShortId returns null when suffix is ambiguous', () => {
    const bridge = createOpenClawBridge({
      getConfig: () => ({ openclaw: { enabled: true, targetUserId: 'peer' } }),
      spawnFn: spy({ stdout: '{}' }),
      logger: { warn() {}, info() {} },
    })
    bridge.registerSessionRoute('ai-one-abcd', { targetUserId: 'peer', threadId: 1 })
    bridge.registerSessionRoute('ai-two-abcd', { targetUserId: 'peer', threadId: 2 })
    expect(bridge.findSessionByShortId('abcd')).toBeNull()
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
      getConfig: () => ({
        openclaw: { enabled: true, targetUserId: '-1001999', channel: 'telegram' },
        telegram: { botToken: 'FAKE_TOKEN' },
      }),
      spawnFn: (...args) => { cliCalls.push(args); return spy({ stdout: '{}' })(...args) },
      logger: { warn() {}, info() {} },
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
      getConfig: () => ({
        openclaw: { enabled: true, targetUserId: '-1001999', channel: 'telegram' },
        telegram: { botToken: 'FAKE_TOKEN' },
      }),
      spawnFn: spy({ stdout: '{}' }),
      logger: { warn() {}, info() {} },
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
      getConfig: () => ({
        openclaw: { enabled: true, targetUserId: '-1001999', channel: 'telegram' },
        telegram: { botToken: 'FAKE_TOKEN' },
      }),
      spawnFn: spy({ stdout: '{}' }),
      logger: { warn() {}, info() {} },
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
