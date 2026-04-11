import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const CLAUDE_SESSION_RE = /claude\s+--resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g
const MAX_LOG_BYTES = 512 * 1024

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
    const args = resumeNativeId ? [...baseArgs, '--resume', resumeNativeId] : [...baseArgs]

    const proc = this.ptyFactory(toolCfg.bin, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1' },
    })

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
    }
    this.sessions.set(sessionId, session)

    proc.onData((data) => {
      session.fullLog.push(data)
      session.logBytes += data.length
      while (session.logBytes > MAX_LOG_BYTES && session.fullLog.length > 1) {
        const removed = session.fullLog.shift()
        session.logBytes -= removed.length
      }
      const stripped = data.replace(ANSI_RE, '')
      const m = stripped.match(CLAUDE_SESSION_RE)
      if (m && session.nativeId !== m[1]) {
        session.nativeId = m[1]
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
