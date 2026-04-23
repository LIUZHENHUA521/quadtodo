import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb } from '../src/db.js'
import { createTranscriptScanner } from '../src/search/transcripts.js'

describe('transcriptScanner', () => {
  let tmp, logDir, db, scanner

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'quadtodo-ts-'))
    logDir = join(tmp, 'logs')
    mkdirSync(logDir, { recursive: true })
    db = openDb(':memory:')
    scanner = createTranscriptScanner({ db, logDir })
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function seed({ todoId, sessionId, startedAt, body, todoTitle = 'T' }) {
    const todo = db.getTodo(todoId) || db.createTodo({ title: todoTitle, quadrant: 1 })
    const sessions = Array.isArray(todo.aiSessions) ? todo.aiSessions.slice() : []
    sessions.push({ sessionId, tool: 'claude', startedAt, completedAt: startedAt + 1000 })
    db.updateTodo(todo.id, { aiSessions: sessions })
    writeFileSync(join(logDir, `${sessionId}.log`), body, 'utf8')
    return todo.id
  }

  it('finds matching lines with context', () => {
    const tId = seed({
      sessionId: 'ai-1',
      startedAt: 1_700_000_000_000,
      body: 'line1\nline2 MATCH_ME here\nline3\n',
    })
    const out = scanner.search({ query: 'MATCH_ME' })
    expect(out.totalMatches).toBe(1)
    const m = out.matches[0]
    expect(m.todoId).toBe(tId)
    expect(m.sessionId).toBe('ai-1')
    expect(m.beforeLines).toContain('line1')
    expect(m.matchLine).toMatch(/MATCH_ME/)
    expect(m.afterLines).toContain('line3')
  })

  it('respects todoId filter', () => {
    const t1 = db.createTodo({ title: 'First', quadrant: 1 })
    const t2 = db.createTodo({ title: 'Second', quadrant: 1 })
    db.updateTodo(t1.id, { aiSessions: [{ sessionId: 's1', startedAt: 1 }] })
    db.updateTodo(t2.id, { aiSessions: [{ sessionId: 's2', startedAt: 1 }] })
    writeFileSync(join(logDir, 's1.log'), 'apple keyword pie\n')
    writeFileSync(join(logDir, 's2.log'), 'banana keyword split\n')
    const out = scanner.search({ query: 'keyword', todoId: t1.id })
    expect(out.totalMatches).toBe(1)
    expect(out.matches[0].matchLine).toMatch(/apple/)
  })

  it('caps with maxMatches across files', () => {
    for (let i = 0; i < 5; i++) {
      seed({
        todoTitle: `T${i}`,
        sessionId: `sess-${i}`,
        startedAt: 1700 + i,
        body: 'hit\nhit\nhit\n',
      })
    }
    const out = scanner.search({ query: 'hit', maxMatches: 3 })
    expect(out.totalMatches).toBe(3)
  })

  it('afterTs / beforeTs filters', () => {
    const base = 1_700_000_000_000
    seed({ sessionId: 'early', startedAt: base - 1000, body: 'match\n' })
    seed({ sessionId: 'late', startedAt: base + 1000, body: 'match\n' })
    const out = scanner.search({ query: 'match', afterTs: base })
    const ids = out.matches.map((m) => m.sessionId)
    expect(ids).toContain('late')
    expect(ids).not.toContain('early')
  })

  it('case-insensitive match', () => {
    seed({ sessionId: 's1', startedAt: 1, body: 'Hello There\n' })
    const out = scanner.search({ query: 'hello' })
    expect(out.totalMatches).toBe(1)
  })

  it('readSession returns full body under limit', () => {
    const tId = seed({ sessionId: 'rs1', startedAt: 1, body: 'short content' })
    const out = scanner.readSession({ sessionId: 'rs1' })
    expect(out.exists).toBe(true)
    expect(out.body).toBe('short content')
    expect(out.truncated).toBe(false)
    expect(tId).toBeTruthy()
  })

  it('readSession tail-truncates big content', () => {
    const big = 'x'.repeat(1000) + 'TAIL_MARKER'
    seed({ sessionId: 'big', startedAt: 1, body: big })
    const out = scanner.readSession({ sessionId: 'big', maxChars: 50 })
    expect(out.truncated).toBe(true)
    expect(out.body).toContain('TAIL_MARKER')
    expect(out.droppedChars).toBeGreaterThan(0)
  })

  it('readSession returns exists:false when no file', () => {
    const out = scanner.readSession({ sessionId: 'missing' })
    expect(out.exists).toBe(false)
  })

  it('rejects empty query', () => {
    expect(() => scanner.search({ query: '' })).toThrow(/query_required/)
  })
})
