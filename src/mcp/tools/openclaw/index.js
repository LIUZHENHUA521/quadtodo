/**
 * OpenClaw 双向桥接的 MCP 工具集（8 个）：
 *
 * 创建任务向导（OpenClaw skill 调）：
 *   - list_workdir_options
 *   - list_quadrants
 *   - list_templates
 *
 * 启动 PTY（OpenClaw skill 调）：
 *   - start_ai_session
 *
 * 双向交互：
 *   - ask_user            （PTY 内 AI 调，阻塞）
 *   - submit_user_reply   （OpenClaw skill 调）
 *   - list_pending_questions
 *   - cancel_pending_question
 */
import { z } from 'zod'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { buildAskUserReplyMarkup } from '../../../ask-user-buttons.js'
import { applySystemRules } from '../../../system-rules.js'

function asText(value) {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  }
}

function asError(message, extra = null) {
  const text = extra ? `error: ${message}\n${JSON.stringify(extra, null, 2)}` : `error: ${message}`
  return {
    isError: true,
    content: [{ type: 'text', text }],
  }
}

const QUADRANTS = [
  { id: 1, label: '重要紧急', shortLabel: 'Q1', isDefault: false },
  { id: 2, label: '重要不紧急', shortLabel: 'Q2', isDefault: true },
  { id: 3, label: '紧急不重要', shortLabel: 'Q3', isDefault: false },
  { id: 4, label: '不重要不紧急', shortLabel: 'Q4', isDefault: false },
]

function expandHome(p) {
  if (!p) return p
  if (p === '~' || p.startsWith('~/')) return p === '~' ? homedir() : join(homedir(), p.slice(2))
  return p
}

function recentWorkDirs(db, limit = 5) {
  // 取最近 200 条 todo，按 work_dir 出现频次排序
  try {
    const rows = db.raw.prepare(`
      SELECT work_dir, COUNT(*) AS n, MAX(updated_at) AS last_used
      FROM todos
      WHERE work_dir IS NOT NULL AND work_dir != ''
      GROUP BY work_dir
      ORDER BY n DESC, last_used DESC
      LIMIT ?
    `).all(limit)
    return rows.map((r) => ({ path: r.work_dir, count: r.n, lastUsedAt: r.last_used }))
  } catch {
    return []
  }
}

