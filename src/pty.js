import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const require = createRequire(import.meta.url)

const CLAUDE_SESSION_RE = /claude\s+--resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/
const CODEX_SESSION_RE = /codex\s+resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MAX_LOG_BYTES = 512 * 1024
const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const CODEX_SESSIONS_DIR = join(homedir(), '.codex', 'sessions')

function claudeProjectHash(absPath) {
  return absPath.replace(/\//g, '-')
}

function detectClaudeSessionFromFs(workDir, afterMs) {
  const projDir = join(CLAUDE_PROJECTS_DIR, claudeProjectHash(workDir))
  if (!existsSync(projDir)) return null
  try {
    let newest = null
    let newestTime = 0
    for (const file of readdirSync(projDir)) {
      if (!file.endsWith('.jsonl')) continue
      const uuid = file.slice(0, -6)
      if (!UUID_RE.test(uuid)) continue
      const st = statSync(join(projDir, file))
      const t = st.birthtimeMs || st.ctimeMs
      if (t > afterMs && t > newestTime) {
        newest = uuid
        newestTime = t
      }
    }
    return newest
  } catch {
    return null
  }
}

function detectCodexSessionFromFs(afterMs) {
  const now = new Date()
  const yy = now.getFullYear().toString()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const dayDir = join(CODEX_SESSIONS_DIR, yy, mm, dd)
  if (!existsSync(dayDir)) return null
  try {
    let newest = null
    let newestTime = 0
    for (const file of readdirSync(dayDir)) {
      if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue
      const st = statSync(join(dayDir, file))
      const t = st.birthtimeMs || st.ctimeMs
      if (t > afterMs && t > newestTime) {
        const uuidMatch = file.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/)
        if (uuidMatch) {
          newest = uuidMatch[1]
          newestTime = t
        }
      }
    }
    return newest
  } catch {
    return null
  }
}

function defaultPtyFactory() {
  const pty = require('node-pty')
  return (bin, args, opts) => pty.spawn(bin, args, opts)
}

export class PtyManager extends EventEmitter {
  constructor({ tools, ptyFactory, promptDelayMs = 2000 } = {}) {
    super()
    if (!tools) throw new Error('PtyManager: tools required')
    this.tools = tools
    this.ptyFactory = ptyFactory || defaultPtyFactory()
    this.promptDelayMs = promptDelayMs
    this.sessions = new Map()
  }

  has(sessionId) {
    return this.sessions.has(sessionId)
  }

  list() {
    return [...this.sessions.keys()]
  }

