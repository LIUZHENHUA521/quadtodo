/**
 * OpenClaw 向导状态机：把"在微信里多轮创建 quadtodo 任务"的所有决策从
 * OpenClaw agent 搬到 quadtodo 内部，OpenClaw 只做消息转发。
 *
 * 设计目标：
 *   - 一条 inbound 消息 → 一个完整的判断 → 一个 reply 字符串
 *   - 状态机存内存（重启丢失也无所谓，向导本来就是短生命周期）
 *   - 一句话直说能跳过任意向导步骤（"目录 X" / "象限 N" / "模板 Y"）
 *   - 与 ask_user pending 共存：wizard 优先，wizard 完成后再吃 ask_user 答复
 *
 * 路由优先级（handleInbound 内）：
 *   1. 取消语 ("取消" / "cancel") + 进行中 wizard → 中止向导
 *   2. 当前 peer 有进行中 wizard → 推进向导（消费数字 / 文本）
 *   3. 当前 peer 有 pending ask_user → 调 pending.submitReply
 *   4. text 看起来像新任务 → 启动新向导
 *   5. 其它 → 友好 fallback
 */

const NEW_TASK_TRIGGERS = [
  /^(在\s*quadtodo\s*[里中])?\s*(新建|开个|开一?个|创建)\s*[任务todo]/i,
  /^(帮我|帮忙)?\s*(做|搞|修|搞定|实现|写一?个|做一?个|修复|重构|调试|debug|加|开发)/i,
  /^新?任务[:：]/,
]
const CANCEL_TRIGGERS = [/^取消$/, /^算了$/, /^不做了$/, /^cancel$/i, /^abort$/i]
// 退出 PTY 直连模式：清掉这个 peer 的 lastPushedSession，下次发的话不再被路由到 PTY
const DETACH_TRIGGERS = [/^退出$/, /^离开$/, /^断开$/, /^detach$/i, /^exit$/i, /^quit$/i, /^bye$/i]
// Claude Code 的 interactive modal 命令 —— Telegram 没法发 Esc 键退出 modal，
// 直接转发会让用户卡在 modal 里。命中 → 拦截不转发，引导用户去 web 终端。
const INTERACTIVE_SLASH_COMMANDS = new Set([
  'usage', 'status', 'config', 'agents', 'skills',
  'permissions', 'mcp', 'hooks', 'model', 'effort',
])
// ESC 触发器：写 `\x1b` 到 PTY stdin，相当于按 Esc 键退出 modal
const ESC_TRIGGERS = [/^esc$/i, /^退出菜单$/, /^cancel[-\s]?modal$/i]
// 中断触发器：写 `\x03`（Ctrl+C 的 ASCII）到 PTY，触发 SIGINT 打断当前 turn / 工具执行
const INTERRUPT_TRIGGERS = [
  /^中断$/, /^打断$/, /^停一下$/,
  /^\^c$/i,                    // ^C
  /^ctrl[\s\-+]?c$/i,           // ctrl+c, ctrl-c, ctrlc
  /^interrupt$/i,
]

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { parseCallbackData, buildAnswerReplyText, buildExtendedReplyText, CB_KIND_ANSWER, CB_KIND_EXTEND } from './ask-user-buttons.js'
import { applySystemRules } from './system-rules.js'

const WIZARD_TIMEOUT_MS = 10 * 60 * 1000

const STEP_WORKDIR = 'workdir'
const STEP_QUADRANT = 'quadrant'
const STEP_TEMPLATE = 'template'
const STEP_DONE = 'done'

const QUADRANTS = [
  { id: 1, label: '重要紧急' },
  { id: 2, label: '重要不紧急' },
  { id: 3, label: '紧急不重要' },
  { id: 4, label: '不重要不紧急' },
]