export function registerOpenClawTools(server, deps) {
  const { db, aiTerminal, openclaw, pending, getConfig } = deps
  if (!db) throw new Error('openclaw_tools: db required')
  if (!pending) throw new Error('openclaw_tools: pending coordinator required')

  // ─── 1. list_workdir_options ────────────────────────────────────
  server.registerTool(
    'list_workdir_options',
    {
      description:
        '列出建议的工作目录候选，用于「创建任务多轮向导」第一步。来源：' +
        '(a) 已有 todo 中频次最高的 work_dir；' +
        '(b) 配置项 defaultCwd；' +
        '(c) 当前用户主目录。每项带 source/path/count/lastUsedAt。',
      inputSchema: {},
    },
    async () => {
      try {
        const cfg = (typeof getConfig === 'function' && getConfig()) || {}
        const recent = recentWorkDirs(db, 5)
        const out = recent.map((r) => ({ ...r, source: 'recent' }))
        const seen = new Set(out.map((x) => x.path))
        const defCwd = cfg.defaultCwd || homedir()
        if (defCwd && !seen.has(defCwd)) {
          out.push({ path: defCwd, source: 'default' })
          seen.add(defCwd)
        }
        const home = homedir()
        if (!seen.has(home)) {
          out.push({ path: home, source: 'home' })
        }
        return asText({ options: out })
      } catch (e) {
        return asError(e?.message || 'list_workdir_options_failed')
      }
    },
  )

  // ─── 2. list_quadrants ──────────────────────────────────────────
  server.registerTool(
    'list_quadrants',
    {
      description: '返回 4 个象限的元数据（id/label/isDefault），创建向导第二步用。',
      inputSchema: {},
    },
    async () => asText({ quadrants: QUADRANTS }),
  )

  // ─── 3. list_templates ──────────────────────────────────────────
  server.registerTool(
    'list_templates',
    {
      description:
        '返回所有提示词模板（id/name/description/builtin/contentPreview），创建向导第三步用。' +
        '完整 content 不返回（避免上下文爆）；启动会话时按 templateId 自动注入。',
      inputSchema: {},
    },
    async () => {
      try {
        const list = db.listTemplates().map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          builtin: t.builtin,
          contentPreview: (t.content || '').slice(0, 80),
        }))
        return asText({ templates: list })
      } catch (e) {
        return asError(e?.message || 'list_templates_failed')
      }
    },
  )

  // ─── 4. start_ai_session ────────────────────────────────────────
  server.registerTool(
    'start_ai_session',
    {
      description:
        '为指定 todo 启动一个 AI 终端会话（Claude Code / Codex）。' +
        '默认 permissionMode=bypass —— 用户从微信远程驱动时无法响应交互式权限。' +
        '可选 templateId：从 prompt_templates 拉模板内容作为首句注入。' +
        '可选 prompt：直接传 prompt 字符串覆盖 templateId（template 不变）。' +
        '可选 routeUserId：把这个微信对端绑定到这个 sessionId，' +
        'AI 后续调 ask_user / Stop hook 都自动推到该用户。' +
        '同时会向 PTY 注入 QUADTODO_SESSION_ID/TARGET_USER/TODO_ID/TODO_TITLE 环境变量，' +
        '让嵌套 Claude Code 的 hook 脚本能识别这是个 quadtodo 启动的会话。',
      inputSchema: {
        todoId: z.string().min(1),
        tool: z.enum(['claude', 'codex']).optional().describe('默认 claude'),
        cwd: z.string().optional().describe('工作目录；不填用 todo.workDir 或 defaultCwd'),
        templateId: z.string().optional(),
        prompt: z.string().optional().describe('显式 prompt；优先级高于 templateId'),
        permissionMode: z.enum(['default', 'acceptEdits', 'bypass']).optional()
          .describe('默认 bypass'),
        routeUserId: z.string().optional().describe('OpenClaw 微信对端 user_id，用于回推'),
        routeAccount: z.string().optional(),
        routeChannel: z.string().optional(),
      },
    },
    async (args) => {
      try {
        if (!aiTerminal?.spawnSession) return asError('ai_terminal_unavailable')
        const todo = db.getTodo(args.todoId)
        if (!todo) return asError('todo_not_found')

        let prompt = args.prompt
        let templateName = null
        if (!prompt && args.templateId) {
          const tpl = db.getTemplate(args.templateId)
          if (!tpl) return asError('template_not_found')
          prompt = `${tpl.content}\n\n---\n任务: ${todo.title}\n${todo.description ? `\n描述:\n${todo.description}` : ''}`
          templateName = tpl.name
        }
        if (!prompt) {
          prompt = `任务: ${todo.title}${todo.description ? `\n\n${todo.description}` : ''}`
        }
        // 注入"拍板必须用 ask_user MCP"工程纪律 —— 跟 wizard 启动路径行为一致
        // config.aiSession.enforceAskUserRule = false 可关
        const cfgEnforce = (getConfig?.()?.aiSession?.enforceAskUserRule !== false)
        prompt = applySystemRules(prompt, { enforce: cfgEnforce })

        const cwd = expandHome(args.cwd) || todo.workDir || (getConfig?.()?.defaultCwd) || homedir()
        if (cwd && !existsSync(cwd)) {
          return asError('cwd_not_exists', { cwd })
        }

        const tool = args.tool || (getConfig?.()?.defaultTool) || 'claude'
        // 默认 bypass —— 微信远程驱动场景必备（无法响应权限弹窗）
        const permissionMode = args.permissionMode || 'bypass'

        // 预生成 sessionId，让 env 能写真值进 PTY 子进程，
        // 嵌套 Claude Code 的 hook 脚本就能在 stdin 里拿到正确 sessionId 路由
        const sessionId = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        const port = getConfig?.()?.port || 5677
        const extraEnv = {
          QUADTODO_SESSION_ID: sessionId,
          QUADTODO_TODO_ID: String(args.todoId),
          QUADTODO_TODO_TITLE: String(todo.title || ''),
          QUADTODO_URL: `http://127.0.0.1:${port}`,
        }
        if (args.routeUserId) extraEnv.QUADTODO_TARGET_USER = String(args.routeUserId)

        // 先注册路由（用预生成的 sessionId）—— 否则 PTY 启动后第一秒内的 hook
        // 若发到 quadtodo，可能因路由没注册而 fallback 到 config.targetUserId
        if (openclaw?.registerSessionRoute && args.routeUserId) {
          openclaw.registerSessionRoute(sessionId, {
            targetUserId: args.routeUserId,
            account: args.routeAccount || null,
            channel: args.routeChannel || null,
          })
        }

        const result = aiTerminal.spawnSession({
          sessionId,
          todoId: args.todoId,
          prompt,
          tool,
          cwd,
          permissionMode,
          label: templateName ? `template:${templateName}` : null,
          extraEnv,
        })

        return asText({
          ok: true,
          sessionId: result.sessionId,
          reused: result.reused,
          tool,
          cwd: resolvePath(cwd),
          templateName,
          permissionMode,
        })
      } catch (e) {
        return asError(e?.message || 'start_ai_session_failed')
      }
    },
  )

  // ─── 5. ask_user (阻塞) ─────────────────────────────────────────
  server.registerTool(
    'ask_user',
    {
      description:
        '【AI 在 PTY 里调】把决策点抛给真人用户。这是一次阻塞调用：' +
        '工具会等用户在 OpenClaw（微信）回复后才返回 chosen 选项。' +
        '什么时候用：方案分歧 / 重大破坏性操作前 / 多个并列实现路径。' +
        '不要为每个小决策都调 —— 只在真正需要人来拍板时用。',
      inputSchema: {
        question: z.string().min(1).describe('问题（精炼，给真人看）'),
        options: z.array(z.string().min(1)).min(2).max(8).describe('2-8 个互斥选项'),
        sessionId: z.string().optional().describe('当前 PTY 会话 ID（不填则尽力推断）'),
        todoId: z.string().optional(),
        timeoutMs: z.number().int().positive().max(3_600_000).optional(),
        urgency: z.enum(['low', 'normal', 'high']).optional(),
      },
    },
    async (args) => {
      try {
        if (!openclaw) return asError('openclaw_bridge_unavailable')

        const oc = getConfig?.()?.openclaw || {}
        if (!openclaw.isEnabled()) return asError('openclaw_disabled', {
          hint: 'set openclaw.enabled = true in config',
        })

        const sessionId = args.sessionId || `ad-hoc-${Date.now()}`
        const todoId = args.todoId || null
        const timeoutMs = args.timeoutMs || oc?.askUser?.defaultTimeoutMs || 600_000

        const { ticket, promise } = pending.ask({
          sessionId,
          todoId,
          question: args.question,
          options: args.options,
          timeoutMs,
        })

        // 拼出微信文本：[#a3f] 任务 X 卡到决策点：\n问题\n\n1. ...\n2. ...
        const todoTitle = todoId ? (db.getTodo(todoId)?.title || todoId) : null
        const lines = []
        const header = todoTitle
          ? `[#${ticket}] 任务「${todoTitle}」需要你拍板：`
          : `[#${ticket}] 决策需求：`
        lines.push(header)
        lines.push('')
        lines.push(args.question)
        lines.push('')
        args.options.forEach((opt, i) => lines.push(`${i + 1}. ${opt}`))
        lines.push('')
        // 提示同时支持文本回复（老路径）和按钮（新路径），两者完全等价
        lines.push(`点上面按钮 / 回 1-${args.options.length} / 回 #${ticket} N`)

        // Telegram 路径：附 inline keyboard；其它 channel 自动忽略 replyMarkup
        // bridge.postText 在 telegram fast-path 才透传，CLI fallback 走纯文本（无按钮）
        let askUserMarkup = null
        try {
          askUserMarkup = buildAskUserReplyMarkup(ticket, args.options)
        } catch (e) {
          // 拼按钮失败不阻塞；纯文本兜底（用户照样能数字回复）
        }

        const sendResult = await openclaw.postText({
          sessionId,
          message: lines.join('\n'),
          replyMarkup: askUserMarkup,
        })
        if (!sendResult.ok) {
          // 不直接 reject 这条 pending；让用户能从 web UI fallback 答复
          // 但要明确告知 AI 推送失败
          return asText({
            ticket,
            status: 'pending',
            warning: `outbound_failed:${sendResult.reason}`,
            note: 'message could not be pushed to OpenClaw; user may answer via web UI. await result anyway.',
            elapsedMs: 0,
          })
        }

        // 阻塞 await，pending coordinator 内部已处理 timeout/cancel
        const settled = await promise
        return asText({
          ticket,
          status: settled.status,
          chosen: settled.chosen,
          chosenIndex: settled.chosenIndex,
          answerText: settled.answerText,
          elapsedMs: settled.elapsedMs,
        })
      } catch (e) {
        return asError(e?.message || 'ask_user_failed')
      }
    },
  )

  // ─── 6. submit_user_reply ───────────────────────────────────────
  server.registerTool(
    'submit_user_reply',
    {
      description:
        '【OpenClaw skill 调】把用户在微信的纯文本回复送进来，路由到对应 pending question。' +
        '路由规则：#xxx 强制 → bare xxx 尝试 → 最新 pending（fallback）。' +
        '会自动模糊匹配选项（数字 1/2/3 / 选项原文 startswith / contains）。',
      inputSchema: {
        text: z.string().min(1),
      },
    },
    async ({ text }) => {
      try {
        const r = pending.submitReply(text)
        return asText(r)
      } catch (e) {
        return asError(e?.message || 'submit_reply_failed')
      }
    },
  )

  // ─── 7. list_pending_questions ──────────────────────────────────
  server.registerTool(
    'list_pending_questions',
    {
      description: '列出当前所有 pending 的 ask_user 问题（含 ticket / 倒计时）。',
      inputSchema: {},
    },
    async () => {
      try {
        const list = pending.listPending()
        return asText({ pending: list, count: list.length })
      } catch (e) {
        return asError(e?.message || 'list_pending_failed')
      }
    },
  )

  // ─── 8. cancel_pending_question ─────────────────────────────────
  server.registerTool(
    'cancel_pending_question',
    {
      description: '取消一条还在等用户回复的 pending question。' +
        'AI 端会立刻收到 status=cancelled 并继续。',
      inputSchema: {
        ticket: z.string().min(1).max(8),
        reason: z.string().optional(),
      },
    },
    async ({ ticket, reason }) => {
      try {
        const r = pending.cancel(ticket, reason)
        if (!r.ok) return asError(r.reason, r)
        return asText(r)
      } catch (e) {
        return asError(e?.message || 'cancel_failed')
      }
    },
  )
}
