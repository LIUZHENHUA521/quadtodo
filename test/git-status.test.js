import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { readGitStatus, readGitDiff } from '../src/git/gitStatus.js'

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'quadtodo-git-'))
  execSync('git init -q', { cwd: dir })
  execSync('git config user.email "t@e.com"', { cwd: dir })
  execSync('git config user.name "t"', { cwd: dir })
  execSync('git config commit.gpgsign false', { cwd: dir })
  return dir
}

describe('readGitStatus', () => {
  let dirs = []
  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }) } catch {}
    }
    dirs = []
  })

  it('returns not_found for non-existent dir', async () => {
    const r = await readGitStatus('/nonexistent/path/xyz123abc')
    expect(r.state).toBe('not_found')
  })

  it('returns not_a_repo for non-git dir', async () => {
    const d = mkdtempSync(join(tmpdir(), 'quadtodo-nogit-'))
    dirs.push(d)
    const r = await readGitStatus(d)
    expect(r.state).toBe('not_a_repo')
  })

  it('fresh repo: branch present, dirty=0, no upstream', async () => {
    const d = makeRepo(); dirs.push(d)
    execSync('git commit --allow-empty -m "init"', { cwd: d })
    const r = await readGitStatus(d)
    expect(r.state).toBe('ok')
    expect(r.branch).toMatch(/^(main|master)$/)
    expect(r.dirty).toBe(0)
    expect(r.hasUpstream).toBe(false)
    expect(r.ahead).toBe(0)
    expect(r.behind).toBe(0)
  })

  it('dirty files counted (modified + untracked)', async () => {
    const d = makeRepo(); dirs.push(d)
    writeFileSync(join(d, 'a.txt'), 'x')
    execSync('git add a.txt && git commit -m "a"', { cwd: d })
    writeFileSync(join(d, 'a.txt'), 'xx')
    writeFileSync(join(d, 'b.txt'), 'new')
    const r = await readGitStatus(d)
    expect(r.state).toBe('ok')
    expect(r.dirty).toBe(2)
  })

  it('upstream set: ahead/behind computed', async () => {
    const remote = mkdtempSync(join(tmpdir(), 'quadtodo-remote-'))
    dirs.push(remote)
    execSync('git init -q --bare', { cwd: remote })
    const d = makeRepo(); dirs.push(d)
    writeFileSync(join(d, 'a.txt'), 'x')
    execSync('git add a.txt && git commit -m "a"', { cwd: d })
    execSync(`git remote add origin ${remote}`, { cwd: d })
    execSync('git push -u origin HEAD', { cwd: d })
    writeFileSync(join(d, 'b.txt'), 'y')
    execSync('git add b.txt && git commit -m "b"', { cwd: d })
    writeFileSync(join(d, 'c.txt'), 'z')
    execSync('git add c.txt && git commit -m "c"', { cwd: d })
    const r = await readGitStatus(d)
    expect(r.state).toBe('ok')
    expect(r.hasUpstream).toBe(true)
    expect(r.ahead).toBe(2)
    expect(r.behind).toBe(0)
  })

  it('detached HEAD: branch field is HEAD, headShort present', async () => {
    const d = makeRepo(); dirs.push(d)
    writeFileSync(join(d, 'a.txt'), 'x')
    execSync('git add a.txt && git commit -m "a"', { cwd: d })
    const sha = execSync('git rev-parse HEAD', { cwd: d }).toString().trim()
    execSync(`git -c advice.detachedHead=false checkout ${sha}`, { cwd: d })
    const r = await readGitStatus(d)
    expect(r.state).toBe('ok')
    expect(r.branch).toBe('HEAD')
    expect(r.headShort).toMatch(/^[0-9a-f]{7}$/)
  })

  it('diff: modified + untracked files', async () => {
    const d = makeRepo(); dirs.push(d)
    writeFileSync(join(d, 'a.txt'), 'hello\n')
    execSync('git add a.txt && git commit -m "a"', { cwd: d })
    writeFileSync(join(d, 'a.txt'), 'hello\nworld\n')
    writeFileSync(join(d, 'new.txt'), 'brand new\n')
    const r = await readGitDiff(d)
    expect(r.state).toBe('ok')
    expect(r.diff).toContain('a.txt')
    expect(r.diff).toContain('+world')
    expect(r.untracked).toContain('new.txt')
    expect(r.truncated).toBe(false)
  })

  it('diff: truncates when exceeding maxBytes', async () => {
    const d = makeRepo(); dirs.push(d)
    writeFileSync(join(d, 'big.txt'), '')
    execSync('git add big.txt && git commit -m "empty"', { cwd: d })
    const big = 'line\n'.repeat(5000)
    writeFileSync(join(d, 'big.txt'), big)
    const r = await readGitDiff(d, { maxBytes: 1024 })
    expect(r.state).toBe('ok')
    expect(r.truncated).toBe(true)
    expect(r.diff.length).toBeLessThanOrEqual(1024 + 256)
  })

  it('diff: not_a_repo for plain dir', async () => {
    const d = mkdtempSync(join(tmpdir(), 'quadtodo-nogit-diff-'))
    dirs.push(d)
    const r = await readGitDiff(d)
    expect(r.state).toBe('not_a_repo')
  })
})
