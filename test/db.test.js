import { describe, it, expect, beforeEach } from 'vitest'
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

  it('getTodo returns null for unknown id', () => {
    expect(db.getTodo('nope')).toBeNull()
  })

  it('nextSortOrder returns max+1024 for a quadrant', () => {
    db.createTodo({ title: 'A', quadrant: 1 })
    db.createTodo({ title: 'B', quadrant: 1 })
    expect(db.nextSortOrder(1)).toBe(3 * 1024)
    expect(db.nextSortOrder(2)).toBe(1024)
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
  })
})
