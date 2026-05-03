import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTelegramBot, readBotTokenWithSource } from '../src/telegram-bot.js'

function makeWizard(handler) {
  return { handleInbound: handler }
}

function makeFetchSeq(seq) {
  let i = 0
  return async (url, opts) => {
    const next = seq[i++] || { ok: true, status: 200, body: { ok: true, result: [] } }
    return {
      ok: next.ok !== false,
      status: next.status || 200,
      json: async () => next.body,
    }
  }
}

describe('telegram-bot api wrappers', () => {
  let tmp, offsetFile

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'qt-tg-'))
    offsetFile = join(tmp, 'offset.json')
  })

  afterEach()
  function afterEach() {
    try { rmSync(tmp, { recursive: true, force: true }) } catch {}
  }

  it('sendMessage POSTs sendMessage with chat_id, text, message_thread_id', async () => {
    const calls = []
    const fetchFn = async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) })
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 99 } }) }
    }
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'TKN', allowedChatIds: ['1'] } }),
      wizard: makeWizard(async () => ({})),
      fetchFn,
      offsetFile,
      logger: { warn() {}, info() {} },
    })
    // 输入故意带 markdown 标记 —— 验证默认 V2 转换器工作 + parse_mode 切到 MarkdownV2
    // ('hi *bold*' 在 CommonMark 里 `*x*` 是 italic → V2 italic 是 `_x_`)
    const r = await bot.sendMessage({ chatId: '-1001', threadId: 42, text: 'hi *bold*' })
    expect(r).toEqual({ message_id: 99 })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('/botTKN/sendMessage')
    expect(calls[0].body.chat_id).toBe('-1001')
    expect(calls[0].body.text).toBe('hi _bold_')   // V2 italic
    expect(calls[0].body.message_thread_id).toBe(42)
    expect(calls[0].body.parse_mode).toBe('MarkdownV2')
  })

  it('sendMessage falls back to plain text on parse error', async () => {
    let count = 0
    const fetchFn = async (url, opts) => {
      count++
      if (count === 1) {
        return { ok: true, status: 200, json: async () => ({ ok: false, description: 'cannot parse entities' }) }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 100 } }) }
    }
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'X', allowedChatIds: ['1'] } }),
      wizard: makeWizard(async () => ({})),
      fetchFn, offsetFile,
      logger: { warn() {}, info() {} },
    })
    const r = await bot.sendMessage({ chatId: '1', text: '*broken' })
    expect(r.message_id).toBe(100)
    expect(count).toBe(2)
  })

  it('editMessageText POSTs editMessageText with V2 conversion', async () => {
    const calls = []
    const fetchFn = async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) })
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 7 } }) }
    }
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'X' } }),
      wizard: makeWizard(async () => ({})),
      fetchFn, offsetFile,
      logger: { warn() {}, info() {} },
    })
    await bot.editMessageText({ chatId: '-100', messageId: 7, text: '## 标题' })
    expect(calls[0].url).toContain('/editMessageText')
    expect(calls[0].body.chat_id).toBe('-100')
    expect(calls[0].body.message_id).toBe(7)
    expect(calls[0].body.parse_mode).toBe('MarkdownV2')
    expect(calls[0].body.text).toContain('*标题*')   // V2 把 ## → *bold*
  })

  it('editMessageText treats "not modified" as success', async () => {
    const fetchFn = async () => ({
      ok: false, status: 400,
      json: async () => ({ ok: false, description: 'Bad Request: message is not modified' }),
    })
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'X' } }),
      wizard: makeWizard(async () => ({})),
      fetchFn, offsetFile,
      logger: { warn() {}, info() {} },
    })
    const r = await bot.editMessageText({ chatId: '-1', messageId: 1, text: 'same' })
    expect(r.ok).toBe(true)
    expect(r.unchanged).toBe(true)
  })

  it('editMessageText falls back to plain text on parse error', async () => {
    let count = 0
    const fetchFn = async () => {
      count++
      if (count === 1) {
        return { ok: false, status: 400, json: async () => ({ ok: false, description: "can't parse entities" }) }
      }
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 7 } }) }
    }
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'X' } }),
      wizard: makeWizard(async () => ({})),
      fetchFn, offsetFile,
      logger: { warn() {}, info() {} },
    })
    const r = await bot.editMessageText({ chatId: '-1', messageId: 7, text: '#### x' })
    expect(r.message_id).toBe(7)
    expect(count).toBe(2)
  })

  it('setMessageReaction posts emoji as reaction array', async () => {
    const calls = []
    const fetchFn = async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) })
      return { ok: true, json: async () => ({ ok: true, result: true }) }
    }
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'X' } }),
      wizard: makeWizard(async () => ({})),
      fetchFn, offsetFile,
      logger: { warn() {}, info() {} },
    })
    await bot.setMessageReaction({ chatId: '-100', messageId: 7, emoji: '👀' })
    expect(calls[0].url).toContain('/setMessageReaction')
    expect(calls[0].body.chat_id).toBe('-100')
    expect(calls[0].body.message_id).toBe(7)
    expect(calls[0].body.reaction).toEqual([{ type: 'emoji', emoji: '👀' }])
    expect(calls[0].body.is_big).toBe(false)
  })

  it('setMessageReaction with null emoji clears all reactions', async () => {
    const calls = []
    const fetchFn = async (url, opts) => {
      calls.push({ body: JSON.parse(opts.body) })
      return { ok: true, json: async () => ({ ok: true, result: true }) }
    }
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'X' } }),
      wizard: makeWizard(async () => ({})),
      fetchFn, offsetFile,
      logger: { warn() {}, info() {} },
    })
    await bot.setMessageReaction({ chatId: '-100', messageId: 7, emoji: null })
    expect(calls[0].body.reaction).toEqual([])
  })

  it('createForumTopic posts correct params', async () => {
    const calls = []
    const fetchFn = async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) })
      return { ok: true, json: async () => ({ ok: true, result: { message_thread_id: 77, name: 'test' } }) }
    }
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'X' } }),
      wizard: makeWizard(async () => ({})),
      fetchFn, offsetFile,
      logger: { warn() {}, info() {} },
    })
    const t = await bot.createForumTopic({ chatId: '-100', name: '#t42 修复 login bug', iconColor: 0x6FB9F0 })
    expect(t.message_thread_id).toBe(77)
    expect(calls[0].body.chat_id).toBe('-100')
    expect(calls[0].body.name).toContain('修复 login bug')
    expect(calls[0].body.icon_color).toBe(0x6FB9F0)
  })

  it('closeForumTopic posts thread_id', async () => {
    const calls = []
    const fetchFn = async (url, opts) => {
      calls.push({ body: JSON.parse(opts.body) })
      return { ok: true, json: async () => ({ ok: true, result: true }) }
    }
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'X' } }),
      wizard: makeWizard(async () => ({})),
      fetchFn, offsetFile,
      logger: { warn() {}, info() {} },
    })
    await bot.closeForumTopic({ chatId: '-100', threadId: 77 })
    expect(calls[0].body.message_thread_id).toBe(77)
  })

  it('editForumTopic posts new name', async () => {
    const calls = []
    const fetchFn = async (url, opts) => {
      calls.push({ body: JSON.parse(opts.body) })
      return { ok: true, json: async () => ({ ok: true, result: true }) }
    }
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'X' } }),
      wizard: makeWizard(async () => ({})),
      fetchFn, offsetFile,
      logger: { warn() {}, info() {} },
    })
    await bot.editForumTopic({ chatId: '-100', threadId: 77, name: '✅ done' })
    expect(calls[0].body.name).toBe('✅ done')
  })

  it('setMyCommands posts commands + chat scope', async () => {
    const calls = []
    const fetchFn = async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) })
      return { ok: true, json: async () => ({ ok: true, result: true }) }
    }
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'X' } }),
      wizard: makeWizard(async () => ({})),
      fetchFn, offsetFile,
      logger: { warn() {}, info() {} },
    })
    const cmds = [
      { command: 'help', description: 'Show help' },
      { command: 'clear', description: 'Clear conversation' },
    ]
    await bot.setMyCommands({ commands: cmds, scope: 'chat', chatId: '-1001999' })
    expect(calls[0].url).toContain('/setMyCommands')
    expect(calls[0].body.commands).toEqual(cmds)
    expect(calls[0].body.scope).toEqual({ type: 'chat', chat_id: -1001999 })
  })

  it('setMyCommands default scope omits scope field', async () => {
    const calls = []
    const fetchFn = async (url, opts) => {
      calls.push({ body: JSON.parse(opts.body) })
      return { ok: true, json: async () => ({ ok: true, result: true }) }
    }
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'X' } }),
      wizard: makeWizard(async () => ({})),
      fetchFn, offsetFile,
      logger: { warn() {}, info() {} },
    })
    await bot.setMyCommands({ commands: [{ command: 'a', description: 'b' }] })
    expect(calls[0].body.scope).toBeUndefined()
  })

  it('setMyCommands throws when scope=chat but chatId missing', async () => {
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'X' } }),
      wizard: makeWizard(async () => ({})),
      fetchFn: async () => ({ ok: true, json: async () => ({ ok: true, result: true }) }),
      offsetFile,
      logger: { warn() {}, info() {} },
    })
    await expect(bot.setMyCommands({ commands: [], scope: 'chat' })).rejects.toThrow(/chatId_required/)
  })

  it('deleteMyCommands sends scope correctly', async () => {
    const calls = []
    const fetchFn = async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) })
      return { ok: true, json: async () => ({ ok: true, result: true }) }
    }
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'X' } }),
      wizard: makeWizard(async () => ({})),
      fetchFn, offsetFile,
      logger: { warn() {}, info() {} },
    })
    await bot.deleteMyCommands({ scope: 'chat', chatId: '-100' })
    expect(calls[0].url).toContain('/deleteMyCommands')
    expect(calls[0].body.scope).toEqual({ type: 'chat', chat_id: -100 })
  })
})

