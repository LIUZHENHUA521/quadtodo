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
})
