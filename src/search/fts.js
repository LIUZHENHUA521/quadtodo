import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 为 todos / comments / ai_sessions / wiki 建 4 张 FTS5 虚拟表并装同步触发器。
 *
 * 设计：
 *   - todos.id / comments.id 是 TEXT UUID，FTS5 要求 INTEGER rowid，所以我们用
 *     **standalone FTS5**（不绑 content='<base>'），用 UNINDEXED 的 todo_id / comment_id
 *     字段把 UUID 存进去，触发器手动同步。
 *   - ai_sessions 存在 todos.ai_session JSON 列里，用 UPDATE trigger + JSON_EACH 把
 *     数组展开成多行 index。
 *   - wiki_fts 没有触发器：由应用层在 wiki run 结束 / 服务启动时用 rebuildWikiFts 刷新。
 *
 * 所有表/触发器都是 `IF NOT EXISTS`，重复调用安全。
 */
export function initFtsTables(dbHandle) {
  dbHandle.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS todos_fts USING fts5(
      todo_id UNINDEXED,
      title, description,
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS comments_fts USING fts5(
      comment_id UNINDEXED,
      todo_id    UNINDEXED,
      body,
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS ai_sessions_fts USING fts5(
      todo_id    UNINDEXED,
      session_id UNINDEXED,
      label, command, native_session_id,
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(
      todo_id UNINDEXED,
      body,
      tokenize='unicode61 remove_diacritics 2'
    );
  `)

  // ── todos_fts 触发器 ──
  dbHandle.exec(`
    CREATE TRIGGER IF NOT EXISTS todos_fts_ai AFTER INSERT ON todos BEGIN
      INSERT INTO todos_fts(todo_id, title, description)
      VALUES (new.id, COALESCE(new.title, ''), COALESCE(new.description, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS todos_fts_ad AFTER DELETE ON todos BEGIN
      DELETE FROM todos_fts WHERE todo_id = old.id;
      DELETE FROM ai_sessions_fts WHERE todo_id = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS todos_fts_au AFTER UPDATE OF title, description ON todos BEGIN
      DELETE FROM todos_fts WHERE todo_id = old.id;
      INSERT INTO todos_fts(todo_id, title, description)
      VALUES (new.id, COALESCE(new.title, ''), COALESCE(new.description, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS ai_sessions_fts_au AFTER UPDATE OF ai_session ON todos BEGIN
      DELETE FROM ai_sessions_fts WHERE todo_id = old.id;
      INSERT INTO ai_sessions_fts(todo_id, session_id, label, command, native_session_id)
      SELECT old.id,
             COALESCE(json_extract(value, '$.sessionId'), ''),
             COALESCE(json_extract(value, '$.label'), ''),
             COALESCE(json_extract(value, '$.command'), ''),
             COALESCE(json_extract(value, '$.nativeSessionId'), '')
      FROM json_each(COALESCE(new.ai_session, '[]'));
    END;

    CREATE TRIGGER IF NOT EXISTS ai_sessions_fts_ai AFTER INSERT ON todos BEGIN
      INSERT INTO ai_sessions_fts(todo_id, session_id, label, command, native_session_id)
      SELECT new.id,
             COALESCE(json_extract(value, '$.sessionId'), ''),
             COALESCE(json_extract(value, '$.label'), ''),
             COALESCE(json_extract(value, '$.command'), ''),
             COALESCE(json_extract(value, '$.nativeSessionId'), '')
      FROM json_each(COALESCE(new.ai_session, '[]'));
    END;
  `)

  // ── comments_fts 触发器 ──
  dbHandle.exec(`
    CREATE TRIGGER IF NOT EXISTS comments_fts_ai AFTER INSERT ON comments BEGIN
      INSERT INTO comments_fts(comment_id, todo_id, body)
      VALUES (new.id, new.todo_id, COALESCE(new.content, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS comments_fts_ad AFTER DELETE ON comments BEGIN
      DELETE FROM comments_fts WHERE comment_id = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS comments_fts_au AFTER UPDATE ON comments BEGIN
      DELETE FROM comments_fts WHERE comment_id = old.id;
      INSERT INTO comments_fts(comment_id, todo_id, body)
      VALUES (new.id, new.todo_id, COALESCE(new.content, ''));
    END;
  `)
}

/**
 * 全量重建 todos_fts / comments_fts / ai_sessions_fts。
 * 用于启动一致性自检或手动 reindex。
 */
export function rebuildTodosFts(dbHandle) {
  dbHandle.exec(`DELETE FROM todos_fts`)
  dbHandle.exec(`
    INSERT INTO todos_fts(todo_id, title, description)
    SELECT id, COALESCE(title, ''), COALESCE(description, '') FROM todos
  `)
}

export function rebuildCommentsFts(dbHandle) {
  dbHandle.exec(`DELETE FROM comments_fts`)
  dbHandle.exec(`
    INSERT INTO comments_fts(comment_id, todo_id, body)
    SELECT id, todo_id, COALESCE(content, '') FROM comments
  `)
}

export function rebuildAiSessionsFts(dbHandle) {
  dbHandle.exec(`DELETE FROM ai_sessions_fts`)
  dbHandle.exec(`
    INSERT INTO ai_sessions_fts(todo_id, session_id, label, command, native_session_id)
    SELECT t.id,
           COALESCE(json_extract(j.value, '$.sessionId'), ''),
           COALESCE(json_extract(j.value, '$.label'), ''),
           COALESCE(json_extract(j.value, '$.command'), ''),
           COALESCE(json_extract(j.value, '$.nativeSessionId'), '')
    FROM todos t,
         json_each(COALESCE(t.ai_session, '[]')) j
  `)
}

/**
 * 重新读取 wikiDir 下所有 .md 文件，按文件名里的 todo_id 建索引。
 * 命名约定：文件名格式 todo-<id>.md（或 wikiService 决定的任何格式）。
 * 这里用宽松匹配：todo_id = 去掉前缀/后缀之后的部分，若 wiki 还没存在就跳过。
 *
 * 如果 wikiDir 不存在 / 读取失败，静默跳过（没有 wiki 不影响搜索其他 scope）。
 */
export function rebuildWikiFts(dbHandle, { wikiDir } = {}) {
  dbHandle.exec(`DELETE FROM wiki_fts`)
  if (!wikiDir || !existsSync(wikiDir)) return { indexed: 0 }
  let indexed = 0
  const stmt = dbHandle.prepare(`INSERT INTO wiki_fts(todo_id, body) VALUES (?, ?)`)
  const insertMany = dbHandle.transaction((entries) => {
    for (const { todoId, body } of entries) {
      stmt.run(todoId, body)
      indexed += 1
    }
  })
  const entries = []
  try {
    for (const entry of readdirSync(wikiDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      if (!/^(todo-)?(.+)\.md$/i.test(entry.name)) continue
      const match = entry.name.match(/^(?:todo-)?(.+?)\.md$/i)
      const todoId = match?.[1]
      if (!todoId) continue
      const fullPath = join(wikiDir, entry.name)
      try {
        const st = statSync(fullPath)
        if (!st.isFile()) continue
        const body = readFileSync(fullPath, 'utf8')
        if (body.trim()) entries.push({ todoId, body })
      } catch {
        // ignore unreadable file
      }
    }
  } catch {
    return { indexed: 0 }
  }
  if (entries.length) insertMany(entries)
  return { indexed }
}

/**
 * 启动时检查 FTS 行数与源表一致（粗略），不一致就全量重建。
 */
export function ensureFtsConsistency(dbHandle, { wikiDir } = {}) {
  const out = { rebuilt: [] }
  const count = (sql) => dbHandle.prepare(sql).get()?.n ?? 0
  if (count(`SELECT COUNT(*) AS n FROM todos_fts`) !== count(`SELECT COUNT(*) AS n FROM todos`)) {
    rebuildTodosFts(dbHandle)
    out.rebuilt.push('todos_fts')
  }
  if (count(`SELECT COUNT(*) AS n FROM comments_fts`) !== count(`SELECT COUNT(*) AS n FROM comments`)) {
    rebuildCommentsFts(dbHandle)
    out.rebuilt.push('comments_fts')
  }
  // ai_sessions 是 JSON 展开后的条数；如果数量不一致（可能上次没跑到触发器）就重建
  const aiSessionsExpected = dbHandle.prepare(`
    SELECT COUNT(*) AS n
    FROM todos t, json_each(COALESCE(t.ai_session, '[]')) j
  `).get()?.n ?? 0
  if (count(`SELECT COUNT(*) AS n FROM ai_sessions_fts`) !== aiSessionsExpected) {
    rebuildAiSessionsFts(dbHandle)
    out.rebuilt.push('ai_sessions_fts')
  }
  // wiki 每次启动都重建（对比文件数成本高、直接 rebuild 便宜）
  rebuildWikiFts(dbHandle, { wikiDir })
  out.rebuilt.push('wiki_fts')
  return out
}
