/**
 * Claude Code 会话日志解析器：把 ~/.claude/projects/<encoded>/<uuid>.jsonl 解析成
 * 干净的可读文本。
 *
 * 用途：
 *   - readLatestAssistantTurn(jsonlPath) → AI 最近一轮的完整文本（用于 Stop hook 推送）
 *   - buildFullTranscript(jsonlPath) → 整段对话 markdown（用于 SessionEnd 附件）
 *
 * jsonl 格式（v2.1.x）：
 *   每行一个 JSON 对象，type ∈ {user, assistant, queue-operation, ...}
 *   message.role: user / assistant
 *   message.content:
 *     - string（user 偶尔）
 *     - array of:
 *         {type: 'text', text: '...'}
 *         {type: 'tool_use', name: 'Bash', input: {...}, id: '...'}
 *         {type: 'tool_result', tool_use_id: '...', content: '...' or array}
 *
 * 设计：
 *   - 读全文件（v1 假设 < 5MB；后续超大可改成 readline 流式）
 *   - 跳过 meta / queue / system 行
 *   - 工具调用用简短摘要（"🔧 Bash: ls /tmp"）替代完整 input
 *   - 工具结果默认折叠（前 200 字 + "(N more chars)"）
 */
import { existsSync, readFileSync } from 'node:fs'

const MAX_FILE_BYTES = 10 * 1024 * 1024  // 10MB 上限保护

/** 把 message.content 拍平成 array<block>，无论它是 string 还是 array. */
function normalizeContent(content) {
  if (!content) return []
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (Array.isArray(content)) return content
  return []
}

/** 从一个 content 块提取人类可读文本（assistant 视角）。 */
function blockToText(block, opts = {}) {
  if (!block || typeof block !== 'object') return ''
  if (block.type === 'text') {
    return String(block.text || '')
  }
  if (block.type === 'tool_use') {
    const name = block.name || 'tool'
    const input = block.input
    let summary = ''
    if (input && typeof input === 'object') {
      // 常见工具：Bash 用 command, Edit 用 file_path, Write 用 file_path, Read 用 file_path
      const cmd = input.command || input.cmd
      const fp = input.file_path || input.path || input.filePath
      const url = input.url
      const pat = input.pattern || input.query
      const desc = input.description
      if (cmd) summary = String(cmd).slice(0, 200)
      else if (fp) summary = String(fp).slice(0, 200)
      else if (url) summary = String(url).slice(0, 200)
      else if (pat) summary = String(pat).slice(0, 200)
      else if (desc) summary = String(desc).slice(0, 120)
      else summary = JSON.stringify(input).slice(0, 200)
    }
    return `🔧 ${name}${summary ? ': ' + summary : ''}`
  }
  if (block.type === 'tool_result') {
    // user 角色里偶尔出现；assistant 视角一般跳过
    if (opts.includeToolResult) {
      const c = block.content
      let text = ''
      if (typeof c === 'string') text = c
      else if (Array.isArray(c)) text = c.map((b) => b.text || JSON.stringify(b)).join('\n')
      const max = opts.toolResultMaxChars || 300
      if (text.length > max) text = text.slice(0, max) + ` …(${text.length - max} more chars)`
      return `📋 result: ${text}`
    }
    return ''
  }
  if (block.type === 'thinking') {
    // 思考内容有时也带，默认不展示给用户
    return ''
  }
  return ''
}

export function readJsonlLines(path) {
  if (!existsSync(path)) return []
  const stat = existsSync(path) ? readFileSync(path) : null
  if (!stat) return []
  if (stat.length > MAX_FILE_BYTES) {
    // 超大文件只读末尾 5MB
    const buf = stat.subarray(stat.length - 5 * 1024 * 1024)
    return buf.toString('utf8').split('\n')
  }
  return stat.toString('utf8').split('\n')
}

function parseJsonlLine(line) {
  if (!line) return null
  const trimmed = line.trim()
  if (!trimmed || !trimmed.startsWith('{')) return null
  try { return JSON.parse(trimmed) } catch { return null }
}

/**
 * 取最后一条 assistant 消息的完整文本。
 * 返回 { text, hasToolUse, timestamp, raw } 或 null。
 */