describe('telegram-bot inbound dispatch', () => {
  let tmp, offsetFile

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'qt-tg-'))
    offsetFile = join(tmp, 'offset.json')
  })

  it('drops message from unauthorized chat', async () => {
    const inboundCalls = []
    const fetchFn = makeFetchSeq([{ body: { ok: true, result: [
      { update_id: 1, message: { chat: { id: '-100unauthorized' }, text: 'hi', from: { id: '999' } } },
    ] } }])
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'X', allowedChatIds: ['-100authorized'] } }),
      wizard: makeWizard(async (args) => { inboundCalls.push(args); return { reply: 'pong' } }),
      fetchFn, offsetFile,
      logger: { warn() {}, info() {} },
    })
    await bot.pollOnce()
    expect(inboundCalls).toHaveLength(0)
  })

  it('routes message from authorized chat to wizard with thread_id', async () => {
    const inboundCalls = []
    const sentMessages = []
    let pollDone = false
    const fetchFn = async (url, opts) => {
      const body = JSON.parse(opts.body)
      if (url.includes('/getUpdates')) {
        if (pollDone) return { ok: true, json: async () => ({ ok: true, result: [] }) }
        pollDone = true
        return { ok: true, json: async () => ({ ok: true, result: [
          {
            update_id: 1,
            message: {
              chat: { id: -1001234567890 },
              message_thread_id: 42,
              from: { id: 8654165034 },
              text: 'c',
            },
          },
        ] }) }
      }
      if (url.includes('/sendMessage')) {
        sentMessages.push(body)
        return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }
      }
      return { ok: true, json: async () => ({ ok: true, result: [] }) }
    }
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'X', allowedChatIds: ['-1001234567890'] } }),
      wizard: makeWizard(async (args) => {
        inboundCalls.push(args)
        return { reply: '↪ test reply' }
      }),
      fetchFn, offsetFile,
      logger: { warn() {}, info() {} },
    })
    await bot.pollOnce()
    expect(inboundCalls).toHaveLength(1)
    expect(inboundCalls[0].chatId).toBe('-1001234567890')
    expect(inboundCalls[0].threadId).toBe(42)
    expect(inboundCalls[0].text).toBe('c')
    expect(inboundCalls[0].fromUserId).toBe('8654165034')
    expect(sentMessages).toHaveLength(1)
    expect(sentMessages[0].text).toBe('↪ test reply')
    expect(sentMessages[0].message_thread_id).toBe(42)
  })

  it('does NOT send reply when wizard returns empty string (silent stdin proxy)', async () => {
    const sentMessages = []
    const fetchFn = async (url, opts) => {
      if (url.includes('/getUpdates')) {
        return { ok: true, json: async () => ({ ok: true, result: [
          { update_id: 5, message: { chat: { id: -1 }, text: 'c', from: { id: '1' } } },
        ] }) }
      }
      if (url.includes('/sendMessage')) {
        sentMessages.push(JSON.parse(opts.body))
        return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }
      }
      return { ok: true, json: async () => ({ ok: true, result: [] }) }
    }
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'X', allowedChatIds: ['-1'] } }),
      wizard: makeWizard(async () => ({ reply: '' })),  // 静默
      fetchFn, offsetFile,
      logger: { warn() {}, info() {} },
    })
    await bot.pollOnce()
    expect(sentMessages).toHaveLength(0)
  })

  it('persists offset after polling', async () => {
    const fetchFn = makeFetchSeq([
      { body: { ok: true, result: [{ update_id: 100, message: { chat: { id: -1 }, text: 'hi', from: { id: '1' } } }] } },
    ])
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'X', allowedChatIds: ['-1'] } }),
      wizard: makeWizard(async () => ({})),
      fetchFn, offsetFile,
      logger: { warn() {}, info() {} },
    })
    await bot.pollOnce()
    const fs = await import('node:fs')
    const persisted = JSON.parse(fs.readFileSync(offsetFile, 'utf8'))
    expect(persisted.offset).toBe(101)
  })

  it('describe returns state snapshot', () => {
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { enabled: true, botToken: 'X', allowedChatIds: ['-1'] } }),
      wizard: makeWizard(async () => ({})),
      fetchFn: () => Promise.resolve({ ok: true, json: async () => ({ ok: true, result: [] }) }),
      offsetFile,
      logger: { warn() {}, info() {} },
    })
    const d = bot.describe()
    expect(d.enabled).toBe(true)
    expect(d.running).toBe(false)
    expect(d.allowedChatIds).toEqual(['-1'])
    expect(d.hasToken).toBe(true)
  })

  it('isAuthorizedChat returns false when allowedChatIds is empty', () => {
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'X', allowedChatIds: [] } }),
      wizard: makeWizard(async () => ({})),
      fetchFn: () => Promise.resolve({ ok: true, json: async () => ({}) }),
      offsetFile,
      logger: { warn() {}, info() {} },
    })
    expect(bot.isAuthorizedChat('-1001')).toBe(false)
  })

  // ─── Group bot disambiguation: strip @botUsername from slash commands ───
  // Telegram 在 group 里点 slash command 自动加 @bot 后缀；要剥掉再喂给 PTY
  it('strips @botUsername from slash command (no args)', async () => {
    const inboundCalls = []
    const fetchFn = async (url, opts) => {
      if (url.includes('/getUpdates')) {
        return { ok: true, json: async () => ({ ok: true, result: [
          { update_id: 1, message: { chat: { id: -1 }, text: '/review@lzhtestBot', from: { id: '1' } } },
        ] }) }
      }
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }
    }
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'X', allowedChatIds: ['-1'] } }),
      wizard: makeWizard(async (args) => { inboundCalls.push(args); return { reply: '' } }),
      fetchFn, offsetFile,
      logger: { warn() {}, info() {} },
    })
    await bot.pollOnce()
    expect(inboundCalls[0].text).toBe('/review')
  })

  it('strips @botUsername with args after the command', async () => {
    const inboundCalls = []
    const fetchFn = async (url, opts) => {
      if (url.includes('/getUpdates')) {
        return { ok: true, json: async () => ({ ok: true, result: [
          { update_id: 2, message: { chat: { id: -1 }, text: '/skill@lzhtestBot brainstorm', from: { id: '1' } } },
        ] }) }
      }
      return { ok: true, json: async () => ({ ok: true, result: {} }) }
    }
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'X', allowedChatIds: ['-1'] } }),
      wizard: makeWizard(async (args) => { inboundCalls.push(args); return { reply: '' } }),
      fetchFn, offsetFile,
      logger: { warn() {}, info() {} },
    })
    await bot.pollOnce()
    expect(inboundCalls[0].text).toBe('/skill brainstorm')
  })

  it('plain slash command (no @suffix) passes through untouched', async () => {
    const inboundCalls = []
    const fetchFn = async (url, opts) => {
      if (url.includes('/getUpdates')) {
        return { ok: true, json: async () => ({ ok: true, result: [
          { update_id: 3, message: { chat: { id: -1 }, text: '/help', from: { id: '1' } } },
        ] }) }
      }
      return { ok: true, json: async () => ({ ok: true, result: {} }) }
    }
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'X', allowedChatIds: ['-1'] } }),
      wizard: makeWizard(async (args) => { inboundCalls.push(args); return { reply: '' } }),
      fetchFn, offsetFile,
      logger: { warn() {}, info() {} },
    })
    await bot.pollOnce()
    expect(inboundCalls[0].text).toBe('/help')
  })

  it('mid-text @username NOT stripped (only first-word slash command)', async () => {
    const inboundCalls = []
    const fetchFn = async (url, opts) => {
      if (url.includes('/getUpdates')) {
        return { ok: true, json: async () => ({ ok: true, result: [
          { update_id: 4, message: { chat: { id: -1 }, text: 'hey @someone check /review@bot', from: { id: '1' } } },
        ] }) }
      }
      return { ok: true, json: async () => ({ ok: true, result: {} }) }
    }
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'X', allowedChatIds: ['-1'] } }),
      wizard: makeWizard(async (args) => { inboundCalls.push(args); return { reply: '' } }),
      fetchFn, offsetFile,
      logger: { warn() {}, info() {} },
    })
    await bot.pollOnce()
    // 整条不以 / 开头，所以正则不匹配，原样保留
    expect(inboundCalls[0].text).toBe('hey @someone check /review@bot')
  })
})

