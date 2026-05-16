import { describe, it, expect, vi } from 'vitest'
import { createLarkBot, BUSY_REACTION_EMOJIS, pickBusyReactionEmoji, adaptWizardResponseToLark } from '../src/lark-bot.js'

function makeApiClient(overrides = {}) {
  return {
    sendMessage: vi.fn().mockResolvedValue({ ok: true, payload: { message_id: 'om_sent' } }),
    replyInThread: vi.fn().mockResolvedValue({ ok: true, payload: { message_id: 'om_reply' } }),
    sendCard: vi.fn().mockResolvedValue({ ok: true, payload: { message_id: 'om_card' } }),
    replyWithCard: vi.fn().mockResolvedValue({ ok: true, payload: { message_id: 'om_card_reply' } }),
    addReaction: vi.fn().mockResolvedValue({ ok: true, payload: { reaction_id: 'rid' } }),
    deleteReaction: vi.fn().mockResolvedValue({ ok: true }),
    getMessageResource: vi.fn().mockResolvedValue({
      ok: true,
      headers: { 'content-type': 'image/png' },
      writeFile: async (p) => p,
    }),
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

describe('lark-bot busy reaction', () => {
  it('adds a random reaction from the BUSY_REACTION_EMOJIS list to user message before dispatching to wizard', async () => {
    const wizard = { handleInbound: vi.fn().mockResolvedValue({ reply: 'wizard up', action: 'wizard_started' }) }
    const { bot, apiClient } = makeBot({ wizard })

    await bot.handleEvent({
      event_id: 'evt_react',
      event: {
        message: {
          chat_id: 'oc_default',
          message_id: 'om_user_input',
          content: '{"text":"帮我做一个登录页"}',
        },
        sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      },
    })

    expect(apiClient.addReaction).toHaveBeenCalledTimes(1)
    const call = apiClient.addReaction.mock.calls[0][0]
    expect(call.messageId).toBe('om_user_input')
    expect(BUSY_REACTION_EMOJIS).toContain(call.emojiType)
    expect(wizard.handleInbound).toHaveBeenCalledTimes(1)
  })

  it('pickBusyReactionEmoji returns each entry of the whitelist over the deterministic range', () => {
    BUSY_REACTION_EMOJIS.forEach((expected, i) => {
      const fakeRng = () => i / BUSY_REACTION_EMOJIS.length
      expect(pickBusyReactionEmoji(fakeRng)).toBe(expected)
    })
  })

  it('whitelist contains only Feishu-validated thinking-semantics emojis', () => {
    // 用户反馈：之前混了 LAUGH/HEART/CLAP 等"赞叹/欢呼"语义太杂；改成"在思考"。
    // 然后又发现 CLOCK 被飞书拒（code 231001 reaction type is invalid），删掉。
    expect(BUSY_REACTION_EMOJIS).toContain('THINKING')
    expect(BUSY_REACTION_EMOJIS).toContain('OK')
    for (const invalid of ['EYES', 'CLOCK', 'WOWFACE']) {
      // 已经踩过坑确认飞书拒绝的值
      expect(BUSY_REACTION_EMOJIS).not.toContain(invalid)
    }
    for (const noisy of ['LAUGH', 'HEART', 'CLAP', 'WINK', 'BLUSH', 'WHIMPER', 'WOW', 'THUMBSUP']) {
      expect(BUSY_REACTION_EMOJIS).not.toContain(noisy)
    }
  })

  it('records reaction_id under the wizard-returned sessionId for later cleanup', async () => {
    const wizard = {
      handleInbound: vi.fn().mockResolvedValue({ action: 'stdin_proxy', sessionId: 'sid-abc' }),
    }
    const apiClient = makeApiClient({
      addReaction: vi.fn().mockResolvedValue({ ok: true, payload: { reaction_id: 'rid_xyz' } }),
    })
    const { bot } = makeBot({ wizard, apiClient })

    await bot.handleEvent({
      event_id: 'evt_track',
      event: {
        message: { chat_id: 'oc_default', message_id: 'om_user', content: '{"text":"hello"}' },
        sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      },
    })

    // pendingReactions 内部记录 (sid-abc → [{messageId: om_user, reactionId: rid_xyz}])
    // 我们通过测试钩子 _peekPendingReactions 观察。
    await new Promise((r) => setTimeout(r, 5))
    const peek = bot.__test__._peekPendingReactions()
    expect(peek.has('sid-abc')).toBe(true)
    const records = peek.get('sid-abc')
    expect(records).toEqual([{ messageId: 'om_user', reactionId: 'rid_xyz' }])
  })

  it('clearReactionsForSession deletes all reactions tracked for that session and clears the map', async () => {
    const apiClient = makeApiClient({
      addReaction: vi.fn().mockResolvedValue({ ok: true, payload: { reaction_id: 'rid_1' } }),
    })
    const wizard = {
      handleInbound: vi.fn().mockResolvedValue({ action: 'stdin_proxy', sessionId: 'sid-clean' }),
    }
    const { bot } = makeBot({ apiClient, wizard })

    await bot.handleEvent({
      event_id: 'evt_a',
      event: {
        message: { chat_id: 'oc_default', message_id: 'om_a', content: '{"text":"a"}' },
        sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      },
    })
    await new Promise((r) => setTimeout(r, 5))

    const result = await bot.clearReactionsForSession('sid-clean')

    expect(result.ok).toBe(true)
    expect(result.removed).toBe(1)
    expect(apiClient.deleteReaction).toHaveBeenCalledWith({ messageId: 'om_a', reactionId: 'rid_1' })
    expect(bot.__test__._peekPendingReactions().has('sid-clean')).toBe(false)
  })

  it('clearReactionsForSession is a no-op when no reactions are tracked', async () => {
    const apiClient = makeApiClient()
    const { bot } = makeBot({ apiClient })

    const result = await bot.clearReactionsForSession('sid-empty')
    expect(result).toEqual({ ok: true, removed: 0 })
    expect(apiClient.deleteReaction).not.toHaveBeenCalled()
  })

  it('does not add reaction when message is filtered (ignored_chat / ignored_self / ignored_empty)', async () => {
    const wizard = { handleInbound: vi.fn() }
    const { bot, apiClient } = makeBot({ wizard })

    // 不同 chatId
    await bot.handleEvent({
      event_id: 'evt_other',
      event: {
        message: { chat_id: 'oc_other', message_id: 'om_other', content: '{"text":"hi"}' },
        sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      },
    })
    // bot 自己发的
    await bot.handleEvent({
      event_id: 'evt_self',
      event: {
        message: { chat_id: 'oc_default', message_id: 'om_self', content: '{"text":"hi"}' },
        sender: { sender_id: { open_id: 'ou_bot' }, sender_type: 'bot' },
      },
    })
    // 空文本
    await bot.handleEvent({
      event_id: 'evt_empty',
      event: {
        message: { chat_id: 'oc_default', message_id: 'om_empty', content: '{"text":""}' },
        sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      },
    })

    expect(apiClient.addReaction).not.toHaveBeenCalled()
    expect(wizard.handleInbound).not.toHaveBeenCalled()
  })

  it('reaction failure does not block wizard / reply pipeline', async () => {
    const apiClient = makeApiClient({
      addReaction: vi.fn().mockRejectedValue(new Error('reaction boom')),
    })
    const wizard = { handleInbound: vi.fn().mockResolvedValue({ reply: 'wizard up', action: 'wizard_started' }) }
    const { bot } = makeBot({ apiClient, wizard })

    const r = await bot.handleEvent({
      event_id: 'evt_react_fail',
      event: {
        message: { chat_id: 'oc_default', message_id: 'om_x', content: '{"text":"帮我做"}' },
        sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      },
    })

    expect(r).toMatchObject({ ok: true, action: 'wizard_started' })
    expect(wizard.handleInbound).toHaveBeenCalledTimes(1)
    expect(apiClient.replyInThread).toHaveBeenCalledWith({ rootMessageId: 'om_x', text: 'wizard up' })
  })
})

describe('lark-bot inbound images', () => {
  it('downloads images for plain image messages and forwards local paths to wizard.imagePaths', async () => {
    const wizard = { handleInbound: vi.fn().mockResolvedValue({ reply: 'got it', action: 'wizard_started' }) }
    const apiClient = makeApiClient()
    const { bot } = makeBot({ wizard, apiClient })

    await bot.handleEvent({
      event_id: 'evt_img',
      event: {
        message: {
          chat_id: 'oc_default',
          message_id: 'om_with_img',
          msg_type: 'image',
          content: '{"image_key":"img_abcdef"}',
        },
        sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      },
    })

    expect(apiClient.getMessageResource).toHaveBeenCalledWith({
      messageId: 'om_with_img',
      fileKey: 'img_abcdef',
      type: 'image',
    })
    expect(wizard.handleInbound).toHaveBeenCalledTimes(1)
    const passed = wizard.handleInbound.mock.calls[0][0]
    expect(passed.imagePaths).toBeDefined()
    expect(passed.imagePaths).toHaveLength(1)
    expect(passed.imagePaths[0]).toMatch(/\.png$/)
  })

  it('extracts img tags from post messages alongside the body text', async () => {
    const wizard = { handleInbound: vi.fn().mockResolvedValue({ reply: 'ok' }) }
    const apiClient = makeApiClient()
    const { bot } = makeBot({ wizard, apiClient })

    await bot.handleEvent({
      event_id: 'evt_post_img',
      event: {
        message: {
          chat_id: 'oc_default',
          message_id: 'om_post_img',
          msg_type: 'post',
          content: JSON.stringify({
            content: [[
              { tag: 'at', user_id: '@_user_1', user_name: 'bot' },
              { tag: 'text', text: ' 看这个截图 ' },
              { tag: 'img', image_key: 'img_one' },
              { tag: 'img', image_key: 'img_two' },
            ]],
          }),
          mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }],
        },
        sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      },
    })

    expect(apiClient.getMessageResource).toHaveBeenCalledTimes(2)
    const passed = wizard.handleInbound.mock.calls[0][0]
    expect(passed.text).toBe('看这个截图')
    expect(passed.imagePaths).toHaveLength(2)
  })

  it('still dispatches an image-only message (no text) to wizard via imagePaths', async () => {
    const wizard = { handleInbound: vi.fn().mockResolvedValue({ reply: '' }) }
    const apiClient = makeApiClient()
    const { bot } = makeBot({ wizard, apiClient })

    const r = await bot.handleEvent({
      event_id: 'evt_img_only',
      event: {
        message: {
          chat_id: 'oc_default',
          message_id: 'om_img_only',
          msg_type: 'image',
          content: '{"image_key":"img_lonely"}',
        },
        sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      },
    })

    expect(r.action).not.toBe('ignored_empty')
    expect(wizard.handleInbound).toHaveBeenCalledTimes(1)
    const passed = wizard.handleInbound.mock.calls[0][0]
    expect(passed.text).toBe('')
    expect(passed.imagePaths).toHaveLength(1)
  })

  it('continues with whatever images downloaded successfully when one fails', async () => {
    const wizard = { handleInbound: vi.fn().mockResolvedValue({ reply: 'ok' }) }
    const apiClient = makeApiClient({
      getMessageResource: vi.fn()
        .mockResolvedValueOnce({ ok: true, headers: { 'content-type': 'image/png' }, writeFile: async (p) => p })
        .mockResolvedValueOnce({ ok: false, reason: 'lark_resource_failed', detail: 'forbidden' }),
    })
    const { bot } = makeBot({ wizard, apiClient })

    await bot.handleEvent({
      event_id: 'evt_partial',
      event: {
        message: {
          chat_id: 'oc_default',
          message_id: 'om_partial',
          msg_type: 'post',
          content: JSON.stringify({
            content: [[
              { tag: 'text', text: '两张图：' },
              { tag: 'img', image_key: 'img_ok' },
              { tag: 'img', image_key: 'img_403' },
            ]],
          }),
        },
        sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      },
    })

    expect(apiClient.getMessageResource).toHaveBeenCalledTimes(2)
    const passed = wizard.handleInbound.mock.calls[0][0]
    expect(passed.imagePaths).toHaveLength(1)  // 只成功一张
  })
})

