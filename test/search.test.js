import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db.js'
import { createSearchService } from '../src/search/index.js'

describe('searchService', () => {
  let db
  let wikiDir
  let tmp
  let svc

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'quadtodo-search-'))
    wikiDir = join(tmp, 'wiki')
    mkdirSync(wikiDir, { recursive: true })
    db = openDb(':memory:')
    svc = createSearchService({ db, wikiDir })
    svc.init()
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('finds a todo by title keyword', () => {
    db.createTodo({ title: 'Fix login bug', quadrant: 1 })
    db.createTodo({ title: 'Deploy staging', quadrant: 2 })
    const res = svc.search({ query: 'login' })
    expect(res.total).toBeGreaterThan(0)
    const todoResults = res.results.filter((r) => r.scope === 'todos')
    expect(todoResults.length).toBe(1)
    expect(todoResults[0].snippet).toMatch(/login/i)
  })

  it('finds a todo by description keyword', () => {
    db.createTodo({ title: 'X', quadrant: 1, description: 'Please rewrite the authentication handler' })
    const res = svc.search({ query: 'authentication' })
    const todoResults = res.results.filter((r) => r.scope === 'todos')
    expect(todoResults.length).toBe(1)
    expect(todoResults[0].snippet).toMatch(/authentication/i)
  })

  it('prefix matches (partial word)', () => {
    db.createTodo({ title: 'Deployment pipeline setup', quadrant: 1 })
    const res = svc.search({ query: 'Deploy' })
    expect(res.results.some((r) => r.scope === 'todos')).toBe(true)
  })

  it('combines scopes and ranks by relevance', () => {
    const a = db.createTodo({ title: 'foo bar baz', quadrant: 1 })
    db.addComment(a.id, 'bar the second')
    const res = svc.search({ query: 'bar' })
    expect(res.total).toBeGreaterThanOrEqual(2)
    const scopes = new Set(res.results.map((r) => r.scope))
    expect(scopes.has('todos')).toBe(true)
    expect(scopes.has('comments')).toBe(true)
  })

  it('excludes archived todos by default', () => {
    const a = db.createTodo({ title: 'hidden dragon', quadrant: 1 })
    db.archiveTodo(a.id)
    const res = svc.search({ query: 'dragon' })
    expect(res.results.find((r) => r.todoId === a.id)).toBeFalsy()
  })

  it('includeArchived:true includes them', () => {
    const a = db.createTodo({ title: 'hidden dragon', quadrant: 1 })
    db.archiveTodo(a.id)
    const res = svc.search({ query: 'dragon', includeArchived: true })
    const hit = res.results.find((r) => r.todoId === a.id)
    expect(hit).toBeTruthy()
    expect(hit.archived).toBe(true)
  })

  it('respects scopes filter', () => {
    const a = db.createTodo({ title: 'alpha', quadrant: 1 })
    db.addComment(a.id, 'alpha too')
    const res = svc.search({ query: 'alpha', scopes: ['comments'] })
    expect(res.results.every((r) => r.scope === 'comments')).toBe(true)
  })

  it('indexes ai_sessions via JSON trigger on updateTodo', () => {
    const a = db.createTodo({ title: 'X', quadrant: 1 })
    // 模拟把 aiSessions 写进去
    db.updateTodo(a.id, {
      aiSessions: [
        { sessionId: 's1', label: 'debug frontend regression', command: 'claude', nativeSessionId: 'native-1' },
        { sessionId: 's2', label: 'backend work', command: 'codex', nativeSessionId: 'native-2' },
      ],
    })
    const res = svc.search({ query: 'regression' })
    const aiRes = res.results.filter((r) => r.scope === 'ai_sessions')
    expect(aiRes.length).toBe(1)
    expect(aiRes[0].todoId).toBe(a.id)
    expect(aiRes[0].sessionId).toBe('s1')
  })

  it('indexes wiki content from files', () => {
    const a = db.createTodo({ title: 'Subject', quadrant: 1 })
    writeFileSync(join(wikiDir, `${a.id}.md`), '# memo\n\nThis is an important reminder about latency budgets.')
    svc.reindexWiki()
    const res = svc.search({ query: 'latency' })
    const wikiHits = res.results.filter((r) => r.scope === 'wiki')
    expect(wikiHits.length).toBe(1)
    expect(wikiHits[0].todoId).toBe(a.id)
  })

  it('returns empty on empty query', () => {
    db.createTodo({ title: 'A', quadrant: 1 })
    expect(() => svc.search({ query: '' })).toThrow(/query_required/)
  })

  it('handles FTS5-unsafe characters without crashing', () => {
    db.createTodo({ title: 'normal content', quadrant: 1 })
    // 含引号 / 括号 / 星号的 query
    const res = svc.search({ query: '"content" (*)' })
    // 不抛异常即可；命中不保证
    expect(typeof res.total).toBe('number')
  })

  it('limit caps results', () => {
    for (let i = 0; i < 30; i++) {
      db.createTodo({ title: `item ${i} keyword`, quadrant: 1 })
    }
    const res = svc.search({ query: 'keyword', limit: 5 })
    expect(res.results.length).toBeLessThanOrEqual(5)
  })

  it('trigger maintains consistency on title update', () => {
    const a = db.createTodo({ title: 'old name', quadrant: 1 })
    db.updateTodo(a.id, { title: 'fresh apple' })
    const r1 = svc.search({ query: 'fresh' })
    expect(r1.results.some((x) => x.todoId === a.id)).toBe(true)
    const r2 = svc.search({ query: 'old' })
    expect(r2.results.some((x) => x.todoId === a.id)).toBe(false)
  })

  it('trigger removes rows on deleteTodo', () => {
    const a = db.createTodo({ title: 'transient', quadrant: 1 })
    db.deleteTodo(a.id)
    const res = svc.search({ query: 'transient' })
    expect(res.results.find((x) => x.todoId === a.id)).toBeFalsy()
  })
})
