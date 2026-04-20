import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { openDb } from '../src/db.js'
import { createWikiService } from '../src/wiki/index.js'

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