describe('pollRetryDelayMs reads from config', () => {
  let tmp, offsetFile

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'qt-tg-'))
    offsetFile = join(tmp, 'offset.json')
  })

  it('uses config.telegram.pollRetryDelayMs as backoff base', async () => {
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'TKN', allowedChatIds: ['1'], pollRetryDelayMs: 123 } }),
      wizard: makeWizard(async () => ({})),
      fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: [] }) }),
      offsetFile,
      logger: { warn() {}, info() {} },
    })
    expect(bot.__getPollRetryDelayMs()).toBe(123)
  })

  it('falls back to 5000 when not configured', async () => {
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'TKN', allowedChatIds: ['1'] } }),
      wizard: makeWizard(async () => ({})),
      fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: [] }) }),
      offsetFile,
      logger: { warn() {}, info() {} },
    })
    expect(bot.__getPollRetryDelayMs()).toBe(5000)
  })
})

describe('readBotTokenWithSource', () => {
  it('returns quadtodo source when config has botToken', () => {
    const r = readBotTokenWithSource(() => ({ telegram: { botToken: 'XXX' } }))
    expect(r).toEqual({ token: 'XXX', source: 'quadtodo' })
  })

  it('returns missing when no source available', () => {
    const r = readBotTokenWithSource(() => ({ telegram: {} }), { fallbackPath: '/nonexistent/openclaw.json' })
    expect(r).toEqual({ token: null, source: 'missing' })
  })

  it('returns openclaw source when fallback file has token', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'qt-fb-'))
    const path = join(tmp, 'openclaw.json')
    writeFileSync(path, JSON.stringify({ channels: { telegram: { botToken: 'YYY' } } }))
    const r = readBotTokenWithSource(() => ({ telegram: {} }), { fallbackPath: path })
    expect(r).toEqual({ token: 'YYY', source: 'openclaw' })
    rmSync(tmp, { recursive: true, force: true })
  })
})

