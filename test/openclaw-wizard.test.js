import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from '../src/db.js'
import { createOpenClawWizard, __test__ as internals } from '../src/openclaw-wizard.js'
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

describe('openclaw-wizard parsers', () => {
  it('extractTitle peels triggers and suffix hints', () => {
    expect(internals.extractTitle('帮我做 修复 login bug')).toContain('修复 login bug')
    expect(internals.extractTitle('在 quadtodo 里新建任务: 写一个 demo')).toBe('写一个 demo')
    expect(internals.extractTitle('新建任务: 重构 X，目录 ~/foo, 象限 1, bug 模板')).toBe('重构 X')
    expect(internals.extractTitle('任务：实现 Y')).toBe('实现 Y')
  })

  it('tryExtractWorkdir picks paths after 目录/路径/cwd', () => {
    expect(internals.tryExtractWorkdir('帮我做 X 目录 ~/foo')).toBe('~/foo')
    expect(internals.tryExtractWorkdir('cwd: /tmp/y')).toBe('/tmp/y')
    expect(internals.tryExtractWorkdir('帮我做 X')).toBeNull()
  })

  it('tryExtractQuadrant picks 1-4', () => {
    expect(internals.tryExtractQuadrant('象限 1')).toBe(1)
    expect(internals.tryExtractQuadrant('Q3')).toBe(3)
    expect(internals.tryExtractQuadrant('帮我做 X')).toBeNull()
    expect(internals.tryExtractQuadrant('象限 9')).toBeNull()
  })

  it('parseNumericChoice within range', () => {
    expect(internals.parseNumericChoice('1', 5)).toBe(0)
    expect(internals.parseNumericChoice('5', 5)).toBe(4)
    expect(internals.parseNumericChoice('6', 5)).toBeNull()
    expect(internals.parseNumericChoice('hi', 5)).toBeNull()
  })
})