describe('lark-bot inbound videos (msg_type=media)', () => {
  it('downloads video from msg_type=media and forwards local path to wizard.imagePaths with caption tag', async () => {
    const wizard = { handleInbound: vi.fn().mockResolvedValue({ reply: 'got it', action: 'wizard_started' }) }
    const apiClient = makeApiClient({
      getMessageResource: vi.fn().mockResolvedValue({
        ok: true,
        headers: { 'content-type': 'video/mp4' },
        writeFile: async (p) => p,
      }),
    })
    const { bot } = makeBot({ wizard, apiClient })

    await bot.handleEvent({
      event_id: 'evt_video',
      event: {
        message: {
          chat_id: 'oc_default',
          message_id: 'om_with_video',
          msg_type: 'media',
          content: '{"file_key":"media_v3_xxx","file_name":"demo.mp4","duration":12345}',
        },
        sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      },
    })

    expect(apiClient.getMessageResource).toHaveBeenCalledWith({
      messageId: 'om_with_video',
      fileKey: 'media_v3_xxx',
      type: 'file',
    })
    expect(wizard.handleInbound).toHaveBeenCalledTimes(1)
    const passed = wizard.handleInbound.mock.calls[0][0]
    expect(passed.imagePaths).toBeDefined()
    expect(passed.imagePaths).toHaveLength(1)
    expect(passed.imagePaths[0]).toMatch(/\.mp4$/)
    expect(passed.text).toBe('[用户发了视频：demo.mp4]')
  })

  it('handles message_type alias (event field name)', async () => {
    const wizard = { handleInbound: vi.fn().mockResolvedValue({ reply: 'ok' }) }
    const apiClient = makeApiClient({
      getMessageResource: vi.fn().mockResolvedValue({
        ok: true,
        headers: { 'content-type': 'video/mp4' },
        writeFile: async (p) => p,
      }),
    })
    const { bot } = makeBot({ wizard, apiClient })

    const r = await bot.handleEvent({
      event_id: 'evt_video_alias',
      event: {
        message: {
          chat_id: 'oc_default',
          message_id: 'om_alias',
          message_type: 'media',  // alias 字段名
          content: '{"file_key":"media_alias","file_name":"alias.mp4"}',
        },
        sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      },
    })

    expect(r.action).not.toBe('ignored_empty')
    expect(wizard.handleInbound).toHaveBeenCalledTimes(1)
    const passed = wizard.handleInbound.mock.calls[0][0]
    expect(passed.imagePaths).toHaveLength(1)
  })

  it('downloads video from REAL Lark shape: msg_type=post + tag=media node', async () => {
    // 真实抓到的飞书 shape：发视频时 msg_type='post'，
    // 视频是 content.content[][] 里 tag==='media' 的节点。
    const wizard = { handleInbound: vi.fn().mockResolvedValue({ reply: 'ok' }) }
    const apiClient = makeApiClient({
      getMessageResource: vi.fn().mockResolvedValue({
        ok: true,
        headers: { 'content-type': 'video/mp4' },
        writeFile: async (p) => p,
      }),
    })
    const { bot } = makeBot({ wizard, apiClient })

    const r = await bot.handleEvent({
      event_id: 'evt_real_post_media',
      event: {
        message: {
          chat_id: 'oc_default',
          message_id: 'om_real',
          msg_type: 'post',
          content: '{"title":"","content":[[{"tag":"media","file_key":"file_v3_0011j_153455b3-9010-456c-82ba-9482b23c7cag","image_key":"img_v3_0211j_9341e90d-d393-4707-9ad3-026f190380dg"}]]}',
        },
        sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      },
    })

    expect(r.action).not.toBe('ignored_empty')
    expect(apiClient.getMessageResource).toHaveBeenCalledWith({
      messageId: 'om_real',
      fileKey: 'file_v3_0011j_153455b3-9010-456c-82ba-9482b23c7cag',
      type: 'file',
    })
    expect(wizard.handleInbound).toHaveBeenCalledTimes(1)
    const passed = wizard.handleInbound.mock.calls[0][0]
    expect(passed.imagePaths).toHaveLength(1)
    expect(passed.imagePaths[0]).toMatch(/\.mp4$/)
    expect(passed.text).toMatch(/^\[用户发了视频/)
  })

  it('does not drop a video-only message with empty text', async () => {
    const wizard = { handleInbound: vi.fn().mockResolvedValue({ reply: '' }) }
    const apiClient = makeApiClient({
      getMessageResource: vi.fn().mockResolvedValue({
        ok: true,
        headers: { 'content-type': 'video/mp4' },
        writeFile: async (p) => p,
      }),
    })
    const { bot } = makeBot({ wizard, apiClient })

    const r = await bot.handleEvent({
      event_id: 'evt_video_only',
      event: {
        message: {
          chat_id: 'oc_default',
          message_id: 'om_video_only',
          msg_type: 'media',
          content: '{"file_key":"mk","file_name":"clip.mp4"}',
        },
        sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      },
    })

    expect(r.action).not.toBe('ignored_empty')
    expect(wizard.handleInbound).toHaveBeenCalledTimes(1)
  })
})

describe('lark-bot extractText post (富文本) parsing', () => {
  it('parses Lark post msg_type that wraps @bot mention + body text', async () => {
    const wizard = { handleInbound: vi.fn().mockResolvedValue({ reply: 'wizard up', action: 'wizard_started' }) }
    const { bot, apiClient } = makeBot({ wizard })

    await bot.handleEvent({
      event_id: 'evt_post',
      event: {
        message: {
          chat_id: 'oc_default',
          message_id: 'om_post',
          msg_type: 'post',
          content: JSON.stringify({
            title: '',
            content: [[
              { tag: 'at', user_id: '@_user_1', user_name: '刘振华的bot' },
              { tag: 'text', text: ' 帮我做：登录页' },
            ]],
          }),
          mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, mentioned_type: 'bot', name: '刘振华的bot' }],
        },
        sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      },
    })

    expect(wizard.handleInbound).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'lark',
      text: '帮我做：登录页',
    }))
    // reply 进同一条消息（messageId 当 reply target）→ 飞书把它显示在用户当前的 thread 里
    expect(apiClient.replyInThread).toHaveBeenCalledWith({ rootMessageId: 'om_post', text: 'wizard up' })
  })

  it('joins multi-line post bodies with newlines', async () => {
    const wizard = { handleInbound: vi.fn().mockResolvedValue({ reply: 'ok' }) }
    const { bot } = makeBot({ wizard })

    await bot.handleEvent({
      event_id: 'evt_multi',
      event: {
        message: {
          chat_id: 'oc_default',
          message_id: 'om_multi',
          msg_type: 'post',
          content: JSON.stringify({
            title: 'ignored',
            content: [
              [{ tag: 'text', text: '第一行' }],
              [{ tag: 'text', text: '第二行' }],
            ],
          }),
        },
        sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      },
    })

    expect(wizard.handleInbound).toHaveBeenCalledWith(expect.objectContaining({
      text: '第一行\n第二行',
    }))
  })

  it('extracts text from anchor (a) and md nodes inside post', async () => {
    const wizard = { handleInbound: vi.fn().mockResolvedValue({ reply: 'ok' }) }
    const { bot } = makeBot({ wizard })

    await bot.handleEvent({
      event_id: 'evt_link',
      event: {
        message: {
          chat_id: 'oc_default',
          message_id: 'om_link',
          msg_type: 'post',
          content: JSON.stringify({
            content: [[
              { tag: 'text', text: '看这个 ' },
              { tag: 'a', href: 'https://example.test', text: '链接' },
              { tag: 'md', text: ' **粗体**' },
            ]],
          }),
        },
        sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      },
    })

    expect(wizard.handleInbound).toHaveBeenCalledWith(expect.objectContaining({
      text: '看这个 链接 **粗体**',
    }))
  })

  it('falls back to post title when content array has no visible text', async () => {
    const wizard = { handleInbound: vi.fn().mockResolvedValue({ reply: 'ok' }) }
    const { bot } = makeBot({ wizard })

    await bot.handleEvent({
      event_id: 'evt_title_only',
      event: {
        message: {
          chat_id: 'oc_default',
          message_id: 'om_title',
          msg_type: 'post',
          content: JSON.stringify({
            title: '只有标题',
            content: [[{ tag: 'img', image_key: 'k' }]],
          }),
        },
        sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      },
    })

    expect(wizard.handleInbound).toHaveBeenCalledWith(expect.objectContaining({
      text: '只有标题',
    }))
  })
})

