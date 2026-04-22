import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const require = createRequire(import.meta.url)

/**
 * 将托管模式映射为原生 CLI 参数：
 *   - default / null：无额外参数（交互式确认）
 *   - acceptEdits (半托管)：自动放行编辑类操作
 *   - bypass (完全托管)：跳过全部权限询问
 * claude/codex 两个 CLI 的标志不同，这里分开处理。
 */
function buildPermissionArgs(tool, mode) {
  if (!mode || mode === 'default') return []
  if (tool === 'claude') {
    if (mode === 'acceptEdits') return ['--permission-mode', 'acceptEdits']
    if (mode === 'bypass') return ['--permission-mode', 'bypassPermissions']
    return []
  }
  if (tool === 'codex') {
    if (mode === 'acceptEdits') return ['--ask-for-approval', 'on-request', '--sandbox', 'workspace-write']
    if (mode === 'bypass') return ['--dangerously-bypass-approvals-and-sandbox']
    return []
  }
  return []
}

const CLAUDE_SESSION_RE = /claude\s+--resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/
const CODEX_SESSION_RE = /codex\s+resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/
const MAX_LOG_BYTES = 512 * 1024
const CODEX_SESSIONS_DIR = join(homedir(), '.codex', 'sessions')

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

  /** 返回当前所有活跃 PTY 的 { sessionId, pid, tool }，供 pidusage 采样用 */
  getPids() {
    const out = []
    for (const [sessionId, s] of this.sessions) {
      const pid = s.proc?.pid
      if (pid) out.push({ sessionId, pid, tool: s.tool })
    }
    return out
  }

  start({ sessionId, tool, prompt, cwd, resumeNativeId, permissionMode }) {
    const toolCfg = this.tools[tool]
    if (!toolCfg) throw new Error(`unknown tool: ${tool}`)
    const baseArgs = toolCfg.args || []
    // 是否通过 CLI 参数传递 prompt（仅新会话、非 resume 时可用）
    const useCliPrompt = prompt && !resumeNativeId
    // permissionMode → 原生 CLI 标志：把托管模式直接交给 claude/codex 处理，
    // 比在 PTY 输出里做正则匹配 + 自动回车 更可靠。
    const permissionArgs = buildPermissionArgs(tool, permissionMode)
    // Claude 支持 --session-id <uuid>：新会话时由我们预生成，避免事后靠 FS/输出扫描。
    const presetClaudeId = tool === 'claude' && !resumeNativeId ? randomUUID() : null
    const claudeSessionArgs = presetClaudeId ? ['--session-id', presetClaudeId] : []
    const args = resumeNativeId
      ? tool === 'codex'
        ? [...baseArgs, ...permissionArgs, 'resume', resumeNativeId]
        : [...baseArgs, ...permissionArgs, '--resume', resumeNativeId]
      : useCliPrompt
        ? [...baseArgs, ...permissionArgs, ...claudeSessionArgs, prompt]
        : [...baseArgs, ...permissionArgs, ...claudeSessionArgs]
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
      pendingPrompt: useCliPrompt ? null : (prompt && !resumeNativeId ? prompt : null),
      resized: false,
      promptTimer: null,
      nativeId: resumeNativeId || presetClaudeId || null,
      stopped: false,
      detectTimer: null,
    }
    this.sessions.set(sessionId, session)

    // Claude 预生成 UUID → 立即同步通知，下游（ai-terminal）能在首次 DB 写入窗口内拿到 nativeSessionId
    if (presetClaudeId) {
      this.emit('native-session', { sessionId, nativeId: presetClaudeId })
    }

    // Codex 新会话：无 --session-id 支持，继续靠 FS 兜底。400ms × 30 次（旧方案 2000ms × 15 次）。
    if (!resumeNativeId && tool === 'codex') {
      const spawnTime = Date.now() - 1000
      let detectAttempts = 0
      session.detectTimer = setInterval(() => {
        detectAttempts++
        if (session.nativeId) {
          clearInterval(session.detectTimer)
          session.detectTimer = null
          return
        }
        const id = detectCodexSessionFromFs(spawnTime)
        if (id) {
          clearInterval(session.detectTimer)
          session.detectTimer = null
          session.nativeId = id
          this.emit('native-session', { sessionId, nativeId: id })
        } else if (detectAttempts >= 30) {
          clearInterval(session.detectTimer)
          session.detectTimer = null
        }
      }, 400)
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
