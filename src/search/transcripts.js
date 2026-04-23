import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 在 AI 会话日志文件里做逐行关键词扫描。不使用 FTS，纯 Node fs。
 *
 * 查 transcripts 时的常见约束：
 *   - 单个 log 文件可能几十 MB（node-pty 输出量大）；
 *   - 查询返回太多命中会把 LLM 上下文拉爆。
 * 所以这里用严格的 maxMatches / perFileLimit 保护。
 */
export function createTranscriptScanner({ db, logDir } = {}) {
  if (!db) throw new Error('db_required')
  if (!logDir) throw new Error('logDir_required')

  /**
   * 从 todo.ai_session 拿出所有 sessionId + 起止时间。
   * 返回 [{ sessionId, startedAt, completedAt, tool, todoId, todoTitle }]
   */
  function collectCandidates({ todoId, afterTs, beforeTs }) {
    const todos = todoId
      ? [db.getTodo(todoId)].filter(Boolean)
      : db.listTodos({ archived: 'all' })
    const out = []
    for (const t of todos) {
      if (!Array.isArray(t.aiSessions)) continue
      for (const s of t.aiSessions) {
        if (!s?.sessionId) continue
        const start = s.startedAt || 0
        if (afterTs && start < afterTs) continue
        if (beforeTs && start > beforeTs) continue
        out.push({
          sessionId: s.sessionId,
          todoId: t.id,
          todoTitle: t.title,
          startedAt: s.startedAt || null,
          completedAt: s.completedAt || null,
          tool: s.tool || null,
        })
      }
    }
    return out
  }

  /**
   * 对单个 log 文件扫 query。返回至多 perFileLimit 条命中。
   * 命中条目：{ lineNumber, beforeLines[], matchLine, afterLines[] }
   */
  function scanFile(absPath, needle, { perFileLimit = 5, contextBefore = 1, contextAfter = 1 } = {}) {
    if (!existsSync(absPath)) return []
    let buf = ''
    try {
      const st = statSync(absPath)
      // 文件超大（>8MB）只读尾部 4MB，避免 OOM
      if (st.size > 8 * 1024 * 1024) {
        const fd = readFileSync(absPath)
        buf = fd.slice(fd.length - 4 * 1024 * 1024).toString('utf8')
      } else {
        buf = readFileSync(absPath, 'utf8')
      }
    } catch {
      return []
    }
    const lines = buf.split('\n')
    const lowerNeedle = needle.toLowerCase()
    const hits = []
    for (let i = 0; i < lines.length && hits.length < perFileLimit; i++) {
      if (lines[i].toLowerCase().includes(lowerNeedle)) {
        hits.push({
          lineNumber: i + 1,
          beforeLines: lines.slice(Math.max(0, i - contextBefore), i),
          matchLine: lines[i],
          afterLines: lines.slice(i + 1, Math.min(lines.length, i + 1 + contextAfter)),
        })
      }
    }
    return hits
  }

  /**
   * 主入口。
   */
  function search({
    query,
    todoId,
    afterTs,
    beforeTs,
    maxMatches = 30,
    perFileLimit = 5,
    contextBefore = 1,
    contextAfter = 1,
  } = {}) {
    if (!query || !String(query).trim()) throw new Error('query_required')
    const q = String(query).trim()
    const candidates = collectCandidates({ todoId, afterTs, beforeTs })
    const matches = []
    let scanned = 0
    for (const c of candidates) {
      if (matches.length >= maxMatches) break
      const file = join(logDir, `${c.sessionId}.log`)
      scanned += 1
      const hits = scanFile(file, q, {
        perFileLimit: Math.min(perFileLimit, Math.max(1, maxMatches - matches.length)),
        contextBefore,
        contextAfter,
      })
      for (const h of hits) {
        matches.push({ ...h, sessionId: c.sessionId, todoId: c.todoId, todoTitle: c.todoTitle, tool: c.tool })
        if (matches.length >= maxMatches) break
      }
    }
    return {
      query: q,
      scannedFiles: scanned,
      totalMatches: matches.length,
      matches,
    }
  }

  /**
   * 读取单个会话 transcript 的完整内容（可截断）。
   * maxChars：返回字符数上限（粗略近似 token，默认 32000 ≈ 8k tokens）
   */
  function readSession({ sessionId, maxChars = 32_000 } = {}) {
    if (!sessionId) throw new Error('sessionId_required')
    const file = join(logDir, `${sessionId}.log`)
    if (!existsSync(file)) {
      return { exists: false, body: null }
    }
    const st = statSync(file)
    const full = readFileSync(file, 'utf8')
    if (full.length <= maxChars) {
      return { exists: true, body: full, bytes: st.size, truncated: false, path: file }
    }
    const tail = full.slice(full.length - maxChars)
    const truncatedChars = full.length - maxChars
    return {
      exists: true,
      body: `…[truncated ${truncatedChars} chars from the start]\n${tail}`,
      bytes: st.size,
      truncated: true,
      droppedChars: truncatedChars,
      path: file,
    }
  }

  return { search, readSession }
}