export function readLatestAssistantTurn(jsonlPath) {
  const lines = readJsonlLines(jsonlPath)
  if (lines.length === 0) return null

  // 反向找最近的 assistant
  for (let i = lines.length - 1; i >= 0; i--) {
    const obj = parseJsonlLine(lines[i])
    if (!obj) continue
    if (obj.type !== 'assistant') continue
    const content = normalizeContent(obj.message?.content)
    if (content.length === 0) continue

    const parts = []
    let hasToolUse = false
    for (const block of content) {
      if (block?.type === 'tool_use') hasToolUse = true
      const piece = blockToText(block)
      if (piece) parts.push(piece)
    }
    const text = parts.join('\n\n').trim()
    if (!text) continue
    return {
      text,
      hasToolUse,
      timestamp: obj.timestamp || null,
      raw: obj,
    }
  }
  return null
}

/**
 * 取最后一条 user 消息的时间戳（不含 isMeta / sidechain）。
 * 用于 Stop hook 识别 "AI 是否已经回应到最新 user 输入"。
 */
export function readLatestUserTimestamp(jsonlPath) {
  const lines = readJsonlLines(jsonlPath)
  for (let i = lines.length - 1; i >= 0; i--) {
    const obj = parseJsonlLine(lines[i])
    if (!obj) continue
    if (obj.type !== 'user') continue
    if (obj.isMeta || obj.isSidechain) continue
    if (obj.timestamp) return obj.timestamp
  }
  return null
}

/**
 * 拿"针对最新 user 输入的 assistant 回应"。
 *
 * 解决的问题：Stop hook 触发瞬间，Claude Code 可能还没写完 jsonl，导致
 * readLatestAssistantTurn 拿到上一轮的内容（用户感觉"每条回复都是上一次的"）。
 *
 * 策略：retry 等待，直到 latest assistant.timestamp > latest user.timestamp。
 * 默认 retry 5 次 × 250ms = 1.25s 上限。
 */
export async function readLatestAssistantTurnFresh(jsonlPath, opts = {}) {
  const maxRetries = opts.maxRetries ?? 5
  const delayMs = opts.delayMs ?? 250
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const userTs = readLatestUserTimestamp(jsonlPath)
    const turn = readLatestAssistantTurn(jsonlPath)
    if (!turn) {
      // 没 assistant 消息 → 只能等
      if (attempt === maxRetries) return null
    } else if (!userTs || !turn.timestamp || turn.timestamp > userTs) {
      // assistant 在 user 之后（已回应 latest input）—— 干净，返回
      return { ...turn, fresh: true, attempts: attempt }
    } else {
      // assistant 在 user 之前 —— stale，等等再读
      if (attempt === maxRetries) {
        // 仍然 stale → 返回 stale 数据让上游决定
        return { ...turn, fresh: false, attempts: attempt }
      }
    }
    await new Promise((r) => setTimeout(r, delayMs))
  }
  return null
}

/**
 * 整段对话渲染成 markdown。供 SessionEnd 附件用。
 * 返回 { markdown, turnCount }。
 */
export function buildFullTranscript(jsonlPath, opts = {}) {
  const lines = readJsonlLines(jsonlPath)
  if (lines.length === 0) return { markdown: '', turnCount: 0 }

  const out = []
  let turnCount = 0

  for (const line of lines) {
    const obj = parseJsonlLine(line)
    if (!obj) continue
    if (obj.type !== 'user' && obj.type !== 'assistant') continue
    if (obj.isMeta) continue   // 跳过 meta（local-command-caveat 等）
    if (obj.isSidechain) continue

    const role = obj.message?.role || obj.type
    const content = normalizeContent(obj.message?.content)
    if (content.length === 0) continue

    const parts = []
    for (const block of content) {
      const piece = blockToText(block, { includeToolResult: true, toolResultMaxChars: opts.toolResultMaxChars || 1000 })
      if (piece) parts.push(piece)
    }
    const text = parts.join('\n\n').trim()
    if (!text) continue

    const ts = obj.timestamp ? new Date(obj.timestamp).toISOString().slice(0, 19).replace('T', ' ') : ''
    if (role === 'user') {
      out.push(`### 👤 User${ts ? ` _${ts}_` : ''}\n\n${text}\n`)
    } else {
      out.push(`### 🤖 Assistant${ts ? ` _${ts}_` : ''}\n\n${text}\n`)
    }
    turnCount++
  }

  if (turnCount === 0) return { markdown: '', turnCount: 0 }
  const header = `# Claude Code Session Transcript\n\n_Generated: ${new Date().toISOString()}_\n_Source: ${jsonlPath}_\n_Turns: ${turnCount}_\n\n---\n\n`
  return {
    markdown: header + out.join('\n'),
    turnCount,
  }
}

export const __test__ = { normalizeContent, blockToText, parseJsonlLine }
