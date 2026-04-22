import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openDb } from '../src/db.js'

describe('db', () => {
  let db

  beforeEach(() => {
    db = openDb(':memory:')
  })

  it('initializes schema and starts empty', () => {
    expect(db.listTodos({})).toEqual([])
  })

  it('creates a todo with default sortOrder', () => {
    const t = db.createTodo({ title: 'Write spec', quadrant: 2 })
    expect(t.id).toBeTruthy()
    expect(t.title).toBe('Write spec')
    expect(t.quadrant).toBe(2)
    expect(t.status).toBe('todo')
    expect(t.sortOrder).toBe(1024)
    expect(t.createdAt).toBeTypeOf('number')
  })

  it('new todos in same quadrant get increasing sortOrder', () => {
    const a = db.createTodo({ title: 'A', quadrant: 1 })
    const b = db.createTodo({ title: 'B', quadrant: 1 })
    expect(b.sortOrder).toBe(a.sortOrder + 1024)
  })

  it('subtodos inherit parent quadrant and track parentId', () => {
    const parent = db.createTodo({ title: 'Parent', quadrant: 2 })
    const child = db.createTodo({ title: 'Child', quadrant: 4, parentId: parent.id })
    expect(child.parentId).toBe(parent.id)
    expect(child.quadrant).toBe(2)
    expect(child.sortOrder).toBe(1024)
  })

  it('subtodos sort within the same parent', () => {
    const parent = db.createTodo({ title: 'Parent', quadrant: 1 })
    const a = db.createTodo({ title: 'A', quadrant: 1, parentId: parent.id })
    const b = db.createTodo({ title: 'B', quadrant: 1, parentId: parent.id })
    expect(b.sortOrder).toBe(a.sortOrder + 1024)
  })

  it('listTodos filters by quadrant', () => {
    db.createTodo({ title: 'Q1', quadrant: 1 })
    db.createTodo({ title: 'Q2', quadrant: 2 })
    expect(db.listTodos({ quadrant: 1 })).toHaveLength(1)
    expect(db.listTodos({ quadrant: 2 })).toHaveLength(1)
  })

  it('listTodos status=todo expands to all unfinished states', () => {
    const a = db.createTodo({ title: 'A', quadrant: 1 })
    db.updateTodo(a.id, { status: 'ai_running' })
    const b = db.createTodo({ title: 'B', quadrant: 1 })
    db.updateTodo(b.id, { status: 'done' })
    const list = db.listTodos({ status: 'todo' })
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe('A')
  })

  it('listTodos status=done is strict', () => {
    const a = db.createTodo({ title: 'A', quadrant: 1 })
    db.updateTodo(a.id, { status: 'done' })
    expect(db.listTodos({ status: 'done' })).toHaveLength(1)
  })

  it('listTodos keyword matches title substring case-insensitive', () => {
    db.createTodo({ title: 'Fix Login Bug', quadrant: 1 })
    db.createTodo({ title: 'Write docs', quadrant: 2 })
    expect(db.listTodos({ keyword: 'login' })).toHaveLength(1)
    expect(db.listTodos({ keyword: 'DOCS' })).toHaveLength(1)
  })

  it('updateTodo changes fields and bumps updatedAt', async () => {
    const t = db.createTodo({ title: 'A', quadrant: 1 })
    await new Promise(r => setTimeout(r, 2))
    const updated = db.updateTodo(t.id, { title: 'A2', description: 'd', workDir: '/tmp/project-a' })
    expect(updated.title).toBe('A2')
    expect(updated.description).toBe('d')
    expect(updated.workDir).toBe('/tmp/project-a')
    expect(updated.updatedAt).toBeGreaterThan(t.updatedAt)
  })

  it('updateTodo can cross quadrants and update sortOrder', () => {
    const t = db.createTodo({ title: 'A', quadrant: 1 })
    db.updateTodo(t.id, { quadrant: 3, sortOrder: 500 })
    const list = db.listTodos({ quadrant: 3 })
    expect(list).toHaveLength(1)
    expect(list[0].sortOrder).toBe(500)
  })

  it('updateTodo stores aiSession as JSON and returns parsed object', () => {
    const t = db.createTodo({ title: 'A', quadrant: 1 })
    const session = {
      sessionId: 'ai-123',
      tool: 'claude',
      nativeSessionId: null,
      status: 'running',
      startedAt: Date.now(),
      completedAt: null,
      prompt: 'hi',
    }
    const updated = db.updateTodo(t.id, { aiSession: session })
    expect(updated.aiSession.sessionId).toBe('ai-123')
    expect(updated.aiSession.tool).toBe('claude')
    expect(updated.aiSessions).toHaveLength(1)
  })

  it('rowToTodo keeps aiSessions history and selects running session as aiSession', () => {
    const t = db.createTodo({ title: 'A', quadrant: 1 })
    const sessions = [
      {
        sessionId: 'old',
        tool: 'claude',
        nativeSessionId: 'old-native',
        status: 'done',
        startedAt: 1,
        completedAt: 2,
        prompt: 'old prompt',
      },
      {
        sessionId: 'new',
        tool: 'codex',
        nativeSessionId: 'new-native',
        status: 'running',
        startedAt: 3,
        completedAt: null,
        prompt: 'new prompt',
      },
    ]
    const updated = db.updateTodo(t.id, { aiSessions: sessions })
    expect(updated.aiSessions).toHaveLength(2)
    expect(updated.aiSession.sessionId).toBe('new')
  })

  it('deleteTodo removes the row', () => {
    const t = db.createTodo({ title: 'A', quadrant: 1 })
    db.deleteTodo(t.id)
    expect(db.listTodos({})).toHaveLength(0)
  })

  it('deleteTodo cascades to subtodos', () => {
    const parent = db.createTodo({ title: 'Parent', quadrant: 1 })
    db.createTodo({ title: 'Child', quadrant: 1, parentId: parent.id })
    db.deleteTodo(parent.id)
    expect(db.listTodos({})).toHaveLength(0)
  })

  it('getTodo returns null for unknown id', () => {
    expect(db.getTodo('nope')).toBeNull()
  })

  it('nextSortOrder returns max+1024 for a quadrant', () => {
    db.createTodo({ title: 'A', quadrant: 1 })
    db.createTodo({ title: 'B', quadrant: 1 })
    expect(db.nextSortOrder(1)).toBe(3 * 1024)
    expect(db.nextSortOrder(2)).toBe(1024)
  })

  it('updateTodo syncs child quadrant when parent moves', () => {
    const parent = db.createTodo({ title: 'Parent', quadrant: 1 })
    const child = db.createTodo({ title: 'Child', quadrant: 1, parentId: parent.id })
    db.updateTodo(parent.id, { quadrant: 3 })
    expect(db.getTodo(child.id)?.quadrant).toBe(3)
  })

  describe('completed_at', () => {
    it('new todo has completedAt=null and becomes set when status→done', async () => {
      const t = db.createTodo({ title: 'A', quadrant: 1 })
      expect(t.completedAt).toBeNull()
      const done = db.updateTodo(t.id, { status: 'done' })
      expect(done.completedAt).toBeTypeOf('number')
      expect(done.completedAt).toBeGreaterThanOrEqual(t.createdAt)
    })

    it('reverting status from done clears completedAt', () => {
      const t = db.createTodo({ title: 'A', quadrant: 1 })
      db.updateTodo(t.id, { status: 'done' })
      const reverted = db.updateTodo(t.id, { status: 'todo' })
      expect(reverted.completedAt).toBeNull()
    })

    it('re-completing updates completedAt to the latest moment', async () => {
      const t = db.createTodo({ title: 'A', quadrant: 1 })
      const first = db.updateTodo(t.id, { status: 'done' })
      db.updateTodo(t.id, { status: 'todo' })
      await new Promise(r => setTimeout(r, 5))
      const second = db.updateTodo(t.id, { status: 'done' })
      expect(second.completedAt).toBeGreaterThan(first.completedAt)
    })

    it('editing a done todo does NOT change completedAt', async () => {
      const t = db.createTodo({ title: 'A', quadrant: 1 })
      const done = db.updateTodo(t.id, { status: 'done' })
      await new Promise(r => setTimeout(r, 5))
      const edited = db.updateTodo(t.id, { title: 'A2' })
      expect(edited.completedAt).toBe(done.completedAt)
    })

    it('listCompletedTodos filters by [since, until) and sorts DESC by completedAt', async () => {
      const a = db.createTodo({ title: 'A', quadrant: 1 })
      const b = db.createTodo({ title: 'B', quadrant: 2 })
      const c = db.createTodo({ title: 'C', quadrant: 3 })
      const ta = db.updateTodo(a.id, { status: 'done' }).completedAt
      await new Promise(r => setTimeout(r, 2))
      const tb = db.updateTodo(b.id, { status: 'done' }).completedAt
      await new Promise(r => setTimeout(r, 2))
      const tc = db.updateTodo(c.id, { status: 'done' }).completedAt
      const all = db.listCompletedTodos({ since: ta, until: tc + 1 })
      expect(all.map(t => t.title)).toEqual(['C', 'B', 'A'])
      const middle = db.listCompletedTodos({ since: tb, until: tc })
      expect(middle.map(t => t.title)).toEqual(['B'])
    })

    it('countMissedInRange counts todos with status=missed by updated_at', () => {
      const now = Date.now()
      const t = db.createTodo({ title: 'Missed one', quadrant: 1 })
      // 直接用 raw 模拟 sweepRecurring 打 missed 状态
      db.raw.prepare(`UPDATE todos SET status = 'missed', updated_at = ? WHERE id = ?`).run(now, t.id)
      expect(db.countMissedInRange({ since: now - 1000, until: now + 1000 })).toBe(1)
      expect(db.countMissedInRange({ since: now + 2000, until: now + 3000 })).toBe(0)
    })
  })

  describe('ai_session_log', () => {
    it('insertSessionLog + querySessionStats aggregates', () => {
      const now = Date.now()
      db.insertSessionLog({ id: 's1', todoId: 't1', tool: 'claude', quadrant: 1, status: 'done', exitCode: 0, startedAt: now - 60000, completedAt: now - 30000 })
      db.insertSessionLog({ id: 's2', todoId: 't2', tool: 'codex', quadrant: 2, status: 'failed', exitCode: 1, startedAt: now - 120000, completedAt: now - 100000 })
      db.insertSessionLog({ id: 's3', todoId: 't3', tool: 'claude', quadrant: 1, status: 'stopped', exitCode: null, startedAt: now - 10000, completedAt: now - 5000 })
      const stats = db.querySessionStats({ since: now - 3600_000, until: now })
      expect(stats.total).toBe(3)
      expect(stats.byStatus.done).toBe(1)
      expect(stats.byStatus.failed).toBe(1)
      expect(stats.byStatus.stopped).toBe(1)
      expect(stats.byTool.claude).toBe(2)
      expect(stats.byTool.codex).toBe(1)
      expect(stats.byQuadrant[1]).toBe(2)
      expect(stats.byQuadrant[2]).toBe(1)
      expect(stats.totalDurationMs).toBe(30000 + 20000 + 5000)
      expect(stats.avgDurationMs).toBe(Math.round((30000 + 20000 + 5000) / 3))
    })

    it('querySessionStats excludes rows outside range', () => {
      const now = Date.now()
      db.insertSessionLog({ id: 's1', todoId: 't1', tool: 'claude', quadrant: 1, status: 'done', exitCode: 0, startedAt: now - 100, completedAt: now - 50 })
      const stats = db.querySessionStats({ since: now + 1000, until: now + 2000 })
      expect(stats.total).toBe(0)
    })

    it('listSessionLogsInWindow 返回同 tool 且 started_at 在窗口内的日志', () => {
      db.insertSessionLog({ id: 'a', todoId: 't1', tool: 'claude', quadrant: 1, status: 'done', startedAt: 1_000_000, completedAt: 1_001_000 })
      db.insertSessionLog({ id: 'b', todoId: 't2', tool: 'claude', quadrant: 1, status: 'done', startedAt: 1_000_030, completedAt: 1_001_030 })
      db.insertSessionLog({ id: 'c', todoId: 't3', tool: 'codex',  quadrant: 1, status: 'done', startedAt: 1_000_010, completedAt: 1_001_010 })
      db.insertSessionLog({ id: 'd', todoId: 't4', tool: 'claude', quadrant: 1, status: 'done', startedAt: 2_000_000, completedAt: 2_001_000 })

      const out = db.listSessionLogsInWindow('claude', 1_000_020, 60_000)
      // 期望：a 和 b 命中（claude 且在 ±60s 内），c 被 tool 过滤，d 在窗外
      const ids = out.map(r => r.id).sort()
      expect(ids).toEqual(['a', 'b'])
      // 返回字段必须至少包含 id, todo_id, tool, started_at
      expect(out[0]).toHaveProperty('todo_id')
      expect(out[0]).toHaveProperty('started_at')
    })
  })
})

