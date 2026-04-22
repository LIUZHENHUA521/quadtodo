import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import xtermHeadless from '@xterm/headless'

const { Terminal } = xtermHeadless

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const CODEX_SESSIONS_DIR = join(homedir(), '.codex', 'sessions')

function claudeProjectHash(absPath) {
  return absPath.replace(/\//g, '-')
}

// Replay ANSI byte stream through a headless xterm so cursor motions (CUF/CUP/CHA…)
// become real spaces rather than being deleted — TUIs like Claude Code render status
// bars by moving the cursor between words instead of writing ASCII spaces.
function renderPtyLogText(raw) {
  return new Promise((resolve) => {
    const term = new Terminal({
      cols: 200,
      rows: 50,
      scrollback: 50000,
      allowProposedApi: true,
      convertEol: true,
    })
    term.write(String(raw), () => {
      const buf = term.buffer.active
      const lines = []
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i)
        lines.push(line ? line.translateToString(true) : '')
      }
      while (lines.length && lines[lines.length - 1] === '') lines.pop()
      term.dispose()
      resolve(lines.join('\n'))
    })
  })
}

function parseClaudeJsonl(filePath) {
  const raw = readFileSync(filePath, 'utf8')
  const turns = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    let obj
    try { obj = JSON.parse(line) } catch { continue }
    if (obj.type !== 'user' && obj.message?.role !== 'assistant' && obj.type !== 'assistant') continue
    const ts = obj.timestamp ? Date.parse(obj.timestamp) : undefined
    const msg = obj.message
    if (!msg) continue

    if (obj.type === 'user') {
      if (typeof msg.content === 'string') {
        turns.push({ role: 'user', content: msg.content, timestamp: ts })
      } else if (Array.isArray(msg.content)) {
        for (const c of msg.content) {
          if (c.type === 'tool_result') {
            const text = Array.isArray(c.content)
              ? c.content.map(x => x.text || '').join('\n')
              : (typeof c.content === 'string' ? c.content : JSON.stringify(c.content))
            turns.push({ role: 'tool_result', content: text, toolUseId: c.tool_use_id, timestamp: ts })
          } else if (c.type === 'text') {
            turns.push({ role: 'user', content: c.text, timestamp: ts })
          }
        }
      }
    } else if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (c.type === 'text' && c.text) {
          turns.push({ role: 'assistant', content: c.text, timestamp: ts })
        } else if (c.type === 'thinking' && c.thinking) {
          turns.push({ role: 'thinking', content: c.thinking, timestamp: ts })
        } else if (c.type === 'tool_use') {
          turns.push({
            role: 'tool_use',
            toolName: c.name,
            toolUseId: c.id,
            content: typeof c.input === 'string' ? c.input : JSON.stringify(c.input, null, 2),
            timestamp: ts,
          })
        }
      }
    }
  }
  return turns
}

function findClaudeFile(cwd, nativeSessionId) {
  if (!cwd || !nativeSessionId) return null
  const projDir = join(CLAUDE_PROJECTS_DIR, claudeProjectHash(cwd))
  const file = join(projDir, `${nativeSessionId}.jsonl`)
  return existsSync(file) ? file : null
}

function findCodexFile(nativeSessionId) {
  if (!nativeSessionId || !existsSync(CODEX_SESSIONS_DIR)) return null
  // Walk yyyy/mm/dd subdirs
  const years = readdirSync(CODEX_SESSIONS_DIR).filter(y => /^\d{4}$/.test(y))
  for (const y of years) {
    const yDir = join(CODEX_SESSIONS_DIR, y)
    for (const m of readdirSync(yDir).filter(x => /^\d{2}$/.test(x))) {
      const mDir = join(yDir, m)
      for (const d of readdirSync(mDir).filter(x => /^\d{2}$/.test(x))) {
        const dDir = join(mDir, d)
        for (const f of readdirSync(dDir)) {
          if (f.includes(nativeSessionId) && f.endsWith('.jsonl')) {
            return join(dDir, f)
          }
        }
      }
    }
  }
  return null
}

