import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { openDb } from '../src/db.js'
import { createSearchService } from '../src/search/index.js'
import { registerReadTools } from '../src/mcp/tools/read/index.js'
import { registerWriteTools } from '../src/mcp/tools/write/index.js'

async function makeInProcess({ wikiDir }) {
  const db = openDb(':memory:')
  const searchService = createSearchService({ db, wikiDir })
  searchService.init()
  const server = new McpServer({ name: 'quadtodo-test', version: '0.0.0' })
  registerReadTools(server, { db, searchService, wikiDir })
  registerWriteTools(server, { db })
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  await server.connect(serverT)
  const client = new Client({ name: 'quadtodo-test-client', version: '0.0.0' })
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

const parseText = (res) => JSON.parse(res.content[0].text)

describe('mcp write tools', () => {
  let tmp, wikiDir, ctx

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'quadtodo-mcp-w-'))
    wikiDir = join(tmp, 'wiki')
    mkdirSync(wikiDir, { recursive: true })
    ctx = await makeInProcess({ wikiDir })
  })

  afterEach(async () => {
    await ctx.dispose()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('create_todo creates a new todo', async () => {
    const res = await ctx.client.callTool({
      name: 'create_todo',
      arguments: { title: 'Draft proposal', quadrant: 2, description: 'for Q3 planning' },
    })
    const payload = parseText(res)
    expect(payload.ok).toBe(true)
    expect(payload.todo.title).toBe('Draft proposal')
    expect(payload.todo.quadrant).toBe(2)
    expect(payload.todo.description).toBe('for Q3 planning')
    // 能立刻在 db 里查到
    expect(ctx.db.getTodo(payload.todo.id)?.title).toBe('Draft proposal')
  })

  it('create_todo with parentId makes a subtodo inheriting quadrant', async () => {
    const parent = ctx.db.createTodo({ title: 'Parent', quadrant: 1 })
    const res = await ctx.client.callTool({
      name: 'create_todo',
      arguments: { title: 'Child', quadrant: 4, parentId: parent.id },
    })
    const payload = parseText(res)
    expect(payload.todo.parentId).toBe(parent.id)
    expect(payload.todo.quadrant).toBe(1) // 继承父象限
  })

  it('create_todo rejects empty title', async () => {
    const res = await ctx.client.callTool({
      name: 'create_todo',
      arguments: { title: '   ', quadrant: 1 },
    })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toMatch(/title_required/)
  })

  it('update_todo patches fields', async () => {
    const t = ctx.db.createTodo({ title: 'Old', quadrant: 4 })
    const res = await ctx.client.callTool({
      name: 'update_todo',
      arguments: { id: t.id, title: 'New', quadrant: 2 },
    })
    const payload = parseText(res)
    expect(payload.todo.title).toBe('New')
    expect(payload.todo.quadrant).toBe(2)
  })

  it('update_todo errors on missing todo', async () => {
    const res = await ctx.client.callTool({
      name: 'update_todo',
      arguments: { id: 'nope', title: 'x' },
    })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toMatch(/todo_not_found/)
  })

  it('update_todo rejects empty patch', async () => {
    const t = ctx.db.createTodo({ title: 'X', quadrant: 1 })
    const res = await ctx.client.callTool({
      name: 'update_todo',
      arguments: { id: t.id },
    })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toMatch(/patch_empty/)
  })

  it('add_comment adds a comment to existing todo', async () => {
    const t = ctx.db.createTodo({ title: 'X', quadrant: 1 })
    const res = await ctx.client.callTool({
      name: 'add_comment',
      arguments: { todoId: t.id, content: 'looks overdue' },
    })
    const payload = parseText(res)
    expect(payload.ok).toBe(true)
    expect(payload.comment.content).toBe('looks overdue')
    expect(ctx.db.listComments(t.id).length).toBe(1)
  })

  it('add_comment errors on missing todo', async () => {
    const res = await ctx.client.callTool({
      name: 'add_comment',
      arguments: { todoId: 'nope', content: 'x' },
    })
    expect(res.isError).toBe(true)
  })

  it('complete_todo marks done', async () => {
    const t = ctx.db.createTodo({ title: 'X', quadrant: 1 })
    const res = await ctx.client.callTool({
      name: 'complete_todo',
      arguments: { id: t.id },
    })
    const payload = parseText(res)
    expect(payload.ok).toBe(true)
    expect(payload.todo.status).toBe('done')
    expect(payload.todo.completedAt).toBeTypeOf('number')
  })

  it('complete_todo is idempotent', async () => {
    const t = ctx.db.createTodo({ title: 'X', quadrant: 1 })
    ctx.db.updateTodo(t.id, { status: 'done' })
    const res = await ctx.client.callTool({
      name: 'complete_todo',
      arguments: { id: t.id },
    })
    const payload = parseText(res)
    expect(payload.alreadyDone).toBe(true)
  })

  it('unarchive_todo restores an archived todo', async () => {
    const t = ctx.db.createTodo({ title: 'X', quadrant: 1 })
    ctx.db.archiveTodo(t.id)
    const res = await ctx.client.callTool({
      name: 'unarchive_todo',
      arguments: { id: t.id },
    })
    const payload = parseText(res)
    expect(payload.ok).toBe(true)
    expect(payload.todo.archivedAt).toBeNull()
  })

  it('lists all 11 tools (6 read + 5 write)', async () => {
    const list = await ctx.client.listTools()
    const names = new Set(list.tools.map((t) => t.name))
    const expected = [
      'search', 'list_todos', 'get_todo', 'read_wiki', 'get_stats', 'get_recent_sessions',
      'create_todo', 'update_todo', 'add_comment', 'complete_todo', 'unarchive_todo',
    ]
    for (const name of expected) {
      expect(names.has(name)).toBe(true)
    }
  })
})
