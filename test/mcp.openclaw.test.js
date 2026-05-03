import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { openDb } from '../src/db.js'
import { registerOpenClawTools } from '../src/mcp/tools/openclaw/index.js'
import { createPendingQuestionCoordinator } from '../src/pending-questions.js'

const parseText = (res) => JSON.parse(res.content[0].text)
const isError = (res) => Boolean(res.isError)

function makeFakeAiTerminal() {
  const sessions = []
  return {
    sessions,
    spawnSession({ sessionId: external, todoId, prompt, tool, cwd, label, permissionMode, extraEnv }) {
      const sessionId = external || `fake-${sessions.length + 1}`
      sessions.push({ sessionId, todoId, prompt, tool, cwd, label, permissionMode, extraEnv })
      return { sessionId, reused: false }
    },
  }
}

function makeFakeBridge({ enabled = true, sendOk = true, sendReason = null } = {}) {
  const sent = []
  const routes = new Map()
  return {
    sent,
    routes,
    isEnabled: () => enabled,
    registerSessionRoute: (sid, info) => routes.set(sid, info),
    postText: async ({ sessionId, message }) => {
      sent.push({ sessionId, message })
      if (sendOk) return { ok: true, payload: { ok: 1 } }
      return { ok: false, reason: sendReason || 'cli_failed' }
    },
  }
}

async function makeMcp({ pending, openclaw, aiTerminal, getConfig }) {
  const db = pending._db || openDb(':memory:')
  const server = new McpServer({ name: 'qt-test', version: '0.0.0' })
  registerOpenClawTools(server, {
    db,
    pending,
    openclaw,
    aiTerminal,
    getConfig: getConfig || (() => ({})),
  })
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  await server.connect(serverT)
  const client = new Client({ name: 'qt-test-client', version: '0.0.0' })
  await client.connect(clientT)
  return {
    db,
    client,
    dispose: async () => {
      await client.close()
      await server.close()
    },
  }
}