  start({ sessionId, tool, prompt, cwd, resumeNativeId }) {
    const toolCfg = this.tools[tool]
    if (!toolCfg) throw new Error(`unknown tool: ${tool}`)
    const baseArgs = toolCfg.args || []
    const args = resumeNativeId
      ? tool === 'codex'
        ? [...baseArgs, 'resume', resumeNativeId]
        : [...baseArgs, '--resume', resumeNativeId]
      : [...baseArgs]
    const effectiveCwd = cwd || process.env.HOME || process.cwd()

    console.log(`[pty] starting ${tool} bin=${toolCfg.bin} cwd=${effectiveCwd} args=${JSON.stringify(args)}`)

    let proc
    try {
      proc = this.ptyFactory(toolCfg.bin, args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: effectiveCwd,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          TZ: process.env.TZ || 'America/Los_Angeles',
          FORCE_COLOR: '1',
        },
      })
    } catch (error) {
      error.message = `PTY spawn failed for ${tool} (bin=${toolCfg.bin}, cwd=${effectiveCwd}, args=${JSON.stringify(args)}): ${error.message}`
      throw error
    }

    const session = {
      proc,
      tool,
      sessionId,
      fullLog: [],
      logBytes: 0,
      pendingPrompt: prompt && !resumeNativeId ? prompt : null,
      resized: false,
      promptTimer: null,
      nativeId: resumeNativeId || null,
      stopped: false,
      detectTimer: null,
    }
    this.sessions.set(sessionId, session)

    if (!resumeNativeId) {
      const spawnTime = Date.now() - 1000
      let detectAttempts = 0
      session.detectTimer = setInterval(() => {
        detectAttempts++
        if (session.nativeId) {
          clearInterval(session.detectTimer)
          session.detectTimer = null
          return
        }
        const id = tool === 'codex'
          ? detectCodexSessionFromFs(spawnTime)
          : detectClaudeSessionFromFs(effectiveCwd, spawnTime)
        if (id) {
          clearInterval(session.detectTimer)
          session.detectTimer = null
          session.nativeId = id
          this.emit('native-session', { sessionId, nativeId: id })
        } else if (detectAttempts >= 15) {
          clearInterval(session.detectTimer)
          session.detectTimer = null
        }
      }, 2000)
      session.detectTimer.unref?.()
    }

    proc.onData((data) => {
      session.fullLog.push(data)
      session.logBytes += data.length
      while (session.logBytes > MAX_LOG_BYTES && session.fullLog.length > 1) {
        const removed = session.fullLog.shift()
        session.logBytes -= removed.length
      }
      const stripped = data
        .replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, '')
        .replace(/\x1b\][^\x07]*\x07/g, '')
        .replace(/\x1b[()#][A-Za-z0-9]/g, '')
        .replace(/\x1b[>=<cDEHMNOPZ78]/g, '')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
      const sessionRe = tool === 'codex' ? CODEX_SESSION_RE : CLAUDE_SESSION_RE
      const m = stripped.match(sessionRe)
      if (m && session.nativeId !== m[1]) {
        session.nativeId = m[1]
        if (session.detectTimer) {
          clearInterval(session.detectTimer)
          session.detectTimer = null
        }
        this.emit('native-session', { sessionId, nativeId: m[1] })
      }
      this.emit('output', { sessionId, data })
    })

    // 兜底：5 秒内 resize 没到就直接发 prompt
    if (session.pendingPrompt) {
      session.promptTimer = setTimeout(() => {
        if (session.pendingPrompt) {
          proc.write(session.pendingPrompt + '\r')
          session.pendingPrompt = null
        }
      }, 5000)
    }

    proc.onExit(({ exitCode }) => {
      if (session.detectTimer) clearInterval(session.detectTimer)
      if (session.promptTimer) clearTimeout(session.promptTimer)
      const fullLog = session.fullLog.join('')
      this.sessions.delete(sessionId)
      this.emit('done', {
        sessionId,
        exitCode: exitCode ?? 1,
        fullLog,
        nativeId: session.nativeId,
        stopped: session.stopped,
      })
    })
  }

  startShell({ sessionId, shell, cwd }) {
    const effectiveCwd = cwd || process.env.HOME || process.cwd()
    let proc
    try {
      proc = this.ptyFactory(shell, [], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: effectiveCwd,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          TZ: process.env.TZ || 'America/Los_Angeles',
          FORCE_COLOR: '1',
        },
      })
    } catch (error) {
      error.message = `PTY spawn failed for shell (bin=${shell}, cwd=${effectiveCwd}): ${error.message}`
      throw error
    }

    const session = {
      proc,
      tool: 'shell',
      sessionId,
      fullLog: [],
      logBytes: 0,
      pendingPrompt: null,
      resized: false,
      promptTimer: null,
      nativeId: null,
      stopped: false,
      detectTimer: null,
    }
    this.sessions.set(sessionId, session)

    proc.onData((data) => {
      session.fullLog.push(data)
      session.logBytes += data.length
      while (session.logBytes > MAX_LOG_BYTES && session.fullLog.length > 1) {
        const removed = session.fullLog.shift()
        session.logBytes -= removed.length
      }
      this.emit('output', { sessionId, data })
    })

    proc.onExit(({ exitCode }) => {
      const fullLog = session.fullLog.join('')
      this.sessions.delete(sessionId)
      this.emit('done', {
        sessionId,
        exitCode: exitCode ?? 0,
        fullLog,
        nativeId: null,
        stopped: session.stopped,
      })
    })
  }

  write(sessionId, data) {
    const s = this.sessions.get(sessionId)
    if (s) s.proc.write(data)
  }

  resize(sessionId, cols, rows) {
    const s = this.sessions.get(sessionId)
    if (!s) return
    try { s.proc.resize(cols, rows) } catch { /* ignore */ }
    if (!s.resized && s.pendingPrompt) {
      s.resized = true
      if (s.promptTimer) { clearTimeout(s.promptTimer); s.promptTimer = null }
      setTimeout(() => {
        if (s.pendingPrompt) {
          s.proc.write(s.pendingPrompt + '\r')
          s.pendingPrompt = null
        }
      }, this.promptDelayMs)
    }
  }

  stop(sessionId) {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.stopped = true
    try { s.proc.kill() } catch { /* ignore */ }
    // cleanup happens in onExit
  }
}