describe('transcript_files usage columns', () => {
  it('upsert 可写入 usage / active_ms / primary_model 字段', () => {
    const db = openDb(':memory:')
    db.upsertTranscriptFile({
      tool: 'claude',
      nativeId: 'u1',
      cwd: '/tmp',
      jsonlPath: '/tmp/u1.jsonl',
      size: 10, mtime: 1,
      startedAt: 1000, endedAt: 2000,
      firstUserPrompt: 'hi', turnCount: 2,
      inputTokens: 100, outputTokens: 50,
      cacheReadTokens: 10, cacheCreationTokens: 5,
      primaryModel: 'claude-sonnet-4-6', activeMs: 800,
    })
    const row = db.raw.prepare(`SELECT * FROM transcript_files WHERE jsonl_path = ?`).get('/tmp/u1.jsonl')
    expect(row.input_tokens).toBe(100)
    expect(row.output_tokens).toBe(50)
    expect(row.cache_read_tokens).toBe(10)
    expect(row.cache_creation_tokens).toBe(5)
    expect(row.primary_model).toBe('claude-sonnet-4-6')
    expect(row.active_ms).toBe(800)
    db.close()
  })

  it('老 todos DB 没有 completed_at 列时自动补列并用 updated_at 回填', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'quadtodo-completed-migration-'))
    const tmpFile = path.join(tmpDir, 'old.db')
    let migratedDb
    try {
      const raw = new Database(tmpFile)
      raw.exec(`
        CREATE TABLE todos (
          id          TEXT PRIMARY KEY,
          parent_id   TEXT,
          title       TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          quadrant    INTEGER NOT NULL CHECK(quadrant IN (1,2,3,4)),
          status      TEXT NOT NULL DEFAULT 'todo',
          due_date    INTEGER,
          work_dir    TEXT,
          sort_order  REAL NOT NULL,
          ai_session  TEXT,
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL
        )
      `)
      raw.prepare(`
        INSERT INTO todos (id, title, quadrant, status, sort_order, created_at, updated_at)
        VALUES ('done1', 'old done', 1, 'done', 1024, 100, 500),
               ('todo1', 'still todo', 2, 'todo', 1024, 100, 500)
      `).run()
      raw.close()

      migratedDb = openDb(tmpFile)
      const cols = migratedDb.raw.prepare(`PRAGMA table_info(todos)`).all().map(c => c.name)
      expect(cols).toContain('completed_at')

      const doneRow = migratedDb.raw.prepare(`SELECT completed_at FROM todos WHERE id = 'done1'`).get()
      expect(doneRow.completed_at).toBe(500)
      const todoRow = migratedDb.raw.prepare(`SELECT completed_at FROM todos WHERE id = 'todo1'`).get()
      expect(todoRow.completed_at).toBeNull()
    } finally {
      migratedDb?.close()
      rmSync(tmpDir, { recursive: true })
    }
  })

  it('老 DB 自动补列', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'quadtodo-migration-test-'))
    const tmpFile = path.join(tmpDir, 'old.db')
    let migratedDb
    try {
      // 1. Create old-schema DB without usage columns
      const raw = new Database(tmpFile)
      raw.exec(`
        CREATE TABLE transcript_files (
          id                INTEGER PRIMARY KEY,
          tool              TEXT NOT NULL,
          native_id         TEXT,
          cwd               TEXT,
          jsonl_path        TEXT NOT NULL UNIQUE,
          size              INTEGER NOT NULL,
          mtime             INTEGER NOT NULL,
          started_at        INTEGER,
          ended_at          INTEGER,
          first_user_prompt TEXT,
          turn_count        INTEGER NOT NULL DEFAULT 0,
          bound_todo_id     TEXT,
          indexed_at        INTEGER NOT NULL
        )
      `)
      raw.close()

      // 2. Open via openDb — must run migration
      migratedDb = openDb(tmpFile)

      // 3. Assert all 6 new columns now exist
      const cols = migratedDb.raw.prepare(`PRAGMA table_info(transcript_files)`).all().map(c => c.name)
      for (const c of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'primary_model', 'active_ms']) {
        expect(cols).toContain(c)
      }
    } finally {
      migratedDb?.close()
      rmSync(tmpDir, { recursive: true })
    }
  })
})