describe('telegram-bot inbound photo dispatch', () => {
  let tmp, offsetFile

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'qt-tg-'))
    offsetFile = join(tmp, 'offset.json')
  })

  it('photo + caption: downloads photo, passes imagePaths and caption-as-text to wizard', async () => {
    const dispatched = []
    let pollDone = false
    const fakePng = Buffer.from([0x89, 0x50, 0x4E, 0x47])
    const fetchFn = async (url, opts) => {
      if (url.includes('/getUpdates')) {
        if (pollDone) return { ok: true, json: async () => ({ ok: true, result: [] }) }
        pollDone = true
        return { ok: true, json: async () => ({ ok: true, result: [{
          update_id: 1,
          message: {
            message_id: 22,
            chat: { id: -100123, type: 'supergroup' },
            message_thread_id: 88,
            from: { id: 7 },
            photo: [
              { file_id: 'small', file_size: 1000 },
              { file_id: 'large', file_size: 99999 },
            ],
            caption: '这个图里面有什么',
          },
        }] }) }
      }
      if (url.includes('/getFile')) {
        return { ok: true, json: async () => ({ ok: true, result: { file_path: 'photos/x.jpg', file_size: 4 } }) }
      }
      // file binary download
      return { ok: true, arrayBuffer: async () => fakePng.buffer.slice(fakePng.byteOffset, fakePng.byteOffset + fakePng.byteLength) }
    }
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'TKN', allowedChatIds: ['-100123'] } }),
      wizard: makeWizard(async (args) => { dispatched.push(args); return { action: 'stdin_proxy', reply: '' } }),
      fetchFn, offsetFile,
      logger: { warn() {}, info() {} },
    })
    await bot.pollOnce()
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].text).toBe('这个图里面有什么')
    expect(dispatched[0].imagePaths).toHaveLength(1)
    expect(dispatched[0].imagePaths[0]).toMatch(/\.jpg$/)
    expect(dispatched[0].threadId).toBe(88)
  })

  it('photo + caption + download fails: still dispatches caption-as-text (does not drop the message)', async () => {
    const dispatched = []
    const sentReplies = []
    let pollDone = false
    const fetchFn = async (url, opts) => {
      if (url.includes('/getUpdates')) {
        if (pollDone) return { ok: true, json: async () => ({ ok: true, result: [] }) }
        pollDone = true
        return { ok: true, json: async () => ({ ok: true, result: [{
          update_id: 1,
          message: {
            message_id: 22,
            chat: { id: -100123, type: 'supergroup' },
            message_thread_id: 88,
            from: { id: 7 },
            photo: [{ file_id: 'x', file_size: 100 }],
            caption: '这个图里面有什么',
          },
        }] }) }
      }
      if (url.includes('/getFile')) {
        // 模拟两次重试都失败
        throw new Error('fetch failed')
      }
      if (url.includes('/sendMessage')) {
        const body = JSON.parse(opts.body)
        sentReplies.push(body)
        return { ok: true, json: async () => ({ ok: true, result: { message_id: 999 } }) }
      }
      return { ok: true, json: async () => ({ ok: true, result: [] }) }
    }
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'TKN', allowedChatIds: ['-100123'] } }),
      wizard: makeWizard(async (args) => { dispatched.push(args); return { action: 'stdin_proxy', reply: '' } }),
      fetchFn, offsetFile,
      logger: { warn() {}, info() {} },
    })
    await bot.pollOnce()
    // wizard 仍被调用，imagePaths=null，text=caption
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].text).toBe('这个图里面有什么')
    expect(dispatched[0].imagePaths).toBeNull()
    // 用户收到一条提示说图丢了
    const warnMsg = sentReplies.find((m) => /图片下载失败/.test(m.text))
    expect(warnMsg).toBeTruthy()
  }, 10000)
})

