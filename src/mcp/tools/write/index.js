import { z } from 'zod'

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

/**
 * 注册 5 个安全写工具：create_todo / update_todo / add_comment / complete_todo / unarchive_todo。
 * 这些操作都是可逆或低风险的（不会破坏关联），不需要 preview/confirm。
 */
export function registerWriteTools(server, { db }) {
  // ─── 1. create_todo ───────────────────────────────────────────
  server.registerTool(
    'create_todo',
    {
      description:
        '新建一条 todo。至少需要 title + quadrant。象限语义：1=重要且紧急，2=重要不紧急，3=紧急不重要，4=不重要不紧急。',
      inputSchema: {
        title: z.string().min(1).describe('标题，必填'),
        quadrant: z.number().int().min(1).max(4).describe('1 / 2 / 3 / 4'),
        description: z.string().optional(),
        parentId: z.string().optional().describe('如果是子任务，指定父 todo id（子任务会继承父的象限）'),
        dueDate: z.number().int().optional().describe('截止时间戳（毫秒 epoch）'),
        workDir: z.string().optional().describe('关联的代码仓路径'),
        brainstorm: z.boolean().optional(),
      },
    },
    async (args) => {
      try {
        if (!args.title?.trim()) return asError('title_required')
        const created = db.createTodo({
          title: args.title.trim(),
          quadrant: args.quadrant,
          description: args.description || '',
          parentId: args.parentId,
          dueDate: args.dueDate,
          workDir: args.workDir,
          brainstorm: !!args.brainstorm,
        })
        return asText({ todo: created, ok: true })
      } catch (e) {
        return asError(e?.message || 'create_failed')
      }
    },
  )

  // ─── 2. update_todo ───────────────────────────────────────────
  server.registerTool(
    'update_todo',
    {
      description:
        '修改已有 todo 的字段（patch 语义，只改传入的字段）。不能通过此工具 complete / archive / delete —— 用专用工具。',
      inputSchema: {
        id: z.string().min(1),
        title: z.string().optional(),
        description: z.string().optional(),
        quadrant: z.number().int().min(1).max(4).optional(),
        dueDate: z.number().int().nullable().optional().describe('传 null 显式清除'),
        workDir: z.string().nullable().optional(),
        parentId: z.string().nullable().optional().describe('传 null 升为顶层 todo'),
      },
    },
    async (args) => {
      try {
        const { id, ...patch } = args
        if (!id) return asError('id_required')
        // 禁止通过此工具改 status，status 变更有专用工具（complete/archive）
        const cleanPatch = {}
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined) continue
          cleanPatch[k] = v
        }
        if (Object.keys(cleanPatch).length === 0) return asError('patch_empty')
        const updated = db.updateTodo(id, cleanPatch)
        if (!updated) return asError('todo_not_found')
        return asText({ todo: updated, ok: true })
      } catch (e) {
        return asError(e?.message || 'update_failed')
      }
    },
  )

  // ─── 3. add_comment ───────────────────────────────────────────
  server.registerTool(
    'add_comment',
    {
      description: '给某个 todo 加一条评论（纯文本）。',
      inputSchema: {
        todoId: z.string().min(1),
        content: z.string().min(1),
      },
    },
    async ({ todoId, content }) => {
      try {
        const todo = db.getTodo(todoId)
        if (!todo) return asError('todo_not_found')
        const comment = db.addComment(todoId, content)
        return asText({ comment, ok: true })
      } catch (e) {
        return asError(e?.message || 'comment_failed')
      }
    },
  )

  // ─── 4. complete_todo ─────────────────────────────────────────
  server.registerTool(
    'complete_todo',
    {
      description:
        '把 todo 标记为已完成（status=done）。可逆：通过 update_todo 把 status 改回 todo 可恢复（但该字段不允许 update 工具直接改，因此请改用 reopen_todo —— 暂未实现，需要时再加）。',
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async ({ id }) => {
      try {
        const todo = db.getTodo(id)
        if (!todo) return asError('todo_not_found')
        if (todo.status === 'done') return asText({ todo, ok: true, alreadyDone: true })
        const updated = db.updateTodo(id, { status: 'done' })
        return asText({ todo: updated, ok: true })
      } catch (e) {
        return asError(e?.message || 'complete_failed')
      }
    },
  )

  // ─── 5. unarchive_todo ────────────────────────────────────────
  server.registerTool(
    'unarchive_todo',
    {
      description: '取消某 todo 的归档状态，让它重新出现在默认列表里。',
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async ({ id }) => {
      try {
        const todo = db.getTodo(id)
        if (!todo) return asError('todo_not_found')
        const updated = db.unarchiveTodo(id)
        return asText({ todo: updated, ok: true })
      } catch (e) {
        return asError(e?.message || 'unarchive_failed')
      }
    },
  )
}
