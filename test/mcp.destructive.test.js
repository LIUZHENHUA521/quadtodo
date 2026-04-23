import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { openDb } from '../src/db.js'
import { createSearchService } from '../src/search/index.js'
import { registerReadTools } from '../src/mcp/tools/read/index.js'
import { registerWriteTools } from '../src/mcp/tools/write/index.js'
import { registerDestructiveTools } from '../src/mcp/tools/destructive/index.js'
import { createAuditLog } from '../src/mcp/audit.js'

async function makeInProcess({ wikiDir, rootDir }) {
  const db = openDb(':memory:')
  const searchService = createSearchService({ db, wikiDir })
  searchService.init()
  const audit = createAuditLog({ rootDir })
  const server = new McpServer({ name: 'quadtodo-test', version: '0.0.0' })
  registerReadTools(server, { db, searchService, wikiDir })
  registerWriteTools(server, { db })
  registerDestructiveTools(server, { db, audit })
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  await server.connect(serverT)
  const client = new Client({ name: 'quadtodo-test-client', version: '0.0.0' })
  await client.connect(clientT)
  return {
    db,
    client,
    audit,
    dispose: async () => {
      await client.close()
      await server.close()
    },
  }
}

const parseText = (res) => JSON.parse(res.content[0].text)

describe('mcp destructive tools', () => {
  let tmp, wikiDir, rootDir, ctx

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'quadtodo-mcp-d-'))
    wikiDir = join(tmp, 'wiki')
    rootDir = join(tmp, 'root')
    mkdirSync(wikiDir, { recursive: true })
    mkdirSync(rootDir, { recursive: true })
    ctx = await makeInProcess({ wikiDir, rootDir })
  })

  afterEach(async () => {
    await ctx.dispose()
    rmSync(tmp, { recursive: true, force: true })
  })

  // ─── delete_todo ───

  it('delete_todo without confirm returns preview and does NOT delete', async () => {
    const t = ctx.db.createTodo({ title: 'Doomed', quadrant: 1 })
    ctx.db.addComment(t.id, 'note1')
    ctx.db.addComment(t.id, 'note2')
    const res = await ctx.client.callTool({ name: 'delete_todo', arguments: { id: t.id } })
    const payload = parseText(res)
    expect(payload.preview).toBe(true)
    expect(payload.impact.comments).toBe(2)
    expect(payload.howToConfirm).toMatch(/confirm/)
    // DB 未变
    expect(ctx.db.getTodo(t.id)?.id).toBe(t.id)
    expect(ctx.db.listComments(t.id).length).toBe(2)
  })

  it('delete_todo with confirm:true actually deletes and writes audit', async () => {
    const t = ctx.db.createTodo({ title: 'Delete me', quadrant: 1 })
    const res = await ctx.client.callTool({
      name: 'delete_todo',
      arguments: { id: t.id, confirm: true, confirmNote: 'user said OK in chat' },
    })
    const payload = parseText(res)
    expect(payload.ok).toBe(true)
    expect(ctx.db.getTodo(t.id)).toBeNull()
    // 审计
    const auditFile = join(rootDir, 'mcp-audit.log')
    expect(existsSync(auditFile)).toBe(true)
    const line = readFileSync(auditFile, 'utf8').trim().split('\n').pop()
    const entry = JSON.parse(line)
    expect(entry.tool).toBe('delete_todo')
    expect(entry.ok).toBe(true)
    expect(entry.confirmNote).toBe('user said OK in chat')
  })

  it('delete_todo on missing id returns error', async () => {
    const res = await ctx.client.callTool({ name: 'delete_todo', arguments: { id: 'nope', confirm: true } })
    expect(res.isError).toBe(true)
  })

  // ─── archive_todo ───

  it('archive_todo preview does not set archivedAt', async () => {
    const t = ctx.db.createTodo({ title: 'A', quadrant: 1 })
    const res = await ctx.client.callTool({ name: 'archive_todo', arguments: { id: t.id } })
    expect(parseText(res).preview).toBe(true)
    expect(ctx.db.getTodo(t.id)?.archivedAt).toBeNull()
  })

  it('archive_todo confirmed sets archivedAt', async () => {
    const t = ctx.db.createTodo({ title: 'A', quadrant: 1 })
    const res = await ctx.client.callTool({ name: 'archive_todo', arguments: { id: t.id, confirm: true } })
    expect(parseText(res).ok).toBe(true)
    expect(ctx.db.getTodo(t.id)?.archivedAt).toBeTypeOf('number')
  })

  it('archive_todo idempotent on already-archived', async () => {
    const t = ctx.db.createTodo({ title: 'A', quadrant: 1 })
    ctx.db.archiveTodo(t.id)
    const res = await ctx.client.callTool({ name: 'archive_todo', arguments: { id: t.id, confirm: true } })
    expect(parseText(res).alreadyArchived).toBe(true)
  })

  // ─── merge_todos ───

  it('merge_todos preview shows move counts without touching DB', async () => {
    const target = ctx.db.createTodo({ title: 'T', quadrant: 1 })
    const src = ctx.db.createTodo({ title: 'S', quadrant: 1 })
    ctx.db.addComment(src.id, 'c1')
    const res = await ctx.client.callTool({
      name: 'merge_todos',
      arguments: { targetId: target.id, sourceIds: [src.id] },
    })
    const payload = parseText(res)
    expect(payload.preview).toBe(true)
    expect(payload.impact.movedComments).toBe(1)
    // DB 未变
    expect(ctx.db.getTodo(src.id)?.id).toBe(src.id)
    expect(ctx.db.listComments(src.id).length).toBe(1)
  })

  it('merge_todos with confirm:true actually merges and writes audit', async () => {
    const target = ctx.db.createTodo({ title: 'T', quadrant: 1 })
    const src = ctx.db.createTodo({ title: 'S', quadrant: 1 })
    ctx.db.addComment(src.id, 'moved')
    const res = await ctx.client.callTool({
      name: 'merge_todos',
      arguments: {
        targetId: target.id,
        sourceIds: [src.id],
        titleStrategy: 'concat',
        confirm: true,
        confirmNote: 'duplicates',
      },
    })
    const payload = parseText(res)
    expect(payload.ok).toBe(true)
    expect(ctx.db.getTodo(src.id)).toBeNull()
    expect(ctx.db.getTodo(target.id)?.title).toBe('T + S')
    expect(ctx.db.listComments(target.id).length).toBe(1)
    // 审计
    const line = readFileSync(join(rootDir, 'mcp-audit.log'), 'utf8').trim().split('\n').pop()
    const entry = JSON.parse(line)
    expect(entry.tool).toBe('merge_todos')
    expect(entry.result.deletedIds).toEqual([src.id])
  })

  it('merge_todos with invalid target returns error (+ audit failure)', async () => {
    const src = ctx.db.createTodo({ title: 'S', quadrant: 1 })
    const res = await ctx.client.callTool({
      name: 'merge_todos',
      arguments: { targetId: 'nope', sourceIds: [src.id], confirm: true },
    })
    expect(res.isError).toBe(true)
    // 审计失败记录
    const line = readFileSync(join(rootDir, 'mcp-audit.log'), 'utf8').trim().split('\n').pop()
    const entry = JSON.parse(line)
    expect(entry.tool).toBe('merge_todos')
    expect(entry.ok).toBe(false)
  })

  // ─── bulk_update ───

  it('bulk_update preview shows affected/missing without patching', async () => {
    const a = ctx.db.createTodo({ title: 'A', quadrant: 1 })
    const b = ctx.db.createTodo({ title: 'B', quadrant: 1 })
    const res = await ctx.client.callTool({
      name: 'bulk_update',
      arguments: { ids: [a.id, b.id, 'nope'], patch: { archived: true } },
    })
    const payload = parseText(res)
    expect(payload.preview).toBe(true)
    expect(payload.impact.affected.length).toBe(2)
    expect(payload.impact.missing).toEqual(['nope'])
    // DB 未变
    expect(ctx.db.getTodo(a.id)?.archivedAt).toBeNull()
  })

  it('bulk_update confirmed patches and audits', async () => {
    const a = ctx.db.createTodo({ title: 'A', quadrant: 1 })
    const b = ctx.db.createTodo({ title: 'B', quadrant: 1 })
    const res = await ctx.client.callTool({
      name: 'bulk_update',
      arguments: { ids: [a.id, b.id], patch: { archived: true }, confirm: true },
    })
    const payload = parseText(res)
    expect(payload.ok).toBe(true)
    expect(ctx.db.getTodo(a.id)?.archivedAt).toBeTypeOf('number')
    expect(ctx.db.getTodo(b.id)?.archivedAt).toBeTypeOf('number')
    const line = readFileSync(join(rootDir, 'mcp-audit.log'), 'utf8').trim().split('\n').pop()
    expect(JSON.parse(line).result.changedCount).toBe(2)
  })

  it('lists 15 tools (6 read + 5 write + 4 destructive)', async () => {
    const list = await ctx.client.listTools()
    const names = new Set(list.tools.map((t) => t.name))
    const expected = [
      'search', 'list_todos', 'get_todo', 'read_wiki', 'get_stats', 'get_recent_sessions',
      'create_todo', 'update_todo', 'add_comment', 'complete_todo', 'unarchive_todo',
      'delete_todo', 'archive_todo', 'merge_todos', 'bulk_update',
    ]
    expect(names.size).toBeGreaterThanOrEqual(expected.length)
    for (const n of expected) expect(names.has(n)).toBe(true)
  })
})