describe('openclaw-wizard state machine', () => {
  let db, wizard, ai, bridge, pending

  beforeEach(() => {
    db = openDb(':memory:')
    db.createTodo({ title: 'seed', quadrant: 1, workDir: '/tmp/foo' })
    db.createTodo({ title: 'seed2', quadrant: 1, workDir: '/tmp/foo' })
    db.createTodo({ title: 'seed3', quadrant: 1, workDir: '/tmp/bar' })
    ai = makeFakeAi()
    bridge = makeFakeBridge()
    pending = createPendingQuestionCoordinator({ db })
    wizard = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: bridge, pending,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })
  })

  it('starts wizard on "帮我做 X" and prompts for workdir', async () => {
    const r = await wizard.handleInbound({ peer: 'u1', text: '帮我做 写个 demo' })
    expect(r.action).toBe('wizard_started')
    expect(r.reply).toContain('📁 选个工作目录')
    expect(r.reply).toContain('/tmp/foo')
  })

  it('full wizard flow: workdir → quadrant → template → done', async () => {
    let r
    r = await wizard.handleInbound({ peer: 'u1', text: '帮我做 写个 demo' })
    expect(r.reply).toContain('📁')

    r = await wizard.handleInbound({ peer: 'u1', text: '1' })
    expect(r.reply).toContain('🎯 选象限')

    r = await wizard.handleInbound({ peer: 'u1', text: '2' })
    expect(r.reply).toContain('📋 选模板')

    r = await wizard.handleInbound({ peer: 'u1', text: '6' }) // 自由模式
    expect(r.action).toBe('wizard_done')
    expect(r.reply).toContain('✅ todo')
    expect(r.reply).toContain('Q2')
    expect(ai.sessions).toHaveLength(1)
    expect(bridge.routes.size).toBe(1)
  })

  it('createForumTopic transient error: retries once before falling back to General', async () => {
    let attempts = 0
    const fakeBot = {
      createForumTopic: async () => {
        attempts++
        if (attempts === 1) {
          const err = new Error('fetch failed')
          throw err
        }
        return { message_thread_id: 999, name: '#tNNN test' }
      },
      sendMessage: async () => ({ message_id: 1 }),
      editForumTopic: async () => ({}),
    }
    const w2 = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: bridge, pending,
      pty: { has: () => false, write: () => {} },
      telegramBot: fakeBot,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude', telegram: { useTopics: true } }),
    })
    // 用 numeric chatId 触发 looksLikeTelegram=true 路径，one-shot 携带所有 hint
    const r = await w2.handleInbound({
      chatId: '-1001234567890',
      threadId: null,
      text: '帮我做 写个 demo, 目录 /tmp, 象限 2, Bug 修复 模板',
    })
    expect(r.action).toBe('wizard_done')
    expect(r.threadId).toBe(999)   // 重试后成功
    expect(attempts).toBe(2)
  }, 5000)

  it('new task with image attachments: prompt prepends @path1 @path2', async () => {
    const r = await wizard.handleInbound({
      peer: 'u1',
      text: '帮我做 看图实现, 目录 /tmp/foo, 象限 1, Bug 修复 模板',
      imagePaths: ['/tmp/img1.jpg', '/tmp/img2.png'],
    })
    expect(r.action).toBe('wizard_done')
    expect(ai.sessions).toHaveLength(1)
    const spawned = ai.sessions[0]
    expect(spawned.prompt).toMatch(/^@\/tmp\/img1\.jpg @\/tmp\/img2\.png/)
    expect(spawned.prompt).toContain('看图实现')
  })

  it('image accumulation: 多步 wizard 中陆续发图，finalize 时全部 attach', async () => {
    let r
    r = await wizard.handleInbound({ peer: 'u1', text: '帮我做 写个 demo', imagePaths: ['/tmp/a.jpg'] })
    expect(r.reply).toContain('📁')
    r = await wizard.handleInbound({ peer: 'u1', text: '1', imagePaths: ['/tmp/b.jpg'] })
    expect(r.reply).toContain('🎯 选象限')
    r = await wizard.handleInbound({ peer: 'u1', text: '2', imagePaths: ['/tmp/c.jpg'] })
    expect(r.reply).toContain('📋 选模板')
    r = await wizard.handleInbound({ peer: 'u1', text: '6' })
    expect(r.action).toBe('wizard_done')
    const spawned = ai.sessions[0]
    expect(spawned.prompt).toMatch(/^@\/tmp\/a\.jpg @\/tmp\/b\.jpg @\/tmp\/c\.jpg/)
  })

  it('one-shot create skips all wizard steps', async () => {
    const r = await wizard.handleInbound({
      peer: 'u1',
      text: '帮我做 修复 login，目录 /tmp/foo, 象限 1, Bug 修复 模板',
    })
    expect(r.action).toBe('wizard_done')
    expect(r.reply).toContain('Q1')
    expect(r.reply).toContain('/tmp/foo')
    expect(r.reply).toContain('Bug 修复')
    expect(ai.sessions).toHaveLength(1)
    expect(ai.sessions[0].permissionMode).toBe('bypass')
    expect(ai.sessions[0].extraEnv.QUADTODO_TARGET_USER).toBe('u1')
  })

  it('cancel mid-wizard aborts cleanly', async () => {
    await wizard.handleInbound({ peer: 'u1', text: '帮我做 X' })
    const r = await wizard.handleInbound({ peer: 'u1', text: '取消' })
    expect(r.action).toBe('wizard_cancelled')
    expect(wizard._peek('u1')).toBeNull()
  })

  it('invalid choice in workdir step re-prompts', async () => {
    await wizard.handleInbound({ peer: 'u1', text: '帮我做 X' })
    const r = await wizard.handleInbound({ peer: 'u1', text: 'hello' })
    expect(r.action).toBe('wizard_step')
    expect(r.reply).toContain('🤔')
    expect(r.reply).toContain('📁')
  })

  it('custom path in workdir step accepted', async () => {
    await wizard.handleInbound({ peer: 'u1', text: '帮我做 X' })
    const r = await wizard.handleInbound({ peer: 'u1', text: '/some/where' })
    expect(r.reply).toContain('🎯')
    expect(wizard._peek('u1').chosenWorkdir).toBe('/some/where')
  })

  it('quadrant default keyword resolves to Q2', async () => {
    await wizard.handleInbound({ peer: 'u1', text: '帮我做 X' })
    await wizard.handleInbound({ peer: 'u1', text: '1' })
    const r = await wizard.handleInbound({ peer: 'u1', text: '默认' })
    expect(r.reply).toContain('📋')
    expect(wizard._peek('u1').chosenQuadrant).toBe(2)
  })

  it('routes ask_user reply when no wizard active', async () => {
    pending.ask({ sessionId: 's1', question: 'q', options: ['a', 'b'] })
    const r = await wizard.handleInbound({ peer: 'u1', text: '1' })
    expect(r.action).toBe('ask_user_replied')
    expect(r.reply).toContain('✓ 已回复')
  })

  it('wizard takes priority over ask_user when both apply', async () => {
    pending.ask({ sessionId: 's1', question: 'q', options: ['a', 'b'] })
    await wizard.handleInbound({ peer: 'u1', text: '帮我做 X' })
    // Now reply "1" — should advance wizard, NOT route to pending
    const r = await wizard.handleInbound({ peer: 'u1', text: '1' })
    expect(r.action).toBe('wizard_step')
  })

  it('fallback when text matches nothing and no state', async () => {
    const r = await wizard.handleInbound({ peer: 'u1', text: 'random unrelated' })
    expect(r.action).toBe('fallback')
    expect(r.reply).toContain('🤔')
  })

  it('peers are isolated', async () => {
    await wizard.handleInbound({ peer: 'u1', text: '帮我做 X' })
    expect(wizard._peek('u1')).toBeTruthy()
    expect(wizard._peek('u2')).toBeNull()
    const r = await wizard.handleInbound({ peer: 'u2', text: '1' })
    // u2 has no wizard, no pending → fallback
    expect(r.action).toBe('fallback')
  })

  it('PTY stdin proxy: when peer has recent push and reply matches no other handler', async () => {
    const writes = []
    const fakePty = {
      has: (sid) => sid === 'sess-x',
      write: (sid, data) => writes.push({ sid, data }),
    }
    const fakeBridge = {
      ...bridge,
      getLastPushedSession: (peer) => peer === 'u1' ? 'sess-x' : null,
    }
    const w2 = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: fakeBridge, pending,
      pty: fakePty,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })
    const r = await w2.handleInbound({ peer: 'u1', text: 'c 用户登录失败提示账号不存在' })
    expect(r.action).toBe('stdin_proxy')
    expect(r.sessionId).toBe('sess-x')
    expect(r.reply).toBe('')   // 静默成功 — 不打扰用户，AI 回话由 Stop hook 单独推
    // 第一次写：只有正文，不带 \r
    expect(writes).toHaveLength(1)
    expect(writes[0].sid).toBe('sess-x')
    expect(writes[0].data).toBe('c 用户登录失败提示账号不存在')
    // 等 100ms 后会有第二次写：单独的 \r（让 TUI 把它当 Enter 按键处理）
    await new Promise(r => setTimeout(r, 120))
    expect(writes).toHaveLength(2)
    expect(writes[1].sid).toBe('sess-x')
    expect(writes[1].data).toBe('\r')
  })

  it('PTY stdin proxy: fallback to single active session when no recent push', async () => {
    const writes = []
    // fake aiTerminal with one running session
    const ai2 = {
      sessions: new Map([
        ['only-sess', { status: 'running', startedAt: Date.now(), lastOutputAt: Date.now() }],
      ]),
      spawnSession: ai.spawnSession,
    }
    const fakePty = { has: () => true, write: (sid, data) => writes.push({ sid, data }) }
    const fakeBridge = { ...bridge, getLastPushedSession: () => null }
    const w2 = createOpenClawWizard({
      db, aiTerminal: ai2, openclaw: fakeBridge, pending,
      pty: fakePty,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })
    const r = await w2.handleInbound({ peer: 'u1', text: 'c' })
    expect(r.action).toBe('stdin_proxy')
    expect(r.sessionId).toBe('only-sess')
    expect(r.reply).toBe('')
    expect(writes[0].data).toBe('c')
    await new Promise(r => setTimeout(r, 120))
    expect(writes[1].data).toBe('\r')
  })

  it('PTY stdin proxy: ambiguous when 2+ active sessions and no recent push', async () => {
    const writes = []
    const ai2 = {
      sessions: new Map([
        ['sess-a', { status: 'running', startedAt: Date.now() - 10000, lastOutputAt: Date.now() - 5000 }],
        ['sess-b', { status: 'pending_confirm', startedAt: Date.now() - 5000, lastOutputAt: Date.now() - 1000 }],
      ]),
    }
    const fakePty = { has: () => true, write: (sid, data) => writes.push({ sid, data }) }
    const fakeBridge = { ...bridge, getLastPushedSession: () => null }
    const w2 = createOpenClawWizard({
      db, aiTerminal: ai2, openclaw: fakeBridge, pending,
      pty: fakePty,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })
    const r = await w2.handleInbound({ peer: 'u1', text: 'c' })
    expect(r.action).toBe('stdin_proxy_ambiguous')
    expect(r.reply).toContain('多个活跃')
    expect(writes).toHaveLength(0)
  })

  it('detach command clears lastPushedSession for peer', async () => {
    let cleared = false
    const fakeBridge = {
      ...bridge,
      getLastPushedSession: () => 'sess-x',
      clearLastPushForPeer: (p) => { cleared = (p === 'u1'); return true },
    }
    const fakePty = { has: () => true, write: () => {} }
    const w2 = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: fakeBridge, pending,
      pty: fakePty,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })
    const r = await w2.handleInbound({ peer: 'u1', text: '退出' })
    expect(r.action).toBe('detached')
    expect(cleared).toBe(true)
    expect(r.reply).toContain('退出 PTY 直连')
  })

  it('detach when no link returns no_active_link', async () => {
    const fakeBridge = {
      ...bridge,
      getLastPushedSession: () => null,
      clearLastPushForPeer: () => false,
    }
    const w2 = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: fakeBridge, pending,
      pty: { has: () => true, write: () => {} },
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })
    const r = await w2.handleInbound({ peer: 'u1', text: 'exit' })
    expect(r.action).toBe('no_active_link')
  })

  it('detach in english "quit" / "bye" also works', async () => {
    let cleared = 0
    const fakeBridge = {
      ...bridge,
      getLastPushedSession: () => 'sess-x',
      clearLastPushForPeer: () => { cleared++; return true },
    }
    const w2 = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: fakeBridge, pending,
      pty: { has: () => true, write: () => {} },
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })
    for (const phrase of ['quit', 'bye', 'detach', '断开', '离开']) {
      cleared = 0
      const r = await w2.handleInbound({ peer: 'u1', text: phrase })
      expect(r.action).toBe('detached')
      expect(cleared).toBe(1)
    }
  })

  it('Telegram: handleInbound accepts {chatId, threadId, text} new shape', async () => {
    const r = await wizard.handleInbound({ chatId: '-1001234567890', threadId: 42, text: '帮我做 写个 demo' })
    expect(r.action).toBe('wizard_started')
    expect(r.reply).toContain('📁')
  })

  it('Telegram: per-thread wizard isolation', async () => {
    // 在 thread 42 启动 wizard
    await wizard.handleInbound({ chatId: '-100', threadId: 42, text: '帮我做 X' })
    // 在 thread 99 也启动（不影响 42）
    await wizard.handleInbound({ chatId: '-100', threadId: 99, text: '帮我做 Y' })
    // 在 thread 42 回 '1' 推进 X 的 wizard
    const r = await wizard.handleInbound({ chatId: '-100', threadId: 42, text: '1' })
    expect(r.action).toBe('wizard_step')
  })

  it('Telegram: finalizeWizard persists telegramRoute to DB.todo.aiSessions', async () => {
    const fakeTelegramBot = {
      createForumTopic: vi.fn(async () => ({ message_thread_id: 88 })),
      sendMessage: vi.fn(async () => ({ message_id: 1 })),
    }
    // 模拟真实 ai-terminal：spawnSession 会把 session entry 写入 db.todo.aiSessions
    const aiWithDb = {
      sessions: [],
      spawnSession({ sessionId, todoId, tool }) {
        this.sessions.push({ sessionId, todoId, tool })
        const t = db.getTodo(todoId)
        if (t) {
          const merged = [
            { sessionId, tool, status: 'running', startedAt: Date.now() },
            ...(t.aiSessions || []),
          ]
          db.updateTodo(todoId, { aiSessions: merged })
        }
        return { sessionId, reused: false }
      },
    }
    const w2 = createOpenClawWizard({
      db, aiTerminal: aiWithDb, openclaw: bridge, pending,
      telegramBot: fakeTelegramBot,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })
    const r = await w2.handleInbound({
      chatId: '-1003985889503',
      threadId: null,
      text: '帮我做 路由持久化测试，目录 /tmp/foo, 象限 2, Bug 修复 模板',
    })
    expect(r.action).toBe('wizard_done')
    const todo = db.getTodo(r.todoId)
    const aiSess = todo.aiSessions[0]
    expect(aiSess.telegramRoute).toBeTruthy()
    expect(aiSess.telegramRoute.threadId).toBe(88)
    expect(aiSess.telegramRoute.targetUserId).toBe('-1003985889503')
    expect(aiSess.telegramRoute.topicName).toContain('路由持久化测试')
  })

  it('Telegram: finalizeWizard creates Topic via telegramBot when one-shot', async () => {
    let topicCreated = null
    let welcomeMsg = null
    const fakeTelegramBot = {
      createForumTopic: vi.fn(async ({ chatId, name }) => {
        topicCreated = { chatId, name }
        return { message_thread_id: 777, name }
      }),
      sendMessage: vi.fn(async ({ chatId, threadId, text }) => {
        if (threadId === 777) welcomeMsg = { chatId, threadId, text }
        return { message_id: 1 }
      }),
    }
    const w2 = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: bridge, pending,
      telegramBot: fakeTelegramBot,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })
    const r = await w2.handleInbound({
      chatId: '-100',
      threadId: null,   // General topic
      text: '帮我做 修复 X，目录 /tmp/foo, 象限 1, Bug 修复 模板',
    })
    expect(r.action).toBe('wizard_done')
    expect(r.threadId).toBe(777)
    expect(topicCreated.chatId).toBe('-100')
    expect(topicCreated.name).toMatch(/^#t\w+ 修复 X/)
    expect(welcomeMsg).toBeTruthy()
    expect(welcomeMsg.text).toContain('AI 已启动')
    // 路由表登记的 sessionRoute 含 threadId
    const ses = ai.sessions[0]
    expect(bridge.routes.get(ses.sessionId).targetUserId).toBe('-100')
  })

  it('Telegram: stdin proxy uses findSessionByRoute when threadId set', async () => {
    let writes = []
    const fakePty = {
      has: () => true,
      write: (sid, data) => writes.push({ sid, data }),
    }
    const fakeBridge = {
      ...bridge,
      findSessionByRoute: ({ chatId, threadId }) =>
        (chatId === '-100' && threadId === 42) ? 'sess-task42' : null,
      getLastPushedSession: () => null,
    }
    const w2 = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: fakeBridge, pending,
      pty: fakePty,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })
    const r = await w2.handleInbound({ chatId: '-100', threadId: 42, text: 'c' })
    expect(r.action).toBe('stdin_proxy')
    expect(r.sessionId).toBe('sess-task42')
    expect(writes[0].sid).toBe('sess-task42')
  })

  it('PTY stdin proxy: pure fallback when no recent push and no active sessions', async () => {
    const writes = []
    const ai2 = { sessions: new Map() }
    const fakePty = { has: () => true, write: (sid, data) => writes.push({ sid, data }) }
    const fakeBridge = { ...bridge, getLastPushedSession: () => null }
    const w2 = createOpenClawWizard({
      db, aiTerminal: ai2, openclaw: fakeBridge, pending,
      pty: fakePty,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })
    const r = await w2.handleInbound({ peer: 'u1', text: 'arbitrary' })
    expect(r.action).toBe('fallback')
    expect(writes).toHaveLength(0)
  })

  it('ensureTopicForSession: creates topic + registers route + persists when none exists', async () => {
    const todo = db.createTodo({ title: 'auto-mirror', quadrant: 2, workDir: '/tmp' })
    db.updateTodo(todo.id, {
      aiSessions: [{ sessionId: 'sid-auto', tool: 'claude', status: 'running', startedAt: Date.now() }],
    })
    const fakeTelegramBot = {
      createForumTopic: vi.fn(async ({ name }) => ({ message_thread_id: 555, name })),
      sendMessage: vi.fn(async () => ({ message_id: 1 })),
    }
    bridge.resolveRoute = (sid) => bridge.routes.get(sid) || null
    const w2 = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: bridge, pending,
      telegramBot: fakeTelegramBot,
      getConfig: () => ({
        defaultCwd: '/tmp', port: 5677, defaultTool: 'claude',
        telegram: { defaultSupergroupId: '-1009', allowedChatIds: ['-1009'] },
      }),
    })
    const r = await w2.ensureTopicForSession({ sessionId: 'sid-auto', todoId: todo.id })
    expect(r.ok).toBe(true)
    expect(r.action).toBe('created')
    expect(r.threadId).toBe(555)
    expect(bridge.routes.get('sid-auto')).toMatchObject({ threadId: 555 })
    const persisted = db.getTodo(todo.id).aiSessions.find((s) => s.sessionId === 'sid-auto')
    expect(persisted.telegramRoute.threadId).toBe(555)
  })

  it('ensureTopicForSession: idempotent — already-bound returns no-op', async () => {
    const todo = db.createTodo({ title: 'auto-idem', quadrant: 2, workDir: '/tmp' })
    db.updateTodo(todo.id, {
      aiSessions: [{ sessionId: 'sid-idem', tool: 'claude', status: 'running', startedAt: Date.now() }],
    })
    bridge.routes.set('sid-idem', { targetUserId: '-100', threadId: 333, topicName: 'already' })
    bridge.resolveRoute = (sid) => bridge.routes.get(sid) || null
    const fakeTelegramBot = {
      createForumTopic: vi.fn(async () => ({ message_thread_id: 999 })),
      sendMessage: vi.fn(async () => ({})),
    }
    const w2 = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: bridge, pending,
      telegramBot: fakeTelegramBot,
      getConfig: () => ({ telegram: { defaultSupergroupId: '-100' } }),
    })
    const r = await w2.ensureTopicForSession({ sessionId: 'sid-idem', todoId: todo.id })
    expect(r.action).toBe('already_bound')
    expect(fakeTelegramBot.createForumTopic).not.toHaveBeenCalled()
  })

  it('ensureTopicForSession: re-registers from DB when bridge route lost (post-restart)', async () => {
    const todo = db.createTodo({ title: 'auto-rehyd', quadrant: 2, workDir: '/tmp' })
    db.updateTodo(todo.id, {
      aiSessions: [{
        sessionId: 'sid-rehyd', tool: 'claude', status: 'running', startedAt: Date.now(),
        telegramRoute: { targetUserId: '-100', threadId: 222, topicName: 'persisted', channel: 'telegram' },
      }],
    })
    bridge.resolveRoute = (sid) => bridge.routes.get(sid) || null  // empty bridge map
    const fakeTelegramBot = {
      createForumTopic: vi.fn(async () => ({ message_thread_id: 999 })),
      sendMessage: vi.fn(async () => ({})),
    }
    const w2 = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: bridge, pending,
      telegramBot: fakeTelegramBot,
      getConfig: () => ({ telegram: { defaultSupergroupId: '-100' } }),
    })
    const r = await w2.ensureTopicForSession({ sessionId: 'sid-rehyd', todoId: todo.id })
    expect(r.action).toBe('re-registered')
    expect(bridge.routes.get('sid-rehyd')).toMatchObject({ threadId: 222 })
    expect(fakeTelegramBot.createForumTopic).not.toHaveBeenCalled()
  })

  it('ensureTopicForSession: missing chatId → returns no_default_chat_id', async () => {
    const todo = db.createTodo({ title: 'no-chat', quadrant: 2, workDir: '/tmp' })
    db.updateTodo(todo.id, {
      aiSessions: [{ sessionId: 'sid-x', tool: 'claude', status: 'running' }],
    })
    bridge.resolveRoute = () => null
    const w2 = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: bridge, pending,
      telegramBot: { createForumTopic: vi.fn(), sendMessage: vi.fn() },
      getConfig: () => ({ telegram: {} }),  // no defaultSupergroupId, no allowedChatIds
    })
    const r = await w2.ensureTopicForSession({ sessionId: 'sid-x', todoId: todo.id })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('no_default_chat_id')
  })

  it('handleTopicEvent(closed): marks todo done, kills PTY, renames topic ✅', async () => {
    // 准备：建一条带 telegramRoute 的 todo
    const todo = db.createTodo({ title: 'close-me', quadrant: 2, workDir: '/tmp' })
    db.updateTodo(todo.id, {
      aiSessions: [{
        sessionId: 'sid-old',
        tool: 'claude',
        nativeSessionId: 'native-uuid-1',
        status: 'running',
        startedAt: Date.now(),
        telegramRoute: { targetUserId: '-100', threadId: 42, topicName: 't-close', channel: 'telegram' },
      }],
    })
    bridge.routes.set('sid-old', { targetUserId: '-100', threadId: 42, topicName: 't-close' })
    bridge.findSessionByRoute = ({ chatId, threadId }) => {
      for (const [sid, info] of bridge.routes) {
        if (String(info.targetUserId) === String(chatId) && info.threadId === threadId) return sid
      }
      return null
    }
    bridge.clearSessionRoute = (sid) => bridge.routes.delete(sid)
    const stops = []
    const edits = []
    const fakePty = { has: () => true, write: () => {}, stop: (sid) => stops.push(sid) }
    const fakeTelegramBot = {
      editForumTopic: vi.fn(async (a) => { edits.push(a); return {} }),
      sendMessage: vi.fn(async () => ({ message_id: 1 })),
    }
    const w2 = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: bridge, pending, pty: fakePty,
      telegramBot: fakeTelegramBot,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })
    const r = await w2.handleTopicEvent({ type: 'closed', chatId: '-100', threadId: 42 })
    expect(r.ok).toBe(true)
    expect(r.action).toBe('closed')
    expect(r.todoId).toBe(todo.id)
    expect(stops).toEqual(['sid-old'])
    expect(bridge.routes.has('sid-old')).toBe(false)
    const refreshed = db.getTodo(todo.id)
    expect(refreshed.status).toBe('done')
    expect(refreshed.completedAt).toBeTruthy()
    expect(edits[0].name).toBe('✅ t-close')
  })

  it('handleTopicEvent(reopened): respawns PTY, restores route, removes ✅', async () => {
    const todo = db.createTodo({ title: 'reopen-me', quadrant: 2, workDir: '/tmp' })
    db.updateTodo(todo.id, {
      status: 'done',
      aiSessions: [{
        sessionId: 'sid-old',
        tool: 'claude',
        nativeSessionId: 'native-uuid-2',
        status: 'done',
        startedAt: Date.now() - 60000,
        completedAt: Date.now() - 1000,
        telegramRoute: { targetUserId: '-100', threadId: 99, topicName: '✅ t-reopen', channel: 'telegram' },
      }],
    })
    const edits = []
    const sentMsgs = []
    const fakeTelegramBot = {
      editForumTopic: vi.fn(async (a) => { edits.push(a); return {} }),
      sendMessage: vi.fn(async (a) => { sentMsgs.push(a); return { message_id: 1 } }),
    }
    const w2 = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: bridge, pending,
      telegramBot: fakeTelegramBot,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })
    const r = await w2.handleTopicEvent({ type: 'reopened', chatId: '-100', threadId: 99 })
    expect(r.ok).toBe(true)
    expect(r.action).toBe('reopened')
    expect(r.sessionId).toMatch(/^ai-/)
    // 新 session 已注册路由
    expect(bridge.routes.get(r.sessionId)).toMatchObject({ threadId: 99, topicName: 't-reopen' })
    // ai-terminal 收到 spawn 调用
    expect(ai.sessions[ai.sessions.length - 1].todoId).toBe(todo.id)
    // todo 重置为 ai_running
    expect(db.getTodo(todo.id).status).toBe('ai_running')
    // 话题改回 't-reopen'（剥掉 ✅）
    expect(edits[0].name).toBe('t-reopen')
    expect(sentMsgs[0].text).toContain('已恢复')
  })

  it('handleTopicEvent(closed): sets userClosedReason on session so PTY done handler does not overwrite status', async () => {
    const todo = db.createTodo({ title: 'race-fix', quadrant: 2, workDir: '/tmp' })
    db.updateTodo(todo.id, {
      status: 'ai_running',
      aiSessions: [{
        sessionId: 'sid-race', tool: 'claude', nativeSessionId: 'nx', status: 'running',
        telegramRoute: { targetUserId: '-100', threadId: 70, topicName: 'r', channel: 'telegram' },
      }],
    })
    const liveSess = { sessionId: 'sid-race', todoId: todo.id, status: 'running' }
    bridge.routes.set('sid-race', { targetUserId: '-100', threadId: 70, topicName: 'r' })
    bridge.findSessionByRoute = ({ threadId }) => threadId === 70 ? 'sid-race' : null
    bridge.clearSessionRoute = (sid) => bridge.routes.delete(sid)
    ai.sessions = new Map([['sid-race', liveSess]])
    const fakePty = { has: () => true, stop: vi.fn() }
    const w2 = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: bridge, pending, pty: fakePty,
      telegramBot: { editForumTopic: vi.fn(async () => ({})) },
      getConfig: () => ({}),
    })
    const r = await w2.handleTopicEvent({ type: 'closed', chatId: '-100', threadId: 70 })
    expect(r.ok).toBe(true)
    // 关键：session 上挂了标记
    expect(liveSess.userClosedReason).toBe('topic_closed')
    // 且 todo 已 mark done
    expect(db.getTodo(todo.id).status).toBe('done')
    // pty.stop 被调用
    expect(fakePty.stop).toHaveBeenCalledWith('sid-race')
  })

  it('handleTopicEvent(closed): falls back to bridge in-memory route when DB has no telegramRoute', async () => {
    // 模拟：老 session（持久化 fix 之前建的），DB 里没 telegramRoute，但 bridge 内存有
    const todo = db.createTodo({ title: 'legacy-route', quadrant: 2, workDir: '/tmp' })
    db.updateTodo(todo.id, {
      status: 'ai_running',
      aiSessions: [{ sessionId: 'sid-legacy', tool: 'claude', nativeSessionId: 'native-x', status: 'running' }],
      // 注意：没 telegramRoute！
    })
    bridge.routes.set('sid-legacy', { targetUserId: '-100', threadId: 555, topicName: 'legacy-topic' })
    bridge.findSessionByRoute = ({ chatId, threadId }) => {
      for (const [sid, info] of bridge.routes) {
        if (String(info.targetUserId) === String(chatId) && info.threadId === threadId) return sid
      }
      return null
    }
    bridge.resolveRoute = (sid) => bridge.routes.get(sid) || null
    bridge.clearSessionRoute = (sid) => bridge.routes.delete(sid)
    // ai 需要 sessions Map（fakeAi 默认没有）
    ai.sessions = new Map([['sid-legacy', { todoId: todo.id, tool: 'claude', nativeSessionId: 'native-x' }]])
    const fakePty = { has: () => true, write: () => {}, stop: () => {} }
    const fakeTelegramBot = { editForumTopic: vi.fn(async () => ({})), sendMessage: vi.fn(async () => ({})) }
    const w2 = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: bridge, pending, pty: fakePty,
      telegramBot: fakeTelegramBot,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })
    const r = await w2.handleTopicEvent({ type: 'closed', chatId: '-100', threadId: 555 })
    expect(r.ok).toBe(true)
    expect(r.action).toBe('closed')
    expect(r.todoId).toBe(todo.id)
    expect(db.getTodo(todo.id).status).toBe('done')
  })

  it('handleTopicEvent: returns no_todo when threadId is unknown', async () => {
    const w2 = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: bridge, pending,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })
    const r = await w2.handleTopicEvent({ type: 'closed', chatId: '-100', threadId: 99999 })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('no_todo')
  })

  it('PTY stdin proxy: blocks interactive slash commands (/usage / /status etc.) with helpful reply', async () => {
    const writes = []
    const fakePty = { has: () => true, write: (sid, data) => writes.push({ sid, data }) }
    const fakeBridge = { ...bridge, getLastPushedSession: () => 'sess-x' }
    const w2 = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: fakeBridge, pending,
      pty: fakePty,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })
    for (const cmd of ['/usage', '/status', '/config', '/agents', '/skills', '/permissions', '/mcp', '/hooks', '/model', '/effort']) {
      const r = await w2.handleInbound({ peer: 'u1', text: cmd })
      expect(r.action).toBe('interactive_command_blocked')
      expect(r.blocked).toBe(cmd.slice(1))
      expect(r.reply).toContain('modal')
      expect(r.reply).toContain('esc')
    }
    expect(writes).toHaveLength(0)   // 一个字符都不写到 PTY
  })

  it('PTY stdin proxy: ESC trigger sends \\x1b to PTY (escape modal)', async () => {
    const writes = []
    const fakePty = { has: () => true, write: (sid, data) => writes.push({ sid, data }) }
    const fakeBridge = { ...bridge, getLastPushedSession: () => 'sess-x' }
    const w2 = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: fakeBridge, pending,
      pty: fakePty,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })
    for (const trig of ['esc', 'ESC', '退出菜单', 'cancel modal', 'cancel-modal']) {
      writes.length = 0
      const r = await w2.handleInbound({ peer: 'u1', text: trig })
      expect(r.action).toBe('stdin_proxy_esc')
      expect(r.sessionId).toBe('sess-x')
      expect(writes).toHaveLength(1)
      expect(writes[0].data).toBe('\x1b')   // 单字节 ESC，无 \r
    }
  })

  it('General channel safety: random text in supergroup General does NOT forward to any PTY', async () => {
    const writes = []
    const fakePty = { has: () => true, write: (sid, data) => writes.push({ sid, data }) }
    const fakeBridge = {
      ...bridge,
      // 故意有 lastPushedSession，验证 General 也不命中 (b)
      getLastPushedSession: () => 'sess-x',
    }
    const fakeAi = {
      sessions: new Map([
        // 故意有 1 个活跃 session，验证 General 也不命中 (c)
        ['only-sess', { status: 'running', startedAt: Date.now(), lastOutputAt: Date.now() }],
      ]),
      spawnSession: ai.spawnSession,
    }
    const w2 = createOpenClawWizard({
      db, aiTerminal: fakeAi, openclaw: fakeBridge, pending,
      pty: fakePty,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })
    // chatId 是 supergroup（-100 开头），threadId 空 → General
    const r = await w2.handleInbound({
      chatId: '-1003985889503',
      threadId: null,
      text: '小红书评论冷却时间应该改成怎样',
    })
    expect(r.action).toBe('fallback')
    expect(r.reason).toBe('general_channel_no_intent')
    expect(r.reply).toContain('污染')
    expect(writes).toHaveLength(0)   // 一个字节都不写到任何 PTY
  })

  it('Topic channel: same input WOULD forward (only General is restricted)', async () => {
    // 验证保护范围只针对 General —— topic 内仍然走 stdin proxy
    const writes = []
    const fakePty = { has: () => true, write: (sid, data) => writes.push({ sid, data }) }
    const fakeBridge = {
      ...bridge,
      getLastPushedSession: () => 'sess-x',
      findSessionByRoute: ({ chatId, threadId }) => threadId === 42 ? 'sess-in-topic' : null,
    }
    const fakeAi = {
      sessions: new Map([
        ['sess-in-topic', { status: 'running', startedAt: Date.now(), lastOutputAt: Date.now() }],
      ]),
      spawnSession: ai.spawnSession,
    }
    const w2 = createOpenClawWizard({
      db, aiTerminal: fakeAi, openclaw: fakeBridge, pending,
      pty: { has: () => true, write: (sid, data) => writes.push({ sid, data }) },
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })
    const r = await w2.handleInbound({
      chatId: '-1003985889503',
      threadId: 42,                  // ← 在某 topic 里发
      text: '继续',
    })
    expect(r.action).toBe('stdin_proxy')
    expect(r.sessionId).toBe('sess-in-topic')
    expect(writes.length).toBeGreaterThanOrEqual(1)
  })

  it('Private DM safety: stdin proxy still works in 1:1 chat (positive chatId, no topics)', async () => {
    // 用户跟 bot 直接 DM 时，没有 topic 概念 —— stdin proxy 不该被 General 保护误伤
    const writes = []
    const fakePty = { has: () => true, write: (sid, data) => writes.push({ sid, data }) }
    const fakeBridge = { ...bridge, getLastPushedSession: () => 'sess-x' }
    const fakeAi = {
      sessions: new Map([
        ['sess-x', { status: 'running', startedAt: Date.now(), lastOutputAt: Date.now() }],
      ]),
      spawnSession: ai.spawnSession,
    }
    const w2 = createOpenClawWizard({
      db, aiTerminal: fakeAi, openclaw: fakeBridge, pending,
      pty: fakePty,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })
    // 1:1 DM：chatId 是正数（非 supergroup），threadId 空但**不是** General
    const r = await w2.handleInbound({
      chatId: '12345',
      threadId: null,
      text: '继续',
    })
    expect(r.action).toBe('stdin_proxy')
    expect(writes.length).toBeGreaterThanOrEqual(1)
  })

  it('PTY stdin proxy: INTERRUPT trigger sends \\x03 (Ctrl+C) to PTY', async () => {
    const writes = []
    const fakePty = { has: () => true, write: (sid, data) => writes.push({ sid, data }) }
    const fakeBridge = { ...bridge, getLastPushedSession: () => 'sess-x' }
    const w2 = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: fakeBridge, pending,
      pty: fakePty,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })
    for (const trig of ['中断', '打断', '停一下', '^C', '^c', 'ctrl+c', 'Ctrl-C', 'ctrlc', 'interrupt']) {
      writes.length = 0
      const r = await w2.handleInbound({ peer: 'u1', text: trig })
      expect(r.action, `trigger="${trig}"`).toBe('stdin_proxy_interrupt')
      expect(r.sessionId).toBe('sess-x')
      expect(writes).toHaveLength(1)
      expect(writes[0].data).toBe('\x03')   // 单字节 Ctrl+C
    }
  })

  it('PTY stdin proxy: "中断xxx" (extra text after) is NOT interrupted, just normal text', async () => {
    const writes = []
    const fakePty = { has: () => true, write: (sid, data) => writes.push({ sid, data }) }
    const fakeBridge = { ...bridge, getLastPushedSession: () => 'sess-x' }
    const w2 = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: fakeBridge, pending,
      pty: fakePty,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })
    // "请中断这个分析任务" → 不该当作 interrupt，整句送 PTY
    const r = await w2.handleInbound({ peer: 'u1', text: '请中断这个分析任务' })
    expect(r.action).toBe('stdin_proxy')
    expect(writes[0].data).toBe('请中断这个分析任务')
  })

  it('PTY stdin proxy: non-interactive slash commands still pass through (e.g. /clear)', async () => {
    const writes = []
    const fakePty = { has: () => true, write: (sid, data) => writes.push({ sid, data }) }
    const fakeBridge = { ...bridge, getLastPushedSession: () => 'sess-x' }
    const w2 = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: fakeBridge, pending,
      pty: fakePty,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })
    const r = await w2.handleInbound({ peer: 'u1', text: '/clear' })
    expect(r.action).toBe('stdin_proxy')
    expect(writes[0].data).toBe('/clear')
  })

  it('PTY stdin proxy: image attach — writes "@path caption" to PTY', async () => {
    const writes = []
    const fakePty = { has: () => true, write: (sid, data) => writes.push({ sid, data }) }
    const fakeBridge = { ...bridge, getLastPushedSession: () => 'sess-x' }
    const w2 = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: fakeBridge, pending,
      pty: fakePty,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })
    const r = await w2.handleInbound({
      peer: 'u1',
      text: '看图实现这个布局',
      imagePaths: ['/tmp/img1.jpg'],
    })
    expect(r.action).toBe('stdin_proxy')
    expect(r.imagePaths).toEqual(['/tmp/img1.jpg'])
    expect(writes[0].data).toBe('@/tmp/img1.jpg 看图实现这个布局')
  })

  it('PTY stdin proxy: multi-image album — writes "@p1 @p2 caption"', async () => {
    const writes = []
    const fakePty = { has: () => true, write: (sid, data) => writes.push({ sid, data }) }
    const fakeBridge = { ...bridge, getLastPushedSession: () => 'sess-x' }
    const w2 = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: fakeBridge, pending,
      pty: fakePty,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })
    const r = await w2.handleInbound({
      peer: 'u1',
      text: '对比这两张',
      imagePaths: ['/tmp/a.jpg', '/tmp/b.jpg'],
    })
    expect(r.action).toBe('stdin_proxy')
    expect(writes[0].data).toBe('@/tmp/a.jpg @/tmp/b.jpg 对比这两张')
  })

  it('PTY stdin proxy: image only (no caption) — writes "@path"', async () => {
    const writes = []
    const fakePty = { has: () => true, write: (sid, data) => writes.push({ sid, data }) }
    const fakeBridge = { ...bridge, getLastPushedSession: () => 'sess-x' }
    const w2 = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: fakeBridge, pending,
      pty: fakePty,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })
    const r = await w2.handleInbound({
      peer: 'u1',
      text: '',
      imagePaths: ['/tmp/x.png'],
    })
    expect(r.action).toBe('stdin_proxy')
    expect(writes[0].data).toBe('@/tmp/x.png')
  })

  it('General channel safety: image+caption in General is also blocked (consistent)', async () => {
    const writes = []
    const fakePty = { has: () => true, write: (sid, data) => writes.push({ sid, data }) }
    const fakeBridge = { ...bridge, getLastPushedSession: () => 'sess-x' }
    const fakeAi = {
      sessions: new Map([['sess-x', { status: 'running', startedAt: Date.now(), lastOutputAt: Date.now() }]]),
      spawnSession: ai.spawnSession,
    }
    const w2 = createOpenClawWizard({
      db, aiTerminal: fakeAi, openclaw: fakeBridge, pending,
      pty: fakePty,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })
    const r = await w2.handleInbound({
      chatId: '-1003985889503',     // supergroup
      threadId: null,                // General
      text: '看图',
      imagePaths: ['/tmp/leak.jpg'],
    })
    expect(r.action).toBe('fallback')
    expect(r.reason).toBe('general_channel_no_intent')
    expect(writes).toHaveLength(0)   // 图片路径绝不能写到任何 PTY
  })

  it('PTY stdin proxy yields to wizard / ask_user / new-task triggers', async () => {
    const writes = []
    const fakePty = { has: () => true, write: (sid, data) => writes.push({ sid, data }) }
    const fakeBridge = { ...bridge, getLastPushedSession: () => 'sess-x' }
    const w2 = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: fakeBridge, pending,
      pty: fakePty,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })
    // 即便有 last push，"帮我做 X" 还是走 wizard 启动
    const r = await w2.handleInbound({ peer: 'u1', text: '帮我做 X' })
    expect(r.action).toBe('wizard_started')
    expect(writes).toHaveLength(0)
  })
})

