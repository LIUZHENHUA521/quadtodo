import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline'
import { extractUsage } from '../usage-parser.js'
import { normalizeContent, blockToText } from './blocks.js'

export const DEFAULT_CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects')
export const DEFAULT_CODEX_DIR = path.join(os.homedir(), '.codex', 'sessions')
export const DEFAULT_CURSOR_DIR = path.join(os.homedir(), '.cursor', 'projects')

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

function decodeCursorCwdFromDir(dirName) {
  // cursor: 'Users-liuzhenhua-Desktop-foo' → '/Users/liuzhenhua/Desktop/foo'
  // 'private-tmp-x' → '/private/tmp/x'
  // 跳过特殊命名（'empty-window'、纯数字 workspaceId 等）
  if (!dirName) return null
  if (dirName === 'empty-window') return null
  if (/^\d+$/.test(dirName)) return null
  return '/' + dirName.replace(/-/g, '/')
}

async function parseClaudeFile(filePath, opts = {}) {
  const preview = Boolean(opts.preview)
  const rl = readline.createInterface({ input: fs.createReadStream(filePath, 'utf8'), crlfDelay: Infinity })
  let nativeId = null
  let cwd = null
  let startedAt = null
  let endedAt = null
  let firstUserPrompt = null
  let turnCount = 0
  const turns = []
  const rawLines = []
  for await (const line of rl) {
    if (!line.trim()) continue
    rawLines.push(line)
    let j
    try { j = JSON.parse(line) } catch { continue }
    if (!nativeId && j.sessionId) nativeId = j.sessionId
    if (!cwd && j.cwd) cwd = j.cwd
    const ts = j.timestamp ? Date.parse(j.timestamp) : null
    if (ts) {
      if (!startedAt || ts < startedAt) startedAt = ts
      if (!endedAt || ts > endedAt) endedAt = ts
    }
    // preview 模式：和 buildFullTranscript 对齐 —— 过滤 meta/sidechain，只取 user/assistant
    if (preview) {
      if (j.isMeta || j.isSidechain) continue
      if (j.type !== 'user' && j.type !== 'assistant') continue
    }
    const role = j.message?.role || j.type || j.role
    const msg = j.message
    let blocks
    if (typeof msg === 'string') blocks = [{ type: 'text', text: msg }]
    else blocks = normalizeContent(msg?.content)
    const parts = []
    for (const blk of blocks) {
      const piece = blockToText(blk, { includeToolUse: preview, includeToolResult: preview, toolResultMaxChars: 300 })
      if (piece) parts.push(piece)
    }
    const content = parts.join('\n').trim()
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
  const usage = extractUsage('claude', rawLines, {})
  return { nativeId, cwd, startedAt, endedAt, firstUserPrompt, turnCount, turns, usage }
}

// eslint-disable-next-line no-unused-vars
async function parseCursorFile(filePath, _opts = {}) {
  // cursor jsonl 格式：每行 {"role":"user|assistant","message":{"content":[...]}}
  // 没有顶层 timestamp / sessionId / cwd，需要从路径反推。
  //   ~/.cursor/projects/<encoded-cwd>/agent-transcripts/<chatId>/<chatId>.jsonl
  const rl = readline.createInterface({ input: fs.createReadStream(filePath, 'utf8'), crlfDelay: Infinity })
  let firstUserPrompt = null
  let turnCount = 0
  const turns = []
  const rawLines = []
  for await (const line of rl) {
    if (!line.trim()) continue
    rawLines.push(line)
    let j
    try { j = JSON.parse(line) } catch { continue }
    const role = j.role || j.message?.role
    const content = j.message?.content
    let text = ''
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) {
      // 块格式同 claude：{type:'text',text}/{type:'tool_use',name,input}/{type:'tool_result',...}
      const parts = []
      for (const blk of content) {
        if (!blk || typeof blk !== 'object') continue
        if (blk.type === 'text' && blk.text) parts.push(String(blk.text))
        else if (blk.type === 'tool_use') {
          const name = blk.name || 'tool'
          const input = blk.input || {}
          const summary = input.command || input.file_path || input.path || input.url || input.pattern || input.query || input.description
          parts.push(`🔧 ${name}${summary ? ': ' + String(summary).slice(0, 200) : ''}`)
        }
      }
      text = parts.join('\n').trim()
    }
    if (!text) continue
    turnCount++
    turns.push({ role: role || 'raw', content: text })
    if (!firstUserPrompt && role === 'user') firstUserPrompt = text.slice(0, 200)
  }
  // chatId = 文件名（去 .jsonl）；cwd 从父目录的父目录反编码
  const chatId = path.basename(filePath, '.jsonl')
  const grandparent = path.basename(path.dirname(path.dirname(path.dirname(filePath))))
  const cwd = decodeCursorCwdFromDir(grandparent)
  const st = safeStat(filePath)
  const startedAt = st?.birthtimeMs ? Math.floor(st.birthtimeMs) : (st?.mtimeMs ? Math.floor(st.mtimeMs) : null)
  const endedAt = st?.mtimeMs ? Math.floor(st.mtimeMs) : null
  return { nativeId: chatId, cwd, startedAt, endedAt, firstUserPrompt, turnCount, turns, usage: null }
}

