import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureGitignore, isGitRepo, getRepoRoot, getHead,
  createWorktree, listWorktrees, removeWorktree, getDiffSinceBase, mergeWorktreeBranch, git,
} from '../src/worktree.js'

const pExec = promisify(execFile)

async function initRepo() {
  // realpath: on macOS `/var/folders/...` is a symlink to `/private/var/folders/...`
  // and `git rev-parse --show-toplevel` returns the resolved path
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'qt-wt-')))
  await pExec('git', ['init', '-b', 'main', dir])
  await pExec('git', ['config', 'user.email', 'test@quadtodo.local'], { cwd: dir })
  await pExec('git', ['config', 'user.name', 'quadtodo-test'], { cwd: dir })
  writeFileSync(join(dir, 'README.md'), '# test\n')
  await pExec('git', ['add', '.'], { cwd: dir })
  await pExec('git', ['commit', '-m', 'init'], { cwd: dir })
  return dir
}

async function currentSha(dir) {
  const { stdout } = await pExec('git', ['rev-parse', 'HEAD'], { cwd: dir })
  return stdout.trim()
}

describe('worktree', () => {
  let repo

  beforeEach(async () => { repo = await initRepo() })
  afterEach(() => { if (repo) rmSync(repo, { recursive: true, force: true }) })

  it('isGitRepo / getRepoRoot / getHead', async () => {
    expect(await isGitRepo(repo)).toBe(true)
    expect(await getRepoRoot(repo)).toBe(repo)
    const { sha, branch } = await getHead(repo)
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    expect(branch).toBe('main')
  })

  it('ensureGitignore adds entry, idempotent', () => {
    const first = ensureGitignore(repo)
    expect(first.changed).toBe(true)
    const gi = readFileSync(join(repo, '.gitignore'), 'utf8')
    expect(gi).toMatch(/\.quadtodo-worktrees\//)
    const second = ensureGitignore(repo)
    expect(second.changed).toBe(false)
  })

  it('createWorktree creates branch + dir under .quadtodo-worktrees/<runId>/', async () => {
    const baseSha = await currentSha(repo)
    const res = await createWorktree({
      cwd: repo, runId: 'run-1', roleKey: 'coder', round: 1, baseSha,
    })
    expect(res.reused).toBe(false)
    expect(res.branch).toBe('quadtodo/run-1/coder-1')
    expect(res.path.endsWith('/.quadtodo-worktrees/run-1/coder-1')).toBe(true)
    expect(existsSync(res.path)).toBe(true)
    expect(existsSync(join(res.path, 'README.md'))).toBe(true)

    const list = await listWorktrees(repo)
    expect(list.some(w => w.path === res.path && w.branch === res.branch)).toBe(true)

    // .gitignore 已被写
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toMatch(/\.quadtodo-worktrees\//)
  })

  it('createWorktree is idempotent — second call returns reused=true', async () => {
    const baseSha = await currentSha(repo)
    const r1 = await createWorktree({ cwd: repo, runId: 'run-x', roleKey: 'coder', round: 1, baseSha })
    const r2 = await createWorktree({ cwd: repo, runId: 'run-x', roleKey: 'coder', round: 1, baseSha })
    expect(r1.path).toBe(r2.path)
    expect(r2.reused).toBe(true)
  })

  it('getDiffSinceBase + mergeWorktreeBranch (squash)', async () => {
    const baseSha = await currentSha(repo)
    const { path: wt, branch } = await createWorktree({
      cwd: repo, runId: 'run-merge', roleKey: 'coder', round: 1, baseSha,
    })
    // In the worktree: add a file + commit
    writeFileSync(join(wt, 'new.txt'), 'hello world\n')
    await git(['add', 'new.txt'], wt)
    await git(['commit', '-m', 'add new.txt'], wt)

    const { diff, truncated } = await getDiffSinceBase({ worktreePath: wt, baseSha })
    expect(truncated).toBe(false)
    expect(diff).toMatch(/\+hello world/)
    expect(diff).toMatch(/new\.txt/)

    // Squash-merge back
    await mergeWorktreeBranch({ cwd: repo, branch, strategy: 'squash', commitMessage: 'merge run-merge' })
    expect(existsSync(join(repo, 'new.txt'))).toBe(true)
    const log = (await git(['log', '--oneline'], repo)).stdout
    expect(log).toMatch(/merge run-merge/)
  })

  it('removeWorktree cleans up directory + git bookkeeping', async () => {
    const baseSha = await currentSha(repo)
    const { path: wt } = await createWorktree({ cwd: repo, runId: 'run-rm', roleKey: 'coder', round: 1, baseSha })
    expect(existsSync(wt)).toBe(true)
    await removeWorktree({ cwd: repo, path: wt, force: true })
    expect(existsSync(wt)).toBe(false)
    const list = await listWorktrees(repo)
    expect(list.some(w => w.path === wt)).toBe(false)
  })

  it('listWorktrees only returns quadtodo-managed worktrees', async () => {
    const baseSha = await currentSha(repo)
    // Create a non-quadtodo worktree manually
    const otherDir = mkdtempSync(join(tmpdir(), 'qt-other-'))
    const otherPath = realpathSync(otherDir)
    rmSync(otherPath, { recursive: true, force: true })
    await git(['worktree', 'add', '-b', 'some-feature', otherPath, baseSha], repo)
    // Create a quadtodo one
    const { path: qtPath } = await createWorktree({ cwd: repo, runId: 'run-filter', roleKey: 'coder', round: 1, baseSha })

    const list = await listWorktrees(repo)
    expect(list.some(w => w.path === qtPath)).toBe(true)
    expect(list.some(w => w.path === otherPath)).toBe(false)

    // cleanup
    await git(['worktree', 'remove', '--force', otherPath], repo).catch(() => {})
  })
})