describe('listWorkdirOptions: 默认目录 + 子目录', () => {
  let tmpRoot, db, wizard, ai, bridge, pending

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'qt-wizard-'))
    mkdirSync(join(tmpRoot, 'projA'))
    mkdirSync(join(tmpRoot, 'projB'))
    mkdirSync(join(tmpRoot, 'projC'))
    mkdirSync(join(tmpRoot, '.hidden'))   // 隐藏目录应该被过滤
    db = openDb(':memory:')
    ai = makeFakeAi()
    bridge = makeFakeBridge()
    pending = createPendingQuestionCoordinator({ db })
    wizard = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: bridge, pending,
      getConfig: () => ({ defaultCwd: tmpRoot, port: 5677, defaultTool: 'claude' }),
    })
  })

  afterEach()
  function afterEach() {
    try { rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
  }

  it('reply 包含默认目录本身 + 所有 1 级子目录', async () => {
    const r = await wizard.handleInbound({ peer: 'u1', text: '帮我做 写个 demo' })
    expect(r.action).toBe('wizard_started')
    expect(r.reply).toContain(tmpRoot)
    expect(r.reply).toContain(join(tmpRoot, 'projA'))
    expect(r.reply).toContain(join(tmpRoot, 'projB'))
    expect(r.reply).toContain(join(tmpRoot, 'projC'))
  })

  it('过滤隐藏目录（.hidden 不应出现）', async () => {
    const r = await wizard.handleInbound({ peer: 'u1', text: '帮我做 X' })
    expect(r.reply).not.toContain('.hidden')
  })

  it('默认目录用"默认目录"标签，子目录用"子目录"标签', async () => {
    const r = await wizard.handleInbound({ peer: 'u1', text: '帮我做 X' })
    expect(r.reply).toContain('(默认目录)')
    expect(r.reply).toContain('(子目录)')
  })

  it('选 2 = 第一个子目录 → 进入下一步', async () => {
    await wizard.handleInbound({ peer: 'u1', text: '帮我做 X' })
    const r = await wizard.handleInbound({ peer: 'u1', text: '2' })
    expect(r.reply).toContain('🎯 选象限')
    expect(wizard._peek('u1').chosenWorkdir).toBe(join(tmpRoot, 'projA'))
  })
})

