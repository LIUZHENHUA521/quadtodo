import { existsSync, mkdirSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { WIKI_GUIDE_CONTENT, EMPTY_INDEX_CONTENT, EMPTY_LOG_CONTENT } from './guide.js'
import { loadTranscript as defaultLoadTranscript } from '../transcript.js'
import { summarizeTurns as defaultSummarize } from '../summarize.js'
import { redact as defaultRedact } from './redact.js'
import { buildSourceMarkdown, sourceFileName } from './sources.js'

const execFileP = promisify(execFile)

function isGitRepo(dir) { return existsSync(join(dir, '.git')) }
function isNonEmptyDir(dir) {
  if (!existsSync(dir)) return false
  try { return readdirSync(dir).length > 0 } catch { return false }
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

async function gitCommit(wikiDir, message) {
  await execFileP('git', ['add', '-A'], { cwd: wikiDir })
  try {
    const { stdout } = await execFileP('git', ['status', '--porcelain'], { cwd: wikiDir })
    if (!stdout.trim()) return { committed: false }
  } catch {}
  try {
    await execFileP('git', ['commit', '-q', '-m', message], { cwd: wikiDir })
  } catch {
    await execFileP(
      'git',
      ['-c', 'user.email=quadtodo@local', '-c', 'user.name=quadtodo', 'commit', '-q', '-m', message],
      { cwd: wikiDir },
    )
  }
  return { committed: true }
}

function defaultExecClaude({ command, bin, args = [], cwd, stdin, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const cmd = bin || command
    const child = spawn(cmd, [...args, '-p', '--output-format', 'text'], {
      cwd, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch {}
      reject(new Error(`claude timeout after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.on('data', d => { stdout += d.toString() })
    child.stderr.on('data', d => { stderr += d.toString() })
    child.on('error', e => { clearTimeout(timer); reject(e) })
    child.on('close', code => { clearTimeout(timer); resolve({ exitCode: code, stdout, stderr }) })
    if (stdin != null) {
      child.stdin.write(stdin)
      child.stdin.end()
    }
  })
}

function buildClaudePrompt(newSourceFiles) {
  const list = newSourceFiles.map(f => `- sources/${f}`).join('\n')
  return `请严格按照 WIKI_GUIDE.md 的规则维护本 wiki。先读 WIKI_GUIDE.md，再读下面这批新的 sources，然后更新 topics/ projects/ index.md 和 log.md：

${list}

约束重申：
- 不要修改 sources/*.md
- 只产出 markdown 文件修改，不要输出总结到终端`
}

export function createWikiService({
  db,
  logDir,
  wikiDir,
  getTools,
  maxTailTurns = 20,
  timeoutMs = 600_000,
  redactEnabled = true,
  loadTranscript = (session) => defaultLoadTranscript({
    tool: session.tool,
    nativeSessionId: session.nativeSessionId,
    cwd: session.cwd || null,
    sessionId: session.sessionId,
    logDir,
  }),
  summarize = defaultSummarize,
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
    if (!existsSync(join(wikiDir, 'index.md'))) writeFileSync(join(wikiDir, 'index.md'), EMPTY_INDEX_CONTENT)
    if (!existsSync(join(wikiDir, 'log.md'))) writeFileSync(join(wikiDir, 'log.md'), EMPTY_LOG_CONTENT)

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
    return {
      wikiDir,
      initState: lastInitState,
      lastRun: runs[0] || null,
      pendingTodoCount: db.listUnappliedDoneTodos().length,
      running,
    }
  }

  function pending() {
    return db.listUnappliedDoneTodos().map(t => ({
      id: t.id, title: t.title, workDir: t.workDir,
      quadrant: t.quadrant, completedAt: t.updatedAt,
    }))
  }

  async function runOnce({ todoIds, dryRun = false } = {}) {
    if (!Array.isArray(todoIds) || todoIds.length === 0) {
      throw new Error('todoIds must be a non-empty array')
    }
    if (running) throw new Error('wiki run already running')
    running = true
    const run = db.createWikiRun({ todoCount: todoIds.length, dryRun: dryRun ? 1 : 0 })

    try {
      const writtenFiles = []
      for (const todoId of todoIds) {
        const todo = db.getTodo(todoId)
        if (!todo) throw new Error(`todo_not_found: ${todoId}`)
        const comments = db.listComments(todoId)
        const redactFn = redactEnabled ? defaultRedact : (s) => String(s ?? '')
        const md = await buildSourceMarkdown({
          todo, comments,
          loadTranscript,
          summarize,
          redact: redactFn,
          maxTailTurns,
        })
        const filename = sourceFileName(todo)
        const abs = join(wikiDir, 'sources', filename)
        writeFileSync(abs, md)
        writtenFiles.push(filename)
        db.upsertWikiCoverage(run.id, todoId, `sources/${filename}`, false)
      }

      if (dryRun) {
        db.completeWikiRun(run.id, { exitCode: 0, note: `dry-run: ${writtenFiles.length} sources` })
        appendFileSync(join(wikiDir, 'log.md'),
          `\n- [${new Date().toISOString()}] dry-run, wrote ${writtenFiles.length} source(s)\n`)
        return { dryRun: true, runId: run.id, sourcesWritten: writtenFiles.length, exitCode: 0 }
      }

      const tools = getTools()
      const tool = tools.claude || {}
      const runner = execClaude || defaultExecClaude
      const prompt = buildClaudePrompt(writtenFiles)
      const result = await runner({
        command: tool.command || 'claude',
        bin: tool.bin,
        args: tool.args || [],
        cwd: wikiDir,
        stdin: prompt,
        timeoutMs,
      })
      if (result.exitCode !== 0) {
        throw new Error(`claude exited ${result.exitCode}: ${String(result.stderr || '').slice(0, 400)}`)
      }

      const now = new Date()
      const tag = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}-${String(now.getHours()).padStart(2,'0')}`
      await gitCommit(wikiDir, `wiki: batch ${tag} (${todoIds.length} todos)`)

      db.markCoverageApplied(run.id)
      db.completeWikiRun(run.id, { exitCode: 0, note: `batch: ${writtenFiles.length} sources` })
      appendFileSync(join(wikiDir, 'log.md'),
        `\n- [${now.toISOString()}] batch run #${run.id}: ${writtenFiles.length} source(s), exit 0\n`)

      return { dryRun: false, runId: run.id, sourcesWritten: writtenFiles.length, exitCode: 0 }
    } catch (e) {
      db.failWikiRun(run.id, e.message)
      throw e
    } finally {
      running = false
    }
  }

  function markOrphansAsFailed() {
    for (const orphan of db.findOrphanWikiRuns()) {
      db.failWikiRun(orphan.id, 'quadtodo process died mid-run')
    }
  }

  return {
    init, status, pending, runOnce, markOrphansAsFailed,
    listRuns: (limit = 20) => db.listWikiRuns({ limit }),
  }
}
