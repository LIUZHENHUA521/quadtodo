import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { openDb } from '../src/db.js'
import { createWikiService } from '../src/wiki/index.js'
import { loadTranscript } from '../src/transcript.js'

function tmp() { return mkdtempSync(join(tmpdir(), 'qt-wiki-svc-')) }

describe('wiki service init', () => {
  let root, wikiDir, db
  beforeEach(() => {
    root = tmp()
    wikiDir = join(root, 'wiki')
    db = openDb(':memory:')
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    try { db.raw.close() } catch {}
  })

  it('init creates wiki dir, writes GUIDE + index + log, runs git init', async () => {
    const svc = createWikiService({
      db, logDir: root, wikiDir,
      getTools: () => ({ claude: { command: 'claude', bin: 'claude', args: [] } }),
    })
    const res = await svc.init()
    expect(res.state).toBe('ready')
    expect(existsSync(join(wikiDir, 'WIKI_GUIDE.md'))).toBe(true)
    expect(existsSync(join(wikiDir, 'index.md'))).toBe(true)
    expect(existsSync(join(wikiDir, 'log.md'))).toBe(true)
    expect(existsSync(join(wikiDir, '.git'))).toBe(true)
    expect(readFileSync(join(wikiDir, 'WIKI_GUIDE.md'), 'utf8')).toMatch(/Wiki 维护指南/)
  })

  it('init is idempotent when already git-initialized', async () => {
    const svc = createWikiService({
      db, logDir: root, wikiDir,
      getTools: () => ({ claude: { command: 'claude', bin: 'claude', args: [] } }),
    })
    const a = await svc.init()
    const b = await svc.init()
    expect(a.state).toBe('ready')
    expect(b.state).toBe('ready')
  })

  it('init returns exists-not-git if dir exists and is not a git repo', async () => {
    mkdirSync(wikiDir, { recursive: true })
    writeFileSync(join(wikiDir, 'hello.md'), 'pre-existing content')
    const svc = createWikiService({
      db, logDir: root, wikiDir,
      getTools: () => ({ claude: { command: 'claude', bin: 'claude', args: [] } }),
    })
    const res = await svc.init()
    expect(res.state).toBe('exists-not-git')
    expect(existsSync(join(wikiDir, 'WIKI_GUIDE.md'))).toBe(false)
  })

  it('status returns state + wikiDir + lastRun=null when fresh', async () => {
    const svc = createWikiService({
      db, logDir: root, wikiDir,
      getTools: () => ({ claude: { command: 'claude', bin: 'claude', args: [] } }),
    })
    await svc.init()
    const s = svc.status()
    expect(s.wikiDir).toBe(wikiDir)
    expect(s.initState).toBe('ready')
    expect(s.lastRun).toBeNull()
  })
})

describe('wiki service runOnce', () => {
  let root, wikiDir, db, todo
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'qt-wiki-run-'))
    wikiDir = join(root, 'wiki')
    db = openDb(':memory:')
    todo = db.createTodo({ title: 'fix deploy', description: 'broke', quadrant: 1, status: 'done' })
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    try { db.raw.close() } catch {}
  })

  it('runOnce rejects empty todoIds', async () => {
    const svc = createWikiService({
      db, logDir: root, wikiDir,
      getTools: () => ({ claude: { command: 'claude', bin: 'claude', args: [] } }),
      execClaude: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    })
    await svc.init()
    await expect(svc.runOnce({ todoIds: [] })).rejects.toThrow(/todoIds/)
  })

  it('runOnce in dryRun mode writes sources but does not call claude', async () => {
    let called = 0
    const svc = createWikiService({
      db, logDir: root, wikiDir,
      getTools: () => ({ claude: { command: 'claude', bin: 'claude', args: [] } }),
      execClaude: async () => { called++; return { exitCode: 0, stdout: '', stderr: '' } },
    })
    await svc.init()
    const res = await svc.runOnce({ todoIds: [todo.id], dryRun: true })
    expect(called).toBe(0)
    expect(res.dryRun).toBe(true)
    expect(res.sourcesWritten).toBe(1)
    const files = readdirSync(join(wikiDir, 'sources'))
    expect(files).toHaveLength(1)
    const coverage = db.listCoverageForTodo(todo.id)
    expect(coverage[0].llm_applied).toBe(0)
  })

  it('runOnce in normal mode calls claude, commits, marks llm_applied', async () => {
    let claudeCalled = 0
    const svc = createWikiService({
      db, logDir: root, wikiDir,
      getTools: () => ({ claude: { command: 'claude', bin: 'claude', args: [] } }),
      execClaude: async ({ cwd, stdin }) => {
        claudeCalled++
        writeFileSync(join(cwd, 'topics', 'deploy.md'), '# Deploy Notes\n\npatched from todo.\n')
        return { exitCode: 0, stdout: 'ok', stderr: '' }
      },
    })
    await svc.init()
    const res = await svc.runOnce({ todoIds: [todo.id], dryRun: false })
    expect(claudeCalled).toBe(1)
    expect(res.dryRun).toBe(false)
    expect(res.exitCode).toBe(0)
    expect(existsSync(join(wikiDir, 'topics', 'deploy.md'))).toBe(true)
    const coverage = db.listCoverageForTodo(todo.id)
    expect(coverage[0].llm_applied).toBe(1)

    const log = execFileSync('git', ['log', '--oneline'], { cwd: wikiDir, encoding: 'utf8' })
    expect(log.split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(2)
    expect(log).toMatch(/wiki: batch/)
  })

  it('runOnce locks concurrent invocations', async () => {
    const svc = createWikiService({
      db, logDir: root, wikiDir,
      getTools: () => ({ claude: { command: 'claude', bin: 'claude', args: [] } }),
      execClaude: () => new Promise(r => setTimeout(() => r({ exitCode: 0, stdout: '', stderr: '' }), 100)),
    })
    await svc.init()
    const p1 = svc.runOnce({ todoIds: [todo.id], dryRun: false })
    await expect(svc.runOnce({ todoIds: [todo.id], dryRun: false })).rejects.toThrow(/already running/i)
    await p1
  })

  it('runOnce records error when claude fails', async () => {
    const svc = createWikiService({
      db, logDir: root, wikiDir,
      getTools: () => ({ claude: { command: 'claude', bin: 'claude', args: [] } }),
      execClaude: async () => ({ exitCode: 1, stdout: '', stderr: 'claude missing' }),
    })
    await svc.init()
    await expect(svc.runOnce({ todoIds: [todo.id], dryRun: false })).rejects.toThrow(/claude/)
    const runs = db.listWikiRuns({ limit: 5 })
    expect(runs[0].error).toMatch(/claude/)
    const coverage = db.listCoverageForTodo(todo.id)
    expect(coverage[0].llm_applied).toBe(0)
  })
})
