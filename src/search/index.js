import {
  ensureFtsConsistency,
  initFtsTables,
  rebuildWikiFts,
} from './fts.js'

const ALL_SCOPES = ['todos', 'comments', 'wiki', 'ai_sessions']

/**
 * 把用户输入的自然语言 query 转成 FTS5 MATCH 友好的表达式。
 *
 * 策略：
 *   - 单词按空白切分；
 *   - 每个 token 加通配 `*` 做前缀匹配；
 *   - tokens 之间用 AND；
 *   - 若 token 含 FTS5 特殊字符（引号/操作符），用 `"..."` 引起来；
 *   - 过短（1 字符）和全标点 token 丢弃。
 */
function sanitizeFtsQuery(raw) {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return ''
  // FTS5 支持的语法字符：AND/OR/NOT/NEAR + 双引号 + 括号 + *
  // 我们简化：先去掉所有引号和括号，保留其它
  const stripped = trimmed.replace(/["()]/g, ' ').replace(/\s+/g, ' ').trim()
  const parts = stripped.split(/\s+/)
  const terms = []
  for (const part of parts) {
    const clean = part.replace(/[*]+$/g, '')  // 先剥尾部星号避免 **
    if (!clean) continue
    if (clean.length === 0) continue
    // 安全起见，所有 token 都套双引号 + 尾部加 *（前缀搜索）
    // 双引号里双引号转义
    const quoted = `"${clean.replace(/"/g, '""')}"`
    terms.push(`${quoted}*`)
  }
  return terms.join(' AND ')
}

/**
 * 工厂：创建 search service。
 *
 * 职责：
 *   1. 启动时 initFtsTables + ensureFtsConsistency
 *   2. 对外暴露 search({ query, scopes, includeArchived, limit })
 *   3. 暴露 reindexWiki() 供 wiki run 完成时调用
 */
export function createSearchService({ db, wikiDir } = {}) {
  if (!db) throw new Error('db_required')
  const dbHandle = db.raw

  function init() {
    initFtsTables(dbHandle)
    return ensureFtsConsistency(dbHandle, { wikiDir })
  }

  function reindexWiki() {
    return rebuildWikiFts(dbHandle, { wikiDir })
  }

  function search({ query, scopes, includeArchived = false, limit = 20 } = {}) {
    if (!query || !String(query).trim()) throw new Error('query_required')
    const cappedLimit = Math.max(1, Math.min(Number(limit) || 20, 100))
    const useScopes = Array.isArray(scopes) && scopes.length
      ? scopes.filter((s) => ALL_SCOPES.includes(s))
      : ALL_SCOPES.slice()
    if (useScopes.length === 0) return { total: 0, results: [] }
    const match = sanitizeFtsQuery(query)
    if (!match) return { total: 0, results: [] }

    const perScopeResults = []

    if (useScopes.includes('todos')) {
      // 注意 bm25 越小越相关，所以我们转成 1/(1+bm25) 归一化
      const rows = dbHandle.prepare(`
        SELECT f.todo_id AS todoId,
               snippet(todos_fts, 1, '<mark>', '</mark>', '…', 12) AS titleSnippet,
               snippet(todos_fts, 2, '<mark>', '</mark>', '…', 16) AS descSnippet,
               bm25(todos_fts) AS bm25
        FROM todos_fts f
        JOIN todos t ON t.id = f.todo_id
        WHERE todos_fts MATCH ? ${includeArchived ? '' : 'AND t.archived_at IS NULL'}
        ORDER BY bm25 ASC
        LIMIT ?
      `).all(match, cappedLimit * 2)
      for (const r of rows) {
        perScopeResults.push({
          scope: 'todos',
          todoId: r.todoId,
          snippet: r.descSnippet || r.titleSnippet || '',
          title: null, // 前端 / MCP 再 JOIN 拿完整 title
          score: 1 / (1 + Number(r.bm25)),
        })
      }
    }

    if (useScopes.includes('comments')) {
      const rows = dbHandle.prepare(`
        SELECT f.comment_id AS commentId,
               f.todo_id AS todoId,
               snippet(comments_fts, 2, '<mark>', '</mark>', '…', 16) AS snippet,
               bm25(comments_fts) AS bm25
        FROM comments_fts f
        JOIN todos t ON t.id = f.todo_id
        WHERE comments_fts MATCH ? ${includeArchived ? '' : 'AND t.archived_at IS NULL'}
        ORDER BY bm25 ASC
        LIMIT ?
      `).all(match, cappedLimit * 2)
      for (const r of rows) {
        perScopeResults.push({
          scope: 'comments',
          todoId: r.todoId,
          commentId: r.commentId,
          snippet: r.snippet || '',
          score: 1 / (1 + Number(r.bm25)),
        })
      }
    }

    if (useScopes.includes('wiki')) {
      const rows = dbHandle.prepare(`
        SELECT f.todo_id AS todoId,
               snippet(wiki_fts, 1, '<mark>', '</mark>', '…', 16) AS snippet,
               bm25(wiki_fts) AS bm25
        FROM wiki_fts f
        JOIN todos t ON t.id = f.todo_id
        WHERE wiki_fts MATCH ? ${includeArchived ? '' : 'AND t.archived_at IS NULL'}
        ORDER BY bm25 ASC
        LIMIT ?
      `).all(match, cappedLimit * 2)
      for (const r of rows) {
        perScopeResults.push({
          scope: 'wiki',
          todoId: r.todoId,
          snippet: r.snippet || '',
          score: 1 / (1 + Number(r.bm25)),
        })
      }
    }

    if (useScopes.includes('ai_sessions')) {
      const rows = dbHandle.prepare(`
        SELECT f.todo_id    AS todoId,
               f.session_id AS sessionId,
               snippet(ai_sessions_fts, 2, '<mark>', '</mark>', '…', 12) AS labelSnip,
               snippet(ai_sessions_fts, 3, '<mark>', '</mark>', '…', 16) AS commandSnip,
               bm25(ai_sessions_fts) AS bm25
        FROM ai_sessions_fts f
        JOIN todos t ON t.id = f.todo_id
        WHERE ai_sessions_fts MATCH ? ${includeArchived ? '' : 'AND t.archived_at IS NULL'}
        ORDER BY bm25 ASC
        LIMIT ?
      `).all(match, cappedLimit * 2)
      for (const r of rows) {
        perScopeResults.push({
          scope: 'ai_sessions',
          todoId: r.todoId,
          sessionId: r.sessionId,
          snippet: r.commandSnip || r.labelSnip || '',
          score: 1 / (1 + Number(r.bm25)),
        })
      }
    }

    // 全局排序 + 截断
    perScopeResults.sort((a, b) => b.score - a.score)
    const top = perScopeResults.slice(0, cappedLimit)

    // 把 todoId → title 查一次，避免 N+1
    const todoIds = [...new Set(top.map((r) => r.todoId))]
    const titleMap = new Map()
    if (todoIds.length) {
      const placeholders = todoIds.map(() => '?').join(',')
      const rows = dbHandle.prepare(`
        SELECT id, title, archived_at FROM todos WHERE id IN (${placeholders})
      `).all(...todoIds)
      for (const r of rows) {
        titleMap.set(r.id, { title: r.title, archived: r.archived_at != null })
      }
    }
    for (const r of top) {
      const info = titleMap.get(r.todoId)
      if (info) {
        r.todoTitle = info.title
        r.archived = info.archived
      }
    }

    return {
      total: perScopeResults.length,
      results: top,
    }
  }

  return {
    init,
    reindexWiki,
    search,
  }
}