describe('mcp openclaw tools', () => {
  let db, pending, ctx

  beforeEach(async () => {
    db = openDb(':memory:')
    pending = createPendingQuestionCoordinator({ db })
    pending._db = db
  })

  afterEach(async () => {
    await ctx?.dispose()
    pending.stop()
  })

  it('list_quadrants returns 4 entries with default Q2', async () => {
    ctx = await makeMcp({ pending })
    const res = await ctx.client.callTool({ name: 'list_quadrants', arguments: {} })
    const data = parseText(res)
    expect(data.quadrants).toHaveLength(4)
    expect(data.quadrants.find((q) => q.isDefault)?.id).toBe(2)
  })

  it('list_templates returns builtin templates with content preview', async () => {
    ctx = await makeMcp({ pending })
    const res = await ctx.client.callTool({ name: 'list_templates', arguments: {} })
    const data = parseText(res)
    expect(Array.isArray(data.templates)).toBe(true)
    expect(data.templates.length).toBeGreaterThan(0)
    expect(data.templates[0]).toHaveProperty('contentPreview')
    expect(data.templates[0]).not.toHaveProperty('content')
  })

  it('list_workdir_options returns recent + default + home', async () => {
    db.createTodo({ title: 'A', quadrant: 1, workDir: '/foo' })
    db.createTodo({ title: 'B', quadrant: 1, workDir: '/foo' })
    db.createTodo({ title: 'C', quadrant: 2, workDir: '/bar' })
    ctx = await makeMcp({ pending, getConfig: () => ({ defaultCwd: '/baz' }) })
    const res = await ctx.client.callTool({ name: 'list_workdir_options', arguments: {} })
    const data = parseText(res)
    expect(data.options.length).toBeGreaterThanOrEqual(2)
    expect(data.options[0].path).toBe('/foo')
    expect(data.options[0].source).toBe('recent')
    expect(data.options[0].count).toBe(2)
    const sources = data.options.map((o) => o.source)
    expect(sources).toContain('default')
    expect(sources).toContain('home')
  })

  it('start_ai_session spawns via aiTerminal and registers route', async () => {
    const todo = db.createTodo({ title: 'Fix login', quadrant: 2, workDir: '/tmp' })
    const aiTerminal = makeFakeAiTerminal()
    const openclaw = makeFakeBridge()
    ctx = await makeMcp({ pending, aiTerminal, openclaw })
    const res = await ctx.client.callTool({
      name: 'start_ai_session',
      arguments: {
        todoId: todo.id,
        cwd: '/tmp',
        prompt: 'do the thing',
        routeUserId: 'user-x',
      },
    })
    const data = parseText(res)
    expect(data.ok).toBe(true)
    // sessionId now comes from MCP tool (pre-generated), not from fake aiTerminal counter
    expect(data.sessionId).toMatch(/^ai-\d+-/)
    expect(aiTerminal.sessions[0].prompt).toBe('do the thing')
    expect(aiTerminal.sessions[0].prompt).not.toContain('ask_user MCP')
    expect(aiTerminal.sessions[0].permissionMode).toBe('bypass') // 默认 bypass
    expect(openclaw.routes.get(data.sessionId)).toEqual({ targetUserId: 'user-x', account: null, channel: null })
  })

  it('start_ai_session injects ask_user rule only when explicitly enabled', async () => {
    const todo = db.createTodo({ title: 'Fix login', quadrant: 2, workDir: '/tmp' })
    const aiTerminal = makeFakeAiTerminal()
    const openclaw = makeFakeBridge()
    ctx = await makeMcp({
      pending, aiTerminal, openclaw,
      getConfig: () => ({ aiSession: { enforceAskUserRule: true } }),
    })
    const res = await ctx.client.callTool({
      name: 'start_ai_session',
      arguments: {
        todoId: todo.id,
        cwd: '/tmp',
        prompt: 'do the thing',
      },
    })
    const data = parseText(res)
    expect(data.ok).toBe(true)
    expect(aiTerminal.sessions[0].prompt).toContain('ask_user MCP')
    expect(aiTerminal.sessions[0].prompt).toContain('do the thing')
  })

  it('start_ai_session injects QUADTODO_* env vars into PTY', async () => {
    const todo = db.createTodo({ title: 'Build X', quadrant: 1, workDir: '/tmp' })
    const aiTerminal = makeFakeAiTerminal()
    const openclaw = makeFakeBridge()
    ctx = await makeMcp({ pending, aiTerminal, openclaw, getConfig: () => ({ port: 5677 }) })
    const res = await ctx.client.callTool({
      name: 'start_ai_session',
      arguments: {
        todoId: todo.id,
        cwd: '/tmp',
        prompt: 'go',
        routeUserId: 'wechat-peer-1',
      },
    })
    const data = parseText(res)
    const env = aiTerminal.sessions[0].extraEnv
    expect(env).toBeTruthy()
    expect(env.QUADTODO_SESSION_ID).toBe(data.sessionId)
    expect(env.QUADTODO_TODO_ID).toBe(todo.id)
    expect(env.QUADTODO_TODO_TITLE).toBe('Build X')
    expect(env.QUADTODO_TARGET_USER).toBe('wechat-peer-1')
    expect(env.QUADTODO_URL).toBe('http://127.0.0.1:5677')
  })

  it('start_ai_session honors explicit permissionMode', async () => {
    const todo = db.createTodo({ title: 'X', quadrant: 2, workDir: '/tmp' })
    const aiTerminal = makeFakeAiTerminal()
    ctx = await makeMcp({ pending, aiTerminal, openclaw: makeFakeBridge() })
    const res = await ctx.client.callTool({
      name: 'start_ai_session',
      arguments: { todoId: todo.id, cwd: '/tmp', prompt: 'x', permissionMode: 'acceptEdits' },
    })
    const data = parseText(res)
    expect(data.permissionMode).toBe('acceptEdits')
    expect(aiTerminal.sessions[0].permissionMode).toBe('acceptEdits')
  })

  it('start_ai_session with templateId injects template content as first prompt', async () => {
    const todo = db.createTodo({ title: 'Refactor X', quadrant: 2, workDir: '/tmp' })
    const tpl = db.createTemplate({ name: 'My T', content: 'STEP1\nSTEP2', description: 'd' })
    const aiTerminal = makeFakeAiTerminal()
    ctx = await makeMcp({ pending, aiTerminal, openclaw: makeFakeBridge() })
    const res = await ctx.client.callTool({
      name: 'start_ai_session',
      arguments: { todoId: todo.id, cwd: '/tmp', templateId: tpl.id },
    })
    const data = parseText(res)
    expect(data.ok).toBe(true)
    expect(aiTerminal.sessions[0].prompt).toContain('STEP1')
    expect(aiTerminal.sessions[0].prompt).toContain('Refactor X')
    expect(data.templateName).toBe('My T')
  })

  it('start_ai_session returns error if cwd does not exist', async () => {
    const todo = db.createTodo({ title: 'X', quadrant: 2 })
    const aiTerminal = makeFakeAiTerminal()
    ctx = await makeMcp({ pending, aiTerminal, openclaw: makeFakeBridge() })
    const res = await ctx.client.callTool({
      name: 'start_ai_session',
      arguments: { todoId: todo.id, cwd: '/no/such/path', prompt: 'x' },
    })
    expect(isError(res)).toBe(true)
    expect(res.content[0].text).toContain('cwd_not_exists')
  })

  it('ask_user pushes formatted message and resolves on submit_user_reply', async () => {
    const openclaw = makeFakeBridge({ enabled: true })
    ctx = await makeMcp({ pending, openclaw })

    // 触发 ask_user，先不 await（它会阻塞）
    const askPromise = ctx.client.callTool({
      name: 'ask_user',
      arguments: {
        question: '用方案 A 还是 B？',
        options: ['cookie session', 'JWT token'],
        timeoutMs: 5000,
      },
    })

    // 等到 outbound 消息发出
    await new Promise((r) => setTimeout(r, 30))
    expect(openclaw.sent).toHaveLength(1)
    const sentMsg = openclaw.sent[0].message
    expect(sentMsg).toMatch(/\[#[a-z2-7]{3}\]/)
    expect(sentMsg).toContain('用方案 A 还是 B？')
    expect(sentMsg).toContain('1. cookie session')
    expect(sentMsg).toContain('2. JWT token')

    // 模拟用户回复 "1"
    const reply = await ctx.client.callTool({
      name: 'submit_user_reply',
      arguments: { text: '1' },
    })
    const replyData = parseText(reply)
    expect(replyData.matched).toBe(true)
    expect(replyData.chosen).toBe('cookie session')

    const askResult = parseText(await askPromise)
    expect(askResult.status).toBe('answered')
    expect(askResult.chosen).toBe('cookie session')
    expect(askResult.chosenIndex).toBe(0)
  })

  it('ask_user returns openclaw_disabled when bridge not enabled', async () => {
    const openclaw = makeFakeBridge({ enabled: false })
    ctx = await makeMcp({ pending, openclaw })
    const res = await ctx.client.callTool({
      name: 'ask_user',
      arguments: { question: 'q', options: ['a', 'b'] },
    })
    expect(isError(res)).toBe(true)
    expect(res.content[0].text).toContain('openclaw_disabled')
  })

  it('ask_user warns but does not fail when outbound send fails', async () => {
    const openclaw = makeFakeBridge({ enabled: true, sendOk: false, sendReason: 'rate_limited' })
    ctx = await makeMcp({ pending, openclaw })
    const res = await ctx.client.callTool({
      name: 'ask_user',
      arguments: { question: 'q', options: ['a', 'b'], timeoutMs: 5000 },
    })
    const data = parseText(res)
    expect(data.status).toBe('pending')
    expect(data.warning).toContain('rate_limited')
  })

  it('list_pending_questions returns count and entries', async () => {
    const openclaw = makeFakeBridge({ enabled: true })
    ctx = await makeMcp({ pending, openclaw })
    pending.ask({ sessionId: 's', question: 'q1', options: ['a', 'b'] })
    const res = await ctx.client.callTool({ name: 'list_pending_questions', arguments: {} })
    const data = parseText(res)
    expect(data.count).toBe(1)
    expect(data.pending[0].question).toBe('q1')
  })

  it('cancel_pending_question cancels by ticket', async () => {
    const openclaw = makeFakeBridge({ enabled: true })
    ctx = await makeMcp({ pending, openclaw })
    const { ticket, promise } = pending.ask({ sessionId: 's', question: 'q', options: ['a', 'b'] })
    const res = await ctx.client.callTool({
      name: 'cancel_pending_question',
      arguments: { ticket, reason: 'test cancel' },
    })
    const data = parseText(res)
    expect(data.ok).toBe(true)
    const settled = await promise
    expect(settled.status).toBe('cancelled')
  })

  it('cancel_pending_question with unknown ticket returns error', async () => {
    ctx = await makeMcp({ pending, openclaw: makeFakeBridge({ enabled: true }) })
    const res = await ctx.client.callTool({
      name: 'cancel_pending_question',
      arguments: { ticket: 'zzz' },
    })
    expect(isError(res)).toBe(true)
  })
})