describe('lark-bot extractText mention stripping', () => {
  it('strips bot mention placeholder so NEW_TASK_TRIGGERS can match "帮我做 X"', async () => {
    const wizard = { handleInbound: vi.fn().mockResolvedValue({ reply: 'wizard started', action: 'wizard_started' }) }
    const { bot, apiClient } = makeBot({ wizard })

    await bot.handleEvent({
      event_id: 'evt_at_bot',
      event: {
        message: {
          chat_id: 'oc_default',
          message_id: 'om_at',
          content: '{"text":"@_user_1 帮我做一个登录页"}',
          mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'quadtodo' }],
        },
        sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      },
    })

    expect(wizard.handleInbound).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'lark',
      text: '帮我做一个登录页',
    }))
    expect(apiClient.replyInThread).toHaveBeenCalledWith({ rootMessageId: 'om_at', text: 'wizard started' })
  })

  it('strips multiple consecutive mentions and preserves middle text', async () => {
    const wizard = { handleInbound: vi.fn().mockResolvedValue({ reply: 'ok', action: 'handled' }) }
    const { bot } = makeBot({ wizard })

    await bot.handleEvent({
      event_id: 'evt_multi_at',
      event: {
        message: {
          chat_id: 'oc_default',
          message_id: 'om_multi',
          content: '{"text":"@_user_1 @_user_2 hello @_user_3 world"}',
          mentions: [
            { key: '@_user_1', id: { open_id: 'ou_a' }, name: 'A' },
            { key: '@_user_2', id: { open_id: 'ou_b' }, name: 'B' },
            { key: '@_user_3', id: { open_id: 'ou_c' }, name: 'C' },
          ],
        },
        sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      },
    })

    expect(wizard.handleInbound).toHaveBeenCalledWith(expect.objectContaining({
      text: 'hello world',
    }))
  })

  it('keeps text unchanged when there are no mentions', async () => {
    const wizard = { handleInbound: vi.fn().mockResolvedValue({ reply: 'ok' }) }
    const { bot } = makeBot({ wizard })

    await bot.handleEvent({
      event_id: 'evt_no_mention',
      event: {
        message: {
          chat_id: 'oc_default',
          message_id: 'om_plain',
          content: '{"text":"普通消息"}',
        },
        sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      },
    })

    expect(wizard.handleInbound).toHaveBeenCalledWith(expect.objectContaining({
      text: '普通消息',
    }))
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
    // 没 rootMessageId → 退回用 messageId 当 reply target → 飞书把 reply 显示在用户当前消息附近
    expect(apiClient.replyInThread).toHaveBeenCalledWith({ rootMessageId: 'om_main', text: 'chat answer' })
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
    // 没 rootMessageId → 退回用 messageId 当 reply target，走 replyInThread + fallback 都失败再走 retry
    const apiClient = makeApiClient({
      replyInThread: vi.fn()
        .mockResolvedValueOnce({ ok: false, reason: 'lark_reply_failed', detail: 'send failed' })
        .mockResolvedValueOnce({ ok: true, payload: { message_id: 'om_sent' } }),
      sendMessage: vi.fn().mockResolvedValue({ ok: false, reason: 'lark_send_failed', detail: 'fb failed' }),
    })
    const wizard = { handleInbound: vi.fn().mockResolvedValue({ reply: 'please deliver', action: 'answered' }) }
    const { bot } = makeBot({ apiClient, wizard })
    const event = { event_id: 'evt_reply_retry', event: { message: { chat_id: 'oc_default', message_id: 'om_reply_retry', content: '{"text":"reply retry"}' }, sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' } } }

    await expect(bot.handleEvent(event)).resolves.toEqual({ ok: false, reason: 'lark_reply_failed', detail: 'send failed' })
    await expect(bot.handleEvent(event)).resolves.toEqual({ ok: true, action: 'answered' })
    await expect(bot.handleEvent(event)).resolves.toEqual({ ok: true, action: 'duplicate' })

    expect(wizard.handleInbound).toHaveBeenCalledTimes(1)
    expect(apiClient.replyInThread).toHaveBeenCalledTimes(2)
    expect(apiClient.replyInThread).toHaveBeenLastCalledWith({ rootMessageId: 'om_reply_retry', text: 'please deliver' })
  })

  it('clears original event id retry cache after redelivery succeeds via message id', async () => {
    const apiClient = makeApiClient({
      replyInThread: vi.fn()
        .mockResolvedValueOnce({ ok: false, reason: 'lark_reply_failed', detail: 'send failed' })
        .mockResolvedValueOnce({ ok: true, payload: { message_id: 'om_sent' } }),
      sendMessage: vi.fn().mockResolvedValue({ ok: false, reason: 'lark_send_failed', detail: 'fb failed' }),
    })
    const wizard = { handleInbound: vi.fn().mockResolvedValue({ reply: 'please deliver once', action: 'answered' }) }
    const { bot } = makeBot({ apiClient, wizard })
    const originalEvent = { event_id: 'evt_original', event: { message: { chat_id: 'oc_default', message_id: 'om_x', content: '{"text":"reply retry"}' }, sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' } } }
    const redeliveryEvent = { event_id: 'evt_new', event: { message: { chat_id: 'oc_default', message_id: 'om_x', content: '{"text":"reply retry"}' }, sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' } } }

    await expect(bot.handleEvent(originalEvent)).resolves.toEqual({ ok: false, reason: 'lark_reply_failed', detail: 'send failed' })
    await expect(bot.handleEvent(redeliveryEvent)).resolves.toEqual({ ok: true, action: 'answered' })
    expect(wizard.handleInbound).toHaveBeenCalledTimes(1)
    expect(apiClient.replyInThread).toHaveBeenCalledTimes(2)

    await expect(bot.handleEvent(originalEvent)).resolves.toEqual({ ok: true, action: 'duplicate' })

    expect(wizard.handleInbound).toHaveBeenCalledTimes(1)
    expect(apiClient.replyInThread).toHaveBeenCalledTimes(2)
  })

  it('retries failed thread reply when both reply and fallback fail, then succeeds via reply', async () => {
    // 两条路径都失败 → 入 retry 队列；下一次同 event_id 再来时重投递成功
    const apiClient = makeApiClient({
      replyInThread: vi.fn()
        .mockResolvedValueOnce({ ok: false, reason: 'lark_reply_failed', detail: 'reply failed' })
        .mockResolvedValueOnce({ ok: true, payload: { message_id: 'om_reply' } }),
      sendMessage: vi.fn().mockResolvedValue({ ok: false, reason: 'lark_send_failed', detail: 'fallback failed' }),
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
      replyInThread: vi.fn()
        .mockResolvedValueOnce({ ok: false, reason: 'lark_reply_failed', detail: 'first send failed' })
        .mockResolvedValueOnce({ ok: false, reason: 'lark_reply_failed', detail: 'second send failed' })
        .mockResolvedValueOnce({ ok: true, payload: { message_id: 'om_sent' } }),
      sendMessage: vi.fn().mockResolvedValue({ ok: false, reason: 'lark_send_failed', detail: 'fb failed' }),
    })
    const wizard = { handleInbound: vi.fn().mockResolvedValue({ reply: 'eventual reply', action: 'answered' }) }
    const { bot } = makeBot({ apiClient, wizard })
    const event = { event_id: 'evt_reply_retry_pending', event: { message: { chat_id: 'oc_default', message_id: 'om_reply_retry_pending', content: '{"text":"reply retry pending"}' }, sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' } } }

    await expect(bot.handleEvent(event)).resolves.toEqual({ ok: false, reason: 'lark_reply_failed', detail: 'first send failed' })
    await expect(bot.handleEvent(event)).resolves.toEqual({ ok: false, reason: 'reply_retry_failed', detail: 'second send failed' })
    await expect(bot.handleEvent(event)).resolves.toEqual({ ok: true, action: 'answered' })

    expect(wizard.handleInbound).toHaveBeenCalledTimes(1)
    expect(apiClient.replyInThread).toHaveBeenCalledTimes(3)
  })
})

describe('lark-bot unbound thread (user-created topic) routing', () => {
  it('routes wizard reply back into the same lark thread via messageId when rootMessageId is null', async () => {
    // 用户在新建话题里 @bot 发"帮我做..."，飞书事件: thread_id 非空，root_id 空。
    // wizard 在新话题里启动，wizard reply 应该 reply 进同一个 thread（用 messageId 当 reply target）。
    const wizard = { handleInbound: vi.fn().mockResolvedValue({ reply: '📁 选个工作目录', action: 'wizard_started' }) }
    const { bot, apiClient } = makeBot({ wizard })

    await bot.handleEvent({
      event_id: 'evt_new_topic',
      event: {
        message: {
          chat_id: 'oc_default',
          message_id: 'om_user_first_msg',
          thread_id: 'omt_user_new_topic',
          // root_id intentionally absent — 新话题第一条消息没 root
          msg_type: 'post',
          content: JSON.stringify({
            content: [[
              { tag: 'at', user_id: '@_user_1', user_name: 'bot' },
              { tag: 'text', text: ' 帮我做：登录页' },
            ]],
          }),
          mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, mentioned_type: 'bot' }],
        },
        sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      },
    })

    expect(wizard.handleInbound).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'lark',
      threadId: 'omt_user_new_topic',
      rootMessageId: null,
      messageId: 'om_user_first_msg',
      text: '帮我做：登录页',
    }))
    // wizard reply 用 messageId 当 reply target，飞书把 reply 显示在用户当前话题里
    expect(apiClient.replyInThread).toHaveBeenCalledWith({
      rootMessageId: 'om_user_first_msg',
      text: '📁 选个工作目录',
    })
    expect(apiClient.sendMessage).not.toHaveBeenCalled()
  })
})

describe('lark-bot reply when thread root is gone', () => {
  it('does NOT fallback to sendMessage when replyInThread fails (root withdrawn)', async () => {
    // 用户撤回 thread root = 不想看了，对应消息直接放弃，不污染群主消息流
    const apiClient = makeApiClient({
      replyInThread: vi.fn().mockResolvedValue({ ok: false, reason: 'lark_reply_failed', detail: 'The message was withdrawn.' }),
      sendMessage: vi.fn().mockResolvedValue({ ok: true, payload: { message_id: 'om_should_not_be_sent' } }),
    })
    const wizard = { handleInbound: vi.fn().mockResolvedValue({ reply: 'wizard reply', action: 'wizard_started' }) }
    const { bot } = makeBot({ apiClient, wizard })
    const event = { event_id: 'evt_withdrawn', event: { message: { chat_id: 'oc_default', message_id: 'om_in', root_id: 'om_withdrawn_root', content: '{"text":"帮我做一个任务"}' }, sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' } } }

    const r = await bot.handleEvent(event)

    expect(r.ok).toBe(false)
    expect(r.reason).toBe('lark_reply_failed')
    expect(apiClient.replyInThread).toHaveBeenCalledWith({ rootMessageId: 'om_withdrawn_root', text: 'wizard reply' })
    expect(apiClient.sendMessage).not.toHaveBeenCalled()
  })
})

describe('lark-bot card actions (interactive cards)', () => {
  it('routes card.action.trigger payload to wizard.handleCallback and returns Lark-shaped toast', async () => {
    const wizard = {
      handleInbound: vi.fn(),
      handleCallback: vi.fn().mockResolvedValue({ ok: true, action: 'permission_allow_sent', toast: '已发送 Enter' }),
    }
    const { bot } = makeBot({ wizard })

    const r = await bot.handleCardAction({
      schema: '2.0',
      header: { event_type: 'card.action.trigger' },
      event: {
        operator: { open_id: 'ou_user_1', tenant_key: 'tk' },
        action: { tag: 'button', value: { callback_data: 'qt:perm:abcd:allow' }, name: '允许' },
        context: { open_chat_id: 'oc_default', open_message_id: 'om_card_1', open_thread_id: 'omt_xyz' },
      },
    })

    // 关键：返回的 toast 必须是 Lark 期望的 {type, content} 对象，而不是裸 string
    expect(r).toEqual({ toast: { type: 'success', content: '已发送 Enter' } })
    expect(wizard.handleCallback).toHaveBeenCalledWith({
      channel: 'lark',
      chatId: 'oc_default',
      threadId: 'omt_xyz',
      rootMessageId: 'om_card_1',
      callbackData: 'qt:perm:abcd:allow',
      fromUserId: 'ou_user_1',
    })
  })

  it('drops card.action.trigger from a different chat (returns undefined → Lark no toast)', async () => {
    const wizard = { handleInbound: vi.fn(), handleCallback: vi.fn() }
    const { bot } = makeBot({ wizard })

    const r = await bot.handleCardAction({
      event: {
        operator: { open_id: 'ou_user' },
        action: { value: { callback_data: 'qt:perm:abcd:allow' } },
        context: { open_chat_id: 'oc_other_chat', open_message_id: 'om_x' },
      },
    })

    expect(r).toBeUndefined()
    expect(wizard.handleCallback).not.toHaveBeenCalled()
  })

  it('returns Lark-shaped warning toast when chatId or callback_data missing', async () => {
    const wizard = { handleInbound: vi.fn(), handleCallback: vi.fn() }
    const { bot } = makeBot({ wizard })

    const r1 = await bot.handleCardAction({ event: { context: {}, action: { value: {} } } })
    const r2 = await bot.handleCardAction({ event: { context: { open_chat_id: 'oc_default' }, action: { value: {} } } })
    expect(r1).toEqual({ toast: { type: 'warning', content: '⚠️ 无效的卡片回传' } })
    expect(r2).toEqual({ toast: { type: 'warning', content: '⚠️ 无效的卡片回传' } })
    expect(wizard.handleCallback).not.toHaveBeenCalled()
  })

  it('wraps wizard error in Lark-shaped error toast (avoids Lark 200340)', async () => {
    const wizard = {
      handleInbound: vi.fn(),
      handleCallback: vi.fn().mockRejectedValue(new Error('write to PTY failed')),
    }
    const { bot } = makeBot({ wizard })

    const r = await bot.handleCardAction({
      event: {
        operator: { open_id: 'ou_user' },
        action: { value: { callback_data: 'qt:perm:abcd:allow' } },
        context: { open_chat_id: 'oc_default', open_message_id: 'om_x' },
      },
    })

    expect(r).toEqual({ toast: { type: 'error', content: expect.stringContaining('处理失败') } })
  })

  it('sendCard / replyWithCard delegate to apiClient', async () => {
    const { bot, apiClient } = makeBot()
    const card = { config: {}, elements: [] }

    await bot.sendCard({ chatId: 'oc_x', card })
    expect(apiClient.sendCard).toHaveBeenCalledWith({ chatId: 'oc_x', card })

    await bot.replyWithCard({ rootMessageId: 'om_y', card })
    expect(apiClient.replyWithCard).toHaveBeenCalledWith({ rootMessageId: 'om_y', card })
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

describe("adaptWizardResponseToLark (Lark card-callback shape adapter)", () => {
  it("wizard `{toast:string, action:permission_allow_sent}` → success toast", () => {
    expect(adaptWizardResponseToLark({ toast: "已发送 Enter", action: "permission_allow_sent" }))
      .toEqual({ toast: { type: "success", content: "已发送 Enter" } })
  })

  it("wizard `{toast:string, action:permission_deny_sent}` → info toast (deny ≠ failure)", () => {
    // 含 "sent" → success（用户主动操作成功完成）；这条用例锁现状
    expect(adaptWizardResponseToLark({ toast: "已发送 Esc", action: "permission_deny_sent" }))
      .toEqual({ toast: { type: "success", content: "已发送 Esc" } })
  })

  it("wizard `{toast:string, action:permission_session_stale}` → warning toast", () => {
    expect(adaptWizardResponseToLark({ toast: "会话已结束", action: "permission_session_stale" }))
      .toEqual({ toast: { type: "warning", content: "会话已结束" } })
  })

  it("wizard `{toast:string, action:handler_failed}` → error toast", () => {
    expect(adaptWizardResponseToLark({ toast: "炸了", action: "handler_failed" }))
      .toEqual({ toast: { type: "error", content: "炸了" } })
  })

  it("already-Lark `{toast:{content}}` 透传 + 默认 type=info", () => {
    expect(adaptWizardResponseToLark({ toast: { content: "hi" } }))
      .toEqual({ toast: { type: "info", content: "hi" } })
  })

  it("already-Lark `{toast:{type,content}}` 完全透传", () => {
    expect(adaptWizardResponseToLark({ toast: { type: "success", content: "yo" } }))
      .toEqual({ toast: { type: "success", content: "yo" } })
  })

  it("空/无 toast 文本 → undefined（Lark UI 不显 toast）", () => {
    expect(adaptWizardResponseToLark(null)).toBeUndefined()
    expect(adaptWizardResponseToLark(undefined)).toBeUndefined()
    expect(adaptWizardResponseToLark({})).toBeUndefined()
    expect(adaptWizardResponseToLark({ toast: "" })).toBeUndefined()
    expect(adaptWizardResponseToLark({ toast: "   " })).toBeUndefined()
  })
})

