import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createLarkBot } from '../src/lark-bot.js'

function makeProc({ exitCode = 0, stdout = '', stderr = '', autoClose = true } = {}) {
  const proc = new EventEmitter()
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = vi.fn()
  if (autoClose) {
    setImmediate(() => {
      if (stdout) proc.stdout.emit('data', Buffer.from(stdout))
      if (stderr) proc.stderr.emit('data', Buffer.from(stderr))
      setImmediate(() => proc.emit('close', exitCode))
    })
  }
  return proc
}

function makeBot(spawnFn, overrides = {}) {
  const wizard = overrides.wizard || { handleInbound: vi.fn() }
  const getConfig = overrides.getConfig || (() => ({ lark: { enabled: true, chatId: 'oc_default' } }))
  const logger = overrides.logger || { warn() {}, info() {} }
  const bot = createLarkBot({
    getConfig,
    wizard,
    spawnFn,
    logger,
  })
  return { bot, wizard, logger }
}

describe('lark-bot outbound CLI wrapper', () => {
  it('sendMessage spawns lark-cli message send args and returns parsed payload', async () => {
    const calls = []
    const spawnFn = vi.fn((bin, args, options) => {
      calls.push({ bin, args, options })
      return makeProc({ stdout: '{"message_id":"om_1"}' })
    })
    const { bot } = makeBot(spawnFn)

    const result = await bot.sendMessage({ chatId: 'oc_123', text: 'hello lark' })

    expect(result).toEqual({ ok: true, payload: { message_id: 'om_1' }, stdout: '{"message_id":"om_1"}' })
    expect(calls).toHaveLength(1)
    expect(calls[0].bin).toBe('lark-cli')
    expect(calls[0].args).toEqual([
      'im', '+messages-send',
      '--chat-id', 'oc_123',
      '--text', 'hello lark',
      '--as', 'bot',
    ])
  })

  it('replyInThread spawns lark-cli thread reply args and returns parsed payload', async () => {
    const calls = []
    const spawnFn = vi.fn((bin, args, options) => {
      calls.push({ bin, args, options })
      return makeProc({ stdout: '{"message_id":"om_reply"}' })
    })
    const { bot } = makeBot(spawnFn)

    const result = await bot.replyInThread({ rootMessageId: 'om_root', text: 'thread reply' })

    expect(result).toEqual({ ok: true, payload: { message_id: 'om_reply' }, stdout: '{"message_id":"om_reply"}' })
    expect(calls).toHaveLength(1)
    expect(calls[0].bin).toBe('lark-cli')
    expect(calls[0].args).toEqual([
      'im', '+messages-reply',
      '--message-id', 'om_root',
      '--text', 'thread reply',
      '--reply-in-thread',
      '--as', 'bot',
    ])
  })

  it('returns validation errors without spawning', async () => {
    const spawnFn = vi.fn(() => makeProc({ stdout: '{}' }))
    const { bot } = makeBot(spawnFn)

    await expect(bot.sendMessage({ text: 'hi' })).resolves.toEqual({ ok: false, reason: 'chatId_required' })
    await expect(bot.sendMessage({ chatId: 'oc_123' })).resolves.toEqual({ ok: false, reason: 'text_required' })
    await expect(bot.replyInThread({ text: 'hi' })).resolves.toEqual({ ok: false, reason: 'rootMessageId_required' })
    await expect(bot.replyInThread({ rootMessageId: 'om_root' })).resolves.toEqual({ ok: false, reason: 'text_required' })
    expect(spawnFn).not.toHaveBeenCalled()
  })
})