describe('setProbeListener exposes dispatch hits', () => {
  let tmp, offsetFile

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'qt-tg-'))
    offsetFile = join(tmp, 'offset.json')
  })

  it('listener gets every dispatched message regardless of allowedChatIds', async () => {
    const seen = []
    const fetchSeq = makeFetchSeq([
      { ok: true, body: { ok: true, result: [
        { update_id: 1, message: { message_id: 10, chat: { id: -100999, title: 'foreign', type: 'supergroup' }, from: { id: 7, username: 'alice' }, text: 'hello' } },
      ] } },
    ])
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'TKN', allowedChatIds: [] } }),
      wizard: makeWizard(async () => ({})),
      fetchFn: fetchSeq,
      offsetFile,
      logger: { warn() {}, info() {} },
    })
    bot.setProbeListener((info) => seen.push(info))
    await bot.pollOnce()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ chatId: '-100999', chatTitle: 'foreign', chatType: 'supergroup', fromUserId: '7', textPreview: 'hello' })
  })

  it('listener does not affect allowedChatIds drop behavior', async () => {
    const dispatched = []
    const fetchSeq = makeFetchSeq([
      { ok: true, body: { ok: true, result: [
        { update_id: 1, message: { message_id: 10, chat: { id: -100999, type: 'supergroup' }, from: { id: 7 }, text: 'ping' } },
      ] } },
    ])
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'TKN', allowedChatIds: [] } }),
      wizard: makeWizard(async (msg) => { dispatched.push(msg); return {} }),
      fetchFn: fetchSeq,
      offsetFile,
      logger: { warn() {}, info() {} },
    })
    bot.setProbeListener(() => {})
    await bot.pollOnce()
    expect(dispatched).toHaveLength(0)  // wizard NOT called for unauthorized chat
  })
})

