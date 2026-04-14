import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline'

export const DEFAULT_CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects')
export const DEFAULT_CODEX_DIR = path.join(os.homedir(), '.codex', 'sessions')

function walkJsonl(root) {
  const out = []
  function walk(dir) {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (ent.isFile() && ent.name.endsWith('.jsonl')) out.push(p)
    }
  }
  walk(root)
  return out
}

function safeStat(p) { try { return fs.statSync(p) } catch { return null } }

function decodeClaudeCwdFromDir(dirName) {
  // Claude 目录名用 '-' 替换路径分隔符：'-Users-liuzhenhua-Desktop-code' → '/Users/liuzhenhua/Desktop/code'
  if (!dirName.startsWith('-')) return null
  return dirName.replace(/-/g, '/')
}

async function parseClaudeFile(filePath) {
  const rl = readline.createInterface({ input: fs.createReadStream(filePath, 'utf8'), crlfDelay: Infinity })
  let nativeId = null
  let cwd = null
  let startedAt = null
  let endedAt = null
  let firstUserPrompt = null
  let turnCount = 0
  const turns = []
  for await (const line of rl) {
    if (!line.trim()) continue
    let j
    try { j = JSON.parse(line) } catch { continue }
    if (!nativeId && j.sessionId) nativeId = j.sessionId
    if (!cwd && j.cwd) cwd = j.cwd
    const ts = j.timestamp ? Date.parse(j.timestamp) : null
    if (ts) {
      if (!startedAt || ts < startedAt) startedAt = ts
      if (!endedAt || ts > endedAt) endedAt = ts
    }
    const role = j.type || j.role
    const msg = j.message
    let content = ''
    if (typeof msg === 'string') content = msg
    else if (msg?.content) {
      if (typeof msg.content === 'string') content = msg.content
      else if (Array.isArray(msg.content)) {
        content = msg.content.map(c => typeof c === 'string' ? c : c?.text || '').filter(Boolean).join('\n')
      }
    }
    if (!content) continue
    turnCount++
    turns.push({ role: role || 'raw', content })
    if (!firstUserPrompt && (role === 'user' || msg?.role === 'user')) {
      firstUserPrompt = content.slice(0, 200)
    }
  }
  if (!cwd) {
    const parent = path.basename(path.dirname(filePath))
    cwd = decodeClaudeCwdFromDir(parent)
  }
  return { nativeId, cwd, startedAt, endedAt, firstUserPrompt, turnCount, turns }
}

async function parseCodexFile(filePath) {
  const rl = readline.createInterface({ input: fs.createReadStream(filePath, 'utf8'), crlfDelay: Infinity })
  let nativeId = null
  let cwd = null
  let startedAt = null
  let endedAt = null
  let firstUserPrompt = null
  let turnCount = 0
  const turns = []
  for await (const line of rl) {
    if (!line.trim()) continue
    let j
    try { j = JSON.parse(line) } catch { continue }
    const ts = j.timestamp ? Date.parse(j.timestamp) : null
    if (ts) {
      if (!startedAt || ts < startedAt) startedAt = ts
      if (!endedAt || ts > endedAt) endedAt = ts
    }
    if (j.type === 'session_meta' && j.payload) {
      if (!nativeId && j.payload.id) nativeId = j.payload.id
      if (!cwd && j.payload.cwd) cwd = j.payload.cwd
      if (j.payload.timestamp) {
        const t = Date.parse(j.payload.timestamp)
        if (t && (!startedAt || t < startedAt)) startedAt = t
      }
      continue
    }
    const payload = j.payload || j
    const role = payload.role || j.type
    let content = ''
    if (typeof payload.content === 'string') content = payload.content
    else if (Array.isArray(payload.content)) {
      content = payload.content.map(c => typeof c === 'string' ? c : c?.text || '').filter(Boolean).join('\n')
    } else if (typeof payload.text === 'string') content = payload.text
    if (!content) continue
    turnCount++
    turns.push({ role: role || 'raw', content })
    if (!firstUserPrompt && role === 'user') firstUserPrompt = content.slice(0, 200)
  }
  return { nativeId, cwd, startedAt, endedAt, firstUserPrompt, turnCount, turns }
}

export function listTranscriptFiles({ claudeDir = DEFAULT_CLAUDE_DIR, codexDir = DEFAULT_CODEX_DIR } = {}) {
  const result = []
  for (const p of walkJsonl(claudeDir)) {
    const st = safeStat(p); if (!st) continue
    result.push({ tool: 'claude', jsonlPath: p, size: st.size, mtime: Math.floor(st.mtimeMs) })
  }
  for (const p of walkJsonl(codexDir)) {
    const st = safeStat(p); if (!st) continue
    result.push({ tool: 'codex', jsonlPath: p, size: st.size, mtime: Math.floor(st.mtimeMs) })
  }
  return result
}

export async function parseTranscriptFile(tool, filePath) {
  if (tool === 'claude') return parseClaudeFile(filePath)
  if (tool === 'codex') return parseCodexFile(filePath)
  throw new Error(`unknown tool: ${tool}`)
}
