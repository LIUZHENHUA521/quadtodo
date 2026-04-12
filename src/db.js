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

  const stmts = {
    insert: db.prepare(`
      INSERT INTO todos (id, title, description, quadrant, status, due_date, work_dir, sort_order, ai_session, created_at, updated_at)
      VALUES (@id, @title, @description, @quadrant, @status, @due_date, @work_dir, @sort_order, @ai_session, @created_at, @updated_at)
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
      sortOrder: 'sort_order',
    }
    for (const [k, col] of Object.entries(map)) {
      if (patch[k] !== undefined) {
        fields.push(`${col} = @${col}`)
        bind[col] = patch[k]
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

  return {
    raw: db,
    createTodo,
    getTodo,
    updateTodo,
    deleteTodo,
    listTodos,
    nextSortOrder,
    close: () => db.close(),
  }
}
