import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS todos (
  id           TEXT PRIMARY KEY,
  parent_id    TEXT,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  quadrant     INTEGER NOT NULL CHECK(quadrant IN (1,2,3,4)),
  status       TEXT NOT NULL DEFAULT 'todo',
  due_date     INTEGER,
  work_dir     TEXT,
  sort_order   REAL NOT NULL,
  ai_session   TEXT,
  completed_at INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
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

CREATE TABLE IF NOT EXISTS transcript_files (
  id                INTEGER PRIMARY KEY,
  tool              TEXT NOT NULL,
  native_id         TEXT,
  cwd               TEXT,
  jsonl_path        TEXT NOT NULL UNIQUE,
  size              INTEGER NOT NULL,
  mtime             INTEGER NOT NULL,
  started_at        INTEGER,
  ended_at          INTEGER,
  first_user_prompt TEXT,
  turn_count        INTEGER NOT NULL DEFAULT 0,
  input_tokens          INTEGER,
  output_tokens         INTEGER,
  cache_read_tokens     INTEGER,
  cache_creation_tokens INTEGER,
  primary_model         TEXT,
  active_ms             INTEGER,
  bound_todo_id     TEXT,
  indexed_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tf_native ON transcript_files(native_id);
CREATE INDEX IF NOT EXISTS idx_tf_bound  ON transcript_files(bound_todo_id);
CREATE INDEX IF NOT EXISTS idx_tf_tool_cwd_started ON transcript_files(tool, cwd, started_at);

CREATE TABLE IF NOT EXISTS recurring_rules (
  id                    TEXT PRIMARY KEY,
  title                 TEXT NOT NULL,
  description           TEXT NOT NULL DEFAULT '',
  quadrant              INTEGER NOT NULL CHECK(quadrant IN (1,2,3,4)),
  work_dir              TEXT,
  brainstorm            INTEGER NOT NULL DEFAULT 0,
  applied_template_ids  TEXT,
  subtodos              TEXT,
  frequency             TEXT NOT NULL CHECK(frequency IN ('daily','weekly','monthly')),
  weekdays              TEXT,
  month_days            TEXT,
  active                INTEGER NOT NULL DEFAULT 1,
  last_generated_date   TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rr_active ON recurring_rules(active);

CREATE TABLE IF NOT EXISTS prompt_templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL,
  builtin     INTEGER NOT NULL DEFAULT 0,
  sort_order  REAL NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pt_sort ON prompt_templates(sort_order);

CREATE TABLE IF NOT EXISTS wiki_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    INTEGER NOT NULL,
  completed_at  INTEGER,
  todo_count    INTEGER NOT NULL DEFAULT 0,
  dry_run       INTEGER NOT NULL DEFAULT 0,
  exit_code     INTEGER,
  error         TEXT,
  note          TEXT
);
CREATE INDEX IF NOT EXISTS idx_wiki_runs_started ON wiki_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS wiki_todo_coverage (
  wiki_run_id   INTEGER NOT NULL,
  todo_id       TEXT NOT NULL,
  source_path   TEXT,
  llm_applied   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (wiki_run_id, todo_id)
);
CREATE INDEX IF NOT EXISTS idx_wiki_cov_todo ON wiki_todo_coverage(todo_id, llm_applied);

CREATE TABLE IF NOT EXISTS pipeline_templates (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  roles_json      TEXT NOT NULL,
  edges_json      TEXT NOT NULL,
  max_iterations  INTEGER NOT NULL DEFAULT 3,
  is_builtin      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id              TEXT PRIMARY KEY,
  todo_id         TEXT NOT NULL,
  template_id     TEXT NOT NULL,
  status          TEXT NOT NULL,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  iteration_count INTEGER NOT NULL DEFAULT 0,
  base_branch     TEXT,
  base_sha        TEXT,
  agents_json     TEXT NOT NULL DEFAULT '[]',
  messages_json   TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_todo ON pipeline_runs(todo_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs(status);
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
    parentId: row.parent_id ?? null,
    title: row.title,
    description: row.description,
    quadrant: row.quadrant,
    status: row.status,
    dueDate: row.due_date,
    workDir: row.work_dir ?? null,
    brainstorm: !!row.brainstorm,
    appliedTemplateIds: row.applied_template_ids ? (() => { try { return JSON.parse(row.applied_template_ids) } catch { return [] } })() : [],
    sortOrder: row.sort_order,
    aiSession: currentAiSession(aiSessions),
    aiSessions,
    recurringRuleId: row.recurring_rule_id ?? null,
    instanceDate: row.instance_date ?? null,
    completedAt: row.completed_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function todayStr(now = Date.now()) {
  const d = new Date(now)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function endOfDayMs(now = Date.now()) {
  const d = new Date(now)
  d.setHours(23, 59, 59, 999)
  return d.getTime()
}

function parseJsonArray(value) {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : null
  } catch { return null }
}

function rowToRule(row) {
  if (!row) return null
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    quadrant: row.quadrant,
    workDir: row.work_dir ?? null,
    brainstorm: !!row.brainstorm,
    appliedTemplateIds: parseJsonArray(row.applied_template_ids) || [],
    subtodos: parseJsonArray(row.subtodos) || [],
    frequency: row.frequency,
    weekdays: parseJsonArray(row.weekdays) || [],
    monthDays: parseJsonArray(row.month_days) || [],
    active: !!row.active,
    lastGeneratedDate: row.last_generated_date ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function ruleShouldProduceOn(rule, dateStr) {
  const d = new Date(`${dateStr}T12:00:00`)
  if (rule.frequency === 'daily') return true
  if (rule.frequency === 'weekly') {
    const wd = d.getDay()
    return (rule.weekdays || []).includes(wd)
  }
  if (rule.frequency === 'monthly') {
    const dom = d.getDate()
    return (rule.monthDays || []).includes(dom)
  }
  return false
}

export function openDb(file = ':memory:') {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)

  let ftsAvailable = false
  try {
    const existing = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='transcript_fts'`).get()
    const usesTrigram = existing && /tokenize\s*=\s*['"]?trigram/i.test(existing.sql || '')
    if (existing && !usesTrigram) {
      db.exec(`DROP TABLE transcript_fts`)
      // 旧 tokenizer 下的 FTS 已清空；把 transcript_files.size 置 -1 让下一次 scan 视为脏，触发重建
      try { db.exec(`UPDATE transcript_files SET size = -1`) } catch {}
    }
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
        content,
        role UNINDEXED,
        file_id UNINDEXED,
        tokenize = "trigram"
      );
    `)
    ftsAvailable = true
  } catch (e) {
    ftsAvailable = false
  }

  const columns = db.prepare(`PRAGMA table_info(todos)`).all()
  if (!columns.some(col => col.name === 'parent_id')) {
    db.exec(`ALTER TABLE todos ADD COLUMN parent_id TEXT`)
  }
  if (!columns.some(col => col.name === 'work_dir')) {
    db.exec(`ALTER TABLE todos ADD COLUMN work_dir TEXT`)
  }
  if (!columns.some(col => col.name === 'brainstorm')) {
    db.exec(`ALTER TABLE todos ADD COLUMN brainstorm INTEGER NOT NULL DEFAULT 0`)
  }
  if (!columns.some(col => col.name === 'applied_template_ids')) {
    db.exec(`ALTER TABLE todos ADD COLUMN applied_template_ids TEXT`)
  }
  if (!columns.some(col => col.name === 'recurring_rule_id')) {
    db.exec(`ALTER TABLE todos ADD COLUMN recurring_rule_id TEXT`)
  }
  if (!columns.some(col => col.name === 'instance_date')) {
    db.exec(`ALTER TABLE todos ADD COLUMN instance_date TEXT`)
  }
  if (!columns.some(col => col.name === 'completed_at')) {
    db.exec(`ALTER TABLE todos ADD COLUMN completed_at INTEGER`)
    // 一次性回填：已完成的旧行用 updated_at 作为近似完成时间
    db.exec(`UPDATE todos SET completed_at = updated_at WHERE status = 'done' AND completed_at IS NULL`)
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_todos_recurring ON todos(recurring_rule_id, instance_date)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_todos_parent_sort ON todos(parent_id, sort_order)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_todos_quad_parent_sort ON todos(quadrant, parent_id, sort_order)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_todos_completed_at ON todos(completed_at)`)

  const tfCols = db.prepare(`PRAGMA table_info(transcript_files)`).all().map(c => c.name)
  for (const [name, type] of [
    ['input_tokens', 'INTEGER'],
    ['output_tokens', 'INTEGER'],
    ['cache_read_tokens', 'INTEGER'],
    ['cache_creation_tokens', 'INTEGER'],
    ['primary_model', 'TEXT'],
    ['active_ms', 'INTEGER'],
  ]) {
    if (!tfCols.includes(name)) db.exec(`ALTER TABLE transcript_files ADD COLUMN ${name} ${type}`)
  }

  const stmts = {
    insert: db.prepare(`
      INSERT INTO todos (id, parent_id, title, description, quadrant, status, due_date, work_dir, brainstorm, applied_template_ids, sort_order, ai_session, recurring_rule_id, instance_date, completed_at, created_at, updated_at)
      VALUES (@id, @parent_id, @title, @description, @quadrant, @status, @due_date, @work_dir, @brainstorm, @applied_template_ids, @sort_order, @ai_session, @recurring_rule_id, @instance_date, @completed_at, @created_at, @updated_at)
    `),
    getById: db.prepare(`SELECT * FROM todos WHERE id = ?`),
    listChildrenByParent: db.prepare(`SELECT id FROM todos WHERE parent_id = ? ORDER BY sort_order ASC, created_at ASC`),
    maxSortInQuadrant: db.prepare(`SELECT MAX(sort_order) AS m FROM todos WHERE quadrant = ? AND parent_id IS NULL`),
    maxSortInParent: db.prepare(`SELECT MAX(sort_order) AS m FROM todos WHERE parent_id = ?`),
    deleteById: db.prepare(`DELETE FROM todos WHERE id = ?`),
  }

  function nextSortOrder(quadrant, parentId = null) {
    const row = parentId
      ? stmts.maxSortInParent.get(parentId)
      : stmts.maxSortInQuadrant.get(quadrant)
    const m = row?.m
    return (m == null ? 0 : m) + 1024
  }

  function resolveParent(parentId) {
    if (parentId == null) return null
    const parent = rowToTodo(stmts.getById.get(parentId))
    if (!parent) throw new Error('parent_not_found')
    if (parent.parentId) throw new Error('nested_subtodo_not_allowed')
    return parent
  }

  function createTodo(data) {
    const now = Date.now()
    const parent = resolveParent(data.parentId ?? null)
    const quadrant = parent ? parent.quadrant : (Number(data.quadrant) || 4)
    const status = data.status || 'todo'
    const row = {
      id: randomUUID(),
      parent_id: parent?.id ?? null,
      title: data.title,
      description: data.description || '',
      quadrant,
      status,
      due_date: data.dueDate ?? null,
      work_dir: data.workDir ?? null,
      brainstorm: data.brainstorm ? 1 : 0,
      applied_template_ids: Array.isArray(data.appliedTemplateIds) ? JSON.stringify(data.appliedTemplateIds) : null,
      sort_order: data.sortOrder != null ? data.sortOrder : nextSortOrder(quadrant, parent?.id ?? null),
      ai_session: JSON.stringify(normalizeAiSessions(data.aiSessions ?? data.aiSession)),
      recurring_rule_id: data.recurringRuleId ?? null,
      instance_date: data.instanceDate ?? null,
      completed_at: status === 'done' ? now : null,
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
    const existing = rowToTodo(stmts.getById.get(id))
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

    let nextParentId = existing.parentId
    if (patch.parentId !== undefined) {
      nextParentId = patch.parentId
    }
    const parent = resolveParent(nextParentId)
    if (parent && parent.id === id) throw new Error('parent_cycle')
    const nextQuadrant = parent ? parent.quadrant : (patch.quadrant !== undefined ? Number(patch.quadrant) || 4 : existing.quadrant)
    if (parent && patch.quadrant !== undefined && parent.quadrant !== nextQuadrant) {
      throw new Error('parent_quadrant_mismatch')
    }

    for (const [k, col] of Object.entries(map)) {
      if (patch[k] !== undefined) {
        fields.push(`${col} = @${col}`)
        bind[col] = k === 'brainstorm' ? (patch[k] ? 1 : 0) : patch[k]
      }
    }
    if (parent && patch.quadrant === undefined && existing.quadrant !== parent.quadrant) {
      fields.push(`quadrant = @quadrant`)
      bind.quadrant = parent.quadrant
    }
    if (patch.parentId !== undefined) {
      fields.push(`parent_id = @parent_id`)
      bind.parent_id = parent?.id ?? null
    }
    if (patch.appliedTemplateIds !== undefined) {
      fields.push(`applied_template_ids = @applied_template_ids`)
      bind.applied_template_ids = Array.isArray(patch.appliedTemplateIds) ? JSON.stringify(patch.appliedTemplateIds) : null
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
    const now = Date.now()
    if (patch.status !== undefined && patch.status !== existing.status) {
      if (patch.status === 'done') {
        fields.push(`completed_at = @completed_at`)
        bind.completed_at = now
      } else if (existing.status === 'done') {
        fields.push(`completed_at = @completed_at`)
        bind.completed_at = null
      }
    }
    if (!fields.length) return existing
    fields.push(`updated_at = @updated_at`)
    bind.updated_at = now
    const sql = `UPDATE todos SET ${fields.join(', ')} WHERE id = @id`
    db.prepare(sql).run(bind)
    if (!existing.parentId && nextQuadrant !== existing.quadrant) {
      db.prepare(`UPDATE todos SET quadrant = ?, updated_at = ? WHERE parent_id = ?`).run(nextQuadrant, now, id)
    }
    return rowToTodo(stmts.getById.get(id))
  }

  function deleteTodo(id) {
    const children = stmts.listChildrenByParent.all(id)
    for (const child of children) {
      deleteTodo(child.id)
    }
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
    } else {
      where.push(`status != 'missed'`)
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const rows = db.prepare(`
      SELECT * FROM todos
      ${whereSql}
      ORDER BY quadrant ASC, COALESCE(parent_id, id) ASC, CASE WHEN parent_id IS NULL THEN 0 ELSE 1 END ASC, sort_order ASC, created_at ASC
    `).all(...params)
    const todos = rows.map(rowToTodo)
    if (!keyword) return todos

    const needle = keyword.toLowerCase()
    const byId = new Map(todos.map(todo => [todo.id, todo]))
    const matched = todos.filter(todo => todo.title.toLowerCase().includes(needle))
    const includeIds = new Set(matched.map(todo => todo.id))
    for (const todo of matched) {
      if (todo.parentId) {
        includeIds.add(todo.parentId)
      } else {
        for (const child of todos) {
          if (child.parentId === todo.id) includeIds.add(child.id)
        }
      }
    }
    return todos.filter(todo => includeIds.has(todo.id) || (todo.parentId && includeIds.has(todo.parentId)))
  }

  function listCompletedTodos({ since, until }) {
    const rows = db.prepare(`
      SELECT * FROM todos
      WHERE status = 'done'
        AND completed_at IS NOT NULL
        AND completed_at >= ?
        AND completed_at < ?
      ORDER BY completed_at DESC
    `).all(Number(since), Number(until))
    return rows.map(rowToTodo)
  }

  function countMissedInRange({ since, until }) {
    // 循环任务过期：status='missed'，在 sweepRecurring 里用 updated_at 标记时间
    const row = db.prepare(`
      SELECT COUNT(*) AS n FROM todos
      WHERE status = 'missed'
        AND updated_at >= ?
        AND updated_at < ?
    `).get(Number(since), Number(until))
    return row?.n || 0
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
    listInWindow: db.prepare(`
      SELECT id, todo_id, tool, started_at, completed_at, duration_ms
      FROM ai_session_log
      WHERE tool = ? AND started_at BETWEEN ? AND ?
    `),
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

  const tfStmts = {
    getByPath: db.prepare(`SELECT * FROM transcript_files WHERE jsonl_path = ?`),
    listAllPaths: db.prepare(`SELECT id, jsonl_path, size, mtime FROM transcript_files`),
    upsert: db.prepare(`
      INSERT INTO transcript_files (tool, native_id, cwd, jsonl_path, size, mtime, started_at, ended_at, first_user_prompt, turn_count, bound_todo_id, indexed_at, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, primary_model, active_ms)
      VALUES (@tool, @native_id, @cwd, @jsonl_path, @size, @mtime, @started_at, @ended_at, @first_user_prompt, @turn_count, @bound_todo_id, @indexed_at, @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens, @primary_model, @active_ms)
      ON CONFLICT(jsonl_path) DO UPDATE SET
        tool=excluded.tool,
        native_id=excluded.native_id,
        cwd=excluded.cwd,
        size=excluded.size,
        mtime=excluded.mtime,
        started_at=excluded.started_at,
        ended_at=excluded.ended_at,
        first_user_prompt=excluded.first_user_prompt,
        turn_count=excluded.turn_count,
        indexed_at=excluded.indexed_at,
        input_tokens=excluded.input_tokens,
        output_tokens=excluded.output_tokens,
        cache_read_tokens=excluded.cache_read_tokens,
        cache_creation_tokens=excluded.cache_creation_tokens,
        primary_model=excluded.primary_model,
        active_ms=excluded.active_ms
    `),
    deleteByPath: db.prepare(`DELETE FROM transcript_files WHERE jsonl_path = ?`),
    getById: db.prepare(`SELECT * FROM transcript_files WHERE id = ?`),
    setBound: db.prepare(`UPDATE transcript_files SET bound_todo_id = ? WHERE id = ?`),
    findByNative: db.prepare(`SELECT * FROM transcript_files WHERE native_id = ? AND tool = ?`),
    countUnbound: db.prepare(`SELECT COUNT(*) AS n FROM transcript_files WHERE bound_todo_id IS NULL`),
    listUnboundForMatching: db.prepare(`SELECT * FROM transcript_files WHERE bound_todo_id IS NULL`),
  }
  const ftsStmts = ftsAvailable ? {
    deleteByFile: db.prepare(`DELETE FROM transcript_fts WHERE file_id = ?`),
    insert: db.prepare(`INSERT INTO transcript_fts (content, role, file_id) VALUES (?, ?, ?)`),
  } : null

  function upsertTranscriptFile(row) {
    tfStmts.upsert.run({
      tool: row.tool,
      native_id: row.nativeId ?? null,
      cwd: row.cwd ?? null,
      jsonl_path: row.jsonlPath,
      size: row.size,
      mtime: row.mtime,
      started_at: row.startedAt ?? null,
      ended_at: row.endedAt ?? null,
      first_user_prompt: row.firstUserPrompt ?? null,
      turn_count: row.turnCount ?? 0,
      bound_todo_id: row.boundTodoId ?? null,
      indexed_at: Date.now(),
      input_tokens: row.inputTokens ?? null,
      output_tokens: row.outputTokens ?? null,
      cache_read_tokens: row.cacheReadTokens ?? null,
      cache_creation_tokens: row.cacheCreationTokens ?? null,
      primary_model: row.primaryModel ?? null,
      active_ms: row.activeMs ?? null,
    })
    return tfStmts.getByPath.get(row.jsonlPath)
  }

  function deleteTranscriptFile(jsonlPath) {
    const existing = tfStmts.getByPath.get(jsonlPath)
    if (!existing) return
    if (ftsStmts) ftsStmts.deleteByFile.run(existing.id)
    tfStmts.deleteByPath.run(jsonlPath)
  }

  function writeFtsTurns(fileId, turns) {
    if (!ftsStmts) return
    const tx = db.transaction(() => {
      ftsStmts.deleteByFile.run(fileId)
      for (const t of turns) {
        if (!t?.content) continue
        ftsStmts.insert.run(String(t.content), String(t.role || ''), fileId)
      }
    })
    tx()
  }

  function searchTranscripts({ q, tool, cwd, since, unboundOnly, limit = 50, offset = 0 } = {}) {
    const where = []
    const params = []
    if (tool) { where.push('tf.tool = ?'); params.push(tool) }
    if (cwd) { where.push('tf.cwd = ?'); params.push(cwd) }
    if (since) { where.push('tf.started_at >= ?'); params.push(since) }
    if (unboundOnly) where.push('tf.bound_todo_id IS NULL')

    if (q && ftsAvailable) {
      // trigram tokenizer 要求 ≥3 字才能走 MATCH；<3 字用 LIKE 兜底扫 FTS 的 content 列
      if (q.length < 3) {
        const like = `%${q.replace(/[\\%_]/g, s => '\\' + s)}%`
        where.push(`tf.id IN (SELECT file_id FROM transcript_fts WHERE content LIKE ? ESCAPE '\\')`)
        params.push(like)
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
        const total = db.prepare(`SELECT COUNT(*) AS n FROM transcript_files tf ${whereSql}`).get(...params).n
        const rows = db.prepare(`
          SELECT tf.*, (
            SELECT SUBSTR(content, MAX(1, INSTR(content, ?) - 16), 64)
            FROM transcript_fts WHERE file_id = tf.id AND content LIKE ? ESCAPE '\\' LIMIT 1
          ) AS snippet
          FROM transcript_files tf
          ${whereSql}
          ORDER BY tf.started_at DESC
          LIMIT ? OFFSET ?
        `).all(q, like, ...params, limit, offset)
        return { total, items: rows }
      }
      const ftsQuery = q.replace(/"/g, '""')
      where.push('tf.id IN (SELECT file_id FROM transcript_fts WHERE transcript_fts MATCH ?)')
      params.push(`"${ftsQuery}"`)
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
      const total = db.prepare(`SELECT COUNT(*) AS n FROM transcript_files tf ${whereSql}`).get(...params).n
      const rows = db.prepare(`
        SELECT tf.*, (
          SELECT snippet(transcript_fts, 0, '<mark>', '</mark>', '…', 16)
          FROM transcript_fts WHERE file_id = tf.id AND transcript_fts MATCH ? LIMIT 1
        ) AS snippet
        FROM transcript_files tf
        ${whereSql}
        ORDER BY tf.started_at DESC NULLS LAST
        LIMIT ? OFFSET ?
      `).all(`"${ftsQuery}"`, ...params, limit, offset)
      return { total, items: rows }
    }

    if (q && !ftsAvailable) {
      where.push('LOWER(tf.first_user_prompt) LIKE ?')
      params.push(`%${q.toLowerCase()}%`)
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = db.prepare(`SELECT COUNT(*) AS n FROM transcript_files tf ${whereSql}`).get(...params).n
    const rows = db.prepare(`
      SELECT tf.*, NULL AS snippet
      FROM transcript_files tf
      ${whereSql}
      ORDER BY tf.started_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset)
    return { total, items: rows }
  }

  const ptStmts = {
    list: db.prepare(`SELECT * FROM prompt_templates ORDER BY builtin DESC, sort_order ASC, created_at ASC`),
    get: db.prepare(`SELECT * FROM prompt_templates WHERE id = ?`),
    insert: db.prepare(`INSERT INTO prompt_templates (id, name, description, content, builtin, sort_order, created_at, updated_at) VALUES (@id, @name, @description, @content, @builtin, @sort_order, @created_at, @updated_at)`),
    update: db.prepare(`UPDATE prompt_templates SET name = @name, description = @description, content = @content, sort_order = @sort_order, updated_at = @updated_at WHERE id = @id`),
    delete: db.prepare(`DELETE FROM prompt_templates WHERE id = ?`),
    countAll: db.prepare(`SELECT COUNT(*) AS n FROM prompt_templates`),
  }

  function rowToTemplate(r) {
    if (!r) return null
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      content: r.content,
      builtin: !!r.builtin,
      sortOrder: r.sort_order,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }
  }

  function listTemplates() { return ptStmts.list.all().map(rowToTemplate) }
  function getTemplate(id) { return rowToTemplate(ptStmts.get.get(id)) }
  function createTemplate(data) {
    const now = Date.now()
    const row = {
      id: randomUUID(),
      name: data.name || '未命名模板',
      description: data.description || '',
      content: data.content || '',
      builtin: data.builtin ? 1 : 0,
      sort_order: Number.isFinite(data.sortOrder) ? data.sortOrder : now,
      created_at: now,
      updated_at: now,
    }
    ptStmts.insert.run(row)
    return rowToTemplate(ptStmts.get.get(row.id))
  }
  function updateTemplate(id, patch) {
    const existing = ptStmts.get.get(id)
    if (!existing) return null
    if (existing.builtin) {
      throw new Error('builtin_template_readonly')
    }
    ptStmts.update.run({
      id,
      name: patch.name ?? existing.name,
      description: patch.description ?? existing.description,
      content: patch.content ?? existing.content,
      sort_order: Number.isFinite(patch.sortOrder) ? patch.sortOrder : existing.sort_order,
      updated_at: Date.now(),
    })
    return rowToTemplate(ptStmts.get.get(id))
  }
  function deleteTemplate(id) {
    const existing = ptStmts.get.get(id)
    if (!existing) return
    if (existing.builtin) throw new Error('builtin_template_readonly')
    ptStmts.delete.run(id)
  }

  function seedBuiltinTemplatesIfEmpty() {
    if (ptStmts.countAll.get().n > 0) return
    const now = Date.now()
    const seeds = [
      {
        name: 'Brainstorm（脑爆）',
        description: '先脑爆方向，不急着动手',
        content: '请先不要直接动手实现。先针对下面的任务 brainstorm：\n- 列出 2-3 种可选方案，说明优缺点\n- 指出风险点与需要用户拍板的关键决策\n- 明确验收标准\n\n在我确认方案后再进入实现。',
      },
      {
        name: 'Bug 修复',
        description: '复现 → 定位 → 最小用例 → 修复 → 回归',
        content: '按 bug 修复流程处理下面的问题：\n1. 先复现（给出复现步骤和实际 vs 预期）\n2. 定位根因（不要过早修改代码）\n3. 写一个能复现该 bug 的最小用例（如果有测试框架）\n4. 修复根因，不是修现象\n5. 回归：跑相关测试；考虑同类 bug 是否还存在',
      },
      {
        name: '重构',
        description: '先读懂 → 列出影响面 → 小步重构',
        content: '按照小步重构原则处理下面的任务：\n1. 先通读相关代码，复述你的理解\n2. 列出此次重构的影响面（调用方 / 测试 / 类型）\n3. 每一步只改一件事，保持可运行\n4. 每步后跑一次测试（如果有）\n5. 不要顺手加功能、不要引入新抽象，除非当前任务要求',
      },
      {
        name: '写测试',
        description: 'TDD：红 → 绿 → 重构',
        content: '用 TDD 的方式处理下面的任务：\n1. 先列出测试矩阵（输入 × 场景）\n2. 先写一个最简失败用例（红）\n3. 用最小改动让它通过（绿）\n4. 重构（保持绿）\n5. 重复 2-4 直到覆盖矩阵\n不 mock 真实依赖（除非跨网络/支付等）。',
      },
      {
        name: '代码评审',
        description: '只评审，不改代码',
        content: '请只做代码评审，不要修改代码。按下面的维度给出具体反馈：\n- 可读性：命名、结构、注释\n- 正确性：边界、错误处理、并发\n- 安全性：注入、鉴权、敏感数据\n- 性能：明显的 N+1 / 无谓复制\n- 简洁性：是否有过度设计 / 可删除的冗余\n每条反馈给出文件:行号 + 建议。',
      },
    ]
    seeds.forEach((s, i) => {
      ptStmts.insert.run({
        id: randomUUID(),
        name: s.name,
        description: s.description,
        content: s.content,
        builtin: 1,
        sort_order: i,
        created_at: now,
        updated_at: now,
      })
    })
  }
  seedBuiltinTemplatesIfEmpty()

  const wikiStmts = {
    insertRun: db.prepare(`
      INSERT INTO wiki_runs (started_at, todo_count, dry_run)
      VALUES (?, ?, ?)
    `),
    completeRun: db.prepare(`
      UPDATE wiki_runs SET completed_at = ?, exit_code = ?, note = ?
      WHERE id = ?
    `),
    failRun: db.prepare(`
      UPDATE wiki_runs SET completed_at = ?, exit_code = ?, error = ?
      WHERE id = ?
    `),
    listRuns: db.prepare(`
      SELECT * FROM wiki_runs ORDER BY started_at DESC LIMIT ?
    `),
    orphanRuns: db.prepare(`
      SELECT * FROM wiki_runs WHERE completed_at IS NULL
    `),
    upsertCoverage: db.prepare(`
      INSERT INTO wiki_todo_coverage (wiki_run_id, todo_id, source_path, llm_applied)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(wiki_run_id, todo_id) DO UPDATE SET
        source_path = excluded.source_path,
        llm_applied = excluded.llm_applied
    `),
    markApplied: db.prepare(`
      UPDATE wiki_todo_coverage SET llm_applied = 1 WHERE wiki_run_id = ?
    `),
    coverageForTodo: db.prepare(`
      SELECT * FROM wiki_todo_coverage WHERE todo_id = ? ORDER BY wiki_run_id DESC
    `),
    unappliedDoneTodos: db.prepare(`
      SELECT t.* FROM todos t
      WHERE t.status = 'done'
        AND NOT EXISTS (
          SELECT 1 FROM wiki_todo_coverage c
          WHERE c.todo_id = t.id AND c.llm_applied = 1
        )
      ORDER BY t.updated_at DESC
    `),
  }

  function createWikiRun({ todoCount = 0, dryRun = 0 } = {}) {
    const now = Date.now()
    const info = wikiStmts.insertRun.run(now, Number(todoCount) || 0, dryRun ? 1 : 0)
    return { id: info.lastInsertRowid, started_at: now, completed_at: null }
  }
  function completeWikiRun(id, { exitCode = 0, note = '' } = {}) {
    wikiStmts.completeRun.run(Date.now(), exitCode, note || '', id)
  }
  function failWikiRun(id, errorMsg) {
    wikiStmts.failRun.run(Date.now(), -1, String(errorMsg || 'unknown'), id)
  }
  function listWikiRuns({ limit = 20 } = {}) {
    return wikiStmts.listRuns.all(Math.max(1, Math.min(200, limit)))
  }
  function findOrphanWikiRuns() {
    return wikiStmts.orphanRuns.all()
  }
  function upsertWikiCoverage(runId, todoId, sourcePath, llmApplied) {
    wikiStmts.upsertCoverage.run(runId, todoId, sourcePath || null, llmApplied ? 1 : 0)
  }
  function markCoverageApplied(runId) {
    wikiStmts.markApplied.run(runId)
  }
  function listCoverageForTodo(todoId) {
    return wikiStmts.coverageForTodo.all(todoId)
  }
  function listUnappliedDoneTodos() {
    return wikiStmts.unappliedDoneTodos.all().map(rowToTodo)
  }

  const ruleStmts = {
    insert: db.prepare(`
      INSERT INTO recurring_rules
        (id, title, description, quadrant, work_dir, brainstorm, applied_template_ids, subtodos, frequency, weekdays, month_days, active, last_generated_date, created_at, updated_at)
      VALUES
        (@id, @title, @description, @quadrant, @work_dir, @brainstorm, @applied_template_ids, @subtodos, @frequency, @weekdays, @month_days, @active, @last_generated_date, @created_at, @updated_at)
    `),
    get: db.prepare(`SELECT * FROM recurring_rules WHERE id = ?`),
    list: db.prepare(`SELECT * FROM recurring_rules ORDER BY created_at DESC`),
    listActive: db.prepare(`SELECT * FROM recurring_rules WHERE active = 1`),
    update: db.prepare(`
      UPDATE recurring_rules SET
        title = @title,
        description = @description,
        quadrant = @quadrant,
        work_dir = @work_dir,
        brainstorm = @brainstorm,
        applied_template_ids = @applied_template_ids,
        subtodos = @subtodos,
        frequency = @frequency,
        weekdays = @weekdays,
        month_days = @month_days,
        updated_at = @updated_at
      WHERE id = @id
    `),
    setActive: db.prepare(`UPDATE recurring_rules SET active = ?, updated_at = ? WHERE id = ?`),
    setLastGenerated: db.prepare(`UPDATE recurring_rules SET last_generated_date = ?, updated_at = ? WHERE id = ?`),
    delete: db.prepare(`DELETE FROM recurring_rules WHERE id = ?`),
    unlinkInstances: db.prepare(`UPDATE todos SET recurring_rule_id = NULL WHERE recurring_rule_id = ?`),
  }

  function normalizeRuleInput(data) {
    const frequency = data.frequency
    if (!['daily', 'weekly', 'monthly'].includes(frequency)) {
      throw new Error('invalid_frequency')
    }
    let weekdays = null
    let monthDays = null
    if (frequency === 'weekly') {
      const arr = Array.isArray(data.weekdays) ? data.weekdays.filter(n => Number.isInteger(n) && n >= 0 && n <= 6) : []
      if (!arr.length) throw new Error('weekdays_required')
      weekdays = [...new Set(arr)].sort((a, b) => a - b)
    }
    if (frequency === 'monthly') {
      const arr = Array.isArray(data.monthDays) ? data.monthDays.filter(n => Number.isInteger(n) && n >= 1 && n <= 31) : []
      if (!arr.length) throw new Error('month_days_required')
      monthDays = [...new Set(arr)].sort((a, b) => a - b)
    }
    const q = Number(data.quadrant)
    if (![1, 2, 3, 4].includes(q)) throw new Error('invalid_quadrant')
    return { frequency, weekdays, monthDays, quadrant: q }
  }

  function instantiateRule(rule, now) {
    const today = todayStr(now)
    const due = endOfDayMs(now)
    const parent = createTodo({
      title: rule.title,
      description: rule.description,
      quadrant: rule.quadrant,
      status: 'todo',
      dueDate: due,
      workDir: rule.workDir ?? null,
      brainstorm: !!rule.brainstorm,
      appliedTemplateIds: rule.appliedTemplateIds || [],
      recurringRuleId: rule.id,
      instanceDate: today,
    })
    for (const st of (rule.subtodos || [])) {
      if (!st || !st.title) continue
      createTodo({
        title: st.title,
        description: st.description || '',
        status: 'todo',
        dueDate: due,
        parentId: parent.id,
        recurringRuleId: rule.id,
        instanceDate: today,
      })
    }
    return parent
  }

  function createRecurringRule(data) {
    const { frequency, weekdays, monthDays, quadrant } = normalizeRuleInput(data)
    if (!data.title || typeof data.title !== 'string') throw new Error('title_required')
    const now = Date.now()
    const today = todayStr(now)
    const rule = {
      id: randomUUID(),
      title: data.title.trim(),
      description: data.description || '',
      quadrant,
      work_dir: data.workDir || null,
      brainstorm: data.brainstorm ? 1 : 0,
      applied_template_ids: JSON.stringify(Array.isArray(data.appliedTemplateIds) ? data.appliedTemplateIds : []),
      subtodos: JSON.stringify(Array.isArray(data.subtodos) ? data.subtodos.map(s => ({
        title: String(s.title || '').trim(),
        description: String(s.description || ''),
      })).filter(s => s.title) : []),
      frequency,
      weekdays: weekdays ? JSON.stringify(weekdays) : null,
      month_days: monthDays ? JSON.stringify(monthDays) : null,
      active: 1,
      last_generated_date: today,
      created_at: now,
      updated_at: now,
    }
    ruleStmts.insert.run(rule)
    const ruleObj = rowToRule(ruleStmts.get.get(rule.id))
    let firstInstance = null
    if (ruleShouldProduceOn(ruleObj, today)) {
      firstInstance = instantiateRule(ruleObj, now)
    }
    return { rule: ruleObj, firstInstance }
  }

  function updateRecurringRule(id, patch) {
    const existing = rowToRule(ruleStmts.get.get(id))
    if (!existing) return null
    const merged = {
      title: patch.title ?? existing.title,
      description: patch.description ?? existing.description,
      quadrant: patch.quadrant ?? existing.quadrant,
      workDir: patch.workDir !== undefined ? patch.workDir : existing.workDir,
      brainstorm: patch.brainstorm !== undefined ? !!patch.brainstorm : existing.brainstorm,
      appliedTemplateIds: patch.appliedTemplateIds !== undefined ? patch.appliedTemplateIds : existing.appliedTemplateIds,
      subtodos: patch.subtodos !== undefined ? patch.subtodos : existing.subtodos,
      frequency: patch.frequency ?? existing.frequency,
      weekdays: patch.frequency === 'weekly' || (patch.frequency === undefined && existing.frequency === 'weekly')
        ? (patch.weekdays ?? existing.weekdays)
        : undefined,
      monthDays: patch.frequency === 'monthly' || (patch.frequency === undefined && existing.frequency === 'monthly')
        ? (patch.monthDays ?? existing.monthDays)
        : undefined,
    }
    const { frequency, weekdays, monthDays, quadrant } = normalizeRuleInput(merged)
    ruleStmts.update.run({
      id,
      title: merged.title,
      description: merged.description,
      quadrant,
      work_dir: merged.workDir || null,
      brainstorm: merged.brainstorm ? 1 : 0,
      applied_template_ids: JSON.stringify(Array.isArray(merged.appliedTemplateIds) ? merged.appliedTemplateIds : []),
      subtodos: JSON.stringify(Array.isArray(merged.subtodos) ? merged.subtodos.map(s => ({
        title: String(s.title || '').trim(),
        description: String(s.description || ''),
      })).filter(s => s.title) : []),
      frequency,
      weekdays: weekdays ? JSON.stringify(weekdays) : null,
      month_days: monthDays ? JSON.stringify(monthDays) : null,
      updated_at: Date.now(),
    })
    return rowToRule(ruleStmts.get.get(id))
  }

  function getRecurringRule(id) {
    return rowToRule(ruleStmts.get.get(id))
  }

  function setRecurringRuleActive(id, active) {
    ruleStmts.setActive.run(active ? 1 : 0, Date.now(), id)
    return rowToRule(ruleStmts.get.get(id))
  }

  function deleteRecurringRule(id) {
    ruleStmts.unlinkInstances.run(id)
    ruleStmts.delete.run(id)
  }

  function sweepRecurring(now = Date.now()) {
    const today = todayStr(now)
    const startOfToday = new Date(now)
    startOfToday.setHours(0, 0, 0, 0)
    const startOfTodayMs = startOfToday.getTime()

    db.prepare(`
      UPDATE todos
      SET status = 'missed', updated_at = ?
      WHERE recurring_rule_id IS NOT NULL
        AND instance_date IS NOT NULL
        AND instance_date < ?
        AND status IN ('todo', 'ai_done')
    `).run(now, today)

    const rules = ruleStmts.listActive.all().map(rowToRule)
    const tx = db.transaction(() => {
      for (const rule of rules) {
        if (rule.lastGeneratedDate === today) continue
        if (ruleShouldProduceOn(rule, today)) {
          instantiateRule(rule, now)
        }
        ruleStmts.setLastGenerated.run(today, now, rule.id)
      }
    })
    tx()
    return { today, startOfTodayMs }
  }

  // ─── pipeline templates & runs ───
  const pipeTmplStmts = {
    list: db.prepare(`SELECT * FROM pipeline_templates ORDER BY is_builtin DESC, created_at ASC`),
    get: db.prepare(`SELECT * FROM pipeline_templates WHERE id = ?`),
    insert: db.prepare(`INSERT INTO pipeline_templates (id, name, description, roles_json, edges_json, max_iterations, is_builtin, created_at, updated_at) VALUES (@id, @name, @description, @roles_json, @edges_json, @max_iterations, @is_builtin, @created_at, @updated_at)`),
    update: db.prepare(`UPDATE pipeline_templates SET name = @name, description = @description, roles_json = @roles_json, edges_json = @edges_json, max_iterations = @max_iterations, updated_at = @updated_at WHERE id = @id`),
    delete: db.prepare(`DELETE FROM pipeline_templates WHERE id = ?`),
    countAll: db.prepare(`SELECT COUNT(*) AS n FROM pipeline_templates`),
  }
  function rowToPipeTemplate(r) {
    if (!r) return null
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      roles: safeParseJson(r.roles_json, []),
      edges: safeParseJson(r.edges_json, []),
      maxIterations: r.max_iterations,
      isBuiltin: !!r.is_builtin,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }
  }
  function safeParseJson(s, fallback) {
    try { return JSON.parse(s) } catch { return fallback }
  }
  function listPipelineTemplates() {
    return pipeTmplStmts.list.all().map(rowToPipeTemplate)
  }
  function getPipelineTemplate(id) {
    return rowToPipeTemplate(pipeTmplStmts.get.get(id))
  }
  function createPipelineTemplate(data) {
    const now = Date.now()
    const row = {
      id: data.id || randomUUID(),
      name: data.name || '未命名流水线',
      description: data.description || '',
      roles_json: JSON.stringify(data.roles || []),
      edges_json: JSON.stringify(data.edges || []),
      max_iterations: Number.isFinite(data.maxIterations) ? data.maxIterations : 3,
      is_builtin: data.isBuiltin ? 1 : 0,
      created_at: now,
      updated_at: now,
    }
    pipeTmplStmts.insert.run(row)
    return rowToPipeTemplate(pipeTmplStmts.get.get(row.id))
  }
  function updatePipelineTemplate(id, patch) {
    const existing = pipeTmplStmts.get.get(id)
    if (!existing) return null
    if (existing.is_builtin) throw new Error('builtin_pipeline_template_readonly')
    pipeTmplStmts.update.run({
      id,
      name: patch.name ?? existing.name,
      description: patch.description ?? existing.description,
      roles_json: patch.roles !== undefined ? JSON.stringify(patch.roles) : existing.roles_json,
      edges_json: patch.edges !== undefined ? JSON.stringify(patch.edges) : existing.edges_json,
      max_iterations: Number.isFinite(patch.maxIterations) ? patch.maxIterations : existing.max_iterations,
      updated_at: Date.now(),
    })
    return rowToPipeTemplate(pipeTmplStmts.get.get(id))
  }
  function deletePipelineTemplate(id) {
    const existing = pipeTmplStmts.get.get(id)
    if (!existing) return
    if (existing.is_builtin) throw new Error('builtin_pipeline_template_readonly')
    pipeTmplStmts.delete.run(id)
  }

  const pipeRunStmts = {
    list: db.prepare(`SELECT * FROM pipeline_runs WHERE todo_id = ? ORDER BY started_at DESC`),
    listRecent: db.prepare(`SELECT * FROM pipeline_runs ORDER BY started_at DESC LIMIT ?`),
    get: db.prepare(`SELECT * FROM pipeline_runs WHERE id = ?`),
    insert: db.prepare(`INSERT INTO pipeline_runs (id, todo_id, template_id, status, started_at, ended_at, iteration_count, base_branch, base_sha, agents_json, messages_json) VALUES (@id, @todo_id, @template_id, @status, @started_at, @ended_at, @iteration_count, @base_branch, @base_sha, @agents_json, @messages_json)`),
    update: db.prepare(`UPDATE pipeline_runs SET status = @status, ended_at = @ended_at, iteration_count = @iteration_count, agents_json = @agents_json, messages_json = @messages_json WHERE id = @id`),
    listActive: db.prepare(`SELECT * FROM pipeline_runs WHERE status = 'running' ORDER BY started_at ASC`),
    findActiveForTodo: db.prepare(`SELECT * FROM pipeline_runs WHERE todo_id = ? AND status = 'running' LIMIT 1`),
  }
  function rowToPipeRun(r) {
    if (!r) return null
    return {
      id: r.id,
      todoId: r.todo_id,
      templateId: r.template_id,
      status: r.status,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      iterationCount: r.iteration_count,
      baseBranch: r.base_branch,
      baseSha: r.base_sha,
      agents: safeParseJson(r.agents_json, []),
      messages: safeParseJson(r.messages_json, []),
    }
  }
  function createPipelineRun(data) {
    const row = {
      id: data.id || randomUUID(),
      todo_id: data.todoId,
      template_id: data.templateId,
      status: data.status || 'running',
      started_at: data.startedAt || Date.now(),
      ended_at: data.endedAt || null,
      iteration_count: data.iterationCount || 0,
      base_branch: data.baseBranch || null,
      base_sha: data.baseSha || null,
      agents_json: JSON.stringify(data.agents || []),
      messages_json: JSON.stringify(data.messages || []),
    }
    pipeRunStmts.insert.run(row)
    return rowToPipeRun(pipeRunStmts.get.get(row.id))
  }
  function updatePipelineRun(id, patch) {
    const existing = pipeRunStmts.get.get(id)
    if (!existing) return null
    pipeRunStmts.update.run({
      id,
      status: patch.status ?? existing.status,
      ended_at: patch.endedAt !== undefined ? patch.endedAt : existing.ended_at,
      iteration_count: Number.isFinite(patch.iterationCount) ? patch.iterationCount : existing.iteration_count,
      agents_json: patch.agents !== undefined ? JSON.stringify(patch.agents) : existing.agents_json,
      messages_json: patch.messages !== undefined ? JSON.stringify(patch.messages) : existing.messages_json,
    })
    return rowToPipeRun(pipeRunStmts.get.get(id))
  }
  function listPipelineRunsForTodo(todoId) {
    return pipeRunStmts.list.all(todoId).map(rowToPipeRun)
  }
  function getPipelineRun(id) {
    return rowToPipeRun(pipeRunStmts.get.get(id))
  }
  function listActivePipelineRuns() {
    return pipeRunStmts.listActive.all().map(rowToPipeRun)
  }
  function findActivePipelineRunForTodo(todoId) {
    return rowToPipeRun(pipeRunStmts.findActiveForTodo.get(todoId))
  }

  function seedBuiltinPipelineTemplatesIfEmpty() {
    if (pipeTmplStmts.countAll.get().n > 0) return
    const CODER_SYS = `你是「代码员」（coder），职责：根据需求编写代码。

重要约束：
- 你当前的工作目录是一个专属 git worktree，请**只在此目录内修改文件**，不要切换到其他目录
- 写代码时遵循项目既有风格、既有模式；不过度设计
- 每完成一轮修改，请**先用 git 提交你的变更**（\`git add && git commit\`）
- 完成后正常结束对话即可（不需要写任何 handoff 标签），后续会自动交给审阅员

若你需要主动提前提交给审阅员，可以写：
<handoff to="reviewer" summary="简短说明本轮做了什么" />

若你刚收到审阅员的驳回反馈（feedback 会注入在消息里），请根据反馈修改，然后照上面流程再提交一次。`

    const REVIEWER_SYS = `你是「审阅员」（reviewer），职责：审阅代码员的本轮修改，判断是否通过。

你当前 cwd 是代码员的 worktree，**只读**，不要修改任何文件。

流程：
1. 用 \`git diff HEAD~..HEAD\` 或 \`git log\` 查看本轮代码员的改动
2. 按以下维度审阅：
   - 需求完成度：是否完成用户最初的诉求
   - 正确性：边界、错误处理、并发
   - 可读性：命名、结构
   - 副作用：是否引入新的抽象、是否改了不该改的东西
3. 必须以**下面其中一个 handoff 标签**结尾：

通过（任务完结）：
<handoff to="__done__" verdict="approved" rationale="简短理由" />

驳回（打回给代码员修改）：
<handoff to="coder" verdict="rejected" feedback="具体的、可执行的修改建议，逐条列出" />

不要含糊 —— 要么通过，要么给出明确可改的反馈。`

    const builtin = {
      id: 'builtin-coder-reviewer-loop',
      name: 'Coder ↔ Reviewer 循环',
      description: '代码员实现 → 审阅员审阅，驳回则打回复用 coder session，通过则结束',
      roles: [
        { key: 'coder', name: '代码员', tool: 'claude', writeAccess: true, worktree: 'own', systemPrompt: CODER_SYS },
        { key: 'reviewer', name: '审阅员', tool: 'claude', writeAccess: false, worktree: 'attach_to_writer', systemPrompt: REVIEWER_SYS },
      ],
      edges: [
        { from: 'coder', event: 'done', to: 'reviewer' },
        { from: 'reviewer', event: 'handoff', verdict: 'approved', to: '__done__' },
        { from: 'reviewer', event: 'handoff', verdict: 'rejected', to: 'coder' },
      ],
      maxIterations: 3,
      isBuiltin: true,
    }
    createPipelineTemplate(builtin)
  }
  seedBuiltinPipelineTemplatesIfEmpty()

  return {
    raw: db,
    listTemplates,
    getTemplate,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    createTodo,
    getTodo,
    updateTodo,
    deleteTodo,
    listTodos,
    listCompletedTodos,
    countMissedInRange,
    nextSortOrder,
    addComment,
    listComments,
    deleteComment,
    getComment,
    insertSessionLog,
    querySessionStats,
    listSessionLogsInWindow: (tool, startedAt, windowMs) => {
      const lo = startedAt - windowMs
      const hi = startedAt + windowMs
      return aiLogStmts.listInWindow.all(tool, lo, hi)
    },
    ftsAvailable,
    transcriptFilesStmts: tfStmts,
    upsertTranscriptFile,
    deleteTranscriptFile,
    writeFtsTurns,
    searchTranscripts,
    getTranscriptFile: (id) => tfStmts.getById.get(id),
    listTranscriptFilesMeta: () => tfStmts.listAllPaths.all(),
    listUnboundTranscriptFiles: () => tfStmts.listUnboundForMatching.all(),
    findTranscriptByNative: (nativeId, tool) => tfStmts.findByNative.get(nativeId, tool),
    setTranscriptBound: (id, todoId) => tfStmts.setBound.run(todoId, id),
    countUnboundTranscripts: () => tfStmts.countUnbound.get().n,
    createRecurringRule,
    updateRecurringRule,
    getRecurringRule,
    setRecurringRuleActive,
    deleteRecurringRule,
    sweepRecurring,
    createWikiRun,
    completeWikiRun,
    failWikiRun,
    listWikiRuns,
    findOrphanWikiRuns,
    upsertWikiCoverage,
    markCoverageApplied,
    listCoverageForTodo,
    listUnappliedDoneTodos,
    // pipeline
    listPipelineTemplates,
    getPipelineTemplate,
    createPipelineTemplate,
    updatePipelineTemplate,
    deletePipelineTemplate,
    createPipelineRun,
    updatePipelineRun,
    listPipelineRunsForTodo,
    getPipelineRun,
    listActivePipelineRuns,
    findActivePipelineRunForTodo,
    close: () => db.close(),
  }
}
