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

describe('scanner preview mode', () => {
  let tmp
  beforeEach(() => { tmp = mkTmpDir() })
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  function writeClaudeRich(dir, cwd, uuid = 'rich1234-0000-0000-0000-000000000001') {
    const encoded = cwd.replace(/\//g, '-')
    const projDir = path.join(dir, encoded)
    fs.mkdirSync(projDir, { recursive: true })
    const filePath = path.join(projDir, `${uuid}.jsonl`)
    const lines = [
      // 1) 真正的 user 输入（纯文本）
      { type: 'user', sessionId: uuid, cwd, timestamp: '2026-04-14T10:00:00.000Z',
        message: { role: 'user', content: 'first user prompt' } },
      // 2) assistant 文本 + tool_use 混合
      { type: 'assistant', sessionId: uuid, timestamp: '2026-04-14T10:00:01.000Z',
        message: { role: 'assistant', content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls /tmp' } },
        ] } },
      // 3) user 角色但 content 是 tool_result —— 旧实现会整轮丢失
      { type: 'user', sessionId: uuid, timestamp: '2026-04-14T10:00:02.000Z',
        message: { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'x', content: 'file1\nfile2\nfile3' },
        ] } },
      // 4) 用户中途追加的纯文本输入
      { type: 'user', sessionId: uuid, timestamp: '2026-04-14T10:00:03.000Z',
        message: { role: 'user', content: 'second user prompt' } },
      // 5) meta 行（应被 preview 过滤）
      { type: 'user', isMeta: true, sessionId: uuid, timestamp: '2026-04-14T10:00:04.000Z',
        message: { role: 'user', content: '<meta-noise>' } },
      // 6) sidechain 行（应被 preview 过滤）
      { type: 'assistant', isSidechain: true, sessionId: uuid, timestamp: '2026-04-14T10:00:05.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: '<sidechain-noise>' }] } },
      // 7) assistant 纯 tool_use（无 text）—— 旧实现会整轮丢失
      { type: 'assistant', sessionId: uuid, timestamp: '2026-04-14T10:00:06.000Z',
        message: { role: 'assistant', content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: '/foo/bar.ts' } },
        ] } },
    ]
    fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
    return filePath
  }

  it('preview=true 保留 tool_result-only user turn', async () => {
    const fp = writeClaudeRich(tmp, '/Users/me/proj')
    const r = await parseTranscriptFile('claude', fp, { preview: true })
    const userTurns = r.turns.filter(t => t.role === 'user')
    expect(userTurns.length).toBe(3)
    expect(userTurns.map(t => t.content)).toEqual([
      'first user prompt',
      expect.stringContaining('📋 result:'),
      'second user prompt',
    ])
    expect(userTurns[1].content).toContain('file1')
  })

  it('preview=true 保留 tool_use-only assistant turn 并渲染 🔧 摘要', async () => {
    const fp = writeClaudeRich(tmp, '/Users/me/proj')
    const r = await parseTranscriptFile('claude', fp, { preview: true })
    const assistantTurns = r.turns.filter(t => t.role === 'assistant')
    expect(assistantTurns.length).toBe(2)
    expect(assistantTurns[0].content).toContain('🔧 Bash: ls /tmp')
    expect(assistantTurns[1].content).toBe('🔧 Edit: /foo/bar.ts')
  })

  it('preview=true 过滤 isMeta / isSidechain', async () => {
    const fp = writeClaudeRich(tmp, '/Users/me/proj')
    const r = await parseTranscriptFile('claude', fp, { preview: true })
    const all = r.turns.map(t => t.content).join('\n')
    expect(all).not.toContain('<meta-noise>')
    expect(all).not.toContain('<sidechain-noise>')
  })

  it('默认 (preview=false) 保持向后兼容：tool_result-only / tool_use-only 仍被丢弃，meta 不过滤', async () => {
    const fp = writeClaudeRich(tmp, '/Users/me/proj')
    const r = await parseTranscriptFile('claude', fp)
    // index 模式不应该把 tool_use/tool_result 写进 FTS 文本，避免改动现有搜索行为
    const joined = r.turns.map(t => t.content).join('\n')
    expect(joined).not.toContain('🔧')
    expect(joined).not.toContain('📋')
    // meta/sidechain 在默认模式下保持原行为（含其文本，若可解析）
    expect(joined).toContain('<meta-noise>')
  })

  it('codex preview=true 渲染 function_call / function_call_output 摘要', async () => {
    const codexRoot = path.join(tmp, 'codex')
    const day = path.join(codexRoot, '2026', '04', '14')
    fs.mkdirSync(day, { recursive: true })
    const uuid = 'codex001-0000-0000-0000-000000000001'
    const fp = path.join(day, `rollout-2026-04-14T10-00-00-${uuid}.jsonl`)
    const lines = [
      { type: 'session_meta', payload: { id: uuid, cwd: '/Users/me/p', timestamp: '2026-04-14T10:00:00.000Z' } },
      { type: 'response_item', timestamp: '2026-04-14T10:00:01.000Z', payload: { type: 'message', role: 'user', content: [{ text: 'do thing' }] } },
      { type: 'response_item', timestamp: '2026-04-14T10:00:02.000Z', payload: { type: 'function_call', name: 'shell', arguments: '{"command":"ls /tmp"}' } },
      { type: 'response_item', timestamp: '2026-04-14T10:00:03.000Z', payload: { type: 'function_call_output', output: 'a\nb\nc' } },
      { type: 'response_item', timestamp: '2026-04-14T10:00:04.000Z', payload: { type: 'reasoning', summary: 'should be hidden' } },
      { type: 'response_item', timestamp: '2026-04-14T10:00:05.000Z', payload: { type: 'message', role: 'assistant', content: [{ text: 'done' }] } },
    ]
    fs.writeFileSync(fp, lines.map(l => JSON.stringify(l)).join('\n') + '\n')

    const r = await parseTranscriptFile('codex', fp, { preview: true })
    expect(r.turns.length).toBe(4)
    expect(r.turns[0]).toEqual({ role: 'user', content: 'do thing' })
    expect(r.turns[1].role).toBe('tool_use')
    expect(r.turns[1].content).toContain('🔧 shell: ls /tmp')
    expect(r.turns[2].role).toBe('tool_result')
    expect(r.turns[2].content).toContain('📋 result:')
    expect(r.turns[2].content).toContain('a\nb\nc')
    expect(r.turns[3]).toEqual({ role: 'assistant', content: 'done' })
    // reasoning 应被隐藏
    expect(r.turns.find(t => t.content.includes('should be hidden'))).toBeUndefined()
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

describe('usage integration', () => {
  it('scanner 解析 claude fixture 时填充 usage 字段', async () => {
    const { parseTranscriptFile } = await import('../src/transcripts/scanner.js')
    const p = new URL('./fixtures/claude-usage.jsonl', import.meta.url).pathname
    const out = await parseTranscriptFile('claude', p)
    expect(out.usage.inputTokens).toBe(160)
    expect(out.usage.primaryModel).toBe('claude-sonnet-4-6')
    expect(out.usage.activeMs).toBe(40000)
  })

  it('usage columns survive full scan→indexer→DB pipeline', async () => {
    const tmp = mkTmpDir()
    const claudeDir = path.join(tmp, 'claude')
    const codexDir = path.join(tmp, 'codex')
    fs.mkdirSync(claudeDir)
    fs.mkdirSync(codexDir)

    // Write the fixture into a properly-structured claude project dir
    const claudeProjectHash = '-Users-me-usage-proj'
    const usageUuid = 'bbbbbbbb-0000-0000-0000-000000000001'
    const projDir = path.join(claudeDir, claudeProjectHash)
    fs.mkdirSync(projDir, { recursive: true })
    const fixtureSrc = path.join(import.meta.dirname, 'fixtures', 'claude-usage.jsonl')
    fs.copyFileSync(fixtureSrc, path.join(projDir, `${usageUuid}.jsonl`))

    const db = openDb(':memory:')
    const service = createTranscriptsService({
      db,
      listTodos: () => db.listTodos(),
      updateTodo: (id, patch) => db.updateTodo(id, patch),
      dirs: { claude: claudeDir, codex: codexDir },
    })

    await service.scanFull()

    const meta = db.listTranscriptFilesMeta()
    expect(meta).toHaveLength(1)
    const row = db.getTranscriptFile(meta[0].id)

    expect(row.input_tokens).toBe(160)
    expect(row.output_tokens).toBe(35)
    expect(row.primary_model).toBe('claude-sonnet-4-6')
    expect(row.active_ms).toBe(40000)

    db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
})
