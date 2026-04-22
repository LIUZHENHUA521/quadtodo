import fs from 'node:fs'
import { listTranscriptFiles, parseTranscriptFile, DEFAULT_CLAUDE_DIR, DEFAULT_CODEX_DIR } from './scanner.js'
import { indexFile } from './indexer.js'
import { collectOrphans, autoMatch } from './matcher.js'

export { DEFAULT_CLAUDE_DIR, DEFAULT_CODEX_DIR }

export function createTranscriptsService({ db, listTodos, updateTodo, dirs = {} } = {}) {
  const claudeDir = dirs.claude || DEFAULT_CLAUDE_DIR
  const codexDir = dirs.codex || DEFAULT_CODEX_DIR

  function applyBindingToTodo(todoId, { nativeId, tool, startedAt, endedAt }, sessionIdHint) {
    const todo = listTodos().find(t => t.id === todoId)
    if (!todo) return null
    const sessions = Array.isArray(todo.aiSessions) ? [...todo.aiSessions] : []

    // Remove any existing session on this todo that already holds this native id (dedup)
    const filtered = sessions.filter(s => !(s?.nativeSessionId === nativeId && s?.tool === tool))

    let targetIdx = -1
    if (sessionIdHint) targetIdx = filtered.findIndex(s => s?.sessionId === sessionIdHint)
    if (targetIdx === -1) targetIdx = filtered.findIndex(s => !s?.nativeSessionId && s?.tool === tool)

    const baseTs = startedAt || Date.now()
    const newSession = targetIdx >= 0 ? { ...filtered[targetIdx] } : {
      sessionId: `imported-${nativeId}`,
      tool,
      status: 'done',
      startedAt: baseTs,
      prompt: '',
      label: '',
    }
    newSession.nativeSessionId = nativeId
    newSession.tool = tool
    newSession.source = 'imported'
    if (!newSession.startedAt) newSession.startedAt = baseTs
    if (!newSession.completedAt) newSession.completedAt = endedAt || baseTs
    if (!newSession.status || newSession.status === 'running' || newSession.status === 'pending_confirm') {
      newSession.status = 'done'
    }

    if (targetIdx >= 0) filtered[targetIdx] = newSession
    else filtered.push(newSession)

    updateTodo(todoId, { aiSessions: filtered })
    return newSession.sessionId
  }

  function removeBindingFromTodo(todoId, nativeId, tool) {
    const todo = listTodos().find(t => t.id === todoId)
    if (!todo) return
    const sessions = Array.isArray(todo.aiSessions) ? todo.aiSessions : []
    const next = sessions.map(s => {
      if (s?.nativeSessionId === nativeId && s?.tool === tool) {
        if (s.source === 'imported') return null
        return { ...s, nativeSessionId: null }
      }
      return s
    }).filter(Boolean)
    updateTodo(todoId, { aiSessions: next })
  }

  async function scanFull() {
    return scan({ mode: 'full' })
  }

  async function scanIncremental() {
    return scan({ mode: 'incremental' })
  }

  async function scan({ mode }) {
    if (db.raw && db.raw.open === false) return { newFiles: 0, indexed: 0, autoBound: 0, unbound: 0 }
    const disk = listTranscriptFiles({ claudeDir, codexDir })
    const diskByPath = new Map(disk.map(f => [f.jsonlPath, f]))
    const dbFiles = db.listTranscriptFilesMeta()
    const dbByPath = new Map(dbFiles.map(r => [r.jsonl_path, r]))

    // delete missing files
    for (const r of dbFiles) {
      if (!diskByPath.has(r.jsonl_path)) db.deleteTranscriptFile(r.jsonl_path)
    }

    let indexed = 0
    let newFiles = 0
    for (const f of disk) {
      const existing = dbByPath.get(f.jsonlPath)
      const missingUsage = existing && existing.input_tokens == null && existing.output_tokens == null
      const dirty = mode === 'full' || !existing || existing.size !== f.size || existing.mtime !== f.mtime || missingUsage
      if (!dirty) continue
      if (!existing) newFiles++
      const row = await indexFile(db, f)
      if (row) indexed++
    }

    const autoBound = await autoBindUnbound()
    const unbound = db.countUnboundTranscripts()
    return { newFiles, indexed, autoBound, unbound }
  }

  async function autoBindUnbound() {
    const unbound = db.listUnboundTranscriptFiles()
    if (!unbound.length) return 0
    const todos = listTodos()

    // Pass 1（直连）：transcript_files.native_id 直接命中 todo.aiSessions[].nativeSessionId
    // quadtodo 启动的会话都走这条，避免依赖 cwd+time+prompt 的模糊匹配
    const nativeToTodo = new Map()
    for (const t of todos) {
      for (const s of (t.aiSessions || [])) {
        if (s?.nativeSessionId && s?.tool) {
          nativeToTodo.set(`${s.tool}:${s.nativeSessionId}`, t.id)
        }
      }
    }
    const remaining = []
    let directBound = 0
    for (const f of unbound) {
      const hit = f.native_id ? nativeToTodo.get(`${f.tool}:${f.native_id}`) : null
      if (hit) {
        db.setTranscriptBound(f.id, hit)
        directBound++
      } else {
        remaining.push(f)
      }
    }

    // Pass 2（fuzzy）：历史遗留、外部工具启动的会话没有 nativeSessionId 记到 todo 上，才走 cwd+time+prompt
    const orphans = collectOrphans(todos)
    let fuzzyBound = 0
    if (orphans.length && remaining.length) {
      const pairs = autoMatch(remaining, orphans)
      for (const p of pairs) {
        const file = db.getTranscriptFile(p.fileId)
        if (!file) continue
        applyBindingToTodo(p.todoId, {
          nativeId: p.nativeId,
          tool: file.tool,
          startedAt: file.started_at,
          endedAt: file.ended_at,
        }, p.sessionId)
        db.setTranscriptBound(p.fileId, p.todoId)
        fuzzyBound++
      }
    }
    return directBound + fuzzyBound
  }

  function search(opts) {
    return db.searchTranscripts(opts || {})
  }

  async function preview(fileId, { offset = 0, limit = 200 } = {}) {
    const f = db.getTranscriptFile(fileId)
    if (!f) return null
    const parsed = await parseTranscriptFile(f.tool, f.jsonl_path)
    return {
      file: f,
      turns: parsed.turns.slice(offset, offset + limit),
      totalTurns: parsed.turns.length,
    }
  }

  function bind(fileId, todoId, { force = false } = {}) {
    const file = db.getTranscriptFile(fileId)
    if (!file) return { ok: false, code: 'NOT_FOUND' }
    if (!file.native_id) return { ok: false, code: 'NO_NATIVE_ID' }

    // uniqueness: check if another transcript_files row has the same native_id+tool already bound elsewhere
    const twin = db.findTranscriptByNative(file.native_id, file.tool)
    // also check todo-side: any other todo already hosts this nativeId
    const todos = listTodos()
    const existingHost = todos.find(t => t.id !== todoId && (t.aiSessions || []).some(s => s?.tool === file.tool && s?.nativeSessionId === file.native_id))

    if ((file.bound_todo_id && file.bound_todo_id !== todoId) || existingHost) {
      if (!force) {
        return { ok: false, code: 'ALREADY_BOUND', currentTodoId: file.bound_todo_id || existingHost?.id || null }
      }
      const prevTodoId = file.bound_todo_id || existingHost?.id
      if (prevTodoId) removeBindingFromTodo(prevTodoId, file.native_id, file.tool)
    }

    applyBindingToTodo(todoId, {
      nativeId: file.native_id,
      tool: file.tool,
      startedAt: file.started_at,
      endedAt: file.ended_at,
    })
    db.setTranscriptBound(fileId, todoId)
    return { ok: true }
  }

  function unbind(fileId) {
    const file = db.getTranscriptFile(fileId)
    if (!file) return { ok: false, code: 'NOT_FOUND' }
    if (file.bound_todo_id) {
      removeBindingFromTodo(file.bound_todo_id, file.native_id, file.tool)
      db.setTranscriptBound(fileId, null)
    }
    return { ok: true }
  }

  return {
    scanFull,
    scanIncremental,
    search,
    preview,
    bind,
    unbind,
    getStats: () => ({ unboundCount: db.countUnboundTranscripts() }),
    getFile: (id) => db.getTranscriptFile(id),
    // exposed for tests
    _applyBindingToTodo: applyBindingToTodo,
  }
}