function defaultRecentWorkDirs(db, limit = 5) {
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

/** 解析"目录 X" / "workdir X" 之类后缀；返回 null 或 path. */
function tryExtractWorkdir(text) {
  const m = text.match(/(?:目录|路径|workdir|cwd|文件夹)[:：=\s]+([^\s,，；;]+)/i)
  if (m) return m[1].trim()
  return null
}

/** 解析"象限 N" / "quadrant N" / "Q1" 等；返回 1-4 或 null */
function tryExtractQuadrant(text) {
  const m1 = text.match(/(?:象限|quadrant|q)[:：=\s]*([1-4])\b/i)
  if (m1) return Number(m1[1])
  return null
}

/** 解析"模板 Bug" / "用 X 模板" 等；返回模板名 (string) 或 null */
function tryExtractTemplateHint(text) {
  const m = text.match(/(?:用|使用)?\s*[「『"]?([^」』"\s,，；;]+)[」』"]?\s*模板/)
  if (m) return m[1].trim()
  const m2 = text.match(/模板[:：=\s]+([^\s,，；;]+)/)
  if (m2) return m2[1].trim()
  return null
}

function parseNumericChoice(text, listLength) {
  const m = String(text).trim().match(/^(\d+)\b/)
  if (!m) return null
  const idx = parseInt(m[1], 10) - 1
  if (idx < 0 || idx >= listLength) return null
  return idx
}

function findTemplateByHint(templates, hint) {
  if (!hint) return null
  const lower = hint.toLowerCase()
  for (const t of templates) {
    const name = String(t.name || '').toLowerCase()
    if (name === lower || name.startsWith(lower) || name.includes(lower)) return t
    const desc = String(t.description || '').toLowerCase()
    if (desc.startsWith(lower)) return t
  }
  return null
}

function extractTitle(text) {
  // "新建任务: X" / "帮我做 X" / "新建任务 X"
  let s = text.trim()
  // 剥触发词头
  s = s.replace(/^在?\s*quadtodo\s*[里中]?\s*/i, '')
  s = s.replace(/^(新建|开个|开一?个|创建)\s*(任务|todo)?[:：\s]*/i, '')
  s = s.replace(/^任务[:：]\s*/, '')
  s = s.replace(/^(帮我|帮忙)\s*(做|搞|修|搞定|实现|写一?个|做一?个|修复|重构|调试|debug|加|开发)\s*[:：]?\s*/i, '')
  // 剥后缀（目录 / 象限 / 模板）
  s = s.replace(/[,，;；]?\s*(目录|路径|workdir|cwd|文件夹)[:：=\s]+[^\s,，；;]+/gi, '')
  s = s.replace(/[,，;；]?\s*(象限|quadrant|q)[:：=\s]*[1-4]\b/gi, '')
  s = s.replace(/[,，;；]?\s*(?:用|使用)?\s*[「『"]?[^」』"\s,，；;]+[」』"]?\s*模板/gi, '')
  s = s.replace(/[,，;；]?\s*模板[:：=\s]+[^\s,，；;]+/gi, '')
  return s.trim()
}

function buildWorkdirMessage(options) {
  const lines = ['📁 选个工作目录：']
  options.forEach((opt, i) => {
    const tag = opt.source === 'default' ? '默认目录'
      : opt.source === 'subdir' ? '子目录'
      : opt.source === 'recent' ? `recent, ${opt.count} 次`
      : opt.source === 'home' ? 'home'
      : opt.source
    lines.push(`${i + 1}. ${opt.path}  (${tag})`)
  })
  lines.push(`${options.length + 1}. 自定义路径（请直接输入路径文本）`)
  return lines.join('\n')
}

function buildQuadrantMessage() {
  const lines = ['🎯 选象限：']
  QUADRANTS.forEach((q) => {
    lines.push(`${q.id}. ${q.label}${q.id === 2 ? ' ✓ 默认' : ''}`)
  })
  return lines.join('\n')
}

function buildTemplateMessage(templates) {
  const lines = ['📋 选模板：']
  templates.forEach((t, i) => {
    lines.push(`${i + 1}. ${t.name}${t.description ? ' — ' + t.description : ''}`)
  })
  lines.push(`${templates.length + 1}. 自由模式（不套模板）`)
  return lines.join('\n')
}

// ─── inline keyboard 构造（Telegram 路径用） ─────────────────────
//
// callback_data 编码（≤ 64 字节硬限）：
//   workdir:    qt:wd:<idx>  / qt:wd:custom
//   quadrant:   qt:q:<1..4>
//   template:   qt:t:<idx>   / qt:t:none
//
// 数字按钮 label 沿用 "1. xxx" 序号 —— 跟纯文本 prompt 保持一致，
// 所以双轨用户（按按钮的 / 回数字的）看到的是同一个心智模型。
const CALLBACK_PREFIX = 'qt'

function ellipsisLabel(s, max = 50) {
  const str = String(s || '')
  if (str.length <= max) return str
  return '…' + str.slice(-(max - 1))
}

function buildWorkdirReplyMarkup(options) {
  // 每行 1 个：路径常常很长，2 列会强制换行难看
  const rows = options.map((opt, i) => [{
    text: `${i + 1}. ${ellipsisLabel(opt.path, 48)}`,
    callback_data: `${CALLBACK_PREFIX}:wd:${i}`,
  }])
  rows.push([{
    text: `${options.length + 1}. 🖋 自定义路径`,
    callback_data: `${CALLBACK_PREFIX}:wd:custom`,
  }])
  return { inline_keyboard: rows }
}

function buildQuadrantReplyMarkup() {
  // 2×2，Q2 默认勾上
  const label = (q) => `Q${q.id} ${q.label}${q.id === 2 ? ' ✓' : ''}`
  return {
    inline_keyboard: [
      [
        { text: label(QUADRANTS[0]), callback_data: `${CALLBACK_PREFIX}:q:1` },
        { text: label(QUADRANTS[1]), callback_data: `${CALLBACK_PREFIX}:q:2` },
      ],
      [
        { text: label(QUADRANTS[2]), callback_data: `${CALLBACK_PREFIX}:q:3` },
        { text: label(QUADRANTS[3]), callback_data: `${CALLBACK_PREFIX}:q:4` },
      ],
    ],
  }
}

function buildTemplateReplyMarkup(templates) {
  // 模板名也可能带描述 → 每行 1 个稳妥
  const rows = templates.map((t, i) => [{
    text: `${i + 1}. ${ellipsisLabel(t.name, 48)}`,
    callback_data: `${CALLBACK_PREFIX}:t:${i}`,
  }])
  rows.push([{
    text: `${templates.length + 1}. 🆓 自由模式`,
    callback_data: `${CALLBACK_PREFIX}:t:none`,
  }])
  return { inline_keyboard: rows }
}

function buildWorkdirPrompt(options) {
  return { text: buildWorkdirMessage(options), replyMarkup: buildWorkdirReplyMarkup(options) }
}

function buildQuadrantPrompt() {
  return { text: buildQuadrantMessage(), replyMarkup: buildQuadrantReplyMarkup() }
}

function buildTemplatePrompt(templates) {
  return { text: buildTemplateMessage(templates), replyMarkup: buildTemplateReplyMarkup(templates) }
}

/**
 * 把 (chatId, threadId) 映射成内部 wizards/lastPush 的复合 key。
 * Telegram 的 General topic（threadId=null）和具体 topic 用不同 key，互不干扰。
 * 老的 weixin 路径只有 peer（=chatId），threadId=null → key=`${peer}:general`，
 * 行为跟之前完全一致。
 */
function makeRouteKey(chatId, threadId) {
  return `${chatId}:${threadId || 'general'}`
}

/**
 * 是否为 Telegram supergroup 的 General 频道。
 *
 * supergroup 的 chatId 是负数且以 -100 开头，General 频道没有 message_thread_id。
 * 全局 quadtodo slash 命令（/list /stop 等）只在 General 响应：
 *   - General 不会有 PTY 直连，命令不会污染任何 AI 上下文
 *   - task topic 里发会被拦截 + 提示去 General 用
 *
 * 注意：weixin 之类的旧路径 chatId 不是 -100… 开头 → 返回 false → 不响应 quadtodo slash，
 * 走老的 fallback / PTY 转发逻辑（保持向后兼容）。
 */
function isGeneralChannel(chatId, threadId) {
  if (!chatId) return false
  if (threadId != null) return false
  return /^-100\d+/.test(String(chatId))
}

// quadtodo 全局 slash command 集合。仅在 General 频道响应；其它 topic 拦截并提示。
const QUADTODO_GLOBAL_SLASH = new Set(['list', 'pending', 'stop'])

/**
 * 创建协调器实例。
 *
 * 依赖：
 *   - db: createTodo, listTemplates, getTemplate, raw
 *   - aiTerminal: spawnSession({sessionId, todoId, prompt, tool, cwd, permissionMode, label, extraEnv})
 *   - openclaw: registerSessionRoute(sessionId, {targetUserId, threadId?, topicName?, ...})
 *   - pending: submitReply(text), listPending() （不直接被调用，但提供给路由层判断）
 *   - getConfig: () => 配置快照（拿 defaultCwd / port / defaultTool）
 *   - telegramBot: 可选，提供 createForumTopic / sendMessage —— 启用每任务一 topic
 */
export function createOpenClawWizard({
  db, aiTerminal, openclaw, pending,
  pty = null, telegramBot = null, loadingTracker = null,
  getConfig, logger = console,
} = {}) {
  if (!db) throw new Error('db_required')

  // routeKey → wizard state object
  const wizards = new Map()

  function getActiveWizard(routeKey) {
    const w = wizards.get(routeKey)
    if (!w) return null
    if (Date.now() - w.updatedAt > WIZARD_TIMEOUT_MS) {
      wizards.delete(routeKey)
      return null
    }
    return w
  }

  /**
   * 列工作目录候选：
   *   1) defaultCwd 自己（"默认目录"）
   *   2) defaultCwd 下的所有 1 级子目录（按字母排序）
   *   3) 历史 recent 里有但不在上面的（"recent"）
   *
   * 跟 web 端 `/api/config/workdirs` 行为对齐 —— 用户在 telegram 也能选到子目录。
   */
  function listWorkdirOptions() {
    const cfg = getConfig?.() || {}
    const out = []
    const seen = new Set()
    const defCwd = cfg.defaultCwd

    // 1. 默认目录本身
    if (defCwd && !seen.has(defCwd)) {
      out.push({ path: defCwd, source: 'default' })
      seen.add(defCwd)
    }

    // 2. 默认目录的所有 1 级子目录（按字母）
    if (defCwd && existsSync(defCwd)) {
      try {
        const subs = readdirSync(defCwd, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
          .map((entry) => join(defCwd, entry.name))
          .sort((a, b) => basename(a).localeCompare(basename(b), 'zh-Hans-CN'))
        for (const p of subs) {
          if (!seen.has(p)) {
            out.push({ path: p, source: 'subdir' })
            seen.add(p)
          }
        }
      } catch (e) {
        logger.warn?.(`[wizard] readdirSync ${defCwd} failed: ${e.message}`)
      }
    }

    // 3. 历史 recent 里独立条目（用过但不在上面）
    const recent = defaultRecentWorkDirs(db, 5)
    for (const r of recent) {
      if (!seen.has(r.path)) {
        out.push({ ...r, source: 'recent' })
        seen.add(r.path)
      }
    }

    return out
  }

  function startWizard({ chatId, threadId, text, messageId = null }) {
    const routeKey = makeRouteKey(chatId, threadId)
    const title = extractTitle(text) || '(未命名任务)'
    const workdirHint = tryExtractWorkdir(text)
    const quadrantHint = tryExtractQuadrant(text)
    const templateHint = tryExtractTemplateHint(text)

    const w = {
      peer: chatId,        // 兼容字段（旧代码读 w.peer）
      chatId,
      threadId,
      triggerMessageId: messageId,   // 用户触发本任务的消息 id（D 方案：tracker 加 reaction）
      routeKey,
      title,
      workdirOptions: listWorkdirOptions(),
      chosenWorkdir: workdirHint || null,
      chosenQuadrant: quadrantHint || null,
      chosenTemplate: null,
      step: STEP_WORKDIR,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    }

    // 模板 hint 解析
    if (templateHint) {
      const tpl = findTemplateByHint(db.listTemplates(), templateHint)
      if (tpl) w.chosenTemplate = { id: tpl.id, name: tpl.name }
    }

    // 自动跳过已填字段
    if (w.chosenWorkdir) w.step = STEP_QUADRANT
    if (w.chosenWorkdir && w.chosenQuadrant) w.step = STEP_TEMPLATE
    if (w.chosenWorkdir && w.chosenQuadrant && w.chosenTemplate) w.step = STEP_DONE

    wizards.set(routeKey, w)
    return w
  }

  function abortWizard(routeKey) {
    const had = wizards.has(routeKey)
    wizards.delete(routeKey)
    return had
  }

  /**
   * 推进 wizard 一步。返回 { reply, replyMarkup?, done? }。
   * replyMarkup 仅在 prompt 性 reply 时附带（让 telegram-bot dispatch 自动塞按钮）。
   */
  async function advance(w, text) {
    w.updatedAt = Date.now()

    // ─── workdir 步 ───
    if (w.step === STEP_WORKDIR) {
      // 自定义路径子态：用户点过 inline 「自定义」按钮，下一条任意非空文本都当路径，
      // 不再走数字 / `/`/`~` 检测。这是 callback_query 路径独有的子态——
      // 文本路径下用户直接粘 `/path` 也仍然走老逻辑。
      if (w.awaitingCustomWorkdir) {
        const path = text.trim()
        if (!path) return { reply: '🖋 路径为空，请重发' }
        w.chosenWorkdir = path
        w.awaitingCustomWorkdir = false
        w.step = STEP_QUADRANT
        const prompt = buildQuadrantPrompt()
        return { reply: prompt.text, replyMarkup: prompt.replyMarkup }
      }
      // 数字选项？
      const idx = parseNumericChoice(text, w.workdirOptions.length + 1)
      if (idx !== null) {
        if (idx < w.workdirOptions.length) {
          w.chosenWorkdir = w.workdirOptions[idx].path
          w.step = STEP_QUADRANT
          const prompt = buildQuadrantPrompt()
          return { reply: prompt.text, replyMarkup: prompt.replyMarkup }
        } else {
          // 选了"自定义"
          return { reply: '🖋 请输入完整路径（绝对路径或 ~/ 开头）' }
        }
      }
      // 自定义路径（文本路径下的隐式触发，老行为）
      if (text.startsWith('/') || text.startsWith('~')) {
        w.chosenWorkdir = text.trim()
        w.step = STEP_QUADRANT
        const prompt = buildQuadrantPrompt()
        return { reply: prompt.text, replyMarkup: prompt.replyMarkup }
      }
      // 看不懂 → 重发提示（保留按钮）
      const prompt = buildWorkdirPrompt(w.workdirOptions)
      return {
        reply: `🤔 没看懂，请点按钮 / 回数字 1-${w.workdirOptions.length + 1} 或粘贴一个绝对路径。\n\n${prompt.text}`,
        replyMarkup: prompt.replyMarkup,
      }
    }

    // ─── quadrant 步 ───
    if (w.step === STEP_QUADRANT) {
      const num = String(text).trim().match(/^([1-4])$/)
      if (num) {
        w.chosenQuadrant = Number(num[1])
      } else if (/默认|default|^$/i.test(text.trim())) {
        w.chosenQuadrant = 2
      } else {
        const prompt = buildQuadrantPrompt()
        return {
          reply: `🤔 请点按钮或回 1-4 选象限，回 "默认" 用 Q2。\n\n${prompt.text}`,
          replyMarkup: prompt.replyMarkup,
        }
      }
      w.step = STEP_TEMPLATE
      const templates = db.listTemplates()
      w.cachedTemplates = templates
      const prompt = buildTemplatePrompt(templates)
      return { reply: prompt.text, replyMarkup: prompt.replyMarkup }
    }

    // ─── template 步 ───
    if (w.step === STEP_TEMPLATE) {
      const templates = w.cachedTemplates || db.listTemplates()
      const idx = parseNumericChoice(text, templates.length + 1)
      if (idx !== null) {
        if (idx < templates.length) {
          w.chosenTemplate = { id: templates[idx].id, name: templates[idx].name }
        } else {
          // 自由模式
          w.chosenTemplate = null
        }
      } else if (/自由|skip|无|none/i.test(text.trim())) {
        w.chosenTemplate = null
      } else {
        // 试模板名匹配
        const tpl = findTemplateByHint(templates, text.trim())
        if (tpl) {
          w.chosenTemplate = { id: tpl.id, name: tpl.name }
        } else {
          const prompt = buildTemplatePrompt(templates)
          return {
            reply: `🤔 请点按钮 / 回数字 1-${templates.length + 1}，或模板名（自由/无）。\n\n${prompt.text}`,
            replyMarkup: prompt.replyMarkup,
          }
        }
      }
      w.step = STEP_DONE
      return await finalizeWizard(w)
    }

    return { reply: '🤔 wizard 状态异常，请重试' }
  }

  async function finalizeWizard(w) {
    try {
      // 创建 todo
      const todo = db.createTodo({
        title: w.title,
        quadrant: w.chosenQuadrant || 2,
        description: '',
        workDir: w.chosenWorkdir || null,
        brainstorm: false,
      })

      const shortCode = String(todo.id).replace(/[^a-z0-9]/gi, '').slice(-3).toLowerCase()
      const topicName = `#t${shortCode} ${w.title}`.slice(0, 128)

      // ── 新增：尝试创建 Telegram Topic（只在有 telegramBot 且 chatId 是 telegram 数字 ID 时）──
      let createdThreadId = null
      const canCreateTopic = !!telegramBot?.createForumTopic
      const looksLikeTelegram = w.chatId && /^-?\d+$/.test(String(w.chatId))   // 只有 telegram chat id 是纯数字
      logger.info?.(`[wizard] finalize: chatId=${w.chatId} canCreateTopic=${canCreateTopic} looksLikeTelegram=${looksLikeTelegram} topicName="${topicName}"`)
      if (canCreateTopic && looksLikeTelegram) {
        // 网络抖动重试 1 次：createForumTopic 经常因 fetch failed / timeout 等瞬时错误挂掉，
        // 跟 sendMessage / 图片下载的策略一致 —— 1s 后重试，再失败才 fallback
        const tryCreateTopic = () => telegramBot.createForumTopic({ chatId: w.chatId, name: topicName })
        try {
          let topic
          try { topic = await tryCreateTopic() }
          catch (e1) {
            if (/fetch failed|fetch_error|aborted|timeout/i.test(e1.message)) {
              logger.warn?.(`[wizard] createForumTopic transient error (${e1.message}); retrying once in 1s`)
              await new Promise((res) => setTimeout(res, 1000))
              topic = await tryCreateTopic()
            } else {
              throw e1
            }
          }
          createdThreadId = topic?.message_thread_id || null
          logger.info?.(`[wizard] createForumTopic OK threadId=${createdThreadId}`)
        } catch (e) {
          logger.warn?.(`[wizard] createForumTopic FAILED after retry: ${e.message}; chatId=${w.chatId} name="${topicName}"; falling back to General`)
        }
      } else if (!canCreateTopic) {
        logger.info?.(`[wizard] no telegramBot — skipping topic creation (likely weixin path)`)
      } else if (!looksLikeTelegram) {
        logger.info?.(`[wizard] chatId="${w.chatId}" is not telegram-shaped (numeric); skipping topic creation`)
      }

      // 启动 PTY
      let sessionInfo = null
      if (aiTerminal?.spawnSession) {
        const cfg = getConfig?.() || {}
        const tool = cfg.defaultTool || 'claude'
        const port = cfg.port || 5677
        const sessionId = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

        let prompt
        if (w.chosenTemplate) {
          const tpl = db.getTemplate(w.chosenTemplate.id)
          if (tpl) {
            prompt = `${tpl.content}\n\n---\n任务: ${w.title}`
          } else {
            prompt = `任务: ${w.title}`
          }
        } else {
          prompt = `任务: ${w.title}`
        }
        // 强制 prepend "拍板必须用 ask_user MCP" 工程纪律 — 让 telegram 端按钮交互生效
        // config.aiSession.enforceAskUserRule = false 可关
        prompt = applySystemRules(prompt, { enforce: cfg.aiSession?.enforceAskUserRule !== false })

        const extraEnv = {
          QUADTODO_SESSION_ID: sessionId,
          QUADTODO_TODO_ID: String(todo.id),
          QUADTODO_TODO_TITLE: String(w.title),
          QUADTODO_URL: `http://127.0.0.1:${port}`,
        }
        if (w.peer) extraEnv.QUADTODO_TARGET_USER = String(w.peer)

        if (openclaw?.registerSessionRoute && w.peer) {
          openclaw.registerSessionRoute(sessionId, {
            targetUserId: w.peer,
            threadId: createdThreadId,    // ← 关键：把 topic 的 thread id 绑到 session 上
            topicName,                    // ← 给 SessionEnd 改名 ✅ 用
            triggerMessageId: w.triggerMessageId || null,   // D 方案：tracker 加 reaction 用
            account: null,
            channel: null,
          })
        }

        try {
          aiTerminal.spawnSession({
            sessionId,
            todoId: todo.id,
            prompt,
            tool,
            cwd: w.chosenWorkdir || cfg.defaultCwd || null,
            permissionMode: 'bypass',
            label: w.chosenTemplate ? `template:${w.chosenTemplate.name}` : null,
            extraEnv,
            skipTelegram: true,   // wizard 自管 topic（下面单独 createForumTopic）
          })
          sessionInfo = { sessionId, tool }
        } catch (e) {
          logger.warn?.(`[wizard] spawnSession failed: ${e.message}`)
        }

        // 持久化路由到 DB.todo.aiSessions[i].telegramRoute（在 spawnSession 之后，
        // 此时 aiSessions[0] 已被写入）→ quadtodo 重启时 recoverPendingTodosOnStartup
        // 复活 session 时通过 mergeTodoAiSessions 的 spread 保留 telegramRoute；
        // server.js 启动时扫描 ait.sessions 并 re-register 到 openclaw-bridge
        if (createdThreadId && sessionInfo) {
          try {
            const todoNow = db.getTodo(todo.id)
            if (todoNow) {
              const route = {
                targetUserId: w.peer,
                threadId: createdThreadId,
                topicName,
                channel: 'telegram',
              }
              const updatedSessions = (todoNow.aiSessions || []).map((s) =>
                s.sessionId === sessionId ? { ...s, telegramRoute: route } : s,
              )
              db.updateTodo(todo.id, { aiSessions: updatedSessions })
            }
          } catch (e) {
            logger.warn?.(`[wizard] persist telegramRoute failed: ${e.message}`)
          }
        }
      }

      // 给新 topic 推欢迎消息
      if (createdThreadId && telegramBot?.sendMessage && w.chatId) {
        const welcome = [
          `🤖 任务「${w.title}」AI 已启动 (${sessionInfo?.tool || 'claude'})`,
          ``,
          `象限 Q${w.chosenQuadrant || 2} · 目录 ${w.chosenWorkdir || '默认'} · 模板 ${w.chosenTemplate?.name || '自由模式'}`,
          ``,
          `AI 一轮回话/卡住/结束会推到这里。直接回任意文本会写进 PTY stdin。`,
        ].join('\n')
        telegramBot.sendMessage({
          chatId: w.chatId,
          threadId: createdThreadId,
          text: welcome,
        }).catch((e) => logger.warn?.(`[wizard] welcome message failed: ${e.message}`))
      }

      wizards.delete(w.routeKey)

      // 在 General topic 回的 ack 短消息
      const lines = []
      if (createdThreadId) {
        lines.push(`✅ todo #${shortCode} 已建 → 去 topic 「${topicName}」 看进度`)
        lines.push(`   Q${w.chosenQuadrant || 2} · ${w.chosenWorkdir || '默认目录'} · ${w.chosenTemplate?.name || '自由模式'}`)
      } else {
        lines.push(`✅ todo #${shortCode} 已建`)
        lines.push(`   标题: ${w.title}`)
        lines.push(`   象限: Q${w.chosenQuadrant || 2}`)
        lines.push(`   目录: ${w.chosenWorkdir || '默认'}`)
        lines.push(`   模板: ${w.chosenTemplate?.name || '自由模式'}`)
        if (sessionInfo) {
          lines.push(`🤖 ${sessionInfo.tool} 终端已启动 (sessionId: ${sessionInfo.sessionId.slice(-8)})`)
        }
      }
      return {
        reply: lines.join('\n'),
        done: true,
        action: 'wizard_done',
        todoId: todo.id,
        threadId: createdThreadId,
      }
    } catch (e) {
      wizards.delete(w.routeKey)
      logger.warn?.(`[wizard] finalize failed: ${e.message}`)
      return { reply: `❌ 创建任务失败: ${e.message}`, action: 'wizard_failed' }
    }
  }

  /**
   * 给一个已起来的 PTY session 确保有对应的 Telegram topic（幂等）。
   * 用于：web UI / MCP / CLI 等非 wizard 路径起 session 时自动镜像到 Telegram。
   * 已绑定路由 / 已持久化 telegramRoute → 直接 no-op；否则建 topic + 注路由 + 持久化。
   */
  async function ensureTopicForSession({ sessionId, todoId } = {}) {
    if (!sessionId || !todoId) return { ok: false, reason: 'missing_args' }
    if (!telegramBot?.createForumTopic) return { ok: false, reason: 'no_telegram_bot' }

    // 已有路由 → 跳过
    const existing = openclaw?.resolveRoute?.(sessionId)
    if (existing && existing.threadId) return { ok: true, action: 'already_bound' }

    // DB 里已持久化（rehydrate 时常见）→ 重注路由就行
    const todo = db.getTodo(todoId)
    if (!todo) return { ok: false, reason: 'todo_not_found' }
    const aiSess = (todo.aiSessions || []).find((s) => s.sessionId === sessionId)
    if (aiSess?.telegramRoute?.threadId) {
      openclaw?.registerSessionRoute?.(sessionId, aiSess.telegramRoute)
      return { ok: true, action: 're-registered', threadId: aiSess.telegramRoute.threadId }
    }

    // 决定 chatId：优先 telegram.defaultSupergroupId，回退 allowedChatIds[0]
    const cfg = getConfig?.() || {}
    const tg = cfg.telegram || {}
    const chatId = tg.defaultSupergroupId || (Array.isArray(tg.allowedChatIds) ? tg.allowedChatIds[0] : null)
    if (!chatId) return { ok: false, reason: 'no_default_chat_id' }

    // 拼名字：#tXXX <title>
    const shortCode = String(todoId).replace(/[^a-zA-Z0-9]/g, '').slice(-4).toLowerCase() || 'auto'
    const title = (todo.title || `todo-${shortCode}`).slice(0, 96)
    const topicName = `#t${shortCode} ${title}`.slice(0, 128)

    let threadId = null
    try {
      const topic = await telegramBot.createForumTopic({ chatId: String(chatId), name: topicName })
      threadId = topic?.message_thread_id || null
    } catch (e) {
      logger.warn?.(`[wizard] auto-create topic failed: ${e.message}`)
      return { ok: false, reason: 'create_topic_failed', detail: e.message }
    }
    if (!threadId) return { ok: false, reason: 'no_thread_id' }

    const route = {
      targetUserId: String(chatId),
      threadId,
      topicName,
      channel: 'telegram',
    }
    openclaw?.registerSessionRoute?.(sessionId, route)

    // 持久化到 DB
    try {
      const tnow = db.getTodo(todoId)
      const updatedSessions = (tnow?.aiSessions || []).map((s) =>
        s.sessionId === sessionId ? { ...s, telegramRoute: route } : s,
      )
      if (updatedSessions.length) db.updateTodo(todoId, { aiSessions: updatedSessions })
    } catch (e) {
      logger.warn?.(`[wizard] persist auto-route failed: ${e.message}`)
    }

    if (telegramBot?.sendMessage) {
      telegramBot.sendMessage({
        chatId: String(chatId),
        threadId,
        text: `🤖 任务「${title}」AI 已起（自动镜像 from web/CLI）\n直接回这里转给 PTY stdin；关闭话题 = 标完成。`,
      }).catch((e) => logger.warn?.(`[wizard] auto-welcome failed: ${e.message}`))
    }

    logger.info?.(`[wizard] auto-bound session ${sessionId} → topic threadId=${threadId} (todo ${todoId})`)
    return { ok: true, action: 'created', threadId }
  }

  /**
   * 通过 telegramRoute.threadId 反查 todo + aiSession。
   * 优先 DB 持久化路由；缺失时用 bridge in-memory 路由 + aiTerminal.sessions 兜底
   * （防老 session 没持久化 telegramRoute 但仍在内存里活着的情况）。
   */
  function findTodoByThreadId(chatId, threadId) {
    if (!threadId) return null
    const tid = Number(threadId)
    const todos = db.listTodos({ status: 'all' }) || db.listTodos() || []
    for (const t of todos) {
      const ai = (t.aiSessions || []).find((s) => s?.telegramRoute?.threadId === tid
        && String(s.telegramRoute.targetUserId) === String(chatId))
      if (ai) return { todo: t, aiSession: ai }
    }
    // 兜底：bridge 内存路由
    if (openclaw?.findSessionByRoute && aiTerminal?.sessions) {
      const sid = openclaw.findSessionByRoute({ chatId: String(chatId), threadId: tid })
      if (sid) {
        const sess = aiTerminal.sessions.get(sid)
        if (sess?.todoId) {
          const todo = db.getTodo(sess.todoId)
          if (todo) {
            // 构造一个假 aiSession（DB 里没持久化，能跑就行）
            const route = openclaw.resolveRoute?.(sid) || {}
            const fakeAi = {
              sessionId: sid,
              tool: sess.tool,
              nativeSessionId: sess.nativeSessionId,
              telegramRoute: {
                targetUserId: route.targetUserId || String(chatId),
                threadId: tid,
                topicName: route.topicName || todo.title,
                channel: 'telegram',
              },
            }
            return { todo, aiSession: fakeAi }
          }
        }
      }
    }
    return null
  }

  /**
   * 处理话题生命周期事件：关闭 / 重开。
   * 关闭：mark todo done，杀 PTY，清路由，话题改名 ✅。
   * 重开：respawn PTY (--resume nativeSessionId)，恢复路由，撤掉 ✅。
   */
  async function handleTopicEvent({ type, chatId, threadId } = {}) {
    if (!chatId || !threadId) return { ok: false, reason: 'missing_args' }
    if (type !== 'closed' && type !== 'reopened') return { ok: false, reason: 'unknown_type' }

    const found = findTodoByThreadId(String(chatId), Number(threadId))
    if (!found) {
      logger.warn?.(`[wizard] topic ${type}: no todo bound to chatId=${chatId} threadId=${threadId}`)
      return { ok: false, reason: 'no_todo' }
    }
    const { todo, aiSession } = found
    const topicName = aiSession.telegramRoute?.topicName || todo.title

    if (type === 'closed') {
      // 1) 杀 PTY（如果还活着，找它的 sessionId）
      // 关键：先在 session 上打"用户关话题"标记，PTY 的 done 事件晚到时
      // 不会用 stopped→'todo' 的默认逻辑覆写我们刚写的 status='done'。
      let killedSid = null
      if (openclaw?.findSessionByRoute) {
        const sid = openclaw.findSessionByRoute({ chatId: String(chatId), threadId })
        if (sid) {
          killedSid = sid
          const sess = aiTerminal?.sessions?.get?.(sid)
          if (sess) sess.userClosedReason = 'topic_closed'
          if (pty?.stop) {
            try { pty.stop(sid) } catch (e) { logger.warn?.(`[wizard] pty.stop failed: ${e.message}`) }
          }
          openclaw.clearSessionRoute?.(sid, 'topic-closed')
        }
      }

      // 2) 标 todo done（保留 aiSessions，里面 telegramRoute 还在 → 重开能反查）
      try {
        db.updateTodo(todo.id, { status: 'done', completedAt: Date.now() })
      } catch (e) {
        logger.warn?.(`[wizard] mark done failed: ${e.message}`)
      }

      // 3) 改话题名 ✅
      if (telegramBot?.editForumTopic && !topicName.startsWith('✅')) {
        telegramBot.editForumTopic({
          chatId,
          threadId,
          name: `✅ ${topicName}`.slice(0, 128),
        }).catch((e) => logger.warn?.(`[wizard] editForumTopic ✅ failed: ${e.message}`))
      }
      logger.info?.(`[wizard] topic closed → todo ${todo.id} done; killed sid=${killedSid || '(none alive)'}`)
      return { ok: true, action: 'closed', todoId: todo.id, killedSid }
    }

    // type === 'reopened'
    if (!aiSession.nativeSessionId) {
      logger.warn?.(`[wizard] topic reopened but no nativeSessionId → cannot resume todo ${todo.id}`)
      return { ok: false, reason: 'no_native_session' }
    }
    const cfg = getConfig?.() || {}
    const port = cfg.port || 5677
    const newSessionId = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const extraEnv = {
      QUADTODO_SESSION_ID: newSessionId,
      QUADTODO_TODO_ID: String(todo.id),
      QUADTODO_TODO_TITLE: String(todo.title),
      QUADTODO_URL: `http://127.0.0.1:${port}`,
      QUADTODO_TARGET_USER: String(chatId),
    }
    try {
      aiTerminal.spawnSession({
        sessionId: newSessionId,
        todoId: todo.id,
        prompt: '继续之前的任务',
        tool: aiSession.tool || 'claude',
        cwd: aiSession.cwd || cfg.defaultCwd || null,
        permissionMode: 'bypass',
        extraEnv,
        resumeNativeId: aiSession.nativeSessionId,
        skipTelegram: true,   // 重开走的是已存在 topic（重注路由），不另建
      })
    } catch (e) {
      logger.warn?.(`[wizard] resume spawnSession failed: ${e.message}`)
      return { ok: false, reason: 'spawn_failed', detail: e.message }
    }
    if (openclaw?.registerSessionRoute) {
      openclaw.registerSessionRoute(newSessionId, {
        targetUserId: String(chatId),
        threadId,
        topicName: topicName.replace(/^✅\s*/, ''),
        channel: 'telegram',
      })
    }
    db.updateTodo(todo.id, { status: 'ai_running' })
    if (telegramBot?.editForumTopic && topicName.startsWith('✅')) {
      telegramBot.editForumTopic({
        chatId,
        threadId,
        name: topicName.replace(/^✅\s*/, '').slice(0, 128),
      }).catch((e) => logger.warn?.(`[wizard] editForumTopic restore failed: ${e.message}`))
    }
    if (telegramBot?.sendMessage) {
      telegramBot.sendMessage({
        chatId,
        threadId,
        text: `🔄 任务「${topicName.replace(/^✅\s*/, '')}」已恢复（resume nativeId=${aiSession.nativeSessionId.slice(0, 8)}…），继续聊吧。`,
      }).catch((e) => logger.warn?.(`[wizard] reopen welcome failed: ${e.message}`))
    }
    logger.info?.(`[wizard] topic reopened → todo ${todo.id} resumed; new sid=${newSessionId}`)
    return { ok: true, action: 'reopened', todoId: todo.id, sessionId: newSessionId }
  }

  /**
   * 给状态机喂一条用户消息。两种入参形式：
   *   旧：{ peer, text }                        ← weixin / OpenClaw skill 路径
   *   新：{ chatId, threadId, text, fromUserId } ← Telegram 直连路径
   * 内部统一为 { chatId, threadId, text } + routeKey。
   */
  async function handleInbound(args = {}) {
    // 兼容老路径
    const chatId = args.chatId != null ? String(args.chatId) : (args.peer != null ? String(args.peer) : null)
    const threadId = args.threadId != null ? args.threadId : null
    const text = args.text || ''
    const messageId = args.messageId != null ? args.messageId : null
    const replyToMessageId = args.replyToMessageId != null ? args.replyToMessageId : null
    // 入站图片本地路径（已下载好），格式：[abs_path, ...]
    const imagePaths = Array.isArray(args.imagePaths) ? args.imagePaths.filter(Boolean) : []
    const peer = chatId  // 内部用，跟旧代码保持一致
    if (!chatId) return { reply: '⚠️ 缺 from chatId，无法路由' }
    // 空消息允许 —— 只要带了图就算有效输入
    if (!text && imagePaths.length === 0) return { reply: '🤔 空消息，请重试' }
    if (typeof text !== 'string') return { reply: '🤔 空消息，请重试' }
    const trimmed = text.trim()
    const routeKey = makeRouteKey(chatId, threadId)

    // 0. ask_user 的 ✏️ 补充流：如果是回复我们的 force_reply 提示 → 拼"选项 · 补充"调 submitReply
    //    放在最顶 —— 优先级高于 wizard / ask_user ticket / PTY proxy；
    //    匹配条件极强（必须 reply_to 我们之前发的特定 messageId），不会误中。
    if (replyToMessageId && pending?.submitReply) {
      const ctx = consumeForceReplyContext(chatId, replyToMessageId)
      if (ctx) {
        const merged = buildExtendedReplyText(ctx.optionLabel, trimmed)
        // 显式 ticket 路由：用 #ticket 前缀确保不会误中"最新 pending"
        const result = pending.submitReply(`#${ctx.ticket} ${merged}`)
        if (result.matched) {
          return {
            reply: `✓ 已回答 [#${result.ticket}]\n   ${merged.slice(0, 120)}${merged.length > 120 ? '…' : ''}`,
            action: 'ask_user_extended',
            ticket: result.ticket,
          }
        }
        // ticket 已过期 / 被取消 → 友好降级
        return {
          reply: `⚠️ 这条补充对应的 ticket #${ctx.ticket} 已结束（${result.reason}），未送达 AI。`,
          action: 'ask_user_extended_stale',
        }
      }
    }

    // 1. 取消语 + 有向导 → 中止
    if (CANCEL_TRIGGERS.some((re) => re.test(trimmed))) {
      const had = abortWizard(routeKey)
      if (had) return { reply: '✓ 已取消向导', action: 'wizard_cancelled' }
      // 无向导 — fallthrough 让 ask_user 也能取消
    }

    // 1.5 退出 PTY 直连 → 清掉 lastPushedSession
    if (DETACH_TRIGGERS.some((re) => re.test(trimmed))) {
      const cleared = openclaw?.clearLastPushForPeer?.(peer)
      if (cleared) {
        return {
          reply: '✓ 已退出 PTY 直连模式。下次发消息会按普通流程处理（新任务 / fallback）。',
          action: 'detached',
        }
      }
      return {
        reply: '🤔 当前不在 PTY 直连模式，没什么可退出的。',
        action: 'no_active_link',
      }
    }

    // 1.7 quadtodo 全局 slash command（/list /pending /stop）
    //
    // 仅在 Telegram supergroup 内识别（chatId 以 -100 开头）。
    //  - General 频道（threadId=null）→ 执行命令
    //  - task topic 里发 → 拦截 + 提示去 General 用，避免被 PTY 转发污染 AI 上下文
    //  - 非 supergroup（weixin / 私聊 / 任何不带 -100 前缀的 peer）→ fallthrough，
    //    交给老路径（PTY proxy / fallback），不假设那里有 General 概念
    //
    // 优先级：放在 active wizard / NEW_TASK / ask_user / PTY proxy 之前，
    // 这样在 wizard 进行中也能用 /list 看一眼任务列表（不影响 wizard 状态）。
    const quadtodoSlash = trimmed.match(/^\/([a-z][a-z0-9_]*)\b\s*(.*)$/i)
    const isSupergroup = chatId && /^-100\d+/.test(String(chatId))
    if (isSupergroup && quadtodoSlash && QUADTODO_GLOBAL_SLASH.has(quadtodoSlash[1].toLowerCase())) {
      const cmd = quadtodoSlash[1].toLowerCase()
      const argText = quadtodoSlash[2].trim()
      if (isGeneralChannel(chatId, threadId)) {
        return handleSlashCommand({ cmd, argText, chatId, threadId })
      }
      return {
        reply: `⚠️ /${cmd} 只在 General 频道用（避免污染当前 task topic 的 AI 上下文）。\n\n请到 General 里发 /${cmd}。`,
        action: 'slash_wrong_topic',
        blockedCommand: cmd,
      }
    }

    // 2. 进行中 wizard → 推进
    const active = getActiveWizard(routeKey)
    if (active) {
      // 触发完成动作的 message id 总是最新一条 → 滚动更新
      if (messageId) active.triggerMessageId = messageId
      // 如果用户在 wizard 中又发新任务触发词 → 重启
      if (NEW_TASK_TRIGGERS.some((re) => re.test(trimmed))) {
        wizards.delete(routeKey)
        const w = startWizard({ chatId, threadId, text: trimmed, messageId })
        if (w.step === STEP_DONE) return await finalizeWizard(w)
        if (w.step === STEP_QUADRANT) {
          const p = buildQuadrantPrompt()
          return { reply: `（已重启向导，跳过目录步）\n${p.text}`, replyMarkup: p.replyMarkup }
        }
        if (w.step === STEP_TEMPLATE) {
          const tpls = db.listTemplates()
          w.cachedTemplates = tpls
          const p = buildTemplatePrompt(tpls)
          return { reply: `（已重启向导，跳过目录+象限步）\n${p.text}`, replyMarkup: p.replyMarkup }
        }
        const p = buildWorkdirPrompt(w.workdirOptions)
        return { reply: `（已重启向导）\n${p.text}`, replyMarkup: p.replyMarkup, action: 'wizard_started' }
      }
      const out = await advance(active, trimmed)
      return { ...out, action: out.done ? 'wizard_done' : 'wizard_step' }
    }

    // 3. 看起来像新任务 → 启动向导（必须在 ask_user 路由之前，避免被当 free text 吃掉）
    if (NEW_TASK_TRIGGERS.some((re) => re.test(trimmed))) {
      const w = startWizard({ chatId, threadId, text: trimmed, messageId })
      if (w.step === STEP_DONE) return await finalizeWizard(w)
      if (w.step === STEP_QUADRANT) {
        const p = buildQuadrantPrompt()
        return {
          reply: `任务: ${w.title}\n（目录已识别为 ${w.chosenWorkdir}）\n\n${p.text}`,
          replyMarkup: p.replyMarkup,
          action: 'wizard_started',
        }
      }
      if (w.step === STEP_TEMPLATE) {
        const tpls = db.listTemplates()
        w.cachedTemplates = tpls
        const p = buildTemplatePrompt(tpls)
        return {
          reply: `任务: ${w.title}\n（目录+象限已识别）\n\n${p.text}`,
          replyMarkup: p.replyMarkup,
          action: 'wizard_started',
        }
      }
      const p = buildWorkdirPrompt(w.workdirOptions)
      return {
        reply: `任务: ${w.title}\n\n${p.text}`,
        replyMarkup: p.replyMarkup,
        action: 'wizard_started',
      }
    }

    // 4. pending ask_user → 路由
    if (pending?.submitReply) {
      const probe = pending.submitReply(trimmed)
      if (probe.matched) {
        const lines = [
          `✓ 已回复 [#${probe.ticket}]`,
        ]
        if (probe.chosen != null) lines.push(`   选了: ${probe.chosenIndex + 1}. ${probe.chosen}`)
        else lines.push(`   自由文本回填: ${probe.answerText.slice(0, 80)}`)
        return { reply: lines.join('\n'), action: 'ask_user_replied', ticket: probe.ticket }
      }
      // probe.reason: empty | no_pending | ticket_not_pending
      if (probe.reason === 'ticket_not_pending') {
        return { reply: `⚠️ ticket #${probe.ticket} 已结束（超时/取消/已答复），无需再回。`, action: 'ask_user_stale' }
      }
      // no_pending / empty → fallthrough
    }

    // 5. PTY stdin proxy：4 级路由策略
    //   a) Telegram thread 路由：当前消息来自一个 task topic →反查绑定到这个 (chatId, threadId)
    //      的 PTY session（最准确，0 歧义）
    //   b) peer 最近收过推送（lastPushByPeer）→ 那个 session
    //   c) 系统里只有 1 个活跃 PTY session → 写它（单用户 + 单任务场景）
    //   d) 多个活跃 → 列出来让用户选
    //
    // 安全门：supergroup 的 General 频道（threadId 空）禁用 (b)/(c) 模糊匹配 ——
    // 用户截图反馈："General 发的话不该转给任何 PTY，差点污染上下文"。
    // 在 General 只允许严格 thread 匹配 (a)，但 (a) 在 General 里必然匹配失败（没 threadId），
    // 等于完全跳过 stdin proxy → 落到 fallback reply 提示用户。
    const isInGeneralOfSupergroup =
      chatId && /^-100\d+/.test(String(chatId)) && (threadId == null || threadId === undefined)
    if (pty?.write && !isInGeneralOfSupergroup) {
      const targetSid = (() => {
        // a) thread 精确路由：找绑定到 (chatId, threadId) 的 sessionId
        if (threadId && openclaw?.findSessionByRoute) {
          const sid = openclaw.findSessionByRoute({ chatId, threadId })
          if (sid && pty.has?.(sid)) return sid
        }
        // b) lastPushByPeer
        const recent = openclaw?.getLastPushedSession?.(peer)
        if (recent && pty.has?.(recent)) return recent
        // c) fallback：系统里的活跃 session（带 todo 上下文，给 ambiguous 提示用）
        if (!aiTerminal?.sessions) return null
        const enriched = findActiveSessions()  // 已含 todo title + 按时间倒序
        if (enriched.length === 1) return enriched[0].sid
        if (enriched.length > 1) {
          return { ambiguous: true, candidates: enriched }
        }
        return null
      })()

      if (targetSid && typeof targetSid === 'string') {
        // ESC 兜底：用户已经卡在 modal 里 → 发文本 "esc" / "退出菜单" / "cancel modal"
        // 我们把它翻译成单字节 \x1b 写到 PTY stdin，触发 Claude Code TUI 退出 modal
        if (ESC_TRIGGERS.some((re) => re.test(trimmed))) {
          try {
            pty.write(targetSid, '\x1b')
            return {
              reply: '✓ 已发送 Esc（应该会退出当前 modal）',
              action: 'stdin_proxy_esc',
              sessionId: targetSid,
            }
          } catch (e) {
            logger.warn?.(`[wizard] esc proxy failed: ${e.message}`)
          }
        }

        // Ctrl+C 中断：写 `\x03` 到 PTY → SIGINT → Claude Code 打断当前 turn / 工具执行
        if (INTERRUPT_TRIGGERS.some((re) => re.test(trimmed))) {
          try {
            pty.write(targetSid, '\x03')
            return {
              reply: '✓ 已发送 Ctrl+C（应该会打断当前任务）',
              action: 'stdin_proxy_interrupt',
              sessionId: targetSid,
            }
          } catch (e) {
            logger.warn?.(`[wizard] interrupt proxy failed: ${e.message}`)
          }
        }

        // 黑名单：interactive slash command 在 Telegram 没法用（Esc 发不出来 → 卡死）
        // 拦截不转发，引导用户去 web 终端
        const slashMatch = trimmed.match(/^\/([a-z0-9_]+)\b/i)
        if (slashMatch && INTERACTIVE_SLASH_COMMANDS.has(slashMatch[1].toLowerCase())) {
          return {
            reply: [
              `⚠️ /${slashMatch[1]} 是 Claude Code 的 modal 命令，在 Telegram 用会卡死`,
              `（modal 要按 Esc 退出，Telegram 发不出 Esc 键）`,
              ``,
              `请去 web 终端用：http://127.0.0.1:5677/ai-terminal`,
              ``,
              `如果你已经卡在 modal 里：回 esc / 退出菜单 → 我帮你发 Esc 键`,
            ].join('\n'),
            action: 'interactive_command_blocked',
            blocked: slashMatch[1].toLowerCase(),
          }
        }

        try {
          // 用户从 telegram 发新输入 → 标题切回 🔄（如果当前是 💤）
          loadingTracker?.markRunning?.(targetSid)?.catch?.(() => {})
          // 组装 PTY 输入：图片用 Claude Code 的 `@path` attach 语法
          //   纯文本：    "text"
          //   纯图片：    "@/path/to/file.jpg"
          //   图+caption: "@/path/to/file.jpg caption text"
          //   多图+text:  "@/p1 @/p2 caption text"
          let payload = trimmed
          if (imagePaths.length > 0) {
            const ats = imagePaths.map((p) => `@${p}`).join(' ')
            payload = trimmed ? `${ats} ${trimmed}` : ats
          }
          // 拆两步写：先正文，延迟 80ms 再发 \r。
          // 一次性写 "text+\r" 时 Claude Code TUI 把整段当 paste 缓冲，文字进了输入框但
          // \r 没被识别为独立的"提交"事件 —— 表现为消息卡在 prompt 不被发送。
          // 拆开后 TUI 先把文字渲染到输入框，再把单独到达的 \r 当作 Enter 按键处理。
          pty.write(targetSid, payload)
          setTimeout(() => {
            try { pty.write(targetSid, '\r') } catch (e) {
              logger.warn?.(`[wizard] stdin proxy submit failed: ${e.message}`)
            }
          }, 80)
          // 静默成功：默认返回空 reply（OpenClaw skill 收到空 stdout 不发消息给用户，
          // AI 回话由 Stop hook 单独推送，体验干净）。
          // 例外：当前 (peer, sid) 第一次路由时回一条小提示，让用户知道发给了哪个 todo —— 解决
          // 重启后多 session resume + 静默路由 = 用户完全不知道发给谁的盲点。
          let firstHint = ''
          if (shouldAnnounceFirstRoute(peer, targetSid)) {
            const title = lookupTodoTitleForSession(targetSid)
            if (title) {
              firstHint = `📍 已发给 「${title}」 (#${targetSid.slice(-4)})\n（之后这条 chat 默认都发给它，不再提醒）`
            }
          }
          return {
            reply: firstHint,
            action: 'stdin_proxy',
            sessionId: targetSid,
            imagePaths: imagePaths.length > 0 ? imagePaths : undefined,
          }
        } catch (e) {
          logger.warn?.(`[wizard] stdin proxy failed: ${e.message}`)
        }
      }
      if (targetSid && typeof targetSid === 'object' && targetSid.ambiguous) {
        // 多个活跃 session：列 todo title + 时间，并附 inline keyboard 让用户一键绑定。
        // 短码统一用 sid.slice(-4)（跟 ticket 风格对齐）。绑定语义：写 lastPushByPeer，
        // 用户**重新发**一条消息时自动路由到所选 session（不重放当前这条，避免状态机化）。
        const top = targetSid.candidates.slice(0, 5)
        const lines = top.map((c, i) => {
          const title = c.todo?.title ? truncateTitle(c.todo.title, 28) : '(未知 todo)'
          const short = c.sid.slice(-4)
          return `${i + 1}. #${short} · ${title}    ${formatTimeAgo(c.lastOutputAt)}`
        })
        const buttons = top.map((c) => {
          const title = c.todo?.title ? truncateTitle(c.todo.title, 22) : '(未知)'
          return [{ text: `📦 ${title}`, callback_data: `qt:rt:${c.sid.slice(-4)}` }]
        })
        return {
          reply: [
            '🔀 多个活跃 AI session，回的不知发给谁：',
            '',
            ...lines,
            '',
            '👆 点按钮选 session（之后这条 chat 都默认发给它），',
            `或回 "#${top[0].sid.slice(-4)} <内容>" 指定。`,
          ].join('\n'),
          replyMarkup: { inline_keyboard: buttons },
          action: 'stdin_proxy_ambiguous',
        }
      }
    }

    // 6. fallback
    // General 频道里专门提示：保护 PTY 上下文不被污染
    if (isInGeneralOfSupergroup) {
      return {
        reply: [
          '🤔 这条消息没匹配到任何意图。',
          '',
          'General 频道不会把消息盲目转给已有任务（避免污染 Claude Code 上下文）。',
          '',
          '想做什么：',
          '  • 新建任务：发「帮我做 X」 / 「新建任务: X」',
          '  • 跟某个任务对话：去对应 task topic 里发',
          '  • 回答 AI 问题：在 ask_user ticket 所在 topic 内回数字',
        ].join('\n'),
        action: 'fallback',
        reason: 'general_channel_no_intent',
      }
    }
    return {
      reply: '🤔 我没看懂这条消息。\n\n要新建任务，发：\n  • 新建任务: 修复 X\n  • 帮我做 X\n要回答 AI 的问题，发：\n  • 数字 1/2/3\n  • #xxx 1（指定 ticket）\n要直接给 AI 发指令，先等它推送一条给你，回复就会转过去。',
      action: 'fallback',
    }
  }

  /**
   * 处理 inline keyboard 按钮点击。
   *
   * 入参：{chatId, threadId, callbackData, callbackMessageId, fromUserId}
   * 出参：
   *   - reply?: string                — 发的下一步 prompt 文本（caller sendMessage）
   *   - replyMarkup?: object          — 下一步 prompt 的按钮（可选）
   *   - chosenLabel?: string          — caller 拿来在原消息末尾打 "✓ 已选: …" 标记
   *   - toast?: string                — answerCallbackQuery 的轻提示
   *   - editOriginal?: boolean        — 默认 true，去除原消息按钮 + 加 ✓ 标记
   *   - action: string                — wizard_step|wizard_done|wizard_custom_workdir|invalid|expired
   *
   * callback_data 协议：
   *   qt:wd:<idx>     工作目录（按 listWorkdirOptions 顺序）
   *   qt:wd:custom    自定义路径 → 进入 awaitingCustomWorkdir 子态，等下一条文本
   *   qt:q:<1..4>     象限
   *   qt:t:<idx>      模板
   *   qt:t:none       自由模式（不套模板）
   *
   * 安全：所有未知 / 不匹配当前 step 的 callback 都返回 toast，从不 throw —— 让
   * telegram-bot 始终能 answerCallbackQuery 关 loading。
   */
  async function handleCallback(args = {}) {
    const chatId = args.chatId != null ? String(args.chatId) : null
    const threadId = args.threadId != null ? args.threadId : null
    const callbackData = String(args.callbackData || '')
    if (!chatId) return { toast: '⚠️ 缺 chatId', action: 'invalid' }
    if (!callbackData) return { toast: '空 callback', action: 'invalid' }

    // ── ask_user 按钮路径 ──────────────────────────────────────────
    // 这个路径**不依赖 wizard 状态**，所以独立在 wizard lookup 之前
    // callback_data 形如 qt:ans:<ticket>:<idx> / qt:ext:<ticket>:<idx>
    const askCb = parseCallbackData(callbackData)
    if (askCb && (askCb.kind === CB_KIND_ANSWER || askCb.kind === CB_KIND_EXTEND)) {
      return handleAskUserCallback(askCb, { chatId, threadId })
    }

    // ── Claude Code 原生 TUI select 控制按钮（qt:key:<short>:enter|up|down|esc）──
    // 这是 ask_user MCP 以外的兜底：Claude Code 自己弹出的 select menu 无法结构化成
    // ask_user ticket，只能把 Telegram 按钮翻译成 PTY key sequence。
    if (callbackData.startsWith('qt:key:')) {
      const parts = callbackData.split(':')
      return handleNativeTuiKeyCallback(parts[2], parts[3], { chatId, threadId })
    }

    // ── 多 session ambiguous 按钮路径（qt:rt:<short>）─────────────
    // 用户从 ambiguous 提示里点了某个 session → 写 lastPushByPeer 把这个 chat 绑过去，
    // 用户**重新发**一条消息时自动路由到所选 session（不重放当前消息，避免状态机化）。
    if (callbackData.startsWith('qt:rt:')) {
      return handleRouteCallback(callbackData.slice(6), { chatId, threadId })
    }

    const routeKey = makeRouteKey(chatId, threadId)
    const w = getActiveWizard(routeKey)
    if (!w) {
      // wizard 已超时 / 不存在 → 提示用户重启，editOriginal=true 顺手把按钮去掉
      return {
        toast: '向导已超时',
        reply: '🤔 这个向导已经超时（>10 分钟未操作），请重发触发词重启。',
        action: 'expired',
      }
    }
    w.updatedAt = Date.now()

    // 解析 qt:<kind>:<value>
    const parts = callbackData.split(':')
    if (parts.length < 3 || parts[0] !== CALLBACK_PREFIX) {
      return { toast: '无效的按钮', action: 'invalid' }
    }
    const kind = parts[1]
    const value = parts.slice(2).join(':')   // 防 path 里包含 ':' 的边界

    // ── workdir step ──────────────────────────────
    if (kind === 'wd') {
      if (w.step !== STEP_WORKDIR) {
        return { toast: '当前步骤不接受目录选择', action: 'invalid' }
      }
      if (value === 'custom') {
        // 进入子态：等用户下一条文本作为路径，不再校验 / / ~
        w.awaitingCustomWorkdir = true
        return {
          chosenLabel: '自定义路径',
          reply: '🖋 请直接输入完整路径（绝对路径或 ~/ 开头都行）',
          action: 'wizard_custom_workdir',
        }
      }
      const idx = Number(value)
      if (!Number.isInteger(idx) || idx < 0 || idx >= w.workdirOptions.length) {
        return { toast: '选项无效', action: 'invalid' }
      }
      w.chosenWorkdir = w.workdirOptions[idx].path
      w.step = STEP_QUADRANT
      const prompt = buildQuadrantPrompt()
      return {
        chosenLabel: w.chosenWorkdir,
        reply: prompt.text,
        replyMarkup: prompt.replyMarkup,
        action: 'wizard_step',
      }
    }

    // ── quadrant step ─────────────────────────────
    if (kind === 'q') {
      if (w.step !== STEP_QUADRANT) {
        return { toast: '当前步骤不接受象限选择', action: 'invalid' }
      }
      const q = Number(value)
      if (![1, 2, 3, 4].includes(q)) return { toast: '象限无效', action: 'invalid' }
      w.chosenQuadrant = q
      w.step = STEP_TEMPLATE
      const templates = db.listTemplates()
      w.cachedTemplates = templates
      const prompt = buildTemplatePrompt(templates)
      const qLabel = QUADRANTS.find((x) => x.id === q)?.label || ''
      return {
        chosenLabel: `Q${q} ${qLabel}`.trim(),
        reply: prompt.text,
        replyMarkup: prompt.replyMarkup,
        action: 'wizard_step',
      }
    }

    // ── template step ─────────────────────────────
    if (kind === 't') {
      if (w.step !== STEP_TEMPLATE) {
        return { toast: '当前步骤不接受模板选择', action: 'invalid' }
      }
      const templates = w.cachedTemplates || db.listTemplates()
      let label
      if (value === 'none') {
        w.chosenTemplate = null
        label = '自由模式'
      } else {
        const idx = Number(value)
        if (!Number.isInteger(idx) || idx < 0 || idx >= templates.length) {
          return { toast: '模板无效', action: 'invalid' }
        }
        w.chosenTemplate = { id: templates[idx].id, name: templates[idx].name }
        label = templates[idx].name
      }
      const out = await finalizeWizard(w)
      return {
        chosenLabel: label,
        reply: out.reply,
        // finalize 返回的 ack 不再带按钮
        action: out.done ? 'wizard_done' : (out.action || 'wizard_step'),
        todoId: out.todoId,
        threadId: out.threadId,
      }
    }

    return { toast: '未知按钮', action: 'invalid' }
  }

  // ─── ask_user 按钮回调 ──────────────────────────────────────────
  //
  // 两类 callback：
  //   qt:ans:<ticket>:<idx> → 直接选了选项 → submitReply(<idx+1>)
  //   qt:ext:<ticket>:<idx> → 想补充细节 → 发 force_reply 提示，挂 forceReplyContext
  //                          等用户回复后拼"选项 · 补充"再 submitReply
  //
  // submitReply 100% 复用现有 pending-questions 协调器；按钮 = 触发器，DB 不变。
  //
  // 边界：
  //   - ticket 已超时 / 已取消 / 已答复 → submitReply 返回 ticket_not_pending → 回提示
  //   - 选项 idx 越界 → toast 警告（实际拼按钮时不会发生，防御性）
  //   - 没接 pending coordinator → 回不可用提示（不应发生，依赖检查在 createWizard 时做）
  async function handleAskUserCallback(askCb, { chatId, threadId } = {}) {
    if (!pending?.submitReply) {
      return { toast: '⚠️ pending coordinator 未启用', action: 'ask_user_unavailable' }
    }

    const { kind, ticket, idx } = askCb

    // 先把 ticket 拉出来确认 pending 状态 + 拿到选项文本（用于 chosenLabel / 补充场景）
    let target = null
    try {
      target = db.getPendingQuestion?.(ticket) || null
    } catch { target = null }
    if (!target || target.status !== 'pending') {
      // editOriginal=true 顺便去按钮，不让用户再点
      return {
        toast: 'ticket 已结束',
        reply: `⚠️ ticket #${ticket} 已结束（超时/取消/已答复），无需再点。`,
        action: 'ask_user_stale',
        editOriginal: true,
      }
    }
    const optionLabel = target.options?.[idx] ?? null
    if (optionLabel == null) {
      return { toast: '选项无效', action: 'invalid' }
    }

    // ── ans：直接答 ──
    if (kind === CB_KIND_ANSWER) {
      const result = pending.submitReply(buildAnswerReplyText(idx))
      // submitReply 已 resolve waiter → AI 阻塞解开
      if (!result.matched) {
        // 极少发生：刚刚 ticket 还在，submitReply 时已被别处答了 → race
        return {
          toast: '回答失败',
          reply: `⚠️ 路由 #${ticket} 失败（${result.reason}）`,
          action: 'ask_user_race',
          editOriginal: true,
        }
      }
      return {
        chosenLabel: `${idx + 1}. ${optionLabel}`,
        toast: '已回答',
        action: 'ask_user_answered',
        editOriginal: true,
      }
    }

    // ── ext：发 force_reply 提示，挂 forceReplyContext，等下一条 message ──
    if (kind === CB_KIND_EXTEND) {
      return {
        toast: '请直接回复消息补充',
        reply: `✏️ 请补充关于「${optionLabel}」的细节，直接回复这条消息即可。\n（5 分钟内有效，超时按"${optionLabel}"原选项答 AI）`,
        // Telegram force_reply：用户客户端会自动聚焦到回复框；reply_to_message.message_id 指向我们这条
        replyMarkup: { force_reply: true, selective: true, input_field_placeholder: '补充细节…' },
        // ↓↓↓ 关键：让 telegram-bot 在 sendMessage 成功后注册 forceReplyContext
        // 由 telegram-bot 拿到新消息的 message_id 回灌到 wizard.registerForceReplyContext
        forceReplyContext: { ticket, optionIndex: idx, optionLabel, chatId, threadId },
        // 不要去原消息按钮（用户可能想换个选 / 改主意）
        editOriginal: false,
        action: 'ask_user_extend_pending',
      }
    }

    return { toast: '未知按钮', action: 'invalid' }
  }

  // ── force_reply 上下文 Map ─────────────────────────────────────
  //   key = chatId|messageId  （我们发出去的那条 force_reply 提示消息的 id）
  //   val = { ticket, optionIndex, optionLabel, expireAt }
  // 5 分钟 TTL，自然过期即清除（懒清理：访问时检查 expireAt）
  const forceReplyContexts = new Map()
  const FORCE_REPLY_TTL_MS = 5 * 60 * 1000

  function _frKey(chatId, messageId) { return `${chatId}|${messageId}` }

  function registerForceReplyContext({ chatId, messageId, ticket, optionIndex, optionLabel } = {}) {
    if (!chatId || !messageId || !ticket) return false
    forceReplyContexts.set(_frKey(chatId, messageId), {
      ticket, optionIndex, optionLabel,
      expireAt: Date.now() + FORCE_REPLY_TTL_MS,
    })
    return true
  }

  function consumeForceReplyContext(chatId, messageId) {
    if (!chatId || !messageId) return null
    const k = _frKey(chatId, messageId)
    const ctx = forceReplyContexts.get(k)
    if (!ctx) return null
    forceReplyContexts.delete(k)
    if (Date.now() > ctx.expireAt) return null   // 过期视为命中失败
    return ctx
  }

  // ─── 多 session ambiguous 选择回调 ─────────────────────────────────
  //
  // 用户从 ambiguous 提示里点了 [📦 修复登录 bug]，触发 callback_data = qt:rt:<short>。
  // 处理流程：
  //   1. 在 aiTerminal.sessions 里按 sid 后缀（4 字符）找匹配的活跃 session
  //   2. 调 openclaw.setLastPushedSession(peer, sid) 把这个 chat 绑过去
  //   3. 标记 singleSessionRouteAnnounced（避免下次发消息又触发"首次提示"）
  //   4. 回 toast + reply 告诉用户绑定结果（不重放当前消息，让用户重新发）
  //
  // 边界：
  //   - short 后缀匹配不到（session 已死） → 回 'session 已没了' 提示
  //   - 多个 sid 同时以这 4 字符结尾（碰撞，理论存在但 36^4≈1.7M 概率极低） → 取第一个
  //   - aiTerminal 不可用 → 提示
  async function handleRouteCallback(short, { chatId, threadId } = {}) {
    if (!short || !aiTerminal?.sessions) {
      return { toast: '⚠️ 无法路由', action: 'route_unavailable' }
    }
    let target = null
    for (const [sid, sess] of aiTerminal.sessions) {
      if ((sess?.status === 'running' || sess?.status === 'pending_confirm') && sid.endsWith(short)) {
        target = { sid, sess }
        break
      }
    }
    if (!target) {
      return {
        toast: '🤔 这个 session 已经没了',
        reply: `🤔 #${short} 已经不在线了，可能刚刚结束。请回 /list 看当前活跃 session。`,
        action: 'route_session_gone',
        editOriginal: true,
      }
    }
    const todoTitle = lookupTodoTitleForSession(target.sid) || '(未命名)'
    const peer = chatId  // 跟 push 路径里 lastPushByPeer 的 key 对齐
    const ok = openclaw?.setLastPushedSession?.(peer, target.sid)
    if (!ok) {
      return { toast: '⚠️ 路由失败（openclaw 不可用）', action: 'route_failed' }
    }
    // 已经显式选过了，下次自然路由不再触发"首次提示"
    singleSessionRouteAnnounced.add(`${peer}::${target.sid}`)
    return {
      toast: `✓ 已绑定到「${todoTitle}」`,
      chosenLabel: `📦 ${truncateTitle(todoTitle, 22)}`,
      reply: `📍 接下来你在这条 chat 发的话，会进 「${todoTitle}」 (#${short})`,
      action: 'route_bound',
    }
  }

  async function handleNativeTuiKeyCallback(short, key, { chatId, threadId } = {}) {
    if (!short || !key || !aiTerminal?.sessions || !pty?.write) {
      return { toast: '⚠️ 无法控制菜单', action: 'native_tui_key_unavailable' }
    }
    let target = null
    for (const [sid, sess] of aiTerminal.sessions) {
      if ((sess?.status === 'running' || sess?.status === 'pending_confirm') && sid.endsWith(short)) {
        target = { sid, sess }
        break
      }
    }
    if (!target) {
      return {
        toast: '🤔 这个 session 已经没了',
        reply: `🤔 #${short} 已经不在线了，可能刚刚结束。请回 /list 看当前活跃 session。`,
        action: 'native_tui_key_session_gone',
        editOriginal: false,
      }
    }

    const keySeq = {
      enter: '\r',
      up: '\x1b[A',
      down: '\x1b[B',
      esc: '\x1b',
    }[key]
    if (!keySeq) return { toast: '⚠️ 不支持的按键', action: 'native_tui_key_invalid' }

    try {
      pty.write(target.sid, keySeq)
      const peer = chatId
      openclaw?.setLastPushedSession?.(peer, target.sid)
      singleSessionRouteAnnounced.add(`${peer}::${target.sid}`)
      const toast = key === 'enter' ? '↵ 已选当前项'
        : key === 'up' ? '⬆️ 已上移'
          : key === 'down' ? '⬇️ 已下移'
            : 'Esc 已发送'
      return {
        toast,
        action: 'native_tui_key',
        sessionId: target.sid,
        editOriginal: false,
      }
    } catch (e) {
      logger.warn?.(`[wizard] native tui key proxy failed: ${e.message}`)
      return { toast: '⚠️ 发送按键失败', action: 'native_tui_key_failed' }
    }
  }

  // ─── /list /pending /stop —— quadtodo 全局 slash command（仅 General 响应） ──
  //
  // 设计：
  //  - 入口在 handleInbound 第 1.7 步（DETACH_TRIGGERS 后、active wizard 之前）
  //  - 仅在 supergroup General 频道执行；task topic 里被拦截 + 提示去 General 用
  //  - "短码" = sid.slice(-8)，跟现有 stdin_proxy_ambiguous 提示对齐
  //  - /stop 走前缀匹配（4-8 字符都 OK），all 停所有，无参列活跃

  /**
   * 找到所有活跃 AI session（status=running / pending_confirm），返回带 todo 上下文的列表：
   *   [{ sid, short, status, lastOutputAt, todo: {id, title, workDir, quadrant} | null }]
   *
   * 数据源：
   *  - aiTerminal.sessions (in-memory PTY session map) —— 状态最准
   *  - 通过 todo.aiSessions 反查每个 sid 对应的 todo（最多扫一次未完成 todos）
   */
  function findActiveSessions() {
    if (!aiTerminal?.sessions) return []
    const active = []
    for (const [sid, sess] of aiTerminal.sessions) {
      if (sess?.status === 'running' || sess?.status === 'pending_confirm') {
        active.push({
          sid,
          short: sid.slice(-8),
          status: sess.status,
          lastOutputAt: sess.lastOutputAt || sess.startedAt || 0,
          todo: null,
        })
      }
    }
    if (active.length === 0) return active
    // 反查 todo —— 只看未完成的（活跃 session 不可能挂在已完成 todo 上）
    let todos = []
    try { todos = db.listTodos({ status: 'todo' }) || [] } catch { todos = [] }
    const sidToTodo = new Map()
    for (const todo of todos) {
      const sessions = todo.aiSessions || (todo.aiSession ? [todo.aiSession] : [])
      for (const s of sessions) {
        if (s?.sessionId) sidToTodo.set(s.sessionId, todo)
      }
    }
    for (const item of active) {
      const t = sidToTodo.get(item.sid)
      if (t) {
        item.todo = {
          id: t.id,
          title: t.title || '(未命名)',
          workDir: t.workDir || '',
          quadrant: t.quadrant || 2,
        }
      }
    }
    // 最近活动的排前面
    active.sort((a, b) => b.lastOutputAt - a.lastOutputAt)
    return active
  }

  function formatTimeAgo(ms) {
    if (!ms) return ''
    const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000))
    if (sec < 60) return `${sec}s 前`
    if (sec < 3600) return `${Math.floor(sec / 60)}m 前`
    return `${Math.floor(sec / 3600)}h 前`
  }

  /**
   * 截断 todo 标题用于按钮 / 提示展示。中文 / emoji 占 1 char（粗略），不做精确宽度。
   * 超出 max 用 '…' 收尾。
   */
  function truncateTitle(s, max = 24) {
    if (!s) return ''
    const str = String(s)
    if (str.length <= max) return str
    return str.slice(0, max) + '…'
  }

  /**
   * 单 session 路由首次提示去重：peer + sid 维度。
   * - peer = chatId（telegram 私聊）或 chatId+threadId（topic）的 string 化
   * - 重启后清零（自然行为，新 sid 也会重新提示）
   */
  const singleSessionRouteAnnounced = new Set()
  function shouldAnnounceFirstRoute(peer, sid) {
    if (!peer || !sid) return false
    const key = `${peer}::${sid}`
    if (singleSessionRouteAnnounced.has(key)) return false
    singleSessionRouteAnnounced.add(key)
    return true
  }
  function lookupTodoTitleForSession(sid) {
    if (!sid) return ''
    let todos = []
    try { todos = db.listTodos({ status: 'todo' }) || [] } catch { todos = [] }
    for (const t of todos) {
      const sessions = t.aiSessions || (t.aiSession ? [t.aiSession] : [])
      if (sessions.some((s) => s?.sessionId === sid)) return t.title || '(未命名)'
    }
    return ''
  }

  /**
   * /list 或 /pending —— 列未完成 todos，按象限分组。
   *
   * 输出限制：30 条；超出加"去 web 看"提示。
   * 状态显示：把 todo.aiSessions 里 running 的标 🟢，便于一眼看哪些任务在跑。
   */
  function cmdList() {
    let todos = []
    try { todos = db.listTodos({ status: 'todo' }) || [] } catch (e) {
      logger.warn?.(`[wizard] /list listTodos failed: ${e.message}`)
      return { reply: '⚠️ 读取 todo 列表失败', action: 'slash_list_failed' }
    }
    if (todos.length === 0) {
      return { reply: '✨ 暂无待办任务\n\n要新建：发「帮我做 X」 / 「新建任务: X」', action: 'slash_list' }
    }
    const PAGE = 30
    const visible = todos.slice(0, PAGE)
    // 活跃 sid 集合 → 标 🟢
    const activeSids = new Set(findActiveSessions().map((s) => s.sid))
    const groups = new Map()
    for (const q of QUADRANTS) groups.set(q.id, [])
    for (const t of visible) {
      const arr = groups.get(t.quadrant) || groups.get(2)
      arr.push(t)
    }
    const lines = [`📋 待办 (${todos.length}${todos.length > PAGE ? `, 仅显示前 ${PAGE}` : ''})`]
    for (const q of QUADRANTS) {
      const arr = groups.get(q.id)
      if (!arr || arr.length === 0) continue
      lines.push('')
      lines.push(`Q${q.id} ${q.label}`)
      for (const t of arr) {
        const short = String(t.id).slice(0, 4)
        const dirTag = t.workDir ? `· ${basename(t.workDir)}` : ''
        const aiSessions = t.aiSessions || (t.aiSession ? [t.aiSession] : [])
        const isRunning = aiSessions.some((s) => s?.sessionId && activeSids.has(s.sessionId))
        const statusTag = isRunning ? '🟢' : '·'
        lines.push(`  ${statusTag} ${short}  ${t.title} ${dirTag}`)
      }
    }
    if (todos.length > PAGE) {
      const port = (getConfig?.()?.port) || 5677
      lines.push('')
      lines.push(`… 还有 ${todos.length - PAGE} 条，去 web 看：http://127.0.0.1:${port}/`)
    }
    return { reply: lines.join('\n'), action: 'slash_list', count: todos.length }
  }

  /**
   * /stop —— 停 AI session。
   *
   *   /stop          → 列所有活跃会话 + 提示用法
   *   /stop <短码>   → 按 sid.slice(-8) 前缀匹配，命中且唯一就停（多个 / 没命中 → 提示）
   *   /stop all      → 停所有活跃
   *
   * 副作用：
   *   1. pty.stop(sid)  —— 杀进程（PTY done handler 会异步清理 in-memory session）
   *   2. 更新 todo.aiSessions 里这条的 status='stopped'，方便 web UI 看到
   *   3. todo.status 不动（仍 pending），用户可以手动重启
   */
  function cmdStop({ argText = '' } = {}) {
    const arg = String(argText || '').trim()
    const active = findActiveSessions()
    if (active.length === 0) {
      return { reply: '✅ 当前没有正在跑的 AI 会话', action: 'slash_stop_noop' }
    }

    // 没有参数 → 列出来让用户选
    if (!arg) {
      const lines = [`🟢 当前活跃 AI 会话 (${active.length})：`]
      active.forEach((s, i) => {
        const title = s.todo?.title || '(未绑定 todo)'
        lines.push(`  ${i + 1}. ${s.short}  ${title}  · ${formatTimeAgo(s.lastOutputAt)}`)
      })
      lines.push('')
      lines.push('停止某个：/stop <短码>   （短码=上面 8 位）')
      lines.push('全部停：  /stop all')
      return { reply: lines.join('\n'), action: 'slash_stop_list', activeCount: active.length }
    }

    // 决定要停的列表
    let targets = []
    if (/^all$/i.test(arg)) {
      targets = active.slice()
    } else {
      const needle = arg.toLowerCase()
      const matched = active.filter((s) => s.short.toLowerCase().startsWith(needle))
      if (matched.length === 0) {
        return {
          reply: `🤔 没找到匹配 "${arg}" 的活跃会话。\n\n回 /stop 看活跃列表。`,
          action: 'slash_stop_no_match',
        }
      }
      if (matched.length > 1) {
        const list = matched.map((s) => `  • ${s.short}  ${s.todo?.title || '(未绑定)'}`).join('\n')
        return {
          reply: `⚠️ "${arg}" 同时匹配多个会话，请加更长的短码：\n${list}`,
          action: 'slash_stop_ambiguous',
        }
      }
      targets = matched
    }

    // 真正去停
    const stopped = []
    const failed = []
    for (const t of targets) {
      try {
        // 标记是用户主动停 —— PTY done handler 不会用 stopped→'todo' 默认逻辑覆写
        const sess = aiTerminal?.sessions?.get?.(t.sid)
        if (sess) sess.userClosedReason = 'slash_stop'
        if (pty?.stop) pty.stop(t.sid)
        // 更新 todo 里这条 aiSession 的状态
        if (t.todo?.id) {
          try {
            const todo = db.getTodo(t.todo.id)
            if (todo) {
              const sessions = (todo.aiSessions || []).map((s) =>
                s?.sessionId === t.sid
                  ? { ...s, status: 'stopped', stoppedAt: Date.now(), stopReason: 'slash_stop' }
                  : s
              )
              db.updateTodo(t.todo.id, { aiSessions: sessions })
            }
          } catch (e) {
            logger.warn?.(`[wizard] /stop persist status failed for sid=${t.short}: ${e.message}`)
          }
        }
        // 解绑路由 + 清 lastPushedSession，避免残留
        openclaw?.clearSessionRoute?.(t.sid, 'slash-stop')
        stopped.push(t)
      } catch (e) {
        logger.warn?.(`[wizard] /stop pty.stop failed for sid=${t.short}: ${e.message}`)
        failed.push({ ...t, error: e.message })
      }
    }

    if (stopped.length === 0 && failed.length > 0) {
      return {
        reply: `❌ 停止失败：${failed.map((f) => f.short).join(', ')}`,
        action: 'slash_stop_failed',
      }
    }
    const lines = [`⏹ 已停止 ${stopped.length} 个会话：`]
    for (const s of stopped) {
      const title = s.todo?.title || '(未绑定 todo)'
      lines.push(`  • ${s.short}  ${title}`)
    }
    if (failed.length > 0) {
      lines.push('')
      lines.push(`⚠️ 失败 ${failed.length} 个：${failed.map((f) => f.short).join(', ')}`)
    }
    return {
      reply: lines.join('\n'),
      action: 'slash_stop_done',
      stoppedCount: stopped.length,
      failedCount: failed.length,
      stoppedSids: stopped.map((s) => s.sid),
    }
  }

  /**
   * 分发 quadtodo 全局 slash command。被 handleInbound 在 General 频道命中时调用。
   * 不在 General 时由 handleInbound 直接拦截，不会进这里。
   */
  function handleSlashCommand({ cmd, argText = '' } = {}) {
    switch (String(cmd || '').toLowerCase()) {
      case 'list':
      case 'pending':
        return cmdList()
      case 'stop':
        return cmdStop({ argText })
      default:
        // 不该走到这（QUADTODO_GLOBAL_SLASH 已经过滤了）
        return { reply: `🤔 未知命令 /${cmd}`, action: 'slash_unknown' }
    }
  }

  function describe() {
    return {
      activeWizards: wizards.size,
      peers: [...wizards.keys()],
    }
  }

  // 测试 / 调试钩子。peer 可以是旧风格 'u1' 或 routeKey 'u1:general'
  function _peek(peerOrRouteKey) {
    if (peerOrRouteKey == null) return null
    const k = String(peerOrRouteKey)
    return wizards.get(k) || wizards.get(makeRouteKey(k, null)) || null
  }
  function _reset() { wizards.clear() }

  return {
    handleInbound,
    handleCallback,
    handleSlashCommand,
    handleTopicEvent,
    ensureTopicForSession,
    abortWizard,
    registerForceReplyContext,
    describe,
    _peek,
    _reset,
  }
}

export const __test__ = {
  extractTitle,
  tryExtractWorkdir,
  tryExtractQuadrant,
  tryExtractTemplateHint,
  parseNumericChoice,
  findTemplateByHint,
  buildWorkdirMessage,
  buildQuadrantMessage,
  buildTemplateMessage,
  buildWorkdirReplyMarkup,
  buildQuadrantReplyMarkup,
  buildTemplateReplyMarkup,
  CALLBACK_PREFIX,
  isGeneralChannel,
  QUADTODO_GLOBAL_SLASH,
  NEW_TASK_TRIGGERS,
  CANCEL_TRIGGERS,
}