// ─── inline keyboard / callback_query ──────────────────────────────────────
describe('telegram-bot inline keyboard wrappers', () => {
  let tmp, offsetFile

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'qt-tg-'))
    offsetFile = join(tmp, 'offset.json')
  })

  it('sendMessage forwards reply_markup verbatim', async () => {
    const calls = []
    const fetchFn = async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) })
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }
    }
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'X', allowedChatIds: ['-1'] } }),
      wizard: { handleInbound: async () => ({}) },
      fetchFn, offsetFile,
      logger: { warn() {}, info() {} },
    })
    const markup = { inline_keyboard: [[{ text: 'A', callback_data: 'qt:q:1' }]] }
    await bot.sendMessage({ chatId: '-1', text: 'pick', replyMarkup: markup })
    expect(calls[0].body.reply_markup).toEqual(markup)
  })

  it('editMessageReplyMarkup posts reply_markup; treats not-modified as success', async () => {
    let count = 0
    const calls = []
    const fetchFn = async (url, opts) => {
      count++
      calls.push({ url, body: JSON.parse(opts.body) })
      if (count === 1) {
        return { ok: true, json: async () => ({ ok: true, result: true }) }
      }
      return { ok: false, status: 400, json: async () => ({ ok: false, description: 'Bad Request: message is not modified' }) }
    }
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'X' } }),
      wizard: { handleInbound: async () => ({}) },
      fetchFn, offsetFile,
      logger: { warn() {}, info() {} },
    })
    const r1 = await bot.editMessageReplyMarkup({ chatId: '-1', messageId: 7 })
    expect(r1).toBe(true)
    expect(calls[0].url).toContain('/editMessageReplyMarkup')
    expect(calls[0].body.reply_markup).toEqual({ inline_keyboard: [] })

    const r2 = await bot.editMessageReplyMarkup({ chatId: '-1', messageId: 7 })
    expect(r2).toEqual({ ok: true, unchanged: true })
  })

  it('answerCallbackQuery posts callback_query_id + optional text', async () => {
    const calls = []
    const fetchFn = async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) })
      return { ok: true, json: async () => ({ ok: true, result: true }) }
    }
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'X' } }),
      wizard: { handleInbound: async () => ({}) },
      fetchFn, offsetFile,
      logger: { warn() {}, info() {} },
    })
    await bot.answerCallbackQuery({ callbackQueryId: 'cbq1', text: 'done', showAlert: true })
    expect(calls[0].url).toContain('/answerCallbackQuery')
    expect(calls[0].body.callback_query_id).toBe('cbq1')
    expect(calls[0].body.text).toBe('done')
    expect(calls[0].body.show_alert).toBe(true)
  })
})

