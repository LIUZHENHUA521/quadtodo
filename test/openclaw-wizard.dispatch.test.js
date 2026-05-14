import { describe, it, expect, beforeEach, vi } from 'vitest'
import { openDb } from '../src/db.js'
import { createOpenClawWizard } from '../src/openclaw-wizard.js'
import { createPendingQuestionCoordinator } from '../src/pending-questions.js'

function makeFakeAi() {
  const sessions = []
  return {
    sessions,
    spawnSession({ sessionId, todoId, prompt, tool, cwd, label, permissionMode, extraEnv }) {
      sessions.push({ sessionId, todoId, prompt, tool, cwd, label, permissionMode, extraEnv })
      return { sessionId, reused: false }
    },
  }
}

function makeFakeBridge() {
  const routes = new Map()
  return {
    routes,
    isEnabled: () => true,
    registerSessionRoute: (sid, info) => routes.set(sid, info),
    postText: vi.fn(async () => ({ ok: true })),
  }
}

describe('openclaw-wizard dispatch resolution', () => {
  let db, wizard, ai, bridge, pending

  beforeEach(() => {
    db = openDb(':memory:')
    db.createTodo({ title: 'seed', quadrant: 1, workDir: '/tmp/foo' })
    ai = makeFakeAi()
    bridge = makeFakeBridge()
    pending = createPendingQuestionCoordinator({ db })
  })

  it('resolves tool=codex when dispatch.lark.perUser hits the inbound fromUserId', async () => {
    const cfg = {
      defaultCwd: '/tmp',
      port: 5677,
      dispatch: {
        lark: { default: 'claude', perUser: { 'open_a': 'codex' } },
        telegram: { default: 'claude' },
      },
    }
    wizard = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: bridge, pending,
      getConfig: () => cfg,
    })

    // Drive the wizard to completion: workdir hint + quadrant 1 + free template (option 6)
    let r = await wizard.handleInbound({
      channel: 'lark',
      chatId: 'oc_chat_x',
      fromUserId: 'open_a',
      text: '帮我做 写个 demo 目录 /tmp/foo',
    })
    expect(r.reply).toContain('🎯 选象限')

    r = await wizard.handleInbound({
      channel: 'lark',
      chatId: 'oc_chat_x',
      fromUserId: 'open_a',
      text: '1',
    })
    expect(r.reply).toContain('📋 选模板')

    r = await wizard.handleInbound({
      channel: 'lark',
      chatId: 'oc_chat_x',
      fromUserId: 'open_a',
      text: '6',
    })
    expect(r.action).toBe('wizard_done')
    expect(ai.sessions).toHaveLength(1)
    expect(ai.sessions[0].tool).toBe('codex')
  })

  it('telegram peer-bound dispatcher gets echoTarget.messageId from inbound', async () => {
    // 回归：曾经调用处用了未定义的 triggerMessageId，导致 dispatcher.send 整条挂掉
    const sid = 'sid_tg_peer'
    const inboundMessageId = 'tg_msg_42'
    const peer = '999000111'

    const dispatcher = {
      send: vi.fn(async () => ({ action: 'sent' })),
    }
    // pty: 有 sid 就能 write
    const pty = {
      has: (s) => s === sid,
      write: vi.fn(),
    }
    // openclaw: 已绑定 last-push session
    const bridgeWithLastPush = {
      ...bridge,
      getLastPushedSession: () => sid,
      // 让 announce-first-route 这条不带 todo 标题的逻辑稳走（不影响 dispatcher.send 调用断言）
      shouldAnnounceFirstRoute: () => false,
    }
    // aiTerminal 暴露一个空 sessions Map 即可，wizard 在 fallback c) 之前就命中 b) lastPush
    const aiWithSessions = {
      ...ai,
      sessions: new Map(),
      markSessionAwaitingReply: vi.fn(),
    }
    // loadingTracker 占位
    const loadingTracker = { markRunning: () => Promise.resolve() }

    wizard = createOpenClawWizard({
      db, aiTerminal: aiWithSessions, openclaw: bridgeWithLastPush, pending,
      pty, sessionInputDispatcher: dispatcher, loadingTracker,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677 }),
    })

    const r = await wizard.handleInbound({
      channel: 'telegram',
      chatId: peer,
      messageId: inboundMessageId,
      text: '继续推进一下',
    })

    expect(dispatcher.send).toHaveBeenCalledTimes(1)
    const arg = dispatcher.send.mock.calls[0][0]
    expect(arg.sessionId).toBe(sid)
    expect(arg.channel).toBe('telegram')
    expect(arg.echoTarget).toMatchObject({
      chatId: peer,
      messageId: inboundMessageId,
    })
    // 不应该回 dispatcher_error（即不应再触发 ReferenceError）
    expect(r.action).not.toBe('dispatcher_error')
  })

  it('falls back to channel default when fromUserId not in perUser', async () => {
    const cfg = {
      defaultCwd: '/tmp',
      port: 5677,
      dispatch: {
        lark: { default: 'codex' },
      },
    }
    wizard = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: bridge, pending,
      getConfig: () => cfg,
    })

    let r = await wizard.handleInbound({
      channel: 'lark',
      chatId: 'oc_chat_y',
      fromUserId: 'open_b',
      text: '帮我做 写个 demo 目录 /tmp/foo',
    })
    expect(r.reply).toContain('🎯 选象限')
    r = await wizard.handleInbound({ channel: 'lark', chatId: 'oc_chat_y', fromUserId: 'open_b', text: '1' })
    r = await wizard.handleInbound({ channel: 'lark', chatId: 'oc_chat_y', fromUserId: 'open_b', text: '6' })
    expect(r.action).toBe('wizard_done')
    expect(ai.sessions[0].tool).toBe('codex')
  })
})
