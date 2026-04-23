import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import request from 'supertest'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { openDb } from '../src/db.js'
import { createSearchService } from '../src/search/index.js'
import { createMcpRouter } from '../src/mcp/server.js'
import { registerReadTools } from '../src/mcp/tools/read/index.js'

async function makeInProcess({ wikiDir }) {
  const db = openDb(':memory:')
  const searchService = createSearchService({ db, wikiDir })
  searchService.init()
  const server = new McpServer({ name: 'quadtodo-test', version: '0.0.0' })
  registerReadTools(server, { db, searchService, wikiDir })
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  await server.connect(serverT)
  const client = new Client({ name: 'quadtodo-test-client', version: '0.0.0' })
  await client.connect(clientT)
  return { db, client, searchService, dispose: async () => {
    await client.close()
    await server.close()
  } }
}

describe('mcp read tools (in-memory)', () => {
  let tmp, wikiDir, ctx

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'quadtodo-mcp-'))
    wikiDir = join(tmp, 'wiki')
    mkdirSync(wikiDir, { recursive: true })
    ctx = await makeInProcess({ wikiDir })
  })

  afterEach(async () => {
    await ctx.dispose()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('lists 6 read tools', async () => {
    const res = await ctx.client.listTools()
    const names = new Set(res.tools.map((t) => t.name))
    expect(names).toContain('search')
    expect(names).toContain('list_todos')
    expect(names).toContain('get_todo')
    expect(names).toContain('read_wiki')
    expect(names).toContain('get_stats')
    expect(names).toContain('get_recent_sessions')
  })

  it('search finds a todo', async () => {
    ctx.db.createTodo({ title: 'Refactor shipping module', quadrant: 1 })
    const res = await ctx.client.callTool({ name: 'search', arguments: { query: 'shipping' } })
    const payload = JSON.parse(res.content[0].text)
    expect(payload.total).toBeGreaterThan(0)
    expect(payload.results[0].todoTitle).toMatch(/shipping/i)
  })

  it('list_todos respects status filter', async () => {
    const a = ctx.db.createTodo({ title: 'A', quadrant: 1 })
    ctx.db.createTodo({ title: 'B', quadrant: 1 })
    ctx.db.updateTodo(a.id, { status: 'done' })
    const r1 = await ctx.client.callTool({ name: 'list_todos', arguments: { status: 'todo' } })
    const todos = JSON.parse(r1.content[0].text).todos
    expect(todos.map((t) => t.title)).toEqual(['B'])
  })

  it('list_todos respects archived filter', async () => {
    const a = ctx.db.createTodo({ title: 'Alpha', quadrant: 1 })
    const b = ctx.db.createTodo({ title: 'Bravo', quadrant: 1 })
    ctx.db.archiveTodo(a.id)
    const r1 = await ctx.client.callTool({ name: 'list_todos', arguments: {} })
    expect(JSON.parse(r1.content[0].text).todos.map((t) => t.title)).toEqual(['Bravo'])
    const r2 = await ctx.client.callTool({ name: 'list_todos', arguments: { archived: 'all' } })
    expect(new Set(JSON.parse(r2.content[0].text).todos.map((t) => t.title))).toEqual(new Set(['Alpha', 'Bravo']))
  })

  it('get_todo returns comments + children + hasWiki flag', async () => {
    const parent = ctx.db.createTodo({ title: 'Parent', quadrant: 1 })
    const child = ctx.db.createTodo({ title: 'Child', quadrant: 1, parentId: parent.id })
    ctx.db.addComment(parent.id, 'a note')
    writeFileSync(join(wikiDir, `${parent.id}.md`), '# memo')
    const res = await ctx.client.callTool({ name: 'get_todo', arguments: { id: parent.id } })
    const payload = JSON.parse(res.content[0].text)
    expect(payload.todo.id).toBe(parent.id)
    expect(payload.children.map((c) => c.id)).toEqual([child.id])
    expect(payload.comments.length).toBe(1)
    expect(payload.hasWiki).toBe(true)
  })

  it('get_todo errors on missing id', async () => {
    const res = await ctx.client.callTool({ name: 'get_todo', arguments: { id: 'nope' } })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toMatch(/todo_not_found/)
  })

  it('read_wiki returns body when file exists', async () => {
    const a = ctx.db.createTodo({ title: 'Subject', quadrant: 1 })
    writeFileSync(join(wikiDir, `${a.id}.md`), '# hello world')
    const res = await ctx.client.callTool({ name: 'read_wiki', arguments: { todoId: a.id } })
    const payload = JSON.parse(res.content[0].text)
    expect(payload.exists).toBe(true)
    expect(payload.body).toContain('hello world')
  })

  it('read_wiki returns exists:false when missing', async () => {
    const a = ctx.db.createTodo({ title: 'NoMemo', quadrant: 1 })
    const res = await ctx.client.callTool({ name: 'read_wiki', arguments: { todoId: a.id } })
    const payload = JSON.parse(res.content[0].text)
    expect(payload.exists).toBe(false)
  })

  it('get_stats returns snapshot with expected keys', async () => {
    ctx.db.createTodo({ title: 'open', quadrant: 2 })
    const res = await ctx.client.callTool({ name: 'get_stats', arguments: {} })
    const payload = JSON.parse(res.content[0].text)
    expect(payload.openCount).toBeGreaterThanOrEqual(1)
    expect(payload.byQuadrant).toBeDefined()
    expect(payload.completedThisWeek).toBeGreaterThanOrEqual(0)
    expect(payload.generatedAt).toBeTypeOf('number')
  })

  it('get_recent_sessions queries ai_session_log', async () => {
    // ai_session_log 是插入式的日志表；用 insertSessionLog（已有 API）
    const a = ctx.db.createTodo({ title: 'X', quadrant: 1 })
    ctx.db.insertSessionLog({
      id: 'sess-1',
      todoId: a.id,
      tool: 'claude',
      quadrant: 1,
      status: 'completed',
      exitCode: 0,
      startedAt: Date.now() - 1000,
      completedAt: Date.now(),
      durationMs: 1000,
    })
    const res = await ctx.client.callTool({ name: 'get_recent_sessions', arguments: { limit: 5 } })
    const payload = JSON.parse(res.content[0].text)
    expect(payload.count).toBeGreaterThanOrEqual(1)
    expect(payload.sessions[0].todoTitle).toBe('X')
  })
})

describe('mcp over http (supertest)', () => {
  let tmp, wikiDir, app, db

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'quadtodo-mcp-http-'))
    wikiDir = join(tmp, 'wiki')
    mkdirSync(wikiDir, { recursive: true })
    db = openDb(':memory:')
    const searchService = createSearchService({ db, wikiDir })
    searchService.init()
    const mcp = createMcpRouter({ db, searchService, wikiDir })
    app = express()
    app.use(express.json())
    app.use('/mcp', mcp.router)
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('GET /mcp/health reports ok', async () => {
    const res = await request(app).get('/mcp/health')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.server).toBe('quadtodo')
  })

  it('POST /mcp without Accept header returns an error JSON-RPC (the transport enforces headers)', async () => {
    // 这条测试记录 transport 对缺失 Accept 头的行为，确保路由至少不 500 炸开。
    const res = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    // 合法响应：200/202/406 均可，重点是不要 5xx
    expect(res.status).toBeLessThan(500)
  })
})