function parseCodexJsonl(filePath) {
  const raw = readFileSync(filePath, 'utf8')
  const turns = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    let obj
    try { obj = JSON.parse(line) } catch { continue }
    if (obj.type !== 'response_item') continue
    const p = obj.payload
    if (!p) continue
    const ts = obj.timestamp ? Date.parse(obj.timestamp) : undefined

    if (p.type === 'message') {
      if (p.role === 'developer' || p.role === 'system') continue
      const text = Array.isArray(p.content)
        ? p.content.map(c => c.text || '').join('\n').trim()
        : ''
      if (!text) continue
      // Filter out environment_context auto-injection
      if (p.role === 'user' && /^<environment_context>/.test(text)) continue
      turns.push({
        role: p.role === 'assistant' ? 'assistant' : 'user',
        content: text,
        timestamp: ts,
      })
    } else if (p.type === 'function_call') {
      let inputStr = p.arguments
      try { inputStr = JSON.stringify(JSON.parse(p.arguments), null, 2) } catch {}
      turns.push({
        role: 'tool_use',
        toolName: p.name,
        toolUseId: p.call_id,
        content: inputStr,
        timestamp: ts,
      })
    } else if (p.type === 'function_call_output') {
      turns.push({
        role: 'tool_result',
        toolUseId: p.call_id,
        content: typeof p.output === 'string' ? p.output : JSON.stringify(p.output),
        timestamp: ts,
      })
    } else if (p.type === 'reasoning') {
      // Codex reasoning is encrypted by default — skip unless there's visible summary
      const summary = Array.isArray(p.summary) ? p.summary.map(s => s.text || s).join('\n').trim() : ''
      if (summary) turns.push({ role: 'thinking', content: summary, timestamp: ts })
    }
  }
  return turns
}

async function loadFromPtyLog(logDir, sessionId) {
  if (!logDir || !sessionId) return null
  const file = join(logDir, `${sessionId}.log`)
  if (!existsSync(file)) return null
  const raw = readFileSync(file, 'utf8')
  const content = await renderPtyLogText(raw)
  return [{ role: 'raw', content, timestamp: statSync(file).mtimeMs }]
}

async function loadFromLiveOutputHistory(outputHistory, timestamp) {
  if (!Array.isArray(outputHistory) || outputHistory.length === 0) return null
  const raw = outputHistory.join('')
  if (!raw) return null
  const content = await renderPtyLogText(raw)
  return [{ role: 'raw', content, timestamp: timestamp || Date.now() }]
}

/**
 * @param {{ tool: 'claude'|'codex', nativeSessionId?: string|null, cwd?: string|null, sessionId: string, logDir?: string|null, liveOutputHistory?: string[]|null, liveTimestamp?: number|null }} opts
 * @returns {Promise<{ source: 'jsonl'|'ptylog'|'empty', turns: Array<object>, filePath: string|null }>}
 */
export async function loadTranscript({ tool, nativeSessionId, cwd, sessionId, logDir, liveOutputHistory, liveTimestamp }) {
  try {
    let filePath = null
    if (tool === 'claude' && nativeSessionId && cwd) {
      filePath = findClaudeFile(cwd, nativeSessionId)
      if (filePath) {
        return { source: 'jsonl', turns: parseClaudeJsonl(filePath), filePath }
      }
    } else if (tool === 'codex' && nativeSessionId) {
      filePath = findCodexFile(nativeSessionId)
      if (filePath) {
        return { source: 'jsonl', turns: parseCodexJsonl(filePath), filePath }
      }
    }
  } catch (e) {
    console.warn('[transcript] parse failed:', e.message)
  }
  const ptyTurns = await loadFromPtyLog(logDir, sessionId)
  if (ptyTurns) return { source: 'ptylog', turns: ptyTurns, filePath: null }
  const liveTurns = await loadFromLiveOutputHistory(liveOutputHistory, liveTimestamp)
  if (liveTurns) return { source: 'ptylog', turns: liveTurns, filePath: null }
  return { source: 'empty', turns: [], filePath: null }
}