// ─── inline keyboard / callback path ────────────────────────────────────────
//
// 设计要点：
//  - 数字回答路径完全保留（双轨）；现有"回 1/2/3"测试已经覆盖
//  - callback 路径走 handleCallback({chatId, threadId, callbackData, ...})
//  - 每个非终态 prompt（workdir / quadrant / template）都同时返回 reply + replyMarkup
//  - 自定义路径走子态 awaitingCustomWorkdir：下一条任意非空文本都当路径
describe('openclaw-wizard inline keyboard (callback_query)', () => {
  let db, wizard, ai, bridge, pending

  beforeEach(() => {
    db = openDb(':memory:')
    db.createTodo({ title: 'seed', quadrant: 1, workDir: '/tmp/foo' })
    ai = makeFakeAi()
    bridge = makeFakeBridge()
    pending = createPendingQuestionCoordinator({ db })
    wizard = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: bridge, pending,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })
  })

  it('handleInbound prompts include replyMarkup with valid callback_data', async () => {
    const r = await wizard.handleInbound({ chatId: '-100', threadId: null, text: '帮我做 X' })
    expect(r.action).toBe('wizard_started')
    expect(r.reply).toContain('📁 选个工作目录')
    expect(r.replyMarkup).toBeTruthy()
    expect(r.replyMarkup.inline_keyboard).toBeInstanceOf(Array)
    // 第一行 = 第一个目录 → callback_data = qt:wd:0
    expect(r.replyMarkup.inline_keyboard[0][0].callback_data).toBe('qt:wd:0')
    // 最后一行 = 自定义路径
    const lastRow = r.replyMarkup.inline_keyboard.at(-1)
    expect(lastRow[0].callback_data).toBe('qt:wd:custom')
  })

  it('full callback flow: pick wd → q → t → todo created', async () => {
    // step 0: trigger wizard
    const start = await wizard.handleInbound({ chatId: '-100', threadId: null, text: '帮我做 callback demo' })
    expect(start.action).toBe('wizard_started')

    // step 1: 点目录第一个
    const r1 = await wizard.handleCallback({
      chatId: '-100', threadId: null,
      callbackData: 'qt:wd:0', callbackMessageId: 11,
    })
    expect(r1.action).toBe('wizard_step')
    expect(r1.chosenLabel).toBeTruthy()
    expect(r1.reply).toContain('🎯 选象限')
    expect(r1.replyMarkup.inline_keyboard).toHaveLength(2)

    // step 2: 点 Q1
    const r2 = await wizard.handleCallback({
      chatId: '-100', threadId: null,
      callbackData: 'qt:q:1', callbackMessageId: 12,
    })
    expect(r2.action).toBe('wizard_step')
    expect(r2.chosenLabel).toMatch(/^Q1/)
    expect(r2.reply).toContain('📋 选模板')

    // step 3: 自由模式
    const r3 = await wizard.handleCallback({
      chatId: '-100', threadId: null,
      callbackData: 'qt:t:none', callbackMessageId: 13,
    })
    expect(r3.action).toBe('wizard_done')
    expect(r3.chosenLabel).toBe('自由模式')
    expect(r3.reply).toContain('✅ todo')
    expect(ai.sessions).toHaveLength(1)
  })

  it('callback "qt:wd:custom" enters awaiting subtate; next text becomes path', async () => {
    await wizard.handleInbound({ chatId: '-100', threadId: null, text: '帮我做 X' })

    const cb = await wizard.handleCallback({
      chatId: '-100', threadId: null,
      callbackData: 'qt:wd:custom', callbackMessageId: 22,
    })
    expect(cb.action).toBe('wizard_custom_workdir')
    expect(cb.reply).toContain('请直接输入完整路径')

    // 子态：下一条任意文本（不再要求 / 或 ~ 开头）
    const r = await wizard.handleInbound({ chatId: '-100', threadId: null, text: 'my-folder' })
    expect(r.action).toBe('wizard_step')
    expect(r.reply).toContain('🎯 选象限')
    expect(r.replyMarkup).toBeTruthy()
    expect(wizard._peek(`-100:general`).chosenWorkdir).toBe('my-folder')
    expect(wizard._peek(`-100:general`).awaitingCustomWorkdir).toBe(false)
  })

  it('callback for wrong step: returns toast, does NOT advance wizard', async () => {
    await wizard.handleInbound({ chatId: '-100', threadId: null, text: '帮我做 X' })
    // 处于 STEP_WORKDIR，却收到 quadrant callback
    const r = await wizard.handleCallback({
      chatId: '-100', threadId: null,
      callbackData: 'qt:q:1', callbackMessageId: 33,
    })
    expect(r.action).toBe('invalid')
    expect(r.toast).toBeTruthy()
    expect(wizard._peek('-100:general').step).toBe('workdir')
  })

  it('callback when no wizard active: returns expired toast', async () => {
    const r = await wizard.handleCallback({
      chatId: '-100', threadId: null,
      callbackData: 'qt:wd:0', callbackMessageId: 44,
    })
    expect(r.action).toBe('expired')
    expect(r.toast).toContain('超时')
  })

  it('callback with invalid index: returns toast, no state mutation', async () => {
    await wizard.handleInbound({ chatId: '-100', threadId: null, text: '帮我做 X' })
    const w = wizard._peek('-100:general')
    const beforeStep = w.step

    const r = await wizard.handleCallback({
      chatId: '-100', threadId: null,
      callbackData: 'qt:wd:9999', callbackMessageId: 55,
    })
    expect(r.action).toBe('invalid')
    expect(wizard._peek('-100:general').step).toBe(beforeStep)
  })

  it('mixed flow: button for step 1, number reply for step 2 — both work', async () => {
    await wizard.handleInbound({ chatId: '-100', threadId: null, text: '帮我做 hybrid' })
    // 按按钮选目录
    await wizard.handleCallback({
      chatId: '-100', threadId: null,
      callbackData: 'qt:wd:0', callbackMessageId: 1,
    })
    // 回数字选象限
    const r = await wizard.handleInbound({ chatId: '-100', threadId: null, text: '2' })
    expect(r.action).toBe('wizard_step')
    expect(r.reply).toContain('📋 选模板')
    expect(r.replyMarkup).toBeTruthy()
  })

  it('quadrant prompt has 2x2 layout with Q2 marked default', () => {
    const markup = internals.buildQuadrantReplyMarkup()
    expect(markup.inline_keyboard).toHaveLength(2)
    expect(markup.inline_keyboard[0]).toHaveLength(2)
    expect(markup.inline_keyboard[0][1].text).toContain('✓')   // Q2 默认
    expect(markup.inline_keyboard[0][0].callback_data).toBe('qt:q:1')
    expect(markup.inline_keyboard[1][1].callback_data).toBe('qt:q:4')
  })

  it('callback prefix is qt and all callback_data ≤ 64 bytes', async () => {
    await wizard.handleInbound({ chatId: '-100', threadId: null, text: '帮我做 X' })
    const w = wizard._peek('-100:general')
    const wdMarkup = internals.buildWorkdirReplyMarkup(w.workdirOptions)
    for (const row of wdMarkup.inline_keyboard) {
      for (const btn of row) {
        expect(btn.callback_data.startsWith('qt:')).toBe(true)
        // Telegram 硬限：≤ 64 字节
        expect(Buffer.byteLength(btn.callback_data, 'utf8')).toBeLessThanOrEqual(64)
      }
    }
  })
})

