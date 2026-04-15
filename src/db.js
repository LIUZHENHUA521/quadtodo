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
    appliedTemplateIds: row.applied_template_ids ? (() => { try { return JSON.parse(row.applied_template_ids) } catch { return [] } })() : [],
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

  let ftsAvailable = false
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
        content,
        role UNINDEXED,
        file_id UNINDEXED,
        tokenize = "unicode61 remove_diacritics 2"
      );
    `)
    ftsAvailable = true
  } catch (e) {
    ftsAvailable = false
  }

  const columns = db.prepare(`PRAGMA table_info(todos)`).all()
  if (!columns.some(col => col.name === 'work_dir')) {
    db.exec(`ALTER TABLE todos ADD COLUMN work_dir TEXT`)
  }
  if (!columns.some(col => col.name === 'brainstorm')) {
    db.exec(`ALTER TABLE todos ADD COLUMN brainstorm INTEGER NOT NULL DEFAULT 0`)
  }
  if (!columns.some(col => col.name === 'applied_template_ids')) {
    db.exec(`ALTER TABLE todos ADD COLUMN applied_template_ids TEXT`)
  }

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
      INSERT INTO todos (id, title, description, quadrant, status, due_date, work_dir, brainstorm, applied_template_ids, sort_order, ai_session, created_at, updated_at)
      VALUES (@id, @title, @description, @quadrant, @status, @due_date, @work_dir, @brainstorm, @applied_template_ids, @sort_order, @ai_session, @created_at, @updated_at)
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
      applied_template_ids: Array.isArray(data.appliedTemplateIds) ? JSON.stringify(data.appliedTemplateIds) : null,
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
    nextSortOrder,
    addComment,
    listComments,
    deleteComment,
    getComment,
    insertSessionLog,
    querySessionStats,
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
    close: () => db.close(),
  }
}
