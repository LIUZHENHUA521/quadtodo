import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'

const DEFAULT_TIMEOUT_MS = 5000

function runGit(args, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, env, maxBytes } = {}) {
  return new Promise((resolve) => {
    let proc
    try {
      proc = spawn('git', args, { cwd, env: env || process.env })
    } catch (e) {
      resolve({ error: 'spawn_failed', code: e?.code || '', stderr: e?.message || '' })
      return
    }
    let stdout = Buffer.alloc(0)
    let stderr = ''
    let truncated = false
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { proc.kill('SIGTERM') } catch {}
      resolve({ error: 'timeout' })
    }, timeoutMs)
    proc.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        error: err?.code === 'ENOENT' ? 'git_missing' : 'spawn_failed',
        code: err?.code || '',
        stderr: err?.message || '',
      })
    })
    proc.stdout?.on('data', (chunk) => {
      if (maxBytes && stdout.length + chunk.length > maxBytes) {
        const remaining = Math.max(0, maxBytes - stdout.length)
        if (remaining > 0) stdout = Buffer.concat([stdout, chunk.slice(0, remaining)])
        truncated = true
        try { proc.kill('SIGTERM') } catch {}
      } else {
        stdout = Buffer.concat([stdout, chunk])
      }
    })
    proc.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
    proc.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout: stdout.toString('utf8'), stderr, truncated })
    })
  })
}

function checkDir(workDir) {
  if (!workDir || !existsSync(workDir)) return { state: 'not_found' }
  try {
    if (!statSync(workDir).isDirectory()) return { state: 'not_found' }
  } catch {
    return { state: 'not_found' }
  }
  return null
}

export async function readGitStatus(workDir, opts = {}) {
  const pre = checkDir(workDir)
  if (pre) return pre

  const isRepo = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: workDir, ...opts })
  if (isRepo.error === 'git_missing') return { state: 'git_missing' }
  if (isRepo.error === 'timeout') return { state: 'timeout' }
  if (isRepo.error) return { state: 'error', message: (isRepo.stderr || '').slice(0, 500) }
  if (isRepo.code !== 0 || (isRepo.stdout || '').trim() !== 'true') return { state: 'not_a_repo' }

  const branchRes = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workDir, ...opts })
  if (branchRes.error === 'timeout') return { state: 'timeout' }
  if (branchRes.error) return { state: 'error', message: (branchRes.stderr || '').slice(0, 500) }
  const branch = (branchRes.stdout || '').trim() || 'HEAD'

  let headShort
  if (branch === 'HEAD') {
    const shaRes = await runGit(['rev-parse', '--short=7', 'HEAD'], { cwd: workDir, ...opts })
    if (shaRes.code === 0) headShort = (shaRes.stdout || '').trim()
  }

  const statusRes = await runGit(['status', '--porcelain'], { cwd: workDir, ...opts })
  if (statusRes.error === 'timeout') return { state: 'timeout' }
  if (statusRes.error) return { state: 'error', message: (statusRes.stderr || '').slice(0, 500) }
  const dirty = (statusRes.stdout || '').split('\n').filter((l) => l.trim().length > 0).length

  let hasUpstream = false
  let ahead = 0
  let behind = 0
  const revListRes = await runGit(
    ['rev-list', '--count', '--left-right', '@{upstream}...HEAD'],
    { cwd: workDir, ...opts }
  )
  if (revListRes.error === 'timeout') return { state: 'timeout' }
  if (!revListRes.error && revListRes.code === 0) {
    const parts = (revListRes.stdout || '').trim().split(/\s+/)
    if (parts.length === 2) {
      hasUpstream = true
      behind = Number(parts[0]) || 0
      ahead = Number(parts[1]) || 0
    }
  }

  const out = { state: 'ok', branch, dirty, ahead, behind, hasUpstream }
  if (headShort) out.headShort = headShort
  return out
}

export async function readGitDiff(workDir, opts = {}) {
  const pre = checkDir(workDir)
  if (pre) return pre
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : 200 * 1024

  const isRepo = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: workDir })
  if (isRepo.error === 'git_missing') return { state: 'git_missing' }
  if (isRepo.error === 'timeout') return { state: 'timeout' }
  if (isRepo.error) return { state: 'error', message: (isRepo.stderr || '').slice(0, 500) }
  if (isRepo.code !== 0 || (isRepo.stdout || '').trim() !== 'true') return { state: 'not_a_repo' }

  const diffRes = await runGit(['diff', 'HEAD'], { cwd: workDir, maxBytes })
  if (diffRes.error === 'timeout') return { state: 'timeout' }
  if (diffRes.error) return { state: 'error', message: (diffRes.stderr || '').slice(0, 500) }

  const untrackedRes = await runGit(['ls-files', '--others', '--exclude-standard'], { cwd: workDir })
  const untracked = untrackedRes.code === 0
    ? (untrackedRes.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean)
    : []

  return {
    state: 'ok',
    diff: diffRes.stdout || '',
    untracked,
    truncated: !!diffRes.truncated,
  }
}
