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

function previewResponse({ toolName, summary, impact, args }) {
  const { confirm, confirmNote, ...safeArgs } = args
  return asText({
    preview: true,
    tool: toolName,
    summary,
    impact,
    howToConfirm:
      `调用一次同样的 ${toolName}，但把 "confirm" 设为 true（同时可选地附上 "confirmNote" 记录用户同意的理由）。`,
    confirmedArgs: { ...safeArgs, confirm: true, confirmNote: '<optional note>' },
  })
}

/**
 * 注册 4 个破坏性工具：delete_todo / archive_todo / merge_todos / bulk_update。
 * 默认 confirm:false 只返回 preview JSON；带 confirm:true 才真执行，并写 audit log。
 */
export function registerDestructiveTools(server, { db, audit }) {
  // ─── 1. delete_todo ───────────────────────────────────────────
  server.registerTool(
    'delete_todo',
    {
      description:
        '硬删除一个 todo（级联删除子任务、评论、AI 会话日志）。不可逆。默认 confirm:false 返回预览，不修改 DB；confirm:true 才真删。',
      inputSchema: {
        id: z.string().min(1),
        confirm: z.boolean().optional(),
        confirmNote: z.string().optional().describe('转述用户同意理由，写入审计日志'),
      },
    },
    async (args) => {
      try {
        const todo = db.getTodo(args.id)
        if (!todo) return asError('todo_not_found')
        const countCascade = (sql, id) => db.raw.prepare(sql).get(id)?.n || 0
        const impact = {
          todoId: todo.id,
          title: todo.title,
          subtodos: countCascade(`SELECT COUNT(*) AS n FROM todos WHERE parent_id = ?`, todo.id),
          comments: countCascade(`SELECT COUNT(*) AS n FROM comments WHERE todo_id = ?`, todo.id),
          sessionLogs: countCascade(`SELECT COUNT(*) AS n FROM ai_session_log WHERE todo_id = ?`, todo.id),
          aiSessions: Array.isArray(todo.aiSessions) ? todo.aiSessions.length : 0,
        }
        if (!args.confirm) {
          return previewResponse({
            toolName: 'delete_todo',
            summary: `将硬删 todo id=${todo.id}（标题「${todo.title}」），级联删除 ${impact.subtodos} 个子任务 / ${impact.comments} 条评论 / ${impact.sessionLogs} 条 AI 会话日志。此操作不可逆。`,
            impact,
            args,
          })
        }
        db.deleteTodo(todo.id)
        audit?.append({
          tool: 'delete_todo',
          ok: true,
          args: { id: args.id },
          result: impact,
          confirmNote: args.confirmNote || null,
        })
        return asText({ ok: true, deleted: impact })
      } catch (e) {
        audit?.append({ tool: 'delete_todo', ok: false, args: { id: args.id }, error: e?.message })
        return asError(e?.message || 'delete_failed')
      }
    },
  )

  // ─── 2. archive_todo ──────────────────────────────────────────
  server.registerTool(
    'archive_todo',
    {
      description:
        '把 todo 从默认列表里隐藏（设置 archived_at=now）。可用 unarchive_todo 撤销。默认 confirm:false 返回预览。',
      inputSchema: {
        id: z.string().min(1),
        confirm: z.boolean().optional(),
        confirmNote: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const todo = db.getTodo(args.id)
        if (!todo) return asError('todo_not_found')
        if (todo.archivedAt) {
          return asText({ ok: true, alreadyArchived: true, todo })
        }
        const impact = { todoId: todo.id, title: todo.title }
        if (!args.confirm) {
          return previewResponse({
            toolName: 'archive_todo',
            summary: `将归档 todo id=${todo.id}（标题「${todo.title}」）。它将不再出现在默认列表里；可用 unarchive_todo 撤销。`,
            impact,
            args,
          })
        }
        const result = db.archiveTodo(todo.id)
        audit?.append({
          tool: 'archive_todo',
          ok: true,
          args: { id: args.id },
          result: impact,
          confirmNote: args.confirmNote || null,
        })
        return asText({ ok: true, todo: result })
      } catch (e) {
        audit?.append({ tool: 'archive_todo', ok: false, args: { id: args.id }, error: e?.message })
        return asError(e?.message || 'archive_failed')
      }
    },
  )

  // ─── 3. merge_todos ───────────────────────────────────────────
  server.registerTool(
    'merge_todos',
    {
      description:
        '把 sourceIds 里的多条 todo 合并进 targetId：它们的子任务、评论、AI 会话、wiki 等关联记录全部迁移到 target，随后源 todo 被删除。不可逆。默认 confirm:false 返回 preview。titleStrategy：keep_target / concat / manual（manual 要 manualTitle）。',
      inputSchema: {
        targetId: z.string().min(1),
        sourceIds: z.array(z.string().min(1)).min(1),
        titleStrategy: z.enum(['keep_target', 'concat', 'manual']).optional(),
        manualTitle: z.string().optional(),
        confirm: z.boolean().optional(),
        confirmNote: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const preview = db.describeMergeTodos({
          targetId: args.targetId,
          sourceIds: args.sourceIds,
          titleStrategy: args.titleStrategy || 'keep_target',
          manualTitle: args.manualTitle,
        })
        if (!args.confirm) {
          const summary =
            `将把 ${preview.sources.length} 条源 todo 合并进 target id=${preview.target.id}（「${preview.target.title}」）。` +
            `迁移：${preview.movedChildren} 子任务 / ${preview.movedComments} 评论 / ${preview.movedSessions} AI 会话 / ${preview.movedSessionLogs} 会话日志。` +
            `合并后标题：「${preview.proposedTitle}」。源 todo 将被删除（不可逆）。`
          return previewResponse({
            toolName: 'merge_todos',
            summary,
            impact: preview,
            args,
          })
        }
        const result = db.mergeTodos({
          targetId: args.targetId,
          sourceIds: args.sourceIds,
          titleStrategy: args.titleStrategy || 'keep_target',
          manualTitle: args.manualTitle,
        })
        audit?.append({
          tool: 'merge_todos',
          ok: true,
          args: {
            targetId: args.targetId,
            sourceIds: args.sourceIds,
            titleStrategy: args.titleStrategy,
          },
          result: {
            movedChildren: result.movedChildren,
            movedComments: result.movedComments,
            movedSessions: result.movedSessions,
            movedSessionLogs: result.movedSessionLogs,
            deletedIds: result.sources.map((s) => s.id),
          },
          confirmNote: args.confirmNote || null,
        })
        return asText({ ok: true, result })
      } catch (e) {
        audit?.append({ tool: 'merge_todos', ok: false, args: { targetId: args.targetId, sourceIds: args.sourceIds }, error: e?.message })
        return asError(e?.message || 'merge_failed')
      }
    },
  )

  // ─── 4. bulk_update ───────────────────────────────────────────
  server.registerTool(
    'bulk_update',
    {
      description:
        '对一组 todo id 批量 patch。允许字段：quadrant / status / archived / dueDate。默认 confirm:false 返回 preview（列出将要修改的 todos，最多 20 条）。',
      inputSchema: {
        ids: z.array(z.string().min(1)).min(1),
        patch: z
          .object({
            quadrant: z.number().int().min(1).max(4).optional(),
            status: z.enum(['todo', 'done']).optional(),
            archived: z.boolean().optional(),
            dueDate: z.number().int().nullable().optional(),
          })
          .refine((obj) => Object.keys(obj).length > 0, 'patch cannot be empty'),
        confirm: z.boolean().optional(),
        confirmNote: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const preview = {
          ids: args.ids,
          patch: args.patch,
          affected: [],
          missing: [],
        }
        for (const id of args.ids.slice(0, 20)) {
          const t = db.getTodo(id)
          if (t) preview.affected.push({ id: t.id, title: t.title, quadrant: t.quadrant, status: t.status })
          else preview.missing.push(id)
        }
        preview.totalTargeted = args.ids.length
        preview.previewTruncated = args.ids.length > 20
        if (!args.confirm) {
          const patchKeys = Object.keys(args.patch).join(', ')
          return previewResponse({
            toolName: 'bulk_update',
            summary: `将对 ${args.ids.length} 条 todo 批量 patch 以下字段：${patchKeys}。命中 ${preview.affected.length} 条、未找到 ${preview.missing.length} 条。`,
            impact: preview,
            args,
          })
        }
        const result = db.bulkUpdateTodos({ ids: args.ids, patch: args.patch })
        audit?.append({
          tool: 'bulk_update',
          ok: true,
          args: { ids: args.ids, patch: args.patch },
          result: { changedCount: result.count, changedIds: result.changedIds },
          confirmNote: args.confirmNote || null,
        })
        return asText({ ok: true, result })
      } catch (e) {
        audit?.append({ tool: 'bulk_update', ok: false, args: { ids: args.ids, patch: args.patch }, error: e?.message })
        return asError(e?.message || 'bulk_update_failed')
      }
    },
  )
}
