import { describe, expect, it, vi } from 'vitest'
import { createLarkApiClient } from '../src/lark-api-client.js'

function makeSdkClient(overrides = {}) {
  return {
    im: {
      message: {
        create: vi.fn().mockResolvedValue({ data: { message_id: 'om_root', thread_id: 'omt_1', message_app_link: 'https://example.test/msg' } }),
        reply: vi.fn().mockResolvedValue({ data: { message_id: 'om_reply' } }),
      },
      messageReaction: {
        create: vi.fn().mockResolvedValue({ data: { reaction_id: 'rid_1', operator: { operator_id: 'ou_bot', operator_type: 'app' }, action_time: '1' } }),
        delete: vi.fn().mockResolvedValue({ data: { reaction_id: 'rid_1' } }),
      },
    },
    // 卡片复用同一个 message.create / reply 接口，靠 msg_type=interactive 区分；
    // 上面的 mock 已经覆盖了。子类用例会单独看 .toHaveBeenCalledWith() 的 msg_type。
    auth: {
      tenantAccessToken: {
        internal: vi.fn().mockResolvedValue({ tenant_access_token: 't-1', expire: 7200 }),
      },
    },
    ...overrides,
  }
}

describe('lark-api-client', () => {
  it('sends root text messages with chat_id receive id type', async () => {
    const sdkClient = makeSdkClient()
    const clientFactory = vi.fn(() => sdkClient)
    const client = createLarkApiClient({
      appId: 'cli_a123',
      appSecret: 'secret',
      clientFactory,
    })

    const result = await client.sendMessage({ chatId: 'oc_123', text: 'hello lark' })

    expect(result).toEqual({ ok: true, payload: { message_id: 'om_root', thread_id: 'omt_1', message_app_link: 'https://example.test/msg' } })
    expect(clientFactory).toHaveBeenCalledWith({ appId: 'cli_a123', appSecret: 'secret' })
    expect(sdkClient.im.message.create).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_123',
        msg_type: 'text',
        content: JSON.stringify({ text: 'hello lark' }),
      },
    })
  })

  it('replies inside a Lark thread', async () => {
    const sdkClient = makeSdkClient()
    const client = createLarkApiClient({
      appId: 'cli_a123',
      appSecret: 'secret',
      clientFactory: () => sdkClient,
    })

    const result = await client.replyInThread({ rootMessageId: 'om_root', text: 'thread reply' })

    expect(result).toEqual({ ok: true, payload: { message_id: 'om_reply' } })
    expect(sdkClient.im.message.reply).toHaveBeenCalledWith({
      path: { message_id: 'om_root' },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text: 'thread reply' }),
        reply_in_thread: true,
      },
    })
  })

  it('fails closed when credentials or required fields are missing', async () => {
    const noCreds = createLarkApiClient({ appId: '', appSecret: '', clientFactory: () => makeSdkClient() })
    await expect(noCreds.sendMessage({ chatId: 'oc_123', text: 'hello' })).resolves.toEqual({ ok: false, reason: 'lark_credentials_missing' })

    const client = createLarkApiClient({ appId: 'cli_a123', appSecret: 'secret', clientFactory: () => makeSdkClient() })
    await expect(client.sendMessage({ text: 'hello' })).resolves.toEqual({ ok: false, reason: 'chatId_required' })
    await expect(client.sendMessage({ chatId: 'oc_123' })).resolves.toEqual({ ok: false, reason: 'text_required' })
    await expect(client.replyInThread({ text: 'hello' })).resolves.toEqual({ ok: false, reason: 'rootMessageId_required' })
    await expect(client.replyInThread({ rootMessageId: 'om_root' })).resolves.toEqual({ ok: false, reason: 'text_required' })
  })

  it('normalizes SDK failures into structured reasons', async () => {
    const sdkClient = makeSdkClient({
      im: {
        message: {
          create: vi.fn().mockRejectedValue(new Error('send exploded')),
          reply: vi.fn().mockRejectedValue(new Error('reply exploded')),
        },
      },
    })
    const client = createLarkApiClient({ appId: 'cli_a123', appSecret: 'secret', clientFactory: () => sdkClient })

    await expect(client.sendMessage({ chatId: 'oc_123', text: 'hello' })).resolves.toEqual({ ok: false, reason: 'lark_send_failed', detail: 'send exploded' })
    await expect(client.replyInThread({ rootMessageId: 'om_root', text: 'hello' })).resolves.toEqual({ ok: false, reason: 'lark_reply_failed', detail: 'reply exploded' })
  })

  it('adds emoji reactions to a message', async () => {
    const sdkClient = makeSdkClient()
    const client = createLarkApiClient({ appId: 'cli_a123', appSecret: 'secret', clientFactory: () => sdkClient })

    const result = await client.addReaction({ messageId: 'om_user', emojiType: 'THUMBSUP' })

    expect(result).toEqual({ ok: true, payload: { reaction_id: 'rid_1', operator: { operator_id: 'ou_bot', operator_type: 'app' }, action_time: '1' } })
    expect(sdkClient.im.messageReaction.create).toHaveBeenCalledWith({
      path: { message_id: 'om_user' },
      data: { reaction_type: { emoji_type: 'THUMBSUP' } },
    })
  })

  it('addReaction validates inputs and propagates SDK failures', async () => {
    const noCreds = createLarkApiClient({ appId: '', appSecret: '', clientFactory: () => makeSdkClient() })
    await expect(noCreds.addReaction({ messageId: 'om_user', emojiType: 'THUMBSUP' })).resolves.toEqual({ ok: false, reason: 'lark_credentials_missing' })

    const client = createLarkApiClient({ appId: 'cli_a123', appSecret: 'secret', clientFactory: () => makeSdkClient() })
    await expect(client.addReaction({ emojiType: 'THUMBSUP' })).resolves.toEqual({ ok: false, reason: 'messageId_required' })
    await expect(client.addReaction({ messageId: 'om_user' })).resolves.toEqual({ ok: false, reason: 'emojiType_required' })

    const failing = createLarkApiClient({
      appId: 'cli_a123',
      appSecret: 'secret',
      clientFactory: () => ({
        im: {
          messageReaction: { create: vi.fn().mockRejectedValue(new Error('reaction boom')) },
        },
      }),
    })
    await expect(failing.addReaction({ messageId: 'om_user', emojiType: 'THUMBSUP' })).resolves.toEqual({ ok: false, reason: 'lark_reaction_failed', detail: 'reaction boom' })
  })

  it('still strips markdown when caller forces format=text (legacy path)', async () => {
    const sdkClient = makeSdkClient()
    const client = createLarkApiClient({ appId: 'cli_a123', appSecret: 'secret', clientFactory: () => sdkClient })

    await client.sendMessage({ chatId: 'oc_123', text: '## 报告\n**OK** [link](https://x.com)', format: 'text' })
    expect(sdkClient.im.message.create).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_123',
        msg_type: 'text',
        content: JSON.stringify({ text: '报告\nOK link (https://x.com)' }),
      },
    })

    await client.replyInThread({ rootMessageId: 'om_root', text: '**done** ~~old~~', format: 'text' })
    expect(sdkClient.im.message.reply).toHaveBeenCalledWith({
      path: { message_id: 'om_root' },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text: 'done old' }),
        reply_in_thread: true,
      },
    })
  })

  it('auto-upgrades markdown content to msg_type=post', async () => {
    const sdkClient = makeSdkClient()
    const client = createLarkApiClient({ appId: 'cli_a123', appSecret: 'secret', clientFactory: () => sdkClient })

    await client.sendMessage({ chatId: 'oc_123', text: '## 报告\n正文' })
    const call = sdkClient.im.message.create.mock.calls.at(-1)[0]
    expect(call.data.msg_type).toBe('post')
    const content = JSON.parse(call.data.content)
    expect(content.zh_cn.content[0][0]).toEqual({ tag: 'text', text: '▎报告', style: ['bold'] })
  })

  it('auto-keeps plain text (no markdown) as msg_type=text', async () => {
    const sdkClient = makeSdkClient()
    const client = createLarkApiClient({ appId: 'cli_a123', appSecret: 'secret', clientFactory: () => sdkClient })

    await client.sendMessage({ chatId: 'oc_123', text: 'hello plain' })
    const call = sdkClient.im.message.create.mock.calls.at(-1)[0]
    expect(call.data.msg_type).toBe('text')
    expect(call.data.content).toBe(JSON.stringify({ text: 'hello plain' }))
  })

  it('falls back to text when post path fails (does not lose the message)', async () => {
    // 第一次 create 调用（post）失败，第二次（text fallback）成功
    const create = vi.fn()
      .mockRejectedValueOnce(new Error('post rejected by server'))
      .mockResolvedValueOnce({ data: { message_id: 'om_after_fallback' } })
    const sdkClient = makeSdkClient({
      im: {
        message: { create, reply: vi.fn() },
      },
    })
    const warn = vi.fn()
    const client = createLarkApiClient({
      appId: 'cli_a123',
      appSecret: 'secret',
      clientFactory: () => sdkClient,
      logger: { warn },
    })

    const r = await client.sendMessage({ chatId: 'oc_123', text: '## 升级失败也别丢' })
    expect(r).toEqual({ ok: true, payload: { message_id: 'om_after_fallback' } })
    expect(create).toHaveBeenCalledTimes(2)
    expect(create.mock.calls[0][0].data.msg_type).toBe('post')
    expect(create.mock.calls[1][0].data.msg_type).toBe('text')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('falling back to text'))
  })

  it('reply path also falls back to text on post failure', async () => {
    const reply = vi.fn()
      .mockRejectedValueOnce(new Error('post reply rejected'))
      .mockResolvedValueOnce({ data: { message_id: 'om_reply_fallback' } })
    const sdkClient = makeSdkClient({
      im: {
        message: { create: vi.fn(), reply },
      },
    })
    const client = createLarkApiClient({ appId: 'cli_a123', appSecret: 'secret', clientFactory: () => sdkClient, logger: { warn: vi.fn() } })

    const r = await client.replyInThread({ rootMessageId: 'om_root', text: '- 列表项一\n- 列表项二' })
    expect(r.ok).toBe(true)
    expect(reply).toHaveBeenCalledTimes(2)
    expect(reply.mock.calls[0][0].data.msg_type).toBe('post')
    expect(reply.mock.calls[1][0].data.msg_type).toBe('text')
  })

  it('sendCard posts msg_type=interactive with serialized card content', async () => {
    const sdkClient = makeSdkClient()
    const client = createLarkApiClient({ appId: 'cli_a123', appSecret: 'secret', clientFactory: () => sdkClient })
    const card = { config: { wide_screen_mode: true }, elements: [{ tag: 'div', text: { tag: 'plain_text', content: '需要授权' } }] }

    const r = await client.sendCard({ chatId: 'oc_1', card })
    expect(r.ok).toBe(true)
    expect(sdkClient.im.message.create).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_1',
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    })
  })

  it('replyWithCard replies in thread with msg_type=interactive', async () => {
    const sdkClient = makeSdkClient()
    const client = createLarkApiClient({ appId: 'cli_a123', appSecret: 'secret', clientFactory: () => sdkClient })
    const card = { elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'hi' } }] }

    await client.replyWithCard({ rootMessageId: 'om_root', card })
    expect(sdkClient.im.message.reply).toHaveBeenCalledWith({
      path: { message_id: 'om_root' },
      data: {
        msg_type: 'interactive',
        content: JSON.stringify(card),
        reply_in_thread: true,
      },
    })
  })

  it('sendCard / replyWithCard validate input', async () => {
    const client = createLarkApiClient({ appId: 'cli_a123', appSecret: 'secret', clientFactory: () => makeSdkClient() })
    await expect(client.sendCard({ card: {} })).resolves.toEqual({ ok: false, reason: 'chatId_required' })
    await expect(client.sendCard({ chatId: 'oc_1' })).resolves.toEqual({ ok: false, reason: 'card_required' })
    await expect(client.replyWithCard({ card: {} })).resolves.toEqual({ ok: false, reason: 'rootMessageId_required' })
    await expect(client.replyWithCard({ rootMessageId: 'om_x' })).resolves.toEqual({ ok: false, reason: 'card_required' })
  })

  it('surfaces Feishu response code+msg in error detail (not just axios status)', async () => {
    // 飞书业务错误（如 reaction type is invalid）在 axios error.response.data 里。
    // normalizeError 应该优先抓 {code, msg} 而不是 axios 的 message。
    const sdkClient = makeSdkClient({
      im: {
        messageReaction: {
          create: vi.fn().mockRejectedValue(Object.assign(new Error('Request failed with status code 400'), {
            response: { data: { code: 231001, msg: 'reaction type is invalid.' } },
          })),
        },
      },
    })
    const client = createLarkApiClient({ appId: 'cli_a123', appSecret: 'secret', clientFactory: () => sdkClient })

    const r = await client.addReaction({ messageId: 'om_user', emojiType: 'BOGUS' })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('lark_reaction_failed')
    expect(r.detail).toBe('code 231001: reaction type is invalid.')
  })

  it('deleteReaction calls SDK delete with message_id + reaction_id and validates input', async () => {
    const sdkClient = makeSdkClient()
    const client = createLarkApiClient({ appId: 'cli_a123', appSecret: 'secret', clientFactory: () => sdkClient })

    const r = await client.deleteReaction({ messageId: 'om_user', reactionId: 'rid_1' })
    expect(r.ok).toBe(true)
    expect(sdkClient.im.messageReaction.delete).toHaveBeenCalledWith({
      path: { message_id: 'om_user', reaction_id: 'rid_1' },
    })

    await expect(client.deleteReaction({ reactionId: 'rid_1' })).resolves.toEqual({ ok: false, reason: 'messageId_required' })
    await expect(client.deleteReaction({ messageId: 'om_user' })).resolves.toEqual({ ok: false, reason: 'reactionId_required' })
  })

  it('tests credentials without sending a chat message', async () => {
    const sdkClient = makeSdkClient()
    const client = createLarkApiClient({ appId: 'cli_a123', appSecret: 'secret', clientFactory: () => sdkClient })

    const result = await client.testConnection()

    expect(result).toEqual({ ok: true })
    expect(sdkClient.auth.tenantAccessToken.internal).toHaveBeenCalledWith({
      data: { app_id: 'cli_a123', app_secret: 'secret' },
    })
    expect(sdkClient.im.message.create).not.toHaveBeenCalled()
  })
})