// ─── /list /pending /stop —— quadtodo 全局 slash command ───────────────────
//
// 关键属性：
//  - 仅在 supergroup 的 General 频道（chatId=-100… + threadId=null）响应
//  - task topic 里发会被拦截 + 提示去 General，不会被 PTY proxy 转发
//  - /list 和 /pending 同义
//  - /stop 不带参 = 列活跃；带前缀 = 匹配停；'all' = 停全部
describe('openclaw-wizard /list /pending /stop slash commands', () => {
  let db, wizard, ai, bridge, pending, ptyStops
  const SUPERGROUP_ID = '-1001234567890'
  const GENERAL = { chatId: SUPERGROUP_ID, threadId: null }
  const TOPIC = { chatId: SUPERGROUP_ID, threadId: 99 }

  function makeFakePty(stops) {
    return {
      has: () => true,
      write: () => {},
      stop: (sid) => { stops.push(sid) },
    }
  }

  beforeEach(() => {
    db = openDb(':memory:')
    ai = makeFakeAi()
    // sessions 是 Map，模拟 in-memory 活跃 session 状态
    ai.sessions = new Map()
    bridge = makeFakeBridge()
    bridge.findSessionByRoute = () => null
    bridge.clearSessionRoute = () => {}
    pending = createPendingQuestionCoordinator({ db })
    ptyStops = []
    wizard = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: bridge, pending,
      pty: makeFakePty(ptyStops),
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })
  })

  // ─── /list / /pending ──────────────────────────────────────────────────
  it('/list in General: shows empty hint when no todos', async () => {
    const r = await wizard.handleInbound({ ...GENERAL, text: '/list' })
    expect(r.action).toBe('slash_list')
    expect(r.reply).toContain('暂无待办')
  })

  it('/list in General: groups todos by quadrant; /pending is alias', async () => {
    db.createTodo({ title: '紧急 bug', quadrant: 1, workDir: '/tmp/proj' })
    db.createTodo({ title: '重要功能', quadrant: 2, workDir: '/tmp/proj' })
    db.createTodo({ title: '杂事', quadrant: 4, workDir: '/tmp/foo' })

    const r1 = await wizard.handleInbound({ ...GENERAL, text: '/list' })
    expect(r1.action).toBe('slash_list')
    expect(r1.count).toBe(3)
    expect(r1.reply).toContain('待办 (3)')
    expect(r1.reply).toContain('Q1 重要紧急')
    expect(r1.reply).toContain('紧急 bug')
    expect(r1.reply).toContain('Q2 重要不紧急')
    expect(r1.reply).toContain('Q4 不重要不紧急')
    expect(r1.reply).toContain('proj')   // basename(workDir)

    const r2 = await wizard.handleInbound({ ...GENERAL, text: '/pending' })
    expect(r2.action).toBe('slash_list')
    expect(r2.reply).toBe(r1.reply)   // 同义
  })

  it('/list marks running sessions with 🟢', async () => {
    const t = db.createTodo({ title: '跑着的任务', quadrant: 1, workDir: '/tmp' })
    db.updateTodo(t.id, {
      aiSessions: [{ sessionId: 'sess-running', status: 'running', startedAt: Date.now() }],
    })
    ai.sessions.set('sess-running', { status: 'running', startedAt: Date.now(), lastOutputAt: Date.now() })

    const r = await wizard.handleInbound({ ...GENERAL, text: '/list' })
    expect(r.reply).toContain('🟢')
    expect(r.reply).toContain('跑着的任务')
  })

  it('/list in task topic: blocked + hint to use General', async () => {
    db.createTodo({ title: 'x', quadrant: 1, workDir: '/tmp' })
    const r = await wizard.handleInbound({ ...TOPIC, text: '/list' })
    expect(r.action).toBe('slash_wrong_topic')
    expect(r.blockedCommand).toBe('list')
    expect(r.reply).toContain('General')
    expect(r.reply).toContain('/list')
  })

  it('/pending in task topic: also blocked', async () => {
    const r = await wizard.handleInbound({ ...TOPIC, text: '/pending' })
    expect(r.action).toBe('slash_wrong_topic')
    expect(r.blockedCommand).toBe('pending')
  })

  // ─── /stop ─────────────────────────────────────────────────────────────
  it('/stop with no active sessions: friendly noop', async () => {
    const r = await wizard.handleInbound({ ...GENERAL, text: '/stop' })
    expect(r.action).toBe('slash_stop_noop')
    expect(r.reply).toContain('没有正在跑')
  })

  it('/stop without arg: lists active sessions with short codes + hints', async () => {
    const t1 = db.createTodo({ title: 'task A', quadrant: 1, workDir: '/tmp' })
    const t2 = db.createTodo({ title: 'task B', quadrant: 2, workDir: '/tmp' })
    db.updateTodo(t1.id, { aiSessions: [{ sessionId: 'ai-aaaa1234', status: 'running', startedAt: Date.now() }] })
    db.updateTodo(t2.id, { aiSessions: [{ sessionId: 'ai-bbbb5678', status: 'running', startedAt: Date.now() }] })
    ai.sessions.set('ai-aaaa1234', { status: 'running', startedAt: Date.now(), lastOutputAt: Date.now() - 5000 })
    ai.sessions.set('ai-bbbb5678', { status: 'running', startedAt: Date.now(), lastOutputAt: Date.now() })

    const r = await wizard.handleInbound({ ...GENERAL, text: '/stop' })
    expect(r.action).toBe('slash_stop_list')
    expect(r.activeCount).toBe(2)
    expect(r.reply).toContain('aaaa1234')
    expect(r.reply).toContain('bbbb5678')
    expect(r.reply).toContain('task A')
    expect(r.reply).toContain('task B')
    expect(r.reply).toContain('/stop <短码>')
    expect(r.reply).toContain('/stop all')
  })

  it('/stop <prefix>: stops the matching session, marks aiSession.status="stopped", does not change todo.status', async () => {
    const t = db.createTodo({ title: 'stop me', quadrant: 1, workDir: '/tmp' })
    db.updateTodo(t.id, { aiSessions: [{ sessionId: 'ai-target99', status: 'running', startedAt: Date.now() }] })
    ai.sessions.set('ai-target99', { status: 'running', startedAt: Date.now(), lastOutputAt: Date.now() })

    const r = await wizard.handleInbound({ ...GENERAL, text: '/stop target99' })   // 完整短码（最后8位）
    expect(r.action).toBe('slash_stop_done')
    expect(r.stoppedCount).toBe(1)
    expect(r.stoppedSids).toEqual(['ai-target99'])
    expect(ptyStops).toEqual(['ai-target99'])

    const after = db.getTodo(t.id)
    expect(after.status).not.toBe('done')   // todo 状态不动
    expect(after.aiSessions[0].status).toBe('stopped')
    expect(after.aiSessions[0].stopReason).toBe('slash_stop')

    // userClosedReason 应该被打到 in-memory session 上 → PTY done handler 不会覆写
    expect(ai.sessions.get('ai-target99').userClosedReason).toBe('slash_stop')
  })

  it('/stop <prefix>: short prefix (4 chars) works as long as unique', async () => {
    const t = db.createTodo({ title: 'x', quadrant: 1, workDir: '/tmp' })
    db.updateTodo(t.id, { aiSessions: [{ sessionId: 'ai-xy12abcd', status: 'running', startedAt: Date.now() }] })
    ai.sessions.set('ai-xy12abcd', { status: 'running', startedAt: Date.now(), lastOutputAt: Date.now() })

    const r = await wizard.handleInbound({ ...GENERAL, text: '/stop xy12' })
    expect(r.action).toBe('slash_stop_done')
    expect(r.stoppedSids).toEqual(['ai-xy12abcd'])
  })

  it('/stop <prefix>: no match → friendly hint', async () => {
    ai.sessions.set('ai-other001', { status: 'running', startedAt: Date.now(), lastOutputAt: Date.now() })
    const r = await wizard.handleInbound({ ...GENERAL, text: '/stop nomatch' })
    expect(r.action).toBe('slash_stop_no_match')
    expect(r.reply).toContain('没找到')
    expect(ptyStops).toEqual([])
  })

  it('/stop <prefix>: ambiguous (matches multiple) → asks for longer code, does not stop anything', async () => {
    ai.sessions.set('ai-aabb1111', { status: 'running', startedAt: Date.now(), lastOutputAt: Date.now() })
    ai.sessions.set('ai-aabb2222', { status: 'running', startedAt: Date.now(), lastOutputAt: Date.now() })
    const r = await wizard.handleInbound({ ...GENERAL, text: '/stop aabb' })
    expect(r.action).toBe('slash_stop_ambiguous')
    expect(ptyStops).toEqual([])
    expect(r.reply).toContain('aabb1111')
    expect(r.reply).toContain('aabb2222')
  })

  it('/stop all: stops every active session', async () => {
    const t1 = db.createTodo({ title: 'a', quadrant: 1, workDir: '/tmp' })
    const t2 = db.createTodo({ title: 'b', quadrant: 2, workDir: '/tmp' })
    db.updateTodo(t1.id, { aiSessions: [{ sessionId: 'ai-zzz11111', status: 'running', startedAt: Date.now() }] })
    db.updateTodo(t2.id, { aiSessions: [{ sessionId: 'ai-zzz22222', status: 'running', startedAt: Date.now() }] })
    ai.sessions.set('ai-zzz11111', { status: 'running', startedAt: Date.now(), lastOutputAt: Date.now() })
    ai.sessions.set('ai-zzz22222', { status: 'pending_confirm', startedAt: Date.now(), lastOutputAt: Date.now() })

    const r = await wizard.handleInbound({ ...GENERAL, text: '/stop all' })
    expect(r.action).toBe('slash_stop_done')
    expect(r.stoppedCount).toBe(2)
    expect(ptyStops.sort()).toEqual(['ai-zzz11111', 'ai-zzz22222'])
  })

  it('/stop in task topic: blocked + hint, no pty.stop called', async () => {
    ai.sessions.set('ai-anything', { status: 'running', startedAt: Date.now(), lastOutputAt: Date.now() })
    const r = await wizard.handleInbound({ ...TOPIC, text: '/stop all' })
    expect(r.action).toBe('slash_wrong_topic')
    expect(r.blockedCommand).toBe('stop')
    expect(ptyStops).toEqual([])   // 没真停
  })

  // ─── 边界：非 supergroup（旧 weixin / 私聊）chatId 不响应 quadtodo slash ──
  it('non-supergroup chatId (e.g. weixin peer "u1"): /list NOT recognized; falls through', async () => {
    const r = await wizard.handleInbound({ peer: 'u1', text: '/list' })
    expect(r.action).not.toBe('slash_list')
    expect(r.action).not.toBe('slash_wrong_topic')
    // 走的是 fallback 或 PTY proxy（取决于环境），关键是不被当 quadtodo 命令处理
  })

  // ─── 与 wizard 共存：/list 在 wizard 进行中也能用，且不破坏 wizard 状态 ──
  it('/list while wizard active: shows list, wizard state preserved', async () => {
    db.createTodo({ title: 'pre-existing', quadrant: 1, workDir: '/tmp' })
    // 先启动 wizard
    await wizard.handleInbound({ ...GENERAL, text: '帮我做 新任务' })
    expect(wizard._peek(`${SUPERGROUP_ID}:general`)).toBeTruthy()

    // 中途 /list
    const r = await wizard.handleInbound({ ...GENERAL, text: '/list' })
    expect(r.action).toBe('slash_list')

    // wizard 还在
    expect(wizard._peek(`${SUPERGROUP_ID}:general`)).toBeTruthy()
  })

  // ─── helper 单测 ─────────────────────────────────────────────────────
  it('isGeneralChannel: only -100… chatId + null threadId returns true', () => {
    expect(internals.isGeneralChannel('-1001234567890', null)).toBe(true)
    expect(internals.isGeneralChannel('-1001234567890', 99)).toBe(false)
    expect(internals.isGeneralChannel('-100', null)).toBe(false)   // 不匹配 \d+
    expect(internals.isGeneralChannel('123', null)).toBe(false)    // 不是 -100
    expect(internals.isGeneralChannel('u1', null)).toBe(false)     // weixin peer
    expect(internals.isGeneralChannel(null, null)).toBe(false)
  })

  it('QUADTODO_GLOBAL_SLASH only contains list, pending, stop', () => {
    expect([...internals.QUADTODO_GLOBAL_SLASH].sort()).toEqual(['list', 'pending', 'stop'])
  })
})

