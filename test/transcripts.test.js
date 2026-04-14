import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { openDb } from '../src/db.js'
import { parseTranscriptFile, listTranscriptFiles } from '../src/transcripts/scanner.js'
import { autoMatch, collectOrphans } from '../src/transcripts/matcher.js'
import { createTranscriptsService } from '../src/transcripts/index.js'

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qt-ts-'))
}

const CLAUDE_UUID = 'abcdef12-3456-7890-abcd-ef1234567890'
const CODEX_UUID = '019d8060-8159-7790-b152-dcafefd784f4'

function writeClaudeFile(dir, cwd, uuid = CLAUDE_UUID) {
  const encoded = cwd.replace(/\//g, '-')
  const projDir = path.join(dir, encoded)
  fs.mkdirSync(projDir, { recursive: true })
  const filePath = path.join(projDir, `${uuid}.jsonl`)
  const lines = [
    { type: 'user', sessionId: uuid, cwd, timestamp: '2026-04-14T10:00:00.000Z', message: { role: 'user', content: 'hello claude please help with foo' } },
    { type: 'assistant', sessionId: uuid, cwd, timestamp: '2026-04-14T10:00:30.000Z', message: { role: 'assistant', content: 'sure i will help' } },
  ]
  fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return filePath
}

function writeCodexFile(dir, cwd, uuid = CODEX_UUID) {
  const day = path.join(dir, '2026', '04', '14')
  fs.mkdirSync(day, { recursive: true })
  const filePath = path.join(day, `rollout-2026-04-14T10-00-00-${uuid}.jsonl`)
  const lines = [
    { type: 'session_meta', timestamp: '2026-04-14T10:00:00.000Z', payload: { id: uuid, cwd, timestamp: '2026-04-14T10:00:00.000Z' } },
    { type: 'turn', timestamp: '2026-04-14T10:00:10.000Z', payload: { role: 'user', content: 'hi codex do thing' } },
  ]
  fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return filePath
}

describe('scanner', () => {
  let tmp
  beforeEach(() => { tmp = mkTmpDir() })
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  it('parses Claude jsonl', async () => {
    const fp = writeClaudeFile(tmp, '/Users/me/proj')
    const r = await parseTranscriptFile('claude', fp)
    expect(r.nativeId).toBe(CLAUDE_UUID)
    expect(r.cwd).toBe('/Users/me/proj')
    expect(r.firstUserPrompt).toMatch(/hello claude/)
    expect(r.turnCount).toBe(2)
  })

  it('parses Codex jsonl', async () => {
    const codexRoot = path.join(tmp, 'codex')
    const fp = writeCodexFile(codexRoot, '/Users/me/proj')
    const r = await parseTranscriptFile('codex', fp)
    expect(r.nativeId).toBe(CODEX_UUID)
    expect(r.cwd).toBe('/Users/me/proj')
    expect(r.firstUserPrompt).toMatch(/hi codex/)
  })

  it('listTranscriptFiles walks both dirs', () => {
    const claudeDir = path.join(tmp, 'claude')
    const codexDir = path.join(tmp, 'codex')
    fs.mkdirSync(claudeDir); fs.mkdirSync(codexDir)
    writeClaudeFile(claudeDir, '/Users/me/a')
    writeCodexFile(codexDir, '/Users/me/b')
    const files = listTranscriptFiles({ claudeDir, codexDir })
    expect(files).toHaveLength(2)
    const tools = files.map(f => f.tool).sort()
    expect(tools).toEqual(['claude', 'codex'])
  })
})

describe('matcher', () => {
  it('auto-binds when cwd + time ±60s + prompt[:100] all match', () => {
    const orphans = collectOrphans([{
      id: 't1',
      workDir: '/p',
      aiSessions: [{ sessionId: 's1', tool: 'claude', startedAt: 1000_000, prompt: 'hello claude please help with foo' }],
    }])
    const files = [{ id: 1, tool: 'claude', cwd: '/p', started_at: 1000_000 + 5000, first_user_prompt: 'hello claude please help with foo', native_id: 'n1' }]
    const pairs = autoMatch(files, orphans)
    expect(pairs).toHaveLength(1)
    expect(pairs[0]).toMatchObject({ fileId: 1, todoId: 't1', nativeId: 'n1' })
  })

  it('does not bind when cwd mismatches', () => {
    const orphans = collectOrphans([{ id: 't1', workDir: '/p', aiSessions: [{ sessionId: 's1', tool: 'claude', startedAt: 1_000_000, prompt: 'x' }] }])
    const files = [{ id: 1, tool: 'claude', cwd: '/q', started_at: 1_000_000, first_user_prompt: 'x', native_id: 'n' }]
    expect(autoMatch(files, orphans)).toEqual([])
  })

  it('does not bind when time window exceeded', () => {
    const orphans = collectOrphans([{ id: 't1', workDir: '/p', aiSessions: [{ sessionId: 's1', tool: 'claude', startedAt: 1_000_000, prompt: 'x' }] }])
    const files = [{ id: 1, tool: 'claude', cwd: '/p', started_at: 2_000_000, first_user_prompt: 'x', native_id: 'n' }]
    expect(autoMatch(files, orphans)).toEqual([])
  })

  it('does not bind on prompt mismatch', () => {
    const orphans = collectOrphans([{ id: 't1', workDir: '/p', aiSessions: [{ sessionId: 's1', tool: 'claude', startedAt: 1_000_000, prompt: 'x' }] }])
    const files = [{ id: 1, tool: 'claude', cwd: '/p', started_at: 1_000_000, first_user_prompt: 'y', native_id: 'n' }]
    expect(autoMatch(files, orphans)).toEqual([])
  })
})

describe('transcripts service', () => {
  let db, tmp, service

  beforeEach(() => {
    db = openDb(':memory:')
    tmp = mkTmpDir()
    fs.mkdirSync(path.join(tmp, 'claude'))
    fs.mkdirSync(path.join(tmp, 'codex'))
    service = createTranscriptsService({
      db,
      listTodos: () => db.listTodos(),
      updateTodo: (id, patch) => db.updateTodo(id, patch),
      dirs: { claude: path.join(tmp, 'claude'), codex: path.join(tmp, 'codex') },
    })
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('scanFull indexes and auto-binds', async () => {
    const cwd = '/Users/me/demo'
    writeClaudeFile(path.join(tmp, 'claude'), cwd)
    const todo = db.createTodo({ title: 'demo', quadrant: 1, workDir: cwd })
    db.updateTodo(todo.id, {
      aiSessions: [{ sessionId: 'local', tool: 'claude', startedAt: Date.parse('2026-04-14T10:00:10.000Z'), prompt: 'hello claude please help with foo' }],
    })

    const r = await service.scanFull()
    expect(r.newFiles).toBe(1)
    expect(r.indexed).toBe(1)
    expect(r.autoBound).toBe(1)
    expect(r.unbound).toBe(0)

    const updated = db.getTodo(todo.id)
    const s = updated.aiSessions[0]
    expect(s.nativeSessionId).toBe(CLAUDE_UUID)
    expect(s.source).toBe('imported')
  })

  it('search returns FTS snippet when available', async () => {
    if (!db.ftsAvailable) return
    writeClaudeFile(path.join(tmp, 'claude'), '/p')
    await service.scanFull()
    const r = service.search({ q: 'help' })
    expect(r.total).toBeGreaterThan(0)
    expect(r.items[0].snippet).toMatch(/<mark>/)
  })

  it('bind returns 409-style conflict when reassigning, force=true moves', async () => {
    writeClaudeFile(path.join(tmp, 'claude'), '/p')
    const a = db.createTodo({ title: 'a', quadrant: 1 })
    const b = db.createTodo({ title: 'b', quadrant: 1 })
    await service.scanFull()
    const item = service.search({}).items[0]

    const r1 = service.bind(item.id, a.id)
    expect(r1.ok).toBe(true)

    const r2 = service.bind(item.id, b.id)
    expect(r2.ok).toBe(false)
    expect(r2.code).toBe('ALREADY_BOUND')
    expect(r2.currentTodoId).toBe(a.id)

    const r3 = service.bind(item.id, b.id, { force: true })
    expect(r3.ok).toBe(true)

    const aUpdated = db.getTodo(a.id)
    const bUpdated = db.getTodo(b.id)
    expect(aUpdated.aiSessions.some(s => s?.nativeSessionId === CLAUDE_UUID)).toBe(false)
    expect(bUpdated.aiSessions.some(s => s?.nativeSessionId === CLAUDE_UUID)).toBe(true)
  })

  it('unbind removes imported session and clears bound_todo_id', async () => {
    writeClaudeFile(path.join(tmp, 'claude'), '/p')
    const t = db.createTodo({ title: 't', quadrant: 1 })
    await service.scanFull()
    const item = service.search({}).items[0]
    service.bind(item.id, t.id)

    service.unbind(item.id)
    const after = db.getTodo(t.id)
    expect(after.aiSessions.some(s => s?.nativeSessionId === CLAUDE_UUID)).toBe(false)
    const file = service.getFile(item.id)
    expect(file.bound_todo_id).toBeNull()
  })
})