function safeParseJson(s) {
  if (typeof s !== 'string') return s
  try { return JSON.parse(s) } catch { return null }
}

async function parseCodexFile(filePath, opts = {}) {
  const preview = Boolean(opts.preview)
  const rl = readline.createInterface({ input: fs.createReadStream(filePath, 'utf8'), crlfDelay: Infinity })
  let nativeId = null
  let cwd = null
  let startedAt = null
  let endedAt = null
  let firstUserPrompt = null
  let turnCount = 0
  const turns = []
  const rawLines = []
  for await (const line of rl) {
    if (!line.trim()) continue
    rawLines.push(line)
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
    if (preview && j.type === 'event_msg') continue   // task_started/task_complete/error 等噪音

    const payload = j.payload || j
    let role
    let blocks = []

    if (payload.type === 'reasoning') {
      // 思考块默认隐藏，和 Claude thinking 行为一致
      continue
    } else if (preview && payload.type === 'function_call') {
      role = 'tool_use'
      blocks = [{ type: 'tool_use', name: payload.name, input: safeParseJson(payload.arguments) }]
    } else if (preview && payload.type === 'function_call_output') {
      role = 'tool_result'
      const outRaw = payload.output ?? payload.content ?? ''
      // codex 的 output 有时是字符串，有时是 {output: '...', metadata: {...}} 的 JSON 串
      let outText = outRaw
      if (typeof outRaw === 'string') {
        const parsed = safeParseJson(outRaw)
        if (parsed && typeof parsed === 'object') outText = parsed.output ?? parsed.content ?? outRaw
      }
      blocks = [{ type: 'tool_result', content: typeof outText === 'string' ? outText : JSON.stringify(outText) }]
    } else if (payload.type === 'message') {
      role = payload.role || 'raw'
      blocks = normalizeContent(payload.content)
    } else {
      // 兜底：旧格式 / 测试 fixtures 的扁平 payload（{role, content}）
      role = payload.role || j.type
      if (typeof payload.content === 'string') blocks = [{ type: 'text', text: payload.content }]
      else if (Array.isArray(payload.content)) blocks = normalizeContent(payload.content)
      else if (typeof payload.text === 'string') blocks = [{ type: 'text', text: payload.text }]
    }

    const parts = []
    for (const blk of blocks) {
      const piece = blockToText(blk, { includeToolUse: preview, includeToolResult: preview, toolResultMaxChars: 300 })
      if (piece) parts.push(piece)
    }
    const content = parts.join('\n').trim()
    if (!content) continue
    turnCount++
    turns.push({ role: role || 'raw', content })
    if (!firstUserPrompt && role === 'user') firstUserPrompt = content.slice(0, 200)
  }
  const usage = extractUsage('codex', rawLines, {})
  return { nativeId, cwd, startedAt, endedAt, firstUserPrompt, turnCount, turns, usage }
}

export function listTranscriptFiles({ claudeDir = DEFAULT_CLAUDE_DIR, codexDir = DEFAULT_CODEX_DIR, cursorDir = null } = {}) {
  const result = []
  for (const p of walkJsonl(claudeDir)) {
    const st = safeStat(p); if (!st) continue
    result.push({ tool: 'claude', jsonlPath: p, size: st.size, mtime: Math.floor(st.mtimeMs) })
  }
  for (const p of walkJsonl(codexDir)) {
    const st = safeStat(p); if (!st) continue
    result.push({ tool: 'codex', jsonlPath: p, size: st.size, mtime: Math.floor(st.mtimeMs) })
  }
  // cursor: 只扫 agent-transcripts/<chatId>/<chatId>.jsonl，避免把 worker.log/repo.json 的同目录其他文件吃进来
  if (cursorDir) {
    for (const p of walkJsonl(cursorDir)) {
      if (!p.includes(`${path.sep}agent-transcripts${path.sep}`)) continue
      const st = safeStat(p); if (!st) continue
      result.push({ tool: 'cursor', jsonlPath: p, size: st.size, mtime: Math.floor(st.mtimeMs) })
    }
  }
  return result
}

export async function parseTranscriptFile(tool, filePath, opts = {}) {
  if (tool === 'claude') return parseClaudeFile(filePath, opts)
  if (tool === 'codex') return parseCodexFile(filePath, opts)
  if (tool === 'cursor') return parseCursorFile(filePath, opts)
  throw new Error(`unknown tool: ${tool}`)
}