// ─── ask_user 按钮回调（qt:ans / qt:ext + force_reply 补充流） ────────────
//
// 关键属性：
//   - qt:ans:<ticket>:<idx> → 直接路由 pending.submitReply，不依赖 wizard 状态
//   - qt:ext:<ticket>:<idx> → 返回 force_reply prompt + forceReplyContext，
//                              telegram-bot 拿到 sent.message_id 回灌 wizard.registerForceReplyContext
//                              用户随后 reply 那条 → handleInbound 通过 replyToMessageId 反查 → 拼"option · extra" 路由
//   - 已超时 / 已取消 ticket 的按钮点击 → 友好降级（不抛错）
//   - 复用 pending-questions 协调器 100%，DB 行为不变
describe('openclaw-wizard ask_user button callbacks (qt:ans / qt:ext)', () => {
  let db, wizard, ai, bridge, pending

  beforeEach(() => {
    db = openDb(':memory:')
    ai = makeFakeAi()
    bridge = makeFakeBridge()
    pending = createPendingQuestionCoordinator({ db })
    wizard = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: bridge, pending,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })
  })

  it('qt:ans:* → submits reply, resolves promise, returns chosenLabel', async () => {
    const { ticket, promise } = pending.ask({
      sessionId: 's1', question: '用什么时区？', options: ['北京时间', 'UTC'],
    })
    const cb = await wizard.handleCallback({
      chatId: '-100', threadId: null,
      callbackData: `qt:ans:${ticket}:0`, callbackMessageId: 100,
    })
    expect(cb.action).toBe('ask_user_answered')
    expect(cb.chosenLabel).toBe('1. 北京时间')
    expect(cb.editOriginal).toBe(true)

    const settled = await promise
    expect(settled.status).toBe('answered')
    expect(settled.chosen).toBe('北京时间')
    expect(settled.chosenIndex).toBe(0)
  })

  it('qt:ans on already-answered ticket → ask_user_stale, no double resolve', async () => {
    const { ticket, promise } = pending.ask({
      sessionId: 's1', question: 'q', options: ['a', 'b'],
    })
    pending.submitReply('1')                // 先用文本答了
    await promise

    const cb = await wizard.handleCallback({
      chatId: '-100', threadId: null,
      callbackData: `qt:ans:${ticket}:1`, callbackMessageId: 200,
    })
    expect(cb.action).toBe('ask_user_stale')
    expect(cb.toast).toBeTruthy()
    expect(cb.reply).toContain(ticket)
  })

  it('qt:ans on cancelled ticket → ask_user_stale', async () => {
    const { ticket } = pending.ask({
      sessionId: 's1', question: 'q', options: ['a', 'b'],
    })
    pending.cancel(ticket, 'user_cancelled')

    const cb = await wizard.handleCallback({
      chatId: '-100', threadId: null,
      callbackData: `qt:ans:${ticket}:0`, callbackMessageId: 300,
    })
    expect(cb.action).toBe('ask_user_stale')
  })

  it('qt:ext:* → returns force_reply markup + forceReplyContext, no submit yet', async () => {
    const { ticket } = pending.ask({
      sessionId: 's1', question: 'q', options: ['北京时间', 'UTC'],
    })
    const cb = await wizard.handleCallback({
      chatId: '-100', threadId: null,
      callbackData: `qt:ext:${ticket}:0`, callbackMessageId: 400,
    })
    expect(cb.action).toBe('ask_user_extend_pending')
    expect(cb.reply).toContain('请补充')
    expect(cb.reply).toContain('北京时间')
    expect(cb.replyMarkup.force_reply).toBe(true)
    expect(cb.editOriginal).toBe(false)
    expect(cb.forceReplyContext).toMatchObject({
      ticket, optionIndex: 0, optionLabel: '北京时间',
    })

    // 重要：ticket 还在 pending，没被 submit
    const probe = pending.listPending().find((p) => p.ticket === ticket)
    expect(probe).toBeTruthy()
  })

  it('register + reply via replyToMessageId → submits "option · extra"', async () => {
    const { ticket, promise } = pending.ask({
      sessionId: 's1', question: 'q', options: ['北京时间', 'UTC'],
    })
    // 模拟 telegram-bot 收到 callback、发完 force_reply prompt 后的回灌
    wizard.registerForceReplyContext({
      chatId: '-100', messageId: 500, ticket, optionIndex: 0, optionLabel: '北京时间',
    })

    const r = await wizard.handleInbound({
      chatId: '-100', threadId: null,
      text: '不要 +08:00 用 +0800',
      replyToMessageId: 500,
    })
    expect(r.action).toBe('ask_user_extended')
    expect(r.ticket).toBe(ticket)
    expect(r.reply).toContain('已回答')

    const settled = await promise
    expect(settled.status).toBe('answered')
    expect(settled.answerText).toBe('北京时间 · 不要 +08:00 用 +0800')
  })

  it('replyToMessageId hits stale ticket (already cancelled) → ask_user_extended_stale', async () => {
    const { ticket } = pending.ask({
      sessionId: 's1', question: 'q', options: ['a', 'b'],
    })
    wizard.registerForceReplyContext({
      chatId: '-100', messageId: 600, ticket, optionIndex: 0, optionLabel: 'a',
    })
    pending.cancel(ticket, 'gone')

    const r = await wizard.handleInbound({
      chatId: '-100', threadId: null, text: '补充内容',
      replyToMessageId: 600,
    })
    expect(r.action).toBe('ask_user_extended_stale')
    expect(r.reply).toContain(ticket)
  })

  it('replyToMessageId without registered context → falls through to normal handleInbound path', async () => {
    // 没注册任何 force_reply 上下文
    const r = await wizard.handleInbound({
      chatId: '-100', threadId: null, text: '随便发一句话',
      replyToMessageId: 999,
    })
    // 应当走老路径（fallback）；至少不应该匹配 ask_user_extended
    expect(r.action).not.toBe('ask_user_extended')
    expect(r.action).not.toBe('ask_user_extended_stale')
  })

  it('forceReplyContext consumed once: same messageId twice → second falls through', async () => {
    const { ticket } = pending.ask({
      sessionId: 's1', question: 'q', options: ['a', 'b'],
    })
    wizard.registerForceReplyContext({
      chatId: '-100', messageId: 700, ticket, optionIndex: 0, optionLabel: 'a',
    })

    const r1 = await wizard.handleInbound({
      chatId: '-100', threadId: null, text: 'first',
      replyToMessageId: 700,
    })
    expect(r1.action).toBe('ask_user_extended')

    const r2 = await wizard.handleInbound({
      chatId: '-100', threadId: null, text: 'second',
      replyToMessageId: 700,
    })
    expect(r2.action).not.toBe('ask_user_extended')
  })

  it('callback with malformed callbackData → falls through to wizard prefix path (returns expired)', async () => {
    // 不是 qt:ans / qt:ext，handleAskUserCallback 不识别 → 进 wizard 老路径 → 没 active wizard → expired
    const cb = await wizard.handleCallback({
      chatId: '-100', threadId: null,
      callbackData: 'xx:bad:format', callbackMessageId: 800,
    })
    expect(cb.action).toBe('expired')
  })

  it('integration: text reply (non-button) still works on ask_user (backward compat)', async () => {
    const { ticket, promise } = pending.ask({
      sessionId: 's1', question: 'q', options: ['北京', '上海'],
    })
    // 用户发个 "1" —— 这个走的是老路径（pending.submitReply 里的数字模糊匹配）
    const r = await wizard.handleInbound({ chatId: '-100', threadId: null, text: '1' })
    expect(r.action).toBe('ask_user_replied')
    expect(r.ticket).toBe(ticket)

    const settled = await promise
    expect(settled.chosen).toBe('北京')
  })
})