describe('telegram-bot callback_query dispatch', () => {
  let tmp, offsetFile

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'qt-tg-'))
    offsetFile = join(tmp, 'offset.json')
  })

  function setupCallbackPoll({ wizard, callbackQuery, allowed = ['-100123'] }) {
    let pollDone = false
    const calls = []
    const fetchFn = async (url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : null
      if (url.includes('/getUpdates')) {
        if (pollDone) return { ok: true, json: async () => ({ ok: true, result: [] }) }
        pollDone = true
        return { ok: true, json: async () => ({ ok: true, result: [
          { update_id: 1, callback_query: callbackQuery },
        ] }) }
      }
      calls.push({ url, body })
      // 通用成功响应
      if (url.includes('/sendMessage')) {
        return { ok: true, json: async () => ({ ok: true, result: { message_id: 999 } }) }
      }
      return { ok: true, json: async () => ({ ok: true, result: true }) }
    }
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'X', allowedChatIds: allowed } }),
      wizard,
      fetchFn, offsetFile,
      logger: { warn() {}, info() {} },
    })
    return { bot, calls }
  }

  it('routes callback_query to wizard.handleCallback with chatId/threadId/data', async () => {
    const seen = []
    const wizard = {
      handleInbound: async () => ({}),
      handleCallback: async (args) => { seen.push(args); return {} },
    }
    const { bot } = setupCallbackPoll({
      wizard,
      callbackQuery: {
        id: 'cbq1',
        from: { id: 7 },
        message: { message_id: 22, chat: { id: -100123 }, message_thread_id: 88, text: 'pick' },
        data: 'qt:q:2',
      },
    })
    await bot.pollOnce()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      chatId: '-100123',
      threadId: 88,
      callbackData: 'qt:q:2',
      callbackMessageId: 22,
      fromUserId: '7',
    })
  })

  it('drops callback from unauthorized chat but still calls answerCallbackQuery (no spinner)', async () => {
    const seen = []
    const wizard = {
      handleInbound: async () => ({}),
      handleCallback: async (args) => { seen.push(args); return {} },
    }
    const { bot, calls } = setupCallbackPoll({
      allowed: ['-100AUTHORIZED'],
      wizard,
      callbackQuery: {
        id: 'cbq2',
        from: { id: 7 },
        message: { message_id: 22, chat: { id: -100999 }, text: 'pick' },
        data: 'qt:q:1',
      },
    })
    await bot.pollOnce()
    expect(seen).toHaveLength(0)
    // 仍然 answerCallbackQuery，避免客户端 loading 转圈
    expect(calls.some((c) => c.url.includes('/answerCallbackQuery'))).toBe(true)
  })

  it('after wizard returns chosenLabel + reply: edits original (✓ 已选) + sends next prompt with markup', async () => {
    const wizard = {
      handleInbound: async () => ({}),
      handleCallback: async () => ({
        chosenLabel: '/tmp/foo',
        reply: '🎯 选象限：',
        replyMarkup: { inline_keyboard: [[{ text: 'Q1', callback_data: 'qt:q:1' }]] },
      }),
    }
    const { bot, calls } = setupCallbackPoll({
      wizard,
      callbackQuery: {
        id: 'cbq3',
        from: { id: 7 },
        message: { message_id: 22, chat: { id: -100123 }, text: '📁 选个工作目录：' },
        data: 'qt:wd:0',
      },
    })
    await bot.pollOnce()

    const answer = calls.find((c) => c.url.includes('/answerCallbackQuery'))
    expect(answer).toBeTruthy()

    const edit = calls.find((c) => c.url.includes('/editMessageText'))
    expect(edit).toBeTruthy()
    expect(edit.body.text).toContain('已选')   // V2 转义后可能是 '✓ 已选: /tmp/foo'

    const send = calls.find((c) => c.url.includes('/sendMessage'))
    expect(send).toBeTruthy()
    expect(send.body.reply_markup).toEqual({ inline_keyboard: [[{ text: 'Q1', callback_data: 'qt:q:1' }]] })
  })

  it('wizard returns toast only: just answerCallbackQuery, no editMessage / no sendMessage', async () => {
    const wizard = {
      handleInbound: async () => ({}),
      handleCallback: async () => ({ toast: '选项无效', editOriginal: false, action: 'invalid' }),
    }
    const { bot, calls } = setupCallbackPoll({
      wizard,
      callbackQuery: {
        id: 'cbq4',
        from: { id: 7 },
        message: { message_id: 22, chat: { id: -100123 }, text: 'pick' },
        data: 'qt:q:99',
      },
    })
    await bot.pollOnce()
    const answer = calls.find((c) => c.url.includes('/answerCallbackQuery'))
    expect(answer.body.text).toBe('选项无效')
    expect(calls.find((c) => c.url.includes('/editMessageText'))).toBeUndefined()
    expect(calls.find((c) => c.url.includes('/editMessageReplyMarkup'))).toBeUndefined()
    expect(calls.find((c) => c.url.includes('/sendMessage'))).toBeUndefined()
  })

  it('wizard without handleCallback: answers with toast, never throws', async () => {
    const wizard = { handleInbound: async () => ({}) }   // 故意不实现 handleCallback
    const { bot, calls } = setupCallbackPoll({
      wizard,
      callbackQuery: {
        id: 'cbq5',
        from: { id: 7 },
        message: { message_id: 22, chat: { id: -100123 }, text: 'pick' },
        data: 'qt:q:1',
      },
    })
    await bot.pollOnce()
    expect(calls.find((c) => c.url.includes('/answerCallbackQuery'))).toBeTruthy()
  })

  it('handleCallback throws → still answers (with 处理失败), never crashes loop', async () => {
    const wizard = {
      handleInbound: async () => ({}),
      handleCallback: async () => { throw new Error('boom') },
    }
    const { bot, calls } = setupCallbackPoll({
      wizard,
      callbackQuery: {
        id: 'cbq6',
        from: { id: 7 },
        message: { message_id: 22, chat: { id: -100123 }, text: 'pick' },
        data: 'qt:q:1',
      },
    })
    await bot.pollOnce()
    const answer = calls.find((c) => c.url.includes('/answerCallbackQuery'))
    expect(answer.body.text).toBe('处理失败')
  })
})
