import { describe, it, expect, beforeEach } from 'vitest'
import { openDb } from '../src/db.js'

describe('db wiki tables', () => {
  let db
  beforeEach(() => { db = openDb(':memory:') })

  it('createWikiRun + completeWikiRun roundtrip', () => {
    const run = db.createWikiRun({ todoCount: 3, dryRun: 0 })
    expect(run.id).toBeGreaterThan(0)
    expect(run.started_at).toBeGreaterThan(0)
    expect(run.completed_at).toBeNull()

    db.completeWikiRun(run.id, { exitCode: 0, note: 'ok' })
    const [row] = db.listWikiRuns({ limit: 10 })
    expect(row.id).toBe(run.id)
    expect(row.exit_code).toBe(0)
    expect(row.completed_at).toBeGreaterThan(0)
    expect(row.note).toBe('ok')
  })

  it('failWikiRun sets error', () => {
    const run = db.createWikiRun({ todoCount: 1, dryRun: 0 })
    db.failWikiRun(run.id, 'claude spawn failed')
    const [row] = db.listWikiRuns({ limit: 10 })
    expect(row.error).toBe('claude spawn failed')
    expect(row.completed_at).toBeGreaterThan(0)
  })

  it('upsertCoverage stores llm_applied flag', () => {
    const run = db.createWikiRun({ todoCount: 1, dryRun: 1 })
    db.upsertWikiCoverage(run.id, 'todo-xyz', 'sources/2026-04-20-todo-xyz.md', false)
    const coverage = db.listCoverageForTodo('todo-xyz')
    expect(coverage).toHaveLength(1)
    expect(coverage[0].llm_applied).toBe(0)
    expect(coverage[0].source_path).toBe('sources/2026-04-20-todo-xyz.md')
  })

  it('markCoverageApplied updates llm_applied=1', () => {
    const run = db.createWikiRun({ todoCount: 1, dryRun: 0 })
    db.upsertWikiCoverage(run.id, 'todo-xyz', 'sources/a.md', false)
    db.markCoverageApplied(run.id)
    const coverage = db.listCoverageForTodo('todo-xyz')
    expect(coverage[0].llm_applied).toBe(1)
  })

  it('listUnappliedDoneTodos returns done todos without llm_applied=1 coverage', () => {
    const t1 = db.createTodo({ title: 'a', quadrant: 1, status: 'done' })
    const t2 = db.createTodo({ title: 'b', quadrant: 1, status: 'done' })
    const t3 = db.createTodo({ title: 'c', quadrant: 1, status: 'todo' })  // not done
    const run = db.createWikiRun({ todoCount: 1, dryRun: 0 })
    db.upsertWikiCoverage(run.id, t2.id, 'sources/b.md', true)

    const pending = db.listUnappliedDoneTodos()
    const ids = pending.map(t => t.id)
    expect(ids).toContain(t1.id)
    expect(ids).not.toContain(t2.id)
    expect(ids).not.toContain(t3.id)
  })

  it('findOrphanWikiRuns returns runs with null completed_at', () => {
    const a = db.createWikiRun({ todoCount: 1, dryRun: 0 })
    const b = db.createWikiRun({ todoCount: 1, dryRun: 0 })
    db.completeWikiRun(b.id, { exitCode: 0, note: '' })

    const orphans = db.findOrphanWikiRuns()
    const ids = orphans.map(r => r.id)
    expect(ids).toContain(a.id)
    expect(ids).not.toContain(b.id)
  })
})