describe('openclaw-wizard multi-session routing (qt:rt:* + first-route hint)', () => {
  let db, pending

  beforeEach(() => {
    db = openDb(':memory:')
    pending = createPendingQuestionCoordinator({ db })
  })

  it('ambiguous prompt: includes todo title + inline keyboard with qt:rt:<short> buttons', async () => {
    const t1 = db.createTodo({ title: '修复登录 bug', quadrant: 1, workDir: '/tmp/a' })
    const t2 = db.createTodo({ title: '重构 GameState', quadrant: 2, workDir: '/tmp/b' })
    db.updateTodo(t1.id, {
      status: 'todo',
      aiSessions: [{ sessionId: 'ai-1700000-aaaa', tool: 'claude', status: 'running', startedAt: Date.now() - 10000 }],
    })
    db.updateTodo(t2.id, {
      status: 'todo',
      aiSessions: [{ sessionId: 'ai-1700000-bbbb', tool: 'claude', status: 'running', startedAt: Date.now() - 5000 }],
    })

    const ai2 = {
      sessions: new Map([
        ['ai-1700000-aaaa', { status: 'running', startedAt: Date.now() - 10000, lastOutputAt: Date.now() - 5000 }],
        ['ai-1700000-bbbb', { status: 'running', startedAt: Date.now() - 5000, lastOutputAt: Date.now() - 1000 }],
      ]),
    }
    const fakeBridge = { ...makeFakeBridge(), getLastPushedSession: () => null }
    const fakePty = { has: () => true, write: () => {} }
    const wizard = createOpenClawWizard({
      db, aiTerminal: ai2, openclaw: fakeBridge, pending,
      pty: fakePty,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })

    const r = await wizard.handleInbound({ peer: 'u1', text: 'hi' })
    expect(r.action).toBe('stdin_proxy_ambiguous')
    expect(r.reply).toContain('修复登录 bug')
    expect(r.reply).toContain('重构 GameState')
    expect(r.reply).toContain('#aaaa')
    expect(r.reply).toContain('#bbbb')
    expect(r.replyMarkup?.inline_keyboard).toBeTruthy()
    const buttons = r.replyMarkup.inline_keyboard.flat()
    expect(buttons).toHaveLength(2)
    expect(buttons[0].callback_data).toMatch(/^qt:rt:[a-z0-9]{4}$/)
    // 最近的（bbbb）排前面 —— sort by lastOutputAt desc
    expect(buttons[0].callback_data).toBe('qt:rt:bbbb')
    expect(buttons[0].text).toContain('重构 GameState')
  })

  it('qt:rt:<short> on alive session → setLastPushedSession + reply with todo title', async () => {
    const t1 = db.createTodo({ title: '修复登录 bug', quadrant: 1, workDir: '/tmp/a' })
    db.updateTodo(t1.id, {
      status: 'todo',
      aiSessions: [{ sessionId: 'ai-1700000-aaaa', tool: 'claude', status: 'running', startedAt: Date.now() }],
    })
    const ai2 = {
      sessions: new Map([
        ['ai-1700000-aaaa', { status: 'running', startedAt: Date.now() }],
      ]),
    }
    const setCalls = []
    const fakeBridge = {
      ...makeFakeBridge(),
      setLastPushedSession: (peer, sid) => { setCalls.push({ peer, sid }); return true },
    }
    const wizard = createOpenClawWizard({
      db, aiTerminal: ai2, openclaw: fakeBridge, pending,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })

    const cb = await wizard.handleCallback({
      chatId: '-100', threadId: null,
      callbackData: 'qt:rt:aaaa', callbackMessageId: 1,
    })
    expect(cb.action).toBe('route_bound')
    expect(cb.toast).toContain('修复登录 bug')
    expect(cb.reply).toContain('修复登录 bug')
    expect(cb.reply).toContain('#aaaa')
    expect(setCalls).toEqual([{ peer: '-100', sid: 'ai-1700000-aaaa' }])
  })

  it('qt:rt:<short> session not found → route_session_gone, no setLastPushed', async () => {
    const ai2 = { sessions: new Map() }   // 没有任何活跃 session
    const setCalls = []
    const fakeBridge = {
      ...makeFakeBridge(),
      setLastPushedSession: (peer, sid) => { setCalls.push({ peer, sid }); return true },
    }
    const wizard = createOpenClawWizard({
      db, aiTerminal: ai2, openclaw: fakeBridge, pending,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })
    const cb = await wizard.handleCallback({
      chatId: '-100', threadId: null,
      callbackData: 'qt:rt:zzzz', callbackMessageId: 1,
    })
    expect(cb.action).toBe('route_session_gone')
    expect(cb.editOriginal).toBe(true)
    expect(setCalls).toHaveLength(0)
  })

  it('single active session: first stdin proxy reply has 📍 hint, second is silent', async () => {
    const t = db.createTodo({ title: '写关卡数据', quadrant: 2, workDir: '/tmp/c' })
    db.updateTodo(t.id, {
      status: 'todo',
      aiSessions: [{ sessionId: 'ai-1700000-cccc', tool: 'claude', status: 'running', startedAt: Date.now() }],
    })
    const ai2 = {
      sessions: new Map([
        ['ai-1700000-cccc', { status: 'running', startedAt: Date.now() }],
      ]),
    }
    const fakePty = { has: () => true, write: () => {} }
    const fakeBridge = { ...makeFakeBridge(), getLastPushedSession: () => null }
    const wizard = createOpenClawWizard({
      db, aiTerminal: ai2, openclaw: fakeBridge, pending,
      pty: fakePty,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })

    const r1 = await wizard.handleInbound({ chatId: '-100', threadId: null, text: 'hi' })
    expect(r1.action).toBe('stdin_proxy')
    expect(r1.reply).toContain('📍')
    expect(r1.reply).toContain('写关卡数据')
    expect(r1.reply).toContain('#cccc')

    const r2 = await wizard.handleInbound({ chatId: '-100', threadId: null, text: 'second' })
    expect(r2.action).toBe('stdin_proxy')
    expect(r2.reply).toBe('')   // 二次静默
  })

  it('after qt:rt explicit selection, subsequent stdin proxy is silent (no first-hint)', async () => {
    const t = db.createTodo({ title: '修复登录 bug', quadrant: 1, workDir: '/tmp/a' })
    db.updateTodo(t.id, {
      status: 'todo',
      aiSessions: [{ sessionId: 'ai-1700000-aaaa', tool: 'claude', status: 'running', startedAt: Date.now() }],
    })
    const ai2 = {
      sessions: new Map([
        ['ai-1700000-aaaa', { status: 'running', startedAt: Date.now() }],
      ]),
    }
    let lastPushed = null
    const fakePty = { has: () => true, write: () => {} }
    const fakeBridge = {
      ...makeFakeBridge(),
      setLastPushedSession: (peer, sid) => { lastPushed = sid; return true },
      getLastPushedSession: () => lastPushed,   // 模拟绑定后的查询
    }
    const wizard = createOpenClawWizard({
      db, aiTerminal: ai2, openclaw: fakeBridge, pending,
      pty: fakePty,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })

    await wizard.handleCallback({
      chatId: '-100', threadId: null,
      callbackData: 'qt:rt:aaaa', callbackMessageId: 1,
    })
    const r = await wizard.handleInbound({ chatId: '-100', threadId: null, text: 'hi' })
    expect(r.action).toBe('stdin_proxy')
    expect(r.reply).toBe('')   // 已通过按钮显式选过 → 不再首次提示
  })
})
