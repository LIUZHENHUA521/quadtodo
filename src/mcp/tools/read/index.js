import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

const ScopeEnum = z.enum(['todos', 'comments', 'wiki', 'ai_sessions'])

/**
 * 把一个 JS 对象序列化成 MCP 工具响应。
 * MCP 工具返回的 content 数组里每项必须有 type + 相应字段；
 * 对 LLM 最友好的是 type:"text" + pretty JSON。
 */
function asText(value) {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  }
}

function asError(message) {
  return {
    isError: true,
    content: [{ type: 'text', text: `error: ${message}` }],
  }
}

export function registerReadTools(server, { db, searchService, wikiDir, transcriptScanner }) {
  // ─── 1. search ────────────────────────────────────────────────
  server.registerTool(
    'search',
    {
      description:
        '全局搜索 quadtodo 的所有语料：todo 标题/描述、评论、wiki 记忆、AI 会话元信息。基于 SQLite FTS5 + BM25 排序。返回每条命中的 scope/snippet/todoId/todoTitle 等。',
      inputSchema: {
        query: z.string().min(1).describe('搜索关键词；可以是自然语言词组，会自动转成 FTS5 前缀匹配'),
        scopes: z.array(ScopeEnum).optional().describe('限定搜索范围，默认 4 个全开'),
        includeArchived: z.boolean().optional().describe('是否包含已归档的 todo。默认 false'),
        limit: z.number().int().positive().max(100).optional().describe('返回条数上限，1-100，默认 20'),
      },
    },
    async (args) => {
      try {
        const out = searchService.search(args)
        return asText(out)
      } catch (e) {
        return asError(e?.message || 'search_failed')
      }
    },
  )

  // ─── 2. list_todos ────────────────────────────────────────────
  server.registerTool(
    'list_todos',
    {
      description:
        '按过滤条件列出 todos。不做全文搜索——用 search 做模糊搜索。返回元数据数组，不含 AI 会话详情（用 get_todo 取）。',
      inputSchema: {
        quadrant: z.number().int().min(1).max(4).optional().describe('1=重要且紧急 2=重要不紧急 3=紧急不重要 4=不重要不紧急'),
        status: z.enum(['todo', 'done', 'all']).optional().describe('默认 all'),
        archived: z.union([z.boolean(), z.literal('all')]).optional().describe('默认 false 只看未归档；"all" 两者都要'),
        parentId: z.string().optional().describe('仅列某 parent 下的子任务'),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    async (args = {}) => {
      try {
        const rawStatus = args.status === 'all' ? '' : args.status
        const list = db.listTodos({
          quadrant: args.quadrant,
          status: rawStatus,
          archived: args.archived,
        })
        let filtered = list
        if (args.parentId) {
          filtered = filtered.filter((t) => t.parentId === args.parentId)
        }
        const limit = args.limit || 100
        const truncated = filtered.length > limit
        const slim = filtered.slice(0, limit).map((t) => ({
          id: t.id,
          parentId: t.parentId,
          title: t.title,
          quadrant: t.quadrant,
          status: t.status,
          dueDate: t.dueDate,
          workDir: t.workDir,
          archivedAt: t.archivedAt,
          completedAt: t.completedAt,
          updatedAt: t.updatedAt,
          aiSessionCount: Array.isArray(t.aiSessions) ? t.aiSessions.length : 0,
        }))
        return asText({ total: filtered.length, returned: slim.length, truncated, todos: slim })
      } catch (e) {
        return asError(e?.message || 'list_failed')
      }
    },
  )

  // ─── 3. get_todo ──────────────────────────────────────────────
  server.registerTool(
    'get_todo',
    {
      description:
        '获取单个 todo 的完整信息：本体字段 + 子任务 id 列表 + 评论数组 + AI 会话数组 + wiki 是否存在。不直接返回 wiki 正文（用 read_wiki）也不返回 transcript（用 read_transcript）。',
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async ({ id }) => {
      try {
        const todo = db.getTodo(id)
        if (!todo) return asError('todo_not_found')
        const comments = db.listComments(id)
        const children = db.raw.prepare(`SELECT id, title FROM todos WHERE parent_id = ?`).all(id)
        const wikiFile = wikiDir ? join(wikiDir, `${id}.md`) : null
        const hasWiki = wikiFile ? existsSync(wikiFile) : false
        return asText({
          todo,
          children,
          comments,
          hasWiki,
        })
      } catch (e) {
        return asError(e?.message || 'get_failed')
      }
    },
  )

  // ─── 4. read_wiki ─────────────────────────────────────────────
  server.registerTool(
    'read_wiki',
    {
      description: '读取指定 todo 的 wiki 记忆文件（markdown）。若该 todo 还没沉淀 wiki，返回 exists:false。',
      inputSchema: {
        todoId: z.string().min(1),
      },
    },
    async ({ todoId }) => {
      try {
        if (!wikiDir) return asText({ exists: false, body: null, reason: 'wikiDir_not_configured' })
        const file = join(wikiDir, `${todoId}.md`)
        if (!existsSync(file)) return asText({ exists: false, body: null })
        const body = readFileSync(file, 'utf8')
        return asText({ exists: true, body, path: file })
      } catch (e) {
        return asError(e?.message || 'read_failed')
      }
    },
  )

  // ─── 5. get_stats ─────────────────────────────────────────────
  server.registerTool(
    'get_stats',
    {
      description:
        '一个当前快照：按象限/状态的分布、今日截止、本周完成、最近 7 天活跃度、归档数量。轻量实时计算。',
      inputSchema: {},
    },
    async () => {
      try {
        const now = Date.now()
        const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0)
        const startOfWeek = new Date(startOfDay); startOfWeek.setDate(startOfWeek.getDate() - 6)
        const all = db.listTodos({ archived: 'all' })
        const open = all.filter((t) => t.status !== 'done' && t.status !== 'missed' && t.archivedAt == null)
        const archivedCount = all.filter((t) => t.archivedAt != null).length
        const byQuadrant = {}
        for (const t of open) byQuadrant[t.quadrant] = (byQuadrant[t.quadrant] || 0) + 1
        const overdue = open.filter((t) => t.dueDate && t.dueDate < now)
        const dueToday = open.filter((t) => t.dueDate && t.dueDate >= startOfDay.getTime() && t.dueDate < startOfDay.getTime() + 86_400_000)
        const weekDone = db.listCompletedTodos({ since: startOfWeek.getTime(), until: now + 1 })
        return asText({
          openCount: open.length,
          archivedCount,
          byQuadrant,
          overdue: { count: overdue.length, ids: overdue.slice(0, 10).map((t) => t.id) },
          dueToday: { count: dueToday.length, ids: dueToday.map((t) => t.id) },
          completedThisWeek: weekDone.length,
          generatedAt: now,
        })
      } catch (e) {
        return asError(e?.message || 'stats_failed')
      }
    },
  )

  // ─── 7. search_transcripts ────────────────────────────────────
  if (transcriptScanner) {
    server.registerTool(
      'search_transcripts',
      {
        description:
          '在 AI 会话日志（~/.quadtodo/logs/*.log）里做纯文本逐行扫描。不使用 FTS，适合查 "当时 Claude 说的那句话"。结果带前后文；单次返回上限默认 30 条、单文件最多 5 条。',
        inputSchema: {
          query: z.string().min(1),
          todoId: z.string().optional().describe('只搜这个 todo 下的会话；不传就全局'),
          afterTs: z.number().int().optional(),
          beforeTs: z.number().int().optional(),
          maxMatches: z.number().int().positive().max(100).optional(),
          perFileLimit: z.number().int().positive().max(20).optional(),
        },
      },
      async (args) => {
        try {
          const out = transcriptScanner.search(args)
          return asText(out)
        } catch (e) {
          return asError(e?.message || 'scan_failed')
        }
      },
    )
  }

  // ─── 8. read_transcript ───────────────────────────────────────
  if (transcriptScanner) {
    server.registerTool(
      'read_transcript',
      {
        description:
          '读某个 sessionId 的完整会话日志。maxChars 控制 token 预算（字符数 ≈ 4×tokens，默认 32000 ≈ 8k tokens）；超出时尾部优先保留，前端标记 [truncated]。',
        inputSchema: {
          sessionId: z.string().min(1),
          maxChars: z.number().int().positive().max(200_000).optional(),
        },
      },
      async (args) => {
        try {
          const out = transcriptScanner.readSession(args)
          return asText(out)
        } catch (e) {
          return asError(e?.message || 'read_failed')
        }
      },
    )
  }

  // ─── 6. get_recent_sessions ───────────────────────────────────
  server.registerTool(
    'get_recent_sessions',
    {
      description:
        '跨 todo 的最近 AI 会话列表。每项含 sessionId / tool / todoId / todoTitle / startedAt / completedAt / durationMs / status。',
      inputSchema: {
        limit: z.number().int().positive().max(100).optional(),
        tool: z.enum(['claude', 'codex']).optional(),
      },
    },
    async ({ limit, tool } = {}) => {
      try {
        const cap = Math.max(1, Math.min(limit || 20, 100))
        const whereExtras = tool ? 'AND s.tool = ?' : ''
        const rows = db.raw
          .prepare(
            `SELECT s.id AS sessionId, s.todo_id AS todoId, s.tool, s.status,
                    s.exit_code AS exitCode, s.started_at AS startedAt,
                    s.completed_at AS completedAt, s.duration_ms AS durationMs,
                    t.title AS todoTitle
             FROM ai_session_log s
             LEFT JOIN todos t ON t.id = s.todo_id
             WHERE 1=1 ${whereExtras}
             ORDER BY s.completed_at DESC
             LIMIT ?`,
          )
          .all(...(tool ? [tool, cap] : [cap]))
        return asText({ count: rows.length, sessions: rows })
      } catch (e) {
        return asError(e?.message || 'recent_failed')
      }
    },
  )
}
