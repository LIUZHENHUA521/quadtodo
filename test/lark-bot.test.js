import { describe, it, expect, vi } from 'vitest'
import { createLarkBot } from '../src/lark-bot.js'

function makeApiClient(overrides = {}) {
  return {
    sendMessage: vi.fn().mockResolvedValue({ ok: true, payload: { message_id: 'om_sent' } }),
    replyInThread: vi.fn().mockResolvedValue({ ok: true, payload: { message_id: 'om_reply' } }),
    ...overrides,
  }
}

function makeEventClient(overrides = {}) {
  return {
    start: vi.fn().mockResolvedValue({ ok: true, action: 'started' }),
    stop: vi.fn().mockResolvedValue({ ok: true }),
    describe: vi.fn(() => ({ running: true, reason: null })),
    ...overrides,
  }
}

function makeBot(overrides = {}) {
  const wizard = overrides.wizard || { handleInbound: vi.fn() }
  const getConfig = overrides.getConfig || (() => ({
    lark: {
      enabled: true,
      appId: 'cli_a123',
      appSecret: 'secret',
      chatId: 'oc_default',
      eventSubscribeEnabled: true,
    },
  }))
  const logger = overrides.logger || { warn() {}, info() {} }
  const apiClient = overrides.apiClient || makeApiClient()
  const eventClient = overrides.eventClient || makeEventClient()
  const apiClientFactory = overrides.apiClientFactory || vi.fn(() => apiClient)
  const eventClientFactory = overrides.eventClientFactory || vi.fn(() => eventClient)
  const bot = createLarkBot({
    getConfig,
    wizard,
    logger,
    apiClientFactory,
    eventClientFactory,
  })
  return { bot, wizard, logger, apiClient, eventClient, apiClientFactory, eventClientFactory }
}

describe('lark-bot outbound SDK facade', () => {
  it('sendMessage delegates to the Lark API client', async () => {
    const { bot, apiClient, apiClientFactory } = makeBot()

    const result = await bot.sendMessage({ chatId: 'oc_123', text: 'hello lark' })

    expect(result).toEqual({ ok: true, payload: { message_id: 'om_sent' } })
    expect(apiClientFactory).toHaveBeenCalledWith(expect.objectContaining({
      appId: 'cli_a123',
      appSecret: 'secret',
    }))
    expect(apiClient.sendMessage).toHaveBeenCalledWith({ chatId: 'oc_123', text: 'hello lark' })
  })

  it('replyInThread delegates to the Lark API client', async () => {
    const { bot, apiClient } = makeBot()

    const result = await bot.replyInThread({ rootMessageId: 'om_root', text: 'thread reply' })

    expect(result).toEqual({ ok: true, payload: { message_id: 'om_reply' } })
    expect(apiClient.replyInThread).toHaveBeenCalledWith({ rootMessageId: 'om_root', text: 'thread reply' })
  })

  it('returns validation errors without creating an API call', async () => {
    const { bot, apiClient } = makeBot()

    await expect(bot.sendMessage({ text: 'hi' })).resolves.toEqual({ ok: false, reason: 'chatId_required' })
    await expect(bot.sendMessage({ chatId: 'oc_123' })).resolves.toEqual({ ok: false, reason: 'text_required' })
    await expect(bot.replyInThread({ text: 'hi' })).resolves.toEqual({ ok: false, reason: 'rootMessageId_required' })
    await expect(bot.replyInThread({ rootMessageId: 'om_root' })).resolves.toEqual({ ok: false, reason: 'text_required' })
    expect(apiClient.sendMessage).not.toHaveBeenCalled()
    expect(apiClient.replyInThread).not.toHaveBeenCalled()
  })
})

