/**
 * Git worktree helpers for Multi-agent Pipeline (Phase B)
 *
 * Each "writer" agent in a pipeline run gets its own branch + worktree at
 * `<repo>/.quadtodo-worktrees/<runId>/<roleKey>-<round>/`
 *
 * "Reader" agents (verdict-only) don't create their own worktree — they just
 * cwd into the latest writer worktree as read-only (enforced by system prompt).
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, sep } from 'node:path'

const pExec = promisify(execFile)

/** Run `git <args>` in given cwd. Returns { stdout, stderr } trimmed. */
export async function git(args, cwd) {
  const { stdout = '', stderr = '' } = await pExec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 })
  return { stdout: String(stdout).trim(), stderr: String(stderr).trim() }
}

export async function isGitRepo(cwd) {
  try {
    const { stdout } = await git(['rev-parse', '--is-inside-work-tree'], cwd)
    return stdout === 'true'
  } catch { return false }
}

export async function getRepoRoot(cwd) {
  const { stdout } = await git(['rev-parse', '--show-toplevel'], cwd)
  return stdout
}

export async function getHead(cwd) {
  const { stdout: sha } = await git(['rev-parse', 'HEAD'], cwd)
  let branch = ''
  try {
    const { stdout } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
    if (stdout && stdout !== 'HEAD') branch = stdout
  } catch { /* detached */ }
  return { sha, branch }
}

const GITIGNORE_ENTRY = '.quadtodo-worktrees/'
const GITIGNORE_MARKER = '# quadtodo multi-agent worktrees'

/** Add `.quadtodo-worktrees/` to repo's `.gitignore` if not already present. */
export function ensureGitignore(repoRoot) {
  const gi = join(repoRoot, '.gitignore')
  let contents = ''
  if (existsSync(gi)) contents = readFileSync(gi, 'utf8')
  const normalized = contents.split(/\r?\n/).map(l => l.trim())
  const alreadyIgnored = normalized.some(l =>
    l === GITIGNORE_ENTRY
    || l === '.quadtodo-worktrees'
    || l === '/.quadtodo-worktrees/'
    || l === '/.quadtodo-worktrees'
  )
  if (alreadyIgnored) return { changed: false }
  const needsNewline = contents.length > 0 && !contents.endsWith('\n')
  const appended = (needsNewline ? '\n' : '') + `\n${GITIGNORE_MARKER}\n${GITIGNORE_ENTRY}\n`
  writeFileSync(gi, contents + appended, 'utf8')
  return { changed: true }
}

/**
 * Create (or reuse) a writer worktree.
 * @param {object} opts
 * @param {string} opts.cwd      Repo cwd (any path inside the repo)
 * @param {string} opts.runId    Pipeline run id
 * @param {string} opts.roleKey  Role key (e.g. 'coder')
 * @param {number} opts.round    Iteration round (1-based)
 * @param {string} opts.baseSha  Commit SHA to branch from
 * @returns {Promise<{ path: string, branch: string, reused: boolean }>}
 */
export async function createWorktree({ cwd, runId, roleKey, round, baseSha }) {
  if (!runId || !roleKey || !baseSha) throw new Error('createWorktree: runId + roleKey + baseSha required')
  const repoRoot = await getRepoRoot(cwd)
  ensureGitignore(repoRoot)
  const worktreesRoot = join(repoRoot, '.quadtodo-worktrees', runId)
  mkdirSync(worktreesRoot, { recursive: true })
  const wtPath = join(worktreesRoot, `${roleKey}-${round}`)
  const branch = `quadtodo/${runId}/${roleKey}-${round}`

  // If directory already exists AND git is aware of it, reuse.
  const existing = await listWorktrees(cwd)
  const hit = existing.find(e => e.path === wtPath)
  if (hit) return { path: wtPath, branch: hit.branch || branch, reused: true }

  if (existsSync(wtPath)) {
    // Orphan directory (git forgot). Remove from disk so `git worktree add` succeeds.
    try { await git(['worktree', 'prune'], cwd) } catch { /* best effort */ }
  }

  await git(['worktree', 'add', '-b', branch, wtPath, baseSha], cwd)
  return { path: wtPath, branch, reused: false }
}

/** List all git worktrees, filtered to quadtodo-managed ones. */
export async function listWorktrees(cwd) {
  try {
    const { stdout } = await git(['worktree', 'list', '--porcelain'], cwd)
    const entries = []
    let cur = {}
    for (const line of stdout.split('\n')) {
      if (!line.trim()) {
        if (cur.path) entries.push(cur)
        cur = {}
        continue
      }
      const sp = line.indexOf(' ')
      const key = sp === -1 ? line : line.slice(0, sp)
      const val = sp === -1 ? '' : line.slice(sp + 1)
      if (key === 'worktree') cur.path = val
      else if (key === 'HEAD') cur.head = val
      else if (key === 'branch') cur.branch = val.replace('refs/heads/', '')
      else if (key === 'detached') cur.detached = true
    }
    if (cur.path) entries.push(cur)
    return entries.filter(e => e.path && e.path.includes(`${sep}.quadtodo-worktrees${sep}`))
  } catch { return [] }
}

/** Remove a worktree (use --force when dirty). */
export async function removeWorktree({ cwd, path, force = false }) {
  const args = ['worktree', 'remove']
  if (force) args.push('--force')
  args.push(path)
  await git(args, cwd)
}

/** Prune stale worktree entries from git's bookkeeping. */
export async function pruneWorktrees(cwd) {
  await git(['worktree', 'prune'], cwd)
}

/**
 * `git diff baseSha..HEAD` inside a worktree — used to hand artifact to reviewer.
 * For huge diffs we cap at 64KB so LLM prompts don't blow up.
 */
export async function getDiffSinceBase({ worktreePath, baseSha, maxBytes = 64 * 1024 }) {
  const { stdout } = await git(['diff', `${baseSha}..HEAD`], worktreePath)
  if (stdout.length <= maxBytes) return { diff: stdout, truncated: false }
  return { diff: stdout.slice(0, maxBytes), truncated: true, fullBytes: stdout.length }
}

/** Short summary of worktree's commits since base (for handoff reason blurb). */
export async function getLogSinceBase({ worktreePath, baseSha, maxCount = 10 }) {
  const { stdout } = await git(['log', `${baseSha}..HEAD`, '--oneline', `-n${maxCount}`], worktreePath)
  return stdout
}

/**
 * Merge a worktree branch back into the main cwd's current HEAD.
 * strategy: 'merge' (merge commit) | 'squash' (single squashed commit)
 */
export async function mergeWorktreeBranch({ cwd, branch, strategy = 'merge', commitMessage }) {
  if (strategy === 'squash') {
    await git(['merge', '--squash', branch], cwd)
    await git(['commit', '-m', commitMessage || `quadtodo: squash-merge ${branch}`], cwd)
  } else {
    await git(['merge', branch, '-m', commitMessage || `quadtodo: merge ${branch}`], cwd)
  }
}
