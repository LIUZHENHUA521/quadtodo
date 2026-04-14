import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS todos (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  quadrant    INTEGER NOT NULL CHECK(quadrant IN (1,2,3,4)),
  status      TEXT NOT NULL DEFAULT 'todo',
  due_date    INTEGER,
  work_dir    TEXT,
  sort_order  REAL NOT NULL,
  ai_session  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_todos_quadrant_sort ON todos(quadrant, sort_order);
CREATE INDEX IF NOT EXISTS idx_todos_status        ON todos(status);

CREATE TABLE IF NOT EXISTS comments (
  id         TEXT PRIMARY KEY,
  todo_id    TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_comments_todo ON comments(todo_id, created_at);

CREATE TABLE IF NOT EXISTS ai_session_log (
  id            TEXT PRIMARY KEY,
  todo_id       TEXT NOT NULL,
  tool          TEXT NOT NULL,
  quadrant      INTEGER NOT NULL,
  status        TEXT NOT NULL,
  exit_code     INTEGER,
  started_at    INTEGER NOT NULL,
  completed_at  INTEGER NOT NULL,
  duration_ms   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ail_completed_at ON ai_session_log(completed_at);
CREATE INDEX IF NOT EXISTS idx_ail_tool         ON ai_session_log(tool);
CREATE INDEX IF NOT EXISTS idx_ail_quadrant     ON ai_session_log(quadrant);
`

const UNFINISHED = ['todo', 'ai_running', 'ai_pending', 'ai_done']

function normalizeAiSessions(value) {
  if (!value) return []
  if (Array.isArray(value)) return value.filter(Boolean)
  return [value]
}

function currentAiSession(aiSessions) {
  if (!aiSessions.length) return null
  return aiSessions.find(s => s?.status === 'running' || s?.status === 'pending_confirm') || aiSessions[0]
}

function rowToTodo(row) {
  if (!row) return null
  const aiSessions = normalizeAiSessions(row.ai_session ? JSON.parse(row.ai_session) : null)
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    quadrant: row.quadrant,
    status: row.status,
    dueDate: row.due_date,
    workDir: row.work_dir ?? null,
    brainstorm: !!row.brainstorm,
    sortOrder: row.sort_order,
    aiSession: currentAiSession(aiSessions),
    aiSessions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function openDb(file = ':memory:') {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  const columns = db.prepare(`PRAGMA table_info(todos)`).all()
  if (!columns.some(col => col.name === 'work_dir')) {
    db.exec(`ALTER TABLE todos ADD COLUMN work_dir TEXT`)
  }
  if (!columns.some(col => col.name === 'brainstorm')) {
    db.exec(`ALTER TABLE todos ADD COLUMN brainstorm INTEGER NOT NULL DEFAULT 0`)
  }

  const stmts = {
    insert: db.prepare(`
      INSERT INTO todos (id, title, description, quadrant, status, due_date, work_dir, brainstorm, sort_order, ai_session, created_at, updated_at)
      VALUES (@id, @title, @description, @quadrant, @status, @due_date, @work_dir, @brainstorm, @sort_order, @ai_session, @created_at, @updated_at)
    `),
    getById: db.prepare(`SELECT * FROM todos WHERE id = ?`),
    maxSortInQuadrant: db.prepare(`SELECT MAX(sort_order) AS m FROM todos WHERE quadrant = ?`),
    deleteById: db.prepare(`DELETE FROM todos WHERE id = ?`),
  }

  function nextSortOrder(quadrant) {
    const row = stmts.maxSortInQuadrant.get(quadrant)
    const m = row?.m
    return (m == null ? 0 : m) + 1024
  }

  function createTodo(data) {
    const now = Date.now()
    const quadrant = Number(data.quadrant) || 4
    const row = {
      id: randomUUID(),
      title: data.title,
      description: data.description || '',
      quadrant,
      status: data.status || 'todo',
      due_date: data.dueDate ?? null,
      work_dir: data.workDir ?? null,
      brainstorm: data.brainstorm ? 1 : 0,
      sort_order: data.sortOrder != null ? data.sortOrder : nextSortOrder(quadrant),
      ai_session: JSON.stringify(normalizeAiSessions(data.aiSessions ?? data.aiSession)),
      created_at: now,
      updated_at: now,
    }
    stmts.insert.run(row)
    return rowToTodo(stmts.getById.get(row.id))
  }

  function getTodo(id) {
    return rowToTodo(stmts.getById.get(id))
  }

  function updateTodo(id, patch) {
    const existing = stmts.getById.get(id)
    if (!existing) return null
    const fields = []
    const bind = { id }
    const map = {
      title: 'title',
      description: 'description',
      quadrant: 'quadrant',
      status: 'status',
      dueDate: 'due_date',
      workDir: 'work_dir',
      brainstorm: 'brainstorm',
      sortOrder: 'sort_order',
    }
    for (const [k, col] of Object.entries(map)) {
      if (patch[k] !== undefined) {
        fields.push(`${col} = @${col}`)
        bind[col] = k === 'brainstorm' ? (patch[k] ? 1 : 0) : patch[k]
      }
    }
    if (patch.aiSession !== undefined) {
      const sessions = patch.aiSession === null ? [] : normalizeAiSessions(patch.aiSession)
      fields.push(`ai_session = @ai_session`)
      bind.ai_session = JSON.stringify(sessions)
    }
    if (patch.aiSessions !== undefined) {
      fields.push(`ai_session = @ai_session`)
      bind.ai_session = JSON.stringify(normalizeAiSessions(patch.aiSessions))
    }
    fields.push(`updated_at = @updated_at`)
    bind.updated_at = Date.now()
    const sql = `UPDATE todos SET ${fields.join(', ')} WHERE id = @id`
    db.prepare(sql).run(bind)
    return rowToTodo(stmts.getById.get(id))
  }

  function deleteTodo(id) {
    stmts.deleteById.run(id)
  }

  function listTodos({ quadrant, status, keyword } = {}) {
    const where = []
    const params = []
    if (quadrant != null) {
      where.push('quadrant = ?')
      params.push(Number(quadrant))
    }
    if (status === 'todo') {
      where.push(`status IN (${UNFINISHED.map(() => '?').join(',')})`)
      params.push(...UNFINISHED)
    } else if (status === 'done') {
      where.push('status = ?')
      params.push('done')
    }
    if (keyword) {
      where.push('LOWER(title) LIKE ?')
      params.push(`%${keyword.toLowerCase()}%`)
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const rows = db.prepare(`SELECT * FROM todos ${whereSql} ORDER BY quadrant ASC, sort_order ASC`).all(...params)
    return rows.map(rowToTodo)
  }

  const commentStmts = {
    insert: db.prepare(`INSERT INTO comments (id, todo_id, content, created_at) VALUES (@id, @todo_id, @content, @created_at)`),
    listByTodo: db.prepare(`SELECT * FROM comments WHERE todo_id = ? ORDER BY created_at ASC`),
    deleteById: db.prepare(`DELETE FROM comments WHERE id = ?`),
    getById: db.prepare(`SELECT * FROM comments WHERE id = ?`),
  }

  function addComment(todoId, content) {
    const row = {
      id: randomUUID(),
      todo_id: todoId,
      content,
      created_at: Date.now(),
    }
    commentStmts.insert.run(row)
    return { id: row.id, todoId: row.todo_id, content: row.content, createdAt: row.created_at }
  }

  function listComments(todoId) {
    return commentStmts.listByTodo.all(todoId).map(r => ({
      id: r.id,
      todoId: r.todo_id,
      content: r.content,
      createdAt: r.created_at,
    }))
  }

  function deleteComment(id) {
    commentStmts.deleteById.run(id)
  }

  function getComment(id) {
    const r = commentStmts.getById.get(id)
    if (!r) return null
    return { id: r.id, todoId: r.todo_id, content: r.content, createdAt: r.created_at }
  }

  const aiLogStmts = {
    insert: db.prepare(`
      INSERT OR REPLACE INTO ai_session_log
        (id, todo_id, tool, quadrant, status, exit_code, started_at, completed_at, duration_ms)
      VALUES
        (@id, @todo_id, @tool, @quadrant, @status, @exit_code, @started_at, @completed_at, @duration_ms)
    `),
    listSince: db.prepare(`SELECT * FROM ai_session_log WHERE completed_at >= ? AND completed_at < ? ORDER BY completed_at DESC`),
  }

  function insertSessionLog(row) {
    aiLogStmts.insert.run({
      id: row.id,
      todo_id: row.todoId,
      tool: row.tool,
      quadrant: Number(row.quadrant) || 0,
      status: row.status,
      exit_code: row.exitCode ?? null,
      started_at: row.startedAt,
      completed_at: row.completedAt,
      duration_ms: Math.max(0, row.completedAt - row.startedAt),
    })
  }

  function querySessionStats({ since, until = Date.now() } = {}) {
    const rows = aiLogStmts.listSince.all(since, until)
    const stats = {
      total: rows.length,
      byStatus: { done: 0, failed: 0, stopped: 0 },
      byTool: { claude: 0, codex: 0 },
      byQuadrant: { 1: 0, 2: 0, 3: 0, 4: 0 },
      totalDurationMs: 0,
      avgDurationMs: 0,
      timeline: [],
    }
    if (!rows.length) return stats
    const buckets = new Map()
    const bucketSize = (until - since) > 7 * 86400_000 ? 86400_000 : 3600_000
    for (const r of rows) {
      stats.byStatus[r.status] = (stats.byStatus[r.status] || 0) + 1
      stats.byTool[r.tool] = (stats.byTool[r.tool] || 0) + 1
      stats.byQuadrant[r.quadrant] = (stats.byQuadrant[r.quadrant] || 0) + 1
      stats.totalDurationMs += r.duration_ms
      const bucket = Math.floor(r.completed_at / bucketSize) * bucketSize
      buckets.set(bucket, (buckets.get(bucket) || 0) + 1)
    }
    stats.avgDurationMs = Math.round(stats.totalDurationMs / rows.length)
    stats.timeline = [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([t, count]) => ({ t, count }))
    return stats
  }

  return {
    raw: db,
    createTodo,
    getTodo,
    updateTodo,
    deleteTodo,
    listTodos,
    nextSortOrder,
    addComment,
    listComments,
    deleteComment,
    getComment,
    insertSessionLog,
    querySessionStats,
    close: () => db.close(),
  }
}