describe('lark-bot inbound events', () => {
  it('normalizes thread message event, calls wizard, and replies in thread', async () => {
    const calls = []
    const spawnFn = vi.fn((bin, args) => {
      calls.push({ bin, args })
      return makeProc({ stdout: '{"message_id":"om_reply"}' })
    })
    const wizard = { handleInbound: vi.fn().mockResolvedValue({ reply: 'thread answer', action: 'answered' }) }
    const { bot } = makeBot(spawnFn, { wizard })

    const result = await bot.handleEvent({
      event_id: 'evt_1',
      event: {
        message: {
          chat_id: 'oc_default',
          message_id: 'om_child',
          thread_id: 'omt_thread',
          root_id: 'om_root',
          content: '{"text":"hello thread"}',
        },
        sender: {
          sender_id: { open_id: 'ou_user' },
          sender_type: 'user',
        },
      },
    })

    expect(result).toEqual({ ok: true, action: 'answered' })
    expect(wizard.handleInbound).toHaveBeenCalledWith({
      channel: 'lark',
      chatId: 'oc_default',
      threadId: 'omt_thread',
      rootMessageId: 'om_root',
      messageId: 'om_child',
      text: 'hello thread',
      fromUserId: 'ou_user',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toEqual([
      'im', '+messages-reply',
      '--message-id', 'om_root',
      '--text', 'thread answer',
      '--reply-in-thread',
      '--as', 'bot',
    ])
  })

  it('normalizes main-stream event, calls wizard, and sends reply to chat', async () => {
    const calls = []
    const spawnFn = vi.fn((bin, args) => {
      calls.push({ bin, args })
      return makeProc({ stdout: '{"message_id":"om_sent"}' })
    })
    const wizard = { handleInbound: vi.fn().mockResolvedValue({ reply: 'chat answer' }) }
    const { bot } = makeBot(spawnFn, { wizard })

    const result = await bot.handleEvent({
      eventId: 'evt_2',
      message: {
        chatId: 'oc_default',
        messageId: 'om_main',
        content: { title: 'fallback title' },
      },
      sender: {
        sender_id: { user_id: 'user_1' },
        type: 'user',
      },
    })

    expect(result).toEqual({ ok: true, action: 'handled' })
    expect(wizard.handleInbound).toHaveBeenCalledWith({
      channel: 'lark',
      chatId: 'oc_default',
      threadId: null,
      rootMessageId: null,
      messageId: 'om_main',
      text: 'fallback title',
      fromUserId: 'user_1',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toEqual([
      'im', '+messages-send',
      '--chat-id', 'oc_default',
      '--text', 'chat answer',
      '--as', 'bot',
    ])
  })

  it('drops other chats, bot/app messages, empty text, and duplicate event/message ids', async () => {
    const spawnFn = vi.fn(() => makeProc({ stdout: '{}' }))
    const wizard = { handleInbound: vi.fn().mockResolvedValue({ action: 'handled' }) }
    const { bot } = makeBot(spawnFn, { wizard })

    await expect(bot.handleEvent({ event_id: 'evt_valid', event: { message: { chat_id: 'oc_default', message_id: 'om_dup', content: '{"text":"hello"}' }, sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' } } })).resolves.toEqual({ ok: true, action: 'handled' })
    await expect(bot.handleEvent({ event_id: 'evt_other', event: { message: { chat_id: 'oc_other', message_id: 'om_other', content: '{"text":"hello"}' }, sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' } } })).resolves.toEqual({ ok: true, action: 'ignored_chat' })
    await expect(bot.handleEvent({ event_id: 'evt_bot', event: { message: { chat_id: 'oc_default', message_id: 'om_bot', content: '{"text":"hello"}' }, sender: { sender_id: { open_id: 'ou_bot' }, sender_type: 'bot' } } })).resolves.toEqual({ ok: true, action: 'ignored_self' })
    await expect(bot.handleEvent({ event_id: 'evt_app', event: { message: { chat_id: 'oc_default', message_id: 'om_app', content: '{"text":"hello"}' }, sender: { sender_id: { open_id: 'ou_app' }, sender_type: 'app' } } })).resolves.toEqual({ ok: true, action: 'ignored_self' })
    await expect(bot.handleEvent({ event_id: 'evt_empty', event: { message: { chat_id: 'oc_default', message_id: 'om_empty', content: '{"text":""}' }, sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' } } })).resolves.toEqual({ ok: true, action: 'ignored_empty' })
    await expect(bot.handleEvent({ event_id: 'evt_valid', event: { message: { chat_id: 'oc_default', message_id: 'om_new', content: '{"text":"hello again"}' }, sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' } } })).resolves.toEqual({ ok: true, action: 'duplicate' })
    await expect(bot.handleEvent({ event: { message: { chat_id: 'oc_default', message_id: 'om_dup', content: '{"text":"hello by message id"}' }, sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' } } })).resolves.toEqual({ ok: true, action: 'duplicate' })

    expect(wizard.handleInbound).toHaveBeenCalledTimes(1)
  })

  it('allows redelivery after wizard handling fails', async () => {
    const spawnFn = vi.fn(() => makeProc({ stdout: '{}' }))
    const wizard = {
      handleInbound: vi.fn()
        .mockRejectedValueOnce(new Error('wizard exploded'))
        .mockResolvedValueOnce({ action: 'handled_after_retry' }),
    }
    const { bot } = makeBot(spawnFn, { wizard })
    const event = { event_id: 'evt_wizard_retry', event: { message: { chat_id: 'oc_default', message_id: 'om_wizard_retry', content: '{"text":"retry me"}' }, sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' } } }

    await expect(bot.handleEvent(event)).resolves.toEqual({ ok: false, reason: 'wizard_failed', detail: 'wizard exploded' })
    await expect(bot.handleEvent(event)).resolves.toEqual({ ok: true, action: 'handled_after_retry' })

    expect(wizard.handleInbound).toHaveBeenCalledTimes(2)
  })

  it('retries failed main-stream reply delivery without re-running wizard', async () => {
    const spawnFn = vi.fn()
      .mockImplementationOnce(() => makeProc({ exitCode: 1, stderr: 'send failed' }))
      .mockImplementationOnce(() => makeProc({ stdout: '{"message_id":"om_sent"}' }))
    const wizard = { handleInbound: vi.fn().mockResolvedValue({ reply: 'please deliver', action: 'answered' }) }
    const { bot } = makeBot(spawnFn, { wizard })
    const event = { event_id: 'evt_reply_retry', event: { message: { chat_id: 'oc_default', message_id: 'om_reply_retry', content: '{"text":"reply retry"}' }, sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' } } }

    await expect(bot.handleEvent(event)).resolves.toEqual({ ok: false, reason: 'cli_failed', detail: 'send failed' })
    await expect(bot.handleEvent(event)).resolves.toEqual({ ok: true, action: 'answered' })
    await expect(bot.handleEvent(event)).resolves.toEqual({ ok: true, action: 'duplicate' })

    expect(wizard.handleInbound).toHaveBeenCalledTimes(1)
    expect(spawnFn).toHaveBeenCalledTimes(2)
    expect(spawnFn.mock.calls[1][1]).toEqual([
      'im', '+messages-send',
      '--chat-id', 'oc_default',
      '--text', 'please deliver',
      '--as', 'bot',
    ])
  })

  it('clears original event id retry cache after redelivery succeeds via message id', async () => {
    const spawnFn = vi.fn()
      .mockImplementationOnce(() => makeProc({ exitCode: 1, stderr: 'send failed' }))
      .mockImplementationOnce(() => makeProc({ stdout: '{"message_id":"om_sent"}' }))
    const wizard = { handleInbound: vi.fn().mockResolvedValue({ reply: 'please deliver once', action: 'answered' }) }
    const { bot } = makeBot(spawnFn, { wizard })
    const originalEvent = { event_id: 'evt_original', event: { message: { chat_id: 'oc_default', message_id: 'om_x', content: '{"text":"reply retry"}' }, sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' } } }
    const redeliveryEvent = { event_id: 'evt_new', event: { message: { chat_id: 'oc_default', message_id: 'om_x', content: '{"text":"reply retry"}' }, sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' } } }

    await expect(bot.handleEvent(originalEvent)).resolves.toEqual({ ok: false, reason: 'cli_failed', detail: 'send failed' })
    await expect(bot.handleEvent(redeliveryEvent)).resolves.toEqual({ ok: true, action: 'answered' })
    expect(wizard.handleInbound).toHaveBeenCalledTimes(1)
    expect(spawnFn).toHaveBeenCalledTimes(2)

    await expect(bot.handleEvent(originalEvent)).resolves.toEqual({ ok: true, action: 'duplicate' })

    expect(wizard.handleInbound).toHaveBeenCalledTimes(1)
    expect(spawnFn).toHaveBeenCalledTimes(2)
  })

  it('retries failed thread reply delivery without re-running wizard', async () => {
    const spawnFn = vi.fn()
      .mockImplementationOnce(() => makeProc({ exitCode: 1, stderr: 'reply failed' }))
      .mockImplementationOnce(() => makeProc({ stdout: '{"message_id":"om_reply"}' }))
    const wizard = { handleInbound: vi.fn().mockResolvedValue({ reply: 'thread answer', action: 'answered_thread' }) }
    const { bot } = makeBot(spawnFn, { wizard })
    const event = { event_id: 'evt_thread_reply_retry', event: { message: { chat_id: 'oc_default', message_id: 'om_thread_retry', root_id: 'om_root_retry', content: '{"text":"thread retry"}' }, sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' } } }

    await expect(bot.handleEvent(event)).resolves.toEqual({ ok: false, reason: 'cli_failed', detail: 'reply failed' })
    await expect(bot.handleEvent(event)).resolves.toEqual({ ok: true, action: 'answered_thread' })
    await expect(bot.handleEvent(event)).resolves.toEqual({ ok: true, action: 'duplicate' })

    expect(wizard.handleInbound).toHaveBeenCalledTimes(1)
    expect(spawnFn).toHaveBeenCalledTimes(2)
    expect(spawnFn.mock.calls[1][1]).toEqual([
      'im', '+messages-reply',
      '--message-id', 'om_root_retry',
      '--text', 'thread answer',
      '--reply-in-thread',
      '--as', 'bot',
    ])
  })

  it('keeps cached reply retry pending when redelivery delivery fails again', async () => {
    const spawnFn = vi.fn()
      .mockImplementationOnce(() => makeProc({ exitCode: 1, stderr: 'first send failed' }))
      .mockImplementationOnce(() => makeProc({ exitCode: 1, stderr: 'second send failed' }))
      .mockImplementationOnce(() => makeProc({ stdout: '{"message_id":"om_sent"}' }))
    const wizard = { handleInbound: vi.fn().mockResolvedValue({ reply: 'eventual reply', action: 'answered' }) }
    const { bot } = makeBot(spawnFn, { wizard })
    const event = { event_id: 'evt_reply_retry_pending', event: { message: { chat_id: 'oc_default', message_id: 'om_reply_retry_pending', content: '{"text":"reply retry pending"}' }, sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' } } }

    await expect(bot.handleEvent(event)).resolves.toEqual({ ok: false, reason: 'cli_failed', detail: 'first send failed' })
    await expect(bot.handleEvent(event)).resolves.toEqual({ ok: false, reason: 'reply_retry_failed', detail: 'second send failed' })
    await expect(bot.handleEvent(event)).resolves.toEqual({ ok: true, action: 'answered' })

    expect(wizard.handleInbound).toHaveBeenCalledTimes(1)
    expect(spawnFn).toHaveBeenCalledTimes(3)
  })
})

describe('lark-bot subscription lifecycle', () => {
  it('start spawns event subscriber when enabled and reports running', async () => {
    const calls = []
    const proc = makeProc({ autoClose: false })
    const spawnFn = vi.fn((bin, args) => {
      calls.push({ bin, args })
      return proc
    })
    const { bot } = makeBot(spawnFn, {
      getConfig: () => ({ lark: { enabled: true, eventSubscribeEnabled: true, chatId: 'oc_default' } }),
    })

    await expect(bot.start()).resolves.toEqual({ ok: true, action: 'started' })

    expect(calls).toHaveLength(1)
    expect(calls[0].args).toEqual(['event', '+subscribe', '--event-types', 'im.message.receive_v1', '--compact', '--as', 'bot'])
    expect(bot.describe().running).toBe(true)
  })

  it('stop kills subscriber with SIGTERM and reports not running', async () => {
    const proc = makeProc({ autoClose: false })
    const spawnFn = vi.fn(() => proc)
    const { bot } = makeBot(spawnFn, {
      getConfig: () => ({ lark: { enabled: true, eventSubscribeEnabled: true, chatId: 'oc_default' } }),
    })

    await bot.start()
    await expect(bot.stop()).resolves.toEqual({ ok: true })

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
    expect(bot.describe().running).toBe(false)
  })
})