describe('lark-bot inbound events', () => {
  it('normalizes thread message event, calls wizard, and replies in thread', async () => {
    const wizard = { handleInbound: vi.fn().mockResolvedValue({ reply: 'thread answer', action: 'answered' }) }
    const { bot, apiClient } = makeBot({ wizard })

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
    expect(apiClient.replyInThread).toHaveBeenCalledWith({ rootMessageId: 'om_root', text: 'thread answer' })
  })

  it('normalizes main-stream event, calls wizard, and sends reply to chat', async () => {
    const wizard = { handleInbound: vi.fn().mockResolvedValue({ reply: 'chat answer' }) }
    const { bot, apiClient } = makeBot({ wizard })

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
    expect(apiClient.sendMessage).toHaveBeenCalledWith({ chatId: 'oc_default', text: 'chat answer' })
  })

  it('drops other chats, bot/app messages, empty text, and duplicate event/message ids', async () => {
    const wizard = { handleInbound: vi.fn().mockResolvedValue({ action: 'handled' }) }
    const { bot, apiClient } = makeBot({ wizard })

    await expect(bot.handleEvent({ event_id: 'evt_valid', event: { message: { chat_id: 'oc_default', message_id: 'om_dup', content: '{"text":"hello"}' }, sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' } } })).resolves.toEqual({ ok: true, action: 'handled' })
    await expect(bot.handleEvent({ event_id: 'evt_other', event: { message: { chat_id: 'oc_other', message_id: 'om_other', content: '{"text":"hello"}' }, sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' } } })).resolves.toEqual({ ok: true, action: 'ignored_chat' })
    await expect(bot.handleEvent({ event_id: 'evt_bot', event: { message: { chat_id: 'oc_default', message_id: 'om_bot', content: '{"text":"hello"}' }, sender: { sender_id: { open_id: 'ou_bot' }, sender_type: 'bot' } } })).resolves.toEqual({ ok: true, action: 'ignored_self' })
    await expect(bot.handleEvent({ event_id: 'evt_app', event: { message: { chat_id: 'oc_default', message_id: 'om_app', content: '{"text":"hello"}' }, sender: { sender_id: { open_id: 'ou_app' }, sender_type: 'app' } } })).resolves.toEqual({ ok: true, action: 'ignored_self' })
    await expect(bot.handleEvent({ event_id: 'evt_empty', event: { message: { chat_id: 'oc_default', message_id: 'om_empty', content: '{"text":""}' }, sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' } } })).resolves.toEqual({ ok: true, action: 'ignored_empty' })
    await expect(bot.handleEvent({ event_id: 'evt_valid', event: { message: { chat_id: 'oc_default', message_id: 'om_new', content: '{"text":"hello again"}' }, sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' } } })).resolves.toEqual({ ok: true, action: 'duplicate' })
    await expect(bot.handleEvent({ event: { message: { chat_id: 'oc_default', message_id: 'om_dup', content: '{"text":"hello by message id"}' }, sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' } } })).resolves.toEqual({ ok: true, action: 'duplicate' })

    expect(wizard.handleInbound).toHaveBeenCalledTimes(1)
    expect(apiClient.sendMessage).not.toHaveBeenCalled()
    expect(apiClient.replyInThread).not.toHaveBeenCalled()
  })

  it('allows redelivery after wizard handling fails', async () => {
    const wizard = {
      handleInbound: vi.fn()
        .mockRejectedValueOnce(new Error('wizard exploded'))
        .mockResolvedValueOnce({ action: 'handled_after_retry' }),
    }
    const { bot } = makeBot({ wizard })
    const event = { event_id: 'evt_wizard_retry', event: { message: { chat_id: 'oc_default', message_id: 'om_wizard_retry', content: '{"text":"retry me"}' }, sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' } } }

    await expect(bot.handleEvent(event)).resolves.toEqual({ ok: false, reason: 'wizard_failed', detail: 'wizard exploded' })
    await expect(bot.handleEvent(event)).resolves.toEqual({ ok: true, action: 'handled_after_retry' })

    expect(wizard.handleInbound).toHaveBeenCalledTimes(2)
  })

  it('retries failed main-stream reply delivery without re-running wizard', async () => {
    const apiClient = makeApiClient({
      sendMessage: vi.fn()
        .mockResolvedValueOnce({ ok: false, reason: 'lark_send_failed', detail: 'send failed' })
        .mockResolvedValueOnce({ ok: true, payload: { message_id: 'om_sent' } }),
    })
    const wizard = { handleInbound: vi.fn().mockResolvedValue({ reply: 'please deliver', action: 'answered' }) }
    const { bot } = makeBot({ apiClient, wizard })
    const event = { event_id: 'evt_reply_retry', event: { message: { chat_id: 'oc_default', message_id: 'om_reply_retry', content: '{"text":"reply retry"}' }, sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' } } }

    await expect(bot.handleEvent(event)).resolves.toEqual({ ok: false, reason: 'lark_send_failed', detail: 'send failed' })
    await expect(bot.handleEvent(event)).resolves.toEqual({ ok: true, action: 'answered' })
    await expect(bot.handleEvent(event)).resolves.toEqual({ ok: true, action: 'duplicate' })

    expect(wizard.handleInbound).toHaveBeenCalledTimes(1)
    expect(apiClient.sendMessage).toHaveBeenCalledTimes(2)
    expect(apiClient.sendMessage).toHaveBeenLastCalledWith({ chatId: 'oc_default', text: 'please deliver' })
  })

  it('clears original event id retry cache after redelivery succeeds via message id', async () => {
    const apiClient = makeApiClient({
      sendMessage: vi.fn()
        .mockResolvedValueOnce({ ok: false, reason: 'lark_send_failed', detail: 'send failed' })
        .mockResolvedValueOnce({ ok: true, payload: { message_id: 'om_sent' } }),
    })
    const wizard = { handleInbound: vi.fn().mockResolvedValue({ reply: 'please deliver once', action: 'answered' }) }
    const { bot } = makeBot({ apiClient, wizard })
    const originalEvent = { event_id: 'evt_original', event: { message: { chat_id: 'oc_default', message_id: 'om_x', content: '{"text":"reply retry"}' }, sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' } } }
    const redeliveryEvent = { event_id: 'evt_new', event: { message: { chat_id: 'oc_default', message_id: 'om_x', content: '{"text":"reply retry"}' }, sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' } } }

    await expect(bot.handleEvent(originalEvent)).resolves.toEqual({ ok: false, reason: 'lark_send_failed', detail: 'send failed' })
    await expect(bot.handleEvent(redeliveryEvent)).resolves.toEqual({ ok: true, action: 'answered' })
    expect(wizard.handleInbound).toHaveBeenCalledTimes(1)
    expect(apiClient.sendMessage).toHaveBeenCalledTimes(2)

    await expect(bot.handleEvent(originalEvent)).resolves.toEqual({ ok: true, action: 'duplicate' })

    expect(wizard.handleInbound).toHaveBeenCalledTimes(1)
    expect(apiClient.sendMessage).toHaveBeenCalledTimes(2)
  })

  it('retries failed thread reply delivery without re-running wizard', async () => {
    const apiClient = makeApiClient({
      replyInThread: vi.fn()
        .mockResolvedValueOnce({ ok: false, reason: 'lark_reply_failed', detail: 'reply failed' })
        .mockResolvedValueOnce({ ok: true, payload: { message_id: 'om_reply' } }),
    })
    const wizard = { handleInbound: vi.fn().mockResolvedValue({ reply: 'thread answer', action: 'answered_thread' }) }
    const { bot } = makeBot({ apiClient, wizard })
    const event = { event_id: 'evt_thread_reply_retry', event: { message: { chat_id: 'oc_default', message_id: 'om_thread_retry', root_id: 'om_root_retry', content: '{"text":"thread retry"}' }, sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' } } }

    await expect(bot.handleEvent(event)).resolves.toEqual({ ok: false, reason: 'lark_reply_failed', detail: 'reply failed' })
    await expect(bot.handleEvent(event)).resolves.toEqual({ ok: true, action: 'answered_thread' })
    await expect(bot.handleEvent(event)).resolves.toEqual({ ok: true, action: 'duplicate' })

    expect(wizard.handleInbound).toHaveBeenCalledTimes(1)
    expect(apiClient.replyInThread).toHaveBeenCalledTimes(2)
    expect(apiClient.replyInThread).toHaveBeenLastCalledWith({ rootMessageId: 'om_root_retry', text: 'thread answer' })
  })

  it('keeps cached reply retry pending when redelivery delivery fails again', async () => {
    const apiClient = makeApiClient({
      sendMessage: vi.fn()
        .mockResolvedValueOnce({ ok: false, reason: 'lark_send_failed', detail: 'first send failed' })
        .mockResolvedValueOnce({ ok: false, reason: 'lark_send_failed', detail: 'second send failed' })
        .mockResolvedValueOnce({ ok: true, payload: { message_id: 'om_sent' } }),
    })
    const wizard = { handleInbound: vi.fn().mockResolvedValue({ reply: 'eventual reply', action: 'answered' }) }
    const { bot } = makeBot({ apiClient, wizard })
    const event = { event_id: 'evt_reply_retry_pending', event: { message: { chat_id: 'oc_default', message_id: 'om_reply_retry_pending', content: '{"text":"reply retry pending"}' }, sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' } } }

    await expect(bot.handleEvent(event)).resolves.toEqual({ ok: false, reason: 'lark_send_failed', detail: 'first send failed' })
    await expect(bot.handleEvent(event)).resolves.toEqual({ ok: false, reason: 'reply_retry_failed', detail: 'second send failed' })
    await expect(bot.handleEvent(event)).resolves.toEqual({ ok: true, action: 'answered' })

    expect(wizard.handleInbound).toHaveBeenCalledTimes(1)
    expect(apiClient.sendMessage).toHaveBeenCalledTimes(3)
  })
})

describe('lark-bot subscription lifecycle', () => {
  it('start starts the SDK event client when enabled and credentialed', async () => {
    const eventClient = makeEventClient()
    const { bot, eventClientFactory } = makeBot({ eventClient })

    await expect(bot.start()).resolves.toEqual({ ok: true, action: 'started' })

    expect(eventClientFactory).toHaveBeenCalledWith(expect.objectContaining({
      appId: 'cli_a123',
      appSecret: 'secret',
      onEvent: expect.any(Function),
    }))
    expect(eventClient.start).toHaveBeenCalledTimes(1)
    expect(bot.describe()).toMatchObject({
      enabled: true,
      chatId: 'oc_default',
      eventSubscribeEnabled: true,
      running: true,
    })
  })

  it('start fails closed when credentials are missing', async () => {
    const { bot, eventClient } = makeBot({
      getConfig: () => ({ lark: { enabled: true, appId: '', appSecret: '', chatId: 'oc_default', eventSubscribeEnabled: true } }),
    })

    await expect(bot.start()).resolves.toEqual({ ok: false, reason: 'lark_credentials_missing' })
    expect(eventClient.start).not.toHaveBeenCalled()
  })

  it('stop stops the SDK event client and reports not running', async () => {
    const eventClient = makeEventClient()
    const { bot } = makeBot({ eventClient })

    await bot.start()
    await expect(bot.stop()).resolves.toEqual({ ok: true })

    expect(eventClient.stop).toHaveBeenCalledTimes(1)
    expect(bot.describe().running).toBe(false)
  })
})
