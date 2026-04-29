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
    const tag = opt.source === 'recent' ? `recent, ${opt.count} 次`
      : opt.source === 'default' ? 'default'
      : opt.source === 'home' ? 'home' : opt.source
    lines.push(`${i + 1}. ${opt.path}  (${tag})`)
  })
  lines.push(`${options.length + 1}. 自定义路径（请直接输入路径文本）`)
  return lines.join('\n')
}

function buildQuadrantMessage() {
  const lines = ['🎯 选象限：']
  QUADRANTS.forEach((q, i) => {
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

/**
 * 创建协调器实例。
 *
 * 依赖：
 *   - db: createTodo, listTemplates, getTemplate, raw
 *   - aiTerminal: spawnSession({sessionId, todoId, prompt, tool, cwd, permissionMode, label, extraEnv})
 *   - openclaw: registerSessionRoute(sessionId, {targetUserId, ...})
 *   - pending: submitReply(text), listPending() （不直接被调用，但提供给路由层判断）
 *   - getConfig: () => 配置快照（拿 defaultCwd / port / defaultTool）
 */
export function createOpenClawWizard({ db, aiTerminal, openclaw, pending, getConfig, logger = console } = {}) {
  if (!db) throw new Error('db_required')

  // peerUserId → wizard state object
  const wizards = new Map()

  function getActiveWizard(peer) {
    const w = wizards.get(peer)
    if (!w) return null
    if (Date.now() - w.updatedAt > WIZARD_TIMEOUT_MS) {
      wizards.delete(peer)
      return null
    }
    return w
  }

  function listWorkdirOptions() {
    const cfg = getConfig?.() || {}
    const recent = defaultRecentWorkDirs(db, 5)
    const out = recent.map((r) => ({ ...r, source: 'recent' }))
    const seen = new Set(out.map((x) => x.path))
    const defCwd = cfg.defaultCwd
    if (defCwd && !seen.has(defCwd)) {
      out.push({ path: defCwd, source: 'default' })
      seen.add(defCwd)
    }
    return out
  }

  function startWizard(peer, text) {
    const title = extractTitle(text) || '(未命名任务)'
    const workdirHint = tryExtractWorkdir(text)
    const quadrantHint = tryExtractQuadrant(text)
    const templateHint = tryExtractTemplateHint(text)

    const w = {
      peer,
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

    wizards.set(peer, w)
    return w
  }

  function abortWizard(peer) {
    const had = wizards.has(peer)
    wizards.delete(peer)
    return had
  }

  /**
   * 推进 wizard 一步。返回 { reply, done? }。
   */
  async function advance(w, text) {
    w.updatedAt = Date.now()

    // ─── workdir 步 ───
    if (w.step === STEP_WORKDIR) {
      // 数字选项？
      const idx = parseNumericChoice(text, w.workdirOptions.length + 1)
      if (idx !== null) {
        if (idx < w.workdirOptions.length) {
          w.chosenWorkdir = w.workdirOptions[idx].path
          w.step = STEP_QUADRANT
          return { reply: buildQuadrantMessage() }
        } else {
          // 选了"自定义"
          return { reply: '🖋 请输入完整路径（绝对路径或 ~/ 开头）' }
        }
      }
      // 自定义路径
      if (text.startsWith('/') || text.startsWith('~')) {
        w.chosenWorkdir = text.trim()
        w.step = STEP_QUADRANT
        return { reply: buildQuadrantMessage() }
      }
      // 看不懂 → 重发提示
      return { reply: `🤔 没看懂，请回数字 1-${w.workdirOptions.length + 1} 或粘贴一个绝对路径。\n\n${buildWorkdirMessage(w.workdirOptions)}` }
    }

    // ─── quadrant 步 ───
    if (w.step === STEP_QUADRANT) {
      const num = String(text).trim().match(/^([1-4])$/)
      if (num) {
        w.chosenQuadrant = Number(num[1])
      } else if (/默认|default|^$/i.test(text.trim())) {
        w.chosenQuadrant = 2
      } else {
        return { reply: `🤔 请回 1-4 选象限，或回 "默认" 用 Q2。\n\n${buildQuadrantMessage()}` }
      }
      w.step = STEP_TEMPLATE
      const templates = db.listTemplates()
      w.cachedTemplates = templates
      return { reply: buildTemplateMessage(templates) }
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
          return { reply: `🤔 请回数字 1-${templates.length + 1}，或模板名（自由/无）。\n\n${buildTemplateMessage(templates)}` }
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
          })
          sessionInfo = { sessionId, tool }
        } catch (e) {
          logger.warn?.(`[wizard] spawnSession failed: ${e.message}`)
        }
      }

      wizards.delete(w.peer)

      const lines = [
        `✅ todo #${String(todo.id).slice(-6)} 已建`,
        `   标题: ${w.title}`,
        `   象限: Q${w.chosenQuadrant || 2}`,
        `   目录: ${w.chosenWorkdir || '默认'}`,
        `   模板: ${w.chosenTemplate?.name || '自由模式'}`,
      ]
      if (sessionInfo) {
        lines.push(`🤖 ${sessionInfo.tool} 终端已启动 (sessionId: ${sessionInfo.sessionId.slice(-8)})`)
        lines.push(`   AI 卡到决策点会主动找你；任务结束也会推送`)
      } else {
        lines.push(`⚠️  AI 终端启动失败，已记录 todo`)
      }
      return { reply: lines.join('\n'), done: true, action: 'wizard_done', todoId: todo.id }
    } catch (e) {
      wizards.delete(w.peer)
      logger.warn?.(`[wizard] finalize failed: ${e.message}`)
      return { reply: `❌ 创建任务失败: ${e.message}`, action: 'wizard_failed' }
    }
  }

  /** 给状态机喂一条用户消息，返回该回复给用户的文本。 */
  async function handleInbound({ peer, text } = {}) {
    if (!peer) return { reply: '⚠️ 缺 from peer，无法路由' }
    if (!text || typeof text !== 'string') return { reply: '🤔 空消息，请重试' }
    const trimmed = text.trim()

    // 1. 取消语 + 有向导 → 中止
    if (CANCEL_TRIGGERS.some((re) => re.test(trimmed))) {
      const had = abortWizard(peer)
      if (had) return { reply: '✓ 已取消向导', action: 'wizard_cancelled' }
      // 无向导 — fallthrough 让 ask_user 也能取消
    }

    // 2. 进行中 wizard → 推进
    const active = getActiveWizard(peer)
    if (active) {
      // 如果用户在 wizard 中又发新任务触发词 → 重启
      if (NEW_TASK_TRIGGERS.some((re) => re.test(trimmed))) {
        wizards.delete(peer)
        const w = startWizard(peer, trimmed)
        if (w.step === STEP_DONE) return await finalizeWizard(w)
        if (w.step === STEP_QUADRANT) return { reply: `（已重启向导，跳过目录步）\n${buildQuadrantMessage()}` }
        if (w.step === STEP_TEMPLATE) {
          const tpls = db.listTemplates()
          w.cachedTemplates = tpls
          return { reply: `（已重启向导，跳过目录+象限步）\n${buildTemplateMessage(tpls)}` }
        }
        return { reply: `（已重启向导）\n${buildWorkdirMessage(w.workdirOptions)}`, action: 'wizard_started' }
      }
      const out = await advance(active, trimmed)
      return { ...out, action: out.done ? 'wizard_done' : 'wizard_step' }
    }

    // 3. 看起来像新任务 → 启动向导（必须在 ask_user 路由之前，避免被当 free text 吃掉）
    if (NEW_TASK_TRIGGERS.some((re) => re.test(trimmed))) {
      const w = startWizard(peer, trimmed)
      if (w.step === STEP_DONE) return await finalizeWizard(w)
      if (w.step === STEP_QUADRANT) return { reply: `任务: ${w.title}\n（目录已识别为 ${w.chosenWorkdir}）\n\n${buildQuadrantMessage()}`, action: 'wizard_started' }
      if (w.step === STEP_TEMPLATE) {
        const tpls = db.listTemplates()
        w.cachedTemplates = tpls
        return { reply: `任务: ${w.title}\n（目录+象限已识别）\n\n${buildTemplateMessage(tpls)}`, action: 'wizard_started' }
      }
      return { reply: `任务: ${w.title}\n\n${buildWorkdirMessage(w.workdirOptions)}`, action: 'wizard_started' }
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

    // 5. fallback
    return {
      reply: '🤔 我没看懂这条消息。\n\n要新建任务，发：\n  • 新建任务: 修复 X\n  • 帮我做 X\n要回答 AI 的问题，发：\n  • 数字 1/2/3\n  • #xxx 1（指定 ticket）',
      action: 'fallback',
    }
  }

  function describe() {
    return {
      activeWizards: wizards.size,
      peers: [...wizards.keys()],
    }
  }

  // 测试 / 调试钩子
  function _peek(peer) { return wizards.get(peer) || null }
  function _reset() { wizards.clear() }

  return {
    handleInbound,
    abortWizard,
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
  NEW_TASK_TRIGGERS,
  CANCEL_TRIGGERS,
}
