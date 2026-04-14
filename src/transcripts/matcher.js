/**
 * Three-gate auto-bind:
 *  - same cwd
 *  - startedAt within ±WINDOW_MS of an orphan AiSession.startedAt
 *  - first_user_prompt[:100] == orphanSession.prompt[:100]
 *
 * Orphan = an AiSession on a todo that has no native_session_id and no completed_at.
 * Greedy match by |Δt| ascending; ties → skip (avoid mis-bind).
 */
export const WINDOW_MS = 60_000
const PROMPT_PREFIX_LEN = 100

function norm(s) { return String(s || '').trim().slice(0, PROMPT_PREFIX_LEN) }

export function collectOrphans(todos) {
  const orphans = []
  for (const todo of todos) {
    const sessions = Array.isArray(todo.aiSessions) ? todo.aiSessions : (todo.aiSession ? [todo.aiSession] : [])
    for (const s of sessions) {
      if (!s) continue
      if (s.nativeSessionId) continue
      if (!s.startedAt) continue
      orphans.push({
        todoId: todo.id,
        sessionId: s.sessionId,
        tool: s.tool,
        cwd: s.cwd ?? todo.workDir ?? null,
        startedAt: s.startedAt,
        prompt: norm(s.prompt),
        claimed: false,
      })
    }
  }
  return orphans
}

export function autoMatch(unboundFiles, orphans) {
  const pairs = []
  const candidates = []
  for (const f of unboundFiles) {
    if (!f.cwd || !f.started_at || !f.first_user_prompt) continue
    for (const o of orphans) {
      if (o.tool !== f.tool) continue
      if (o.cwd !== f.cwd) continue
      if (norm(f.first_user_prompt) !== o.prompt) continue
      const dt = Math.abs(f.started_at - o.startedAt)
      if (dt > WINDOW_MS) continue
      candidates.push({ file: f, orphan: o, dt })
    }
  }
  candidates.sort((a, b) => a.dt - b.dt)
  const usedFiles = new Set()
  const usedOrphans = new Set()
  const tieReject = new Set()
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]
    const nxt = candidates[i + 1]
    if (nxt && nxt.file.id === c.file.id && nxt.dt === c.dt && nxt.orphan.sessionId !== c.orphan.sessionId) {
      tieReject.add(c.file.id)
      while (i + 1 < candidates.length && candidates[i + 1].file.id === c.file.id) i++
      continue
    }
    if (usedFiles.has(c.file.id) || usedOrphans.has(c.orphan.sessionId)) continue
    if (tieReject.has(c.file.id)) continue
    usedFiles.add(c.file.id)
    usedOrphans.add(c.orphan.sessionId)
    pairs.push({ fileId: c.file.id, todoId: c.orphan.todoId, sessionId: c.orphan.sessionId, nativeId: c.file.native_id })
  }
  return pairs
}
