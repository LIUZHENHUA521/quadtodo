import { describe, expect, it, vi } from 'vitest'
import { createLarkApiClient } from '../src/lark-api-client.js'

function makeSdkClient(overrides = {}) {
  return {
    im: {
      message: {
        create: vi.fn().mockResolvedValue({ data: { message_id: 'om_root', thread_id: 'omt_1', message_app_link: 'https://example.test/msg' } }),
        reply: vi.fn().mockResolvedValue({ data: { message_id: 'om_reply' } }),
      },
    },
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
