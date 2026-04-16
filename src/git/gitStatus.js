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
  return { state: 'ok', branch: '', dirty: 0, ahead: 0, behind: 0, hasUpstream: false }
}

export async function readGitDiff(workDir, _opts = {}) {
  const pre = checkDir(workDir)
  if (pre) return pre
  return { state: 'ok', diff: '', untracked: [], truncated: false }
}
