import { existsSync, mkdirSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { WIKI_GUIDE_CONTENT, EMPTY_INDEX_CONTENT, EMPTY_LOG_CONTENT } from './guide.js'

const execFileP = promisify(execFile)

function isGitRepo(dir) {
  return existsSync(join(dir, '.git'))
}

function isNonEmptyDir(dir) {
  if (!existsSync(dir)) return false
  try {
    return readdirSync(dir).length > 0
  } catch {
    return false
  }
}

async function gitInit(wikiDir) {
  await execFileP('git', ['init', '-q'], { cwd: wikiDir })
  await execFileP('git', ['add', '-A'], { cwd: wikiDir })
  try {
    await execFileP('git', ['commit', '-q', '-m', 'wiki: initial commit'], { cwd: wikiDir })
  } catch {
    await execFileP(
      'git',
      ['-c', 'user.email=quadtodo@local', '-c', 'user.name=quadtodo', 'commit', '-q', '-m', 'wiki: initial commit'],
      { cwd: wikiDir },
    )
  }
}

export function createWikiService({
  db,
  logDir,
  wikiDir,
  getTools,
  maxTailTurns = 20,
  timeoutMs = 600_000,
  redactEnabled = true,
  execClaude = null,
}) {
  let running = false
  let lastInitState = 'unknown'

  async function init() {
    if (existsSync(wikiDir) && isNonEmptyDir(wikiDir) && !isGitRepo(wikiDir)) {
      lastInitState = 'exists-not-git'
      return { state: 'exists-not-git', wikiDir }
    }
    if (!existsSync(wikiDir)) mkdirSync(wikiDir, { recursive: true })
    mkdirSync(join(wikiDir, 'sources'), { recursive: true })
    mkdirSync(join(wikiDir, 'topics'), { recursive: true })
    mkdirSync(join(wikiDir, 'projects'), { recursive: true })

    const guidePath = join(wikiDir, 'WIKI_GUIDE.md')
    if (!existsSync(guidePath)) writeFileSync(guidePath, WIKI_GUIDE_CONTENT)
    const indexPath = join(wikiDir, 'index.md')
    if (!existsSync(indexPath)) writeFileSync(indexPath, EMPTY_INDEX_CONTENT)
    const logPath = join(wikiDir, 'log.md')
    if (!existsSync(logPath)) writeFileSync(logPath, EMPTY_LOG_CONTENT)

    if (!isGitRepo(wikiDir)) {
      try { await gitInit(wikiDir) } catch (e) {
        lastInitState = 'git-failed'
        return { state: 'git-failed', wikiDir, error: e.message }
      }
    }
    lastInitState = 'ready'
    return { state: 'ready', wikiDir }
  }

  function status() {
    const runs = db.listWikiRuns({ limit: 1 })
    const pendingCount = db.listUnappliedDoneTodos().length
    return {
      wikiDir,
      initState: lastInitState,
      lastRun: runs[0] || null,
      pendingTodoCount: pendingCount,
      running,
    }
  }

  function pending() {
    return db.listUnappliedDoneTodos().map(t => ({
      id: t.id,
      title: t.title,
      workDir: t.workDir,
      quadrant: t.quadrant,
      completedAt: t.updatedAt,
    }))
  }

  async function runOnce(_opts) {
    throw new Error('runOnce: not yet implemented — see Task 7')
  }

  return { init, status, pending, runOnce }
}
