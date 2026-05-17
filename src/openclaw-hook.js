/**
 * Claude Code Hook 主动推送处理器。
 *
 * 接收 hook 脚本（~/.agentquad/claude-hooks/notify.js）发来的事件，
 * 应用节流规则，调 openclaw-bridge 推送微信/Telegram。
 *
 * 节流规则（按设计稿 §4）：
 *   - ask_user pending 时 Stop 静默：DB 查 pending_questions 匹配 sessionId → 跳过 Stop
 *   - 同 (sessionId × event) 30s cooldown
 *   - Notification 优先级最高，无视 cooldown
 *   - SessionEnd 不节流，必送达
 *   - 整体出站沿用 openclaw-bridge 的 6/min 限流
 *
 * 内容来源（v2 重构）：
 *   - 优先：Claude Code 的 jsonl 日志（~/.claude/projects/.../uuid.jsonl）
 *     干净的结构化消息，无 spinner/ANSI 噪声
 *   - 兜底：PTY recentOutput（旧路径，过滤 spinner）
 *
 * 长内容处理：
 *   - ≤ 4000 字 → inline 直发
 *   - > 4000 字 → inline 顶部 800 字 + 完整 .md 附件（Telegram sendDocument）
 *   - SessionEnd → 额外附整段 transcript .md
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { readLatestAssistantTurn, readLatestAssistantTurnFresh, buildFullTranscript, readJsonlLines as defaultReadJsonlLines } from './claude-transcript.js'
import { extractTurnUsage, extractSessionUsageFromLines as defaultExtractSessionUsageFromLines, formatUsageFooter } from './usage-footer.js'
import { DEFAULT_PRICING } from './pricing.js'
import {
  readLatestCodexTurnFresh as defaultReadLatestCodexTurnFresh,
  buildFullCodexTranscript as defaultBuildFullCodexTranscript,
  extractCodexTurnUsageFromLines as defaultExtractCodexTurnUsageFromLines,
} from './codex-transcript.js'
import { buildPermissionCard } from './lark-card.js'
import { DEFAULT_ROOT_DIR } from './config.js'

const DEFAULT_COOLDOWN_MS = 30_000
const TRANSCRIPT_TMP_DIR = join(DEFAULT_ROOT_DIR, 'tmp')
const INLINE_MAX_CHARS = 4000
const ATTACHMENT_HEAD_CHARS = 800

function ensureTranscriptDir() {
  try { mkdirSync(TRANSCRIPT_TMP_DIR, { recursive: true }) } catch {}
}

function writeTranscriptTmp(content, sessionId, kind) {
  ensureTranscriptDir()
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const path = join(TRANSCRIPT_TMP_DIR, `transcript-${sessionId}-${ts}-${kind}.md`)
  try {
    writeFileSync(path, content, 'utf8')
    return path
  } catch (e) {
    return null
  }
}

function hookTranscriptMatchesSession(transcriptPath, nativeId) {
  if (!transcriptPath || !nativeId) return false
  const fileName = String(transcriptPath).split(/[\\/]/).pop()
  return fileName === `${nativeId}.jsonl`
}

// 把 todoId 字符串收成 3 字符短码（去除连字符后取末 3 位，转小写）
function shortTodoId(todoId) {
  if (!todoId) return null
  const cleaned = String(todoId).replace(/[^a-z0-9]/gi, '')
  if (cleaned.length === 0) return null
  return cleaned.slice(-3).toLowerCase()
}

function stripAnsi(s) {
  return String(s || '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()#][A-Za-z0-9]/g, '')
    .replace(/\x1b[>=<cDEHMNOPZ78]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
}

// Unicode box-drawing chars: 把 ╭ ╮ ╰ ╯ ├ ┤ │ ─ 等替成简洁字符
const BOX_HORIZONTAL = /[─━┄┅┈┉═]/g
const BOX_VERTICAL = /[│┃┆┇┊┋║]/g
const BOX_CORNERS = /[┌┍┎┏┐┑┒┓└┕┖┗┘┙┚┛┌┐└┘╭╮╯╰╓╒╕╖╙╘╛╜╔╗╚╝]/g
const BOX_TEES = /[├┝┞┟┠┡┢┣┤┥┦┧┨┩┪┫┬┭┮┯┰┱┲┳┴┵┶┷┸┹┺┻┼┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋╠╣╦╩╬]/g
// Unicode Block Elements (U+2580-259F)：▀▁▂▃▄▅▆▇█ ▉▊▋▌▍▎▏ ▐░▒▓▔▕▖▗▘▙▚▛▜▝▞▟
// Cursor TUI 用这些画状态栏 / 进度条 / 边框，发到 IM 一串看就是黑条。
const BOX_BLOCK = /[▀-▟]/g

function cleanBoxDrawing(s) {
  return String(s || '')
    .replace(BOX_HORIZONTAL, '-')   // 横线 → -
    .replace(BOX_VERTICAL, '|')     // 竖线 → |
    .replace(BOX_CORNERS, '+')      // 角 → +
    .replace(BOX_TEES, '+')         // 三叉 → +
    .replace(BOX_BLOCK, '')         // 块元素直接删（连成一片就是黑条，没语义）
}

function compactBlankLines(s) {
  // 多个空行收成一个
  return String(s || '').replace(/\n[ \t]*\n+/g, '\n\n')
}

function trimTrailingSpaces(s) {
  return String(s || '').split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n')
}

// Claude Code 的 spinner / 进度 / 状态行 —— 这些是无信息量的 UI chrome
// 出现在每次 AI thinking 时大量刷屏，会把真正的问题内容挤出 buffer
const SPINNER_CHARS = '✶✳✻✽★⚙∗⠁⠂⠄⡀⢀⠠⠐⠈'
// "<Verb>ing…" / "<Verb>ed for X" 是 Claude Code 的 spinner 状态 —— 不写死词典
// 因为 Claude Code 几乎每周都在加新动词（Skedaddling / Drizzling / Mulling / etc）
// 通用规则：任何 3-20 字母单词后接 ing/ed + 省略号 / for + 时间，视为状态
const STATUS_KEYWORDS = /\b[A-Z][a-z]{2,19}(?:ing|ed)\s+for\s+/   // "Cooked for 3m" / "Brewing for"
// 行首允许任意 spinner 字符 + 空格，再跟 verb + ellipsis
const STATUS_VERB_LINE = /^\s*[*✶✳✻✽★⚙∗⠁⠂⠄⡀⢀⠠⠐⠈]*\s*[A-Z][a-z]{2,19}(?:ing|ed)?\s*(…|\.\.\.|\.\.|\.)\s*$/
const PROMPT_LINE = /^\s*(❯|⏵|►|→)/
const AUTO_MODE_LINE = /(auto mode (on|off)|shift\+tab to cycle|ctrl\+[a-z]\b)/i
const BORDER_LINE = /^[\s\-=_|+~]+$/

// Cursor TUI 底部状态栏噪声 —— 每次 stop hook 触发时这些行都会出现在 PTY tail，
// 完全没信息量，发到 IM 是纯刷屏。
//   "Opus 4.6 (Thinking) 200K High · 23.6%"  → 模型选择器 + context %
//   "Auto-run" / "Manual"                    → 模式指示
//   "~/Desktop/code/crazyCombo/quadtodo · main" → cwd · git branch
const CURSOR_MODEL_LINE = /^\s*(Opus|Sonnet|Haiku|GPT|Claude|Codex|Composer)\s+[\w.-]+.*·\s*[\d.]+%\s*$/i
const CURSOR_AUTORUN_LINE = /^\s*(Auto-run|Manual|Auto)\s*$/i
const CURSOR_CWD_BRANCH_LINE = /^\s*~?\/[^\s·]+(?:\/[^\s·]+)*\s+·\s+[\w./-]+\s*$/

function isSpinnerOnly(line) {
  // 全部是 spinner 字符（含空格）
  const trimmed = line.replace(/\s+/g, '')
  if (!trimmed) return true
  for (const ch of trimmed) {
    if (!SPINNER_CHARS.includes(ch) && !/\d/.test(ch)) return false
  }
  return true
}

function isStatusLine(line) {
  if (STATUS_KEYWORDS.test(line)) return true
  if (STATUS_VERB_LINE.test(line)) return true
  if (PROMPT_LINE.test(line)) return true
  if (AUTO_MODE_LINE.test(line)) return true
  if (BORDER_LINE.test(line)) return true
  if (CURSOR_MODEL_LINE.test(line)) return true
  if (CURSOR_AUTORUN_LINE.test(line)) return true
  if (CURSOR_CWD_BRANCH_LINE.test(line)) return true
  return false
}

function isThinLine(line) {
  // 空行保留（compactBlankLines 阶段再合并），只过滤"很短但非空"的噪声行
  const real = line.replace(/[\s✶✳✻✽★⚙∗⠁⠂⠄⡀⢀⠠⠐⠈]/g, '')
  if (real.length === 0) return false  // 空行 → 不算 thin，保留作分隔
  return real.length < 3
}

function filterMeaningfulLines(s) {
  return s.split('\n').filter((line) => {
    // 空行保留
    if (!line.trim()) return true
    if (isSpinnerOnly(line)) return false
    if (isStatusLine(line)) return false
    if (isThinLine(line)) return false
    return true
  }).join('\n')
}

/**
 * 取 PTY recentOutput 的"有意义"末尾。
 * 多步清洗：strip ANSI → strip box-drawing → 过滤 spinner/状态/边框 → 折叠空行 → 截尾。
 *
 * AI thinking 时 spinner 会快速覆盖 recentOutput buffer（4KB），导致原始
 * 问题内容被冲走。所以传入 fallback `historicalRaw`（更大的 outputHistory），
 * 当 recentOutput 过滤后过瘦时回退过去找。
 */
function extractTailSnippet(recentOutput, maxChars = 800, historicalRaw = null) {
  function clean(raw) {
    let s = stripAnsi(raw || '')
    s = cleanBoxDrawing(s)
    s = trimTrailingSpaces(s)
    s = filterMeaningfulLines(s)
    s = compactBlankLines(s)
    return s.trim()
  }

  let s = clean(recentOutput)
  // recentOutput 太瘦 → 回退到 outputHistory
  if (s.length < 50 && historicalRaw) {
    const fallback = clean(historicalRaw)
    if (fallback.length > s.length) s = fallback
  }
  if (!s) return ''
  if (s.length <= maxChars) return s
  // 从尾部截，但尽量从最近的换行开始（避免半截行）
  const cut = s.slice(-maxChars)
  const nl = cut.indexOf('\n')
  return '…' + (nl > 0 && nl < 200 ? cut.slice(nl + 1) : cut)
}

/**
 * 构造给 IM 推送的最终消息文本。
 *
 * 两种内容源：
 *   - cleanContent: 来自 Claude jsonl 的"已经干净"的 turn 文本 → 原样使用，不再过滤
 *   - snippet/historicalRaw: 来自 PTY 的"脏" 输出 → 走 extractTailSnippet 过滤 spinner / box-drawing
 *
 * 优先 cleanContent；只在它缺失时走脏路径。
 */
function buildMessage({ event, todoId, todoTitle, cleanContent, snippet, historicalRaw }) {
  // 每任务一个 topic — 无需 tag / title / 引导语，正文直给
  let body = ''
  if (cleanContent && typeof cleanContent === 'string' && cleanContent.trim()) {
    body = cleanContent.trim()
  } else if (snippet) {
    body = extractTailSnippet(snippet, 800, historicalRaw)
  }

  const fallback = event === 'notification'
    ? '⚠️ AI 还在思考 / spinner 中，最近没新内容'
    : '🤖 AI 一轮结束（无新内容）'
  switch (event) {
    case 'stop':
      return body || fallback
    case 'notification':
      return body ? `⚠️ ${body}` : fallback
    case 'session-end':
      return body ? `✅ AI session 已结束\n\n${body}` : `✅ AI session 已结束`
    default:
      return `🦞 ${tag} ${title} hook event: ${event}${snippetBlock || ''}`
  }
}

/**
 * 创建 hook 处理器。
 *
 * 依赖：
 *   - db: 用于查 pending_questions（ask_user pending 静默用）
 *   - openclaw: openclaw-bridge 实例
 *   - cooldownMs: 同 (sessionId × event) 内的最小间隔
 *
 * 并发安全：所有状态都在单实例内部 Map 里；同进程多 hook 调用顺序处理。
 */
export function createOpenClawHookHandler(deps = {}) {
  const {
    db,
    aiTerminal = null,
    sidecar = null,
    pty = null,
    telegramBot = null,
    larkBot = null,
    loadingTracker = null,
    reactionTracker = null,
    sessionInputDispatcher = null,     // Stop / session-end → 触发 dispatcher flush / cleanup
    cooldownMs = DEFAULT_COOLDOWN_MS,
    getConfig = null,                  // () => app config（用于读 telegram.notificationCooldownMs）
    logger = console,
    // injectable transcript / usage helpers (codex branch testability)
    readLatestCodexTurnFresh = defaultReadLatestCodexTurnFresh,
    buildFullCodexTranscript = defaultBuildFullCodexTranscript,
    extractCodexTurnUsageFromLines = defaultExtractCodexTurnUsageFromLines,
    extractSessionUsageFromLines = defaultExtractSessionUsageFromLines,
    readJsonlLines = defaultReadJsonlLines,
  } = deps
  // `openclaw` is the legacy bridge handle (used by the claude branch);
  // `bridge` is the codex-branch alias accepted for clarity. Either one is fine.
  const openclaw = deps.openclaw || deps.bridge
  const codexBridge = deps.bridge || deps.openclaw

  if (!db) throw new Error('db_required')
  if (!openclaw) throw new Error('openclaw_required')

  // dedupKey → lastSentAt
  const lastSentAt = new Map()

  function dedupKey(sessionId, event) {
    return `${sessionId || 'global'}:${event}`
  }

  function isOnCooldown(sessionId, event, customCooldownMs) {
    const key = dedupKey(sessionId, event)
    const last = lastSentAt.get(key) || 0
    return (Date.now() - last) < (customCooldownMs ?? cooldownMs)
  }

  // Notification 自己的 cooldown（默认 10 分钟，可改 telegram.notificationCooldownMs）
  // 设 0 = 关闭（每条都推），设很大 = 等于禁用 idle 提醒
  function notificationCooldownMs() {
    try {
      const cfg = getConfig?.() || {}
      const raw = cfg.telegram?.notificationCooldownMs
      if (raw === 0) return 0
      const n = Number(raw)
      return Number.isFinite(n) && n >= 0 ? n : 600_000   // default 10min
    } catch { return 600_000 }
  }

  // 默认丢弃 Claude Code 的 idle Notification —— AgentQuad bypass 模式下纯噪声。
  // 用户可在 config 里 telegram.suppressNotificationEvents = false 恢复旧 cooldown 行为。
  function notificationSuppressed() {
    try {
      const cfg = getConfig?.() || {}
      const raw = cfg.telegram?.suppressNotificationEvents
      if (raw === false) return false   // 显式 false → 不抑制
      return true                        // 默认 true / undefined → 抑制
    } catch { return true }
  }

  function getSessionPermissionMode(sessionId) {
    const sess = sessionId && aiTerminal?.sessions?.get(sessionId)
    return sess?.permissionMode || sess?.autoMode || 'default'
  }

  function resolveExplicitInteractiveRoute(sessionId) {
    if (!sessionId) return null
    if (!openclaw.hasExplicitRoute?.(sessionId)) return null
    const route = openclaw.resolveRoute?.(sessionId)
    if (!route) return null
    if (route.channel === 'telegram' || !!route.threadId) return route
    if (route.channel === 'lark' && route.rootMessageId) return route
    return null
  }

  function suppressPermissionNotifications() {
    try {
      const cfg = getConfig?.() || {}
      return cfg.telegram?.suppressPermissionNotifications === true
    } catch { return false }
  }

  function isPermissionReminderEligible(sessionId) {
    if (!sessionId) return false
    if (!resolveExplicitInteractiveRoute(sessionId)) return false
    if (suppressPermissionNotifications()) return false
    return getSessionPermissionMode(sessionId) !== 'bypass'
  }

  function permissionShortId(sessionId) {
    return String(sessionId || '').slice(-4)
  }

  function buildPermissionReplyMarkup(sessionId) {
    const shortId = permissionShortId(sessionId)
    return {
      inline_keyboard: [[
        { text: '允许（Enter）', callback_data: `qt:perm:${shortId}:allow` },
        { text: '拒绝/退出（Esc）', callback_data: `qt:perm:${shortId}:deny` },
      ]],
    }
  }

  function buildPermissionNotificationMessage(message) {
    return `⚠️ Claude Code 正在等待你的响应。\n按钮会向终端发送 Enter/Esc。\n\n${message}`
  }

  // ── token usage footer 配置 ──
  // pricing.showInPush    : 是否在每条 Telegram/飞书推送末尾追加 token / 费用 footer（默认 false，需在 UI 打开）
  // pricing.showCnyInPush : footer 显示时是否同时带 ¥（默认 true，仅 showInPush=true 时生效）
  // pricing              : 单价表，缺省走 pricing.js 的 DEFAULT_PRICING（含 cnyRate=7.2）
  //                       若 config.pricing 存在，原样透传给 estimateCost
  function shouldShowUsage() {
    try {
      return getConfig?.()?.pricing?.showInPush === true
    } catch { return false }
  }
  function shouldShowUsageCny() {
    try {
      const v = getConfig?.()?.pricing?.showCnyInPush
      return v !== false   // undefined / true → on
    } catch { return true }
  }
  function getPricingConfig() {
    try {
      const cfg = getConfig?.() || {}
      // 用户可整块覆盖；不覆盖时用 DEFAULT_PRICING
      return cfg.pricing || DEFAULT_PRICING
    } catch { return DEFAULT_PRICING }
  }

  function recordSent(sessionId, event) {
    lastSentAt.set(dedupKey(sessionId, event), Date.now())
  }

  function hasPendingAskUser(sessionId) {
    if (!sessionId) return false
    try {
      // 通过 listPendingQuestions 拿全部，过滤 sessionId 匹配
      const list = db.listPendingQuestions()
      return list.some((p) => p.sessionId === sessionId && p.status === 'pending')
    } catch {
      return false
    }
  }

  function notifyWebTurnDone(sessionId, todoTitle) {
    if (!sessionId || !aiTerminal?.notifyTurnDone) return
    try {
      aiTerminal.notifyTurnDone(sessionId, {
        event: 'stop',
        status: 'idle',
        todoTitle: todoTitle || undefined,
      })
    } catch (e) {
      logger.warn?.(`[openclaw-hook] notifyTurnDone failed: ${e.message}`)
    }
  }

  function normalizePersistedTelegramRoute(route) {
    const targetUserId = String(route?.targetUserId ?? '').trim()
    if (!targetUserId) return null
    if (route.channel && route.channel !== 'telegram') return null

    const threadId = Number(route.threadId)
    if (!Number.isInteger(threadId) || threadId <= 0) return null

    return {
      ...route,
      targetUserId,
      threadId,
      channel: 'telegram',
    }
  }

  function normalizePersistedLarkRoute(route) {
    const targetUserId = String(route?.targetUserId ?? '').trim()
    if (!targetUserId) return null
    if (route.channel && route.channel !== 'lark') return null
    const rootMessageId = String(route?.rootMessageId ?? '').trim()
    if (!rootMessageId) return null
    return { ...route, targetUserId, rootMessageId, channel: 'lark' }
  }

  function restorePersistedRoute(sessionId, todoId) {
    if (!sessionId || !todoId || !openclaw?.registerSessionRoute || !db?.getTodo) return false
    if (openclaw.hasExplicitRoute?.(sessionId)) return false
    try {
      const todo = db.getTodo(todoId)
      const aiSession = (todo?.aiSessions || []).find((item) => item?.sessionId === sessionId)
      // 优先 lark：纯飞书用户 telegramRoute 永远是空，用旧逻辑会无声跳过 → 重启后 hook
      // 拿不到 route → push 失败到飞书。lark 校验通过就走它，否则再尝试 telegram。
      const larkRoute = normalizePersistedLarkRoute(aiSession?.larkRoute)
      if (larkRoute) {
        openclaw.registerSessionRoute(sessionId, larkRoute)
        logger.info?.(`[openclaw-hook] restored lark route for sid=${sessionId} root=${larkRoute.rootMessageId}`)
        return true
      }
      const tgRoute = normalizePersistedTelegramRoute(aiSession?.telegramRoute)
      if (!tgRoute) return false
      openclaw.registerSessionRoute(sessionId, tgRoute)
      logger.info?.(`[openclaw-hook] restored telegram route for sid=${sessionId} threadId=${tgRoute.threadId}`)
      return true
    } catch (e) {
      logger.warn?.(`[openclaw-hook] restore route failed: ${e.message}`)
      return false
    }
  }

  /**
   * 处理一条 hook 事件 —— 统一入口，按 source/path 分发。
   *  - source=codex,path=jsonl    → handleCodexJsonl（Phase C）
   *  - source=codex,path=detector → handleCodexDetector（Phase E 占位，目前直接拒绝）
   *  - source=claude,path=detector→ handleClaudeDetector（PTY 兜底 Notification hook 不 fire）
   *  - 其它（默认 claude）        → handleClaude（保留原逻辑，签名不变）
   * 返回 { ok, action: 'sent'|'skipped'|'failed', reason? }
   */
  async function handle(req = {}) {
    const source = req?.source || 'claude'
    if (source === 'codex' && req?.path === 'jsonl') return handleCodexJsonl(req)
    if (source === 'codex' && req?.path === 'detector') return handleCodexDetector(req)
    if (source === 'claude' && req?.path === 'detector') return handleClaudeDetector(req)
    return handleClaude(req)
  }

  // ─── Codex 分支（Phase C）─────────────────────────────────────────────────────
  async function handleCodexJsonl({ event, nativeId, transcript_path, raw_event_payload }) {
    // 1) 解析 AgentQuad sessionId
    let quadtodoSessionId = null
    let todoId = null
    let cwd = null
    const fromSidecar = sidecar?.lookup?.(nativeId)
    if (fromSidecar) {
      quadtodoSessionId = fromSidecar.quadtodoSessionId
      todoId = fromSidecar.todoId
      cwd = fromSidecar.cwd
    } else if (aiTerminal?.sessions) {
      // pty.js 里 session 上挂的字段是 `nativeId`（见 pty.js:297），不是
      // `nativeSessionId`——只有 PtyManager 内部 API 参数名是 nativeSessionId。
      // 早期实现写错了字段名，导致 fallback 扫描永远 miss。
      for (const [sid, sess] of aiTerminal.sessions) {
        if (sess?.nativeId === nativeId) {
          quadtodoSessionId = sid
          todoId = sess.todoId || null
          cwd = sess.cwd || null
          break
        }
      }
    }
    if (!quadtodoSessionId) {
      logger.warn?.(`[codex-hook] no AgentQuad session for nativeId=${nativeId}`)
      return { ok: false, reason: 'no_quadtodo_session' }
    }

    // 1.5) 翻转 AgentQuad 会话状态 —— 与 Claude Stop 路径对齐
    //
    // 历史回归：codex 的 task_complete 事件流水线（emitter→server→/openclaw/hook→handleCodexJsonl）
    // 只负责 IM 推送，从来没有调过 ait 的 markSessionAwaitingReply / notifyTurnDone；导致 codex
    // 一轮跑完后 deriveAiState 仍然吃到 (status=running, awaitingReply=false) → UI pill 永远显
    // 示"运行中"。这里补齐：Stop 与 TurnAborted（用户按 Esc 中断也等价于"本轮结束、等用户"）
    // 都翻状态。push 失败不阻塞翻转——理由跟 Claude 路径同：awaitingReply 描述的是 AI 自身
    // 状态，跟 IM 是否送达无关；吞掉会让 dispatcher 永远 busy。
    if ((event === 'Stop' || event === 'TurnAborted') && aiTerminal) {
      try {
        aiTerminal.notifyTurnDone?.(quadtodoSessionId, { event: 'stop', status: 'idle' })
      } catch (e) {
        logger.warn?.(`[codex-hook] notifyTurnDone failed: ${e.message}`)
      }
      try {
        const ok = aiTerminal.markSessionAwaitingReply?.(quadtodoSessionId, true)
        if (ok === false) {
          const sess = aiTerminal.sessions?.get?.(quadtodoSessionId)
          logger.warn?.(`[codex-hook] markSessionAwaitingReply(true) NO-OP sid=${quadtodoSessionId} sessionExists=${!!sess} status=${sess?.status || 'null'} awaitingReply=${sess?.awaitingReply}`)
        }
      } catch (e) {
        logger.warn?.(`[codex-hook] markSessionAwaitingReply failed: ${e.message}`)
      }
      if (sessionInputDispatcher?.onSessionIdle) {
        Promise.resolve(sessionInputDispatcher.onSessionIdle(quadtodoSessionId))
          .catch((e) => logger.warn?.(`[codex-hook] dispatcher.onSessionIdle failed: ${e.message}`))
      }
    }

    // 2) 定位 jsonl
    const filePath = transcript_path || pty?.findCodexSession?.(nativeId)?.filePath || null
    if (!filePath) return { ok: false, reason: 'no_transcript' }

    // 3) 读最新一轮
    let text = ''
    if (event === 'Stop' || event === 'TurnAborted') {
      try {
        const turn = await readLatestCodexTurnFresh(filePath, null, { retries: 3, retryMs: 200 })
        text = turn?.text || ''
      } catch (e) {
        logger.warn?.(`[codex-hook] read latest turn failed: ${e.message}`)
      }
    }

    // 4) 拼 footer
    let lines = []
    try { lines = readJsonlLines(filePath) || [] } catch { lines = [] }
    let turnUsage = null
    let sessionUsage = null
    try { turnUsage = extractCodexTurnUsageFromLines(lines) } catch {}
    try { sessionUsage = extractSessionUsageFromLines(lines, 'codex') } catch {}
    let footer = ''
    try {
      footer = formatUsageFooter({
        turn: turnUsage ? { ...turnUsage, model: sessionUsage?.primaryModel } : null,
        session: sessionUsage,
      })
    } catch (e) {
      logger.warn?.(`[codex-hook] format usage footer failed: ${e.message}`)
    }

    // 5) 拼正文
    let todoTitle = null
    try { todoTitle = (await db.getTodo?.(todoId))?.title || null } catch { todoTitle = null }
    todoTitle = todoTitle || todoId || ''
    const idTail = todoId ? String(todoId).slice(-3) : '???'
    const headLine = event === 'Stop'
      ? `🤖 [#t${idTail}] 任务「${todoTitle}」AI 一轮结束`
      : event === 'TurnAborted'
        ? `🛑 [#t${idTail}] 任务「${todoTitle}」AI 一轮被中断`
        : event === 'Error'
          ? `❌ [#t${idTail}] 任务「${todoTitle}」Codex 报错：${raw_event_payload?.message || ''}`
          : event === 'SessionEnd'
            ? `✅ [#t${idTail}] 任务「${todoTitle}」AI 跑完了`
            : `[codex] 未知事件 ${event}`
    const fullText = text
      ? `${headLine}\n\n${text}${footer ? `\n\n${footer}` : ''}`
      : `${headLine}${footer ? `\n\n${footer}` : ''}`

    // 6) 推送
    // bridge.postText 的形参是 `message`，不是 `text`——早期实现写错字段名，
    // 导致 bridge 收到 message=undefined 直接走 message_required 短路返回。
    try {
      const r = await codexBridge.broadcastText({ sessionId: quadtodoSessionId, message: fullText })
      if (!r?.ok) {
        logger.warn?.(`[codex-hook] broadcastText returned not-ok: reason=${r?.reason} detail=${r?.detail || ''}`)
        return { ok: false, reason: 'post_failed', detail: r?.reason }
      }
      logger.info?.(`[codex-hook] broadcastText OK sessionId=${quadtodoSessionId} event=${event} len=${fullText.length}`)
    } catch (e) {
      logger.warn?.(`[codex-hook] postText threw: ${e.message}`)
      return { ok: false, reason: 'post_failed', detail: e?.message }
    }

    // 7) SessionEnd → 附完整 transcript
    if (event === 'SessionEnd') {
      try {
        const full = buildFullCodexTranscript(filePath)
        if (full?.markdown) {
          const tmpPath = writeTranscriptTmp(full.markdown, quadtodoSessionId, 'codex-full')
          if (tmpPath && codexBridge?.sendDocument) {
            await codexBridge.sendDocument({ sessionId: quadtodoSessionId, path: tmpPath })
          }
        }
      } catch (e) {
        logger.warn?.(`[codex-hook] attach full transcript failed: ${e.message}`)
      }
    }

    return { ok: true, action: 'sent', source: 'codex', event }
  }

  // ─── Codex stdout detector 分支（Phase E）────────────────────────────────────
  // PtyManager 的 prompt-detector 命中（[Y/n] / apply patch? 等）→ POST /api/openclaw/hook
  // 走到这里推一张飞书 / Telegram 权限卡片。actionId 里带 'codex:' 前缀，让卡片回调
  // 走的还是 wizard.handlePermissionCallback 的 \r/\x1b 路径（tool-agnostic）。
  async function handleCodexDetector({ event, sessionId, nativeId, promptText, matchedPattern } = {}) {
    if (!sessionId) return { ok: false, reason: 'no_sessionId' }
    const sess = aiTerminal?.sessions?.get(sessionId)
    if (!sess) return { ok: false, reason: 'session_gone' }
    // bridge in-memory route 缺失但 DB 有 → 先恢复，否则 postCard 一样发不出去。
    // handleClaudeDetector 同源处理，保持两条 detector 路径行为一致。
    if (openclaw?.hasExplicitRoute && !openclaw.hasExplicitRoute(sessionId)) {
      restorePersistedRoute(sessionId, sess.todoId)
    }
    // 把 session.status 翻成 pending_confirm —— 前端 deriveAiState 据此显示"待确认"。
    // 信号源是 codex-prompt-detector（已经过 AI self-quoted 过滤），比旧的 PTY 正则路径准。
    try { aiTerminal?.markPendingConfirm?.(sessionId, { source: 'codex-detector', promptText }) } catch { /* ignore */ }
    const todoId = sess.todoId
    let todoTitle = todoId
    try {
      const todo = await db.getTodo?.(todoId)
      todoTitle = todo?.title || todoId
    } catch { /* ignore */ }
    const idTail = todoId ? String(todoId).slice(-3) : '???'
    const text = `⚠️ [#t${idTail}] 任务「${todoTitle}」AI 卡住等输入：\n\n\`\`\`\n${promptText}\n\`\`\``
    const card = buildPermissionCard({
      message: text,
      actionId: `codex:${sessionId}`,
      headerTitle: '⚠️ Codex 等待授权',
    })
    try {
      await codexBridge.postCard?.({ sessionId, card })
    } catch (e) {
      logger.warn?.(`[codex-detector] postCard failed: ${e.message}`)
      return { ok: false, reason: 'post_failed', detail: e?.message }
    }
    return { ok: true, action: 'sent', source: 'codex', event, nativeId, matchedPattern }
  }

  // ─── Claude PTY-detector 分支 ────────────────────────────────────────────────
  // Notification hook 不 fire 的兜底（实测 permissions.defaultMode='auto' 时 model
  // classifier 触发的权限框走不到 hook）。两件事：
  //   1) 翻 session.status → pending_confirm（web 端 deriveAiState 据此显示"待确认"）
  //   2) 推 IM 权限卡 / 按钮（跟真 Notification 走同一份 cooldown，避免双推）
  // 与 handleCodexDetector 同构，但走 broadcastText（保持跟 Claude 真 Notification 一致），
  // header 标题区别成 "Claude Code 等待你的响应"。
  async function handleClaudeDetector({ event, sessionId, promptText } = {}) {
    if (!sessionId) return { ok: false, reason: 'no_sessionId' }
    const sess = aiTerminal?.sessions?.get(sessionId)
    if (!sess) return { ok: false, reason: 'session_gone' }

    // 0) bridge in-memory route 缺失但 DB 有 → 先恢复。否则 isPermissionReminderEligible
    //    会立即 short-circuit 返回 false，IM 永远收不到权限卡片。
    //    handleClaude 在自己开头做了同样的事；detector 路径之前漏了这一步，导致
    //    resume / mode-switch（spawnSession skipTelegram=true）后第一条权限弹窗被吞。
    if (openclaw?.hasExplicitRoute && !openclaw.hasExplicitRoute(sessionId)) {
      restorePersistedRoute(sessionId, sess.todoId)
    }

    // 1) 翻状态。markPendingConfirm 默认只接受 running → pending_confirm，但 PTY-detector
    //    要求 anchor + ≥2 数字选项才 emit，假阳性概率极低；显式 allowIdleFlip=true 让它
    //    在 status=idle 时也能翻（覆盖 auto 模式权限框在 Stop hook 后才浮出的场景）。
    try {
      aiTerminal?.markPendingConfirm?.(sessionId, {
        source: 'claude-pty-detector',
        promptText,
        allowIdleFlip: true,
      })
    } catch { /* ignore */ }

    // 2) IM 推送资格 & cooldown 跟真 Notification 共享 → 不会双推
    if (!isPermissionReminderEligible(sessionId)) {
      return { ok: true, action: 'skipped', reason: 'im_push_not_eligible' }
    }
    const cd = notificationCooldownMs()
    if (cd > 0 && isOnCooldown(sessionId, 'notification', cd)) {
      return { ok: true, action: 'skipped', reason: 'notification_cooldown', cooldownMs: cd }
    }

    // 3) 拼消息：直接用 PTY detector 抽出来的 promptText（已经过 anchor + cleanPtyTail 清洗）
    const todoId = sess.todoId
    let todoTitle = todoId
    try {
      const todo = await db.getTodo?.(todoId)
      todoTitle = todo?.title || todoId
    } catch { /* ignore */ }
    const idTail = todoId ? String(todoId).slice(-3) : '???'
    let message = `[#t${idTail}] 任务「${todoTitle}」\n\n${promptText || '(no prompt text)'}`
    message = buildPermissionNotificationMessage(message)
    const replyMarkup = buildPermissionReplyMarkup(sessionId)

    let result
    try {
      result = await openclaw.broadcastText({ sessionId, message, replyMarkup })
    } catch (e) {
      logger.warn?.(`[claude-detector] broadcastText failed: ${e.message}`)
      return { ok: false, reason: 'post_failed', detail: e?.message }
    }
    if (result?.ok !== false) recordSent(sessionId, 'notification')
    return { ok: true, action: 'sent', source: 'claude', path: 'detector', event }
  }

  // ─── Claude 分支（既有实现，原 handle() 主体不变）─────────────────────────────
  async function handleClaude({ event, sessionId, todoId, todoTitle, hookPayload } = {}) {
    if (!event) return { ok: false, action: 'failed', reason: 'event_required' }
    const evt = String(event).toLowerCase()

    // 诊断：sessionId 给了但 bridge 没注册过 route → 先尝试从 DB 持久化 route 恢复。
    // 恢复失败才 warn；postText 仍会拒绝 route-less Telegram session，避免泄漏到 General。
    if (sessionId && openclaw?.hasExplicitRoute && !openclaw.hasExplicitRoute(sessionId)) {
      restorePersistedRoute(sessionId, todoId)
    }
    if (sessionId && openclaw?.hasExplicitRoute && !openclaw.hasExplicitRoute(sessionId)) {
      logger.warn?.(`[openclaw-hook] hook fired with no registered route: event=${evt} sid=${sessionId} todoId=${todoId || 'null'}`)
    }

    // 0) user-prompt-submit → echo user's prompt to all IM channels (minus origin)
    if (evt === 'user-prompt-submit') {
      if (!sessionId) return { ok: true, action: 'skipped', reason: 'no_session' }
      const promptRaw =
        (hookPayload && typeof hookPayload === 'object' && (
          hookPayload.user_prompt ||
          hookPayload.prompt ||
          hookPayload.user_message ||
          hookPayload.message
        )) || ''
      const prompt = String(promptRaw).trim()
      if (!prompt) return { ok: true, action: 'skipped', reason: 'empty_prompt' }

      // 截断：>2000 字符 → 取前 2000 + 末尾标注总字数
      const MAX = 2000
      const truncated = prompt.length > MAX
        ? `${prompt.slice(0, MAX)}\n… [共 ${prompt.length} 字]`
        : prompt
      const message = `👤 ${truncated}`

      let originChannel = null
      try {
        originChannel = sessionInputDispatcher?.consumeOrigin?.(sessionId, prompt) || null
      } catch (e) {
        logger.warn?.(`[openclaw-hook] consumeOrigin threw: ${e.message}`)
      }

      try {
        await openclaw?.broadcastEcho?.({ sessionId, message, excludeChannel: originChannel })
      } catch (e) {
        logger.warn?.(`[openclaw-hook] broadcastEcho threw: ${e.message}`)
      }
      return { ok: true, action: 'echoed', origin: originChannel, length: prompt.length }
    }

    // 1) ask_user pending 时 Stop 静默
    if (evt === 'stop' && hasPendingAskUser(sessionId)) {
      return { ok: true, action: 'skipped', reason: 'ask_user_pending' }
    }

    // 1a) Cursor 的 stop hook 每轮 fire 3 次（实测 13ms 内连发，cursor 内部架构使然）。
    //     给 cursor session 加 5 秒短 cooldown 去重 —— 5s 足够吞掉同一轮内的连发，
    //     又远小于用户两轮对话的最小间隔。Claude/Codex 不受影响（它们 stop 一轮一发）。
    if (evt === 'stop' && sessionId) {
      const sess = aiTerminal?.sessions?.get?.(sessionId)
      if (sess?.tool === 'cursor' && isOnCooldown(sessionId, 'stop', 5_000)) {
        return { ok: true, action: 'skipped', reason: 'cursor_stop_dedup' }
      }
    }

    const permissionReminderEligible = evt === 'notification' && isPermissionReminderEligible(sessionId)

    // 注：原来这里会立即 notifyWebTurnDone。已经挪到 ③ 读完 JSONL 之后，
    // 由 turnEndedNormally 把校验门串起来——只有 stop_reason === 'end_turn' 才翻 idle。

    // 2) cooldown：默认不再对 Stop 启用 cooldown
    //
    // 原因：每个 Stop 事件都对应一次 AI 真实回话（用户提问 → AI 回应 → Stop fire）。
    // 之前用 30s cooldown 想去重 micro-turn，但实际把多轮对话也吞了 ——
    // 用户问完话 AI 立刻回 → Stop 在 30s 内 fire → 被静默 → 用户只能等 1min
    // 后的 idle Notification（⚠️ 图标），误以为"超时响应"。
    //
    // 现在所有事件都无 cooldown；rate limit 由 openclaw-bridge 整体的 6/min 出站
    // 限流兜底（防风控）。
    // 仍然保留 isOnCooldown 函数（debug / 未来某些事件类型可能需要）。

    // 3) 拼消息文本 —— 优先从 Claude Code jsonl 拿干净的 assistant turn
    let cleanContent = null         // jsonl 干净内容（不过滤、不截尾）
    let snippet = null              // PTY 兜底（脏，需要过滤）
    let historicalRaw = null
    let attachmentPath = null

    // 3a. 拿 sessionId 的 nativeId（Claude Code session UUID）
    let nativeId = null
    if (sessionId && aiTerminal?.sessions) {
      const sess = aiTerminal.sessions.get(sessionId)
      nativeId = sess?.nativeSessionId || null
      if (sess) {
        snippet = sess.recentOutput || ''
        if (Array.isArray(sess.outputHistory)) historicalRaw = sess.outputHistory.join('')
      }
    }
    if (!nativeId && hookPayload && typeof hookPayload === 'object') {
      nativeId = hookPayload.session_id || hookPayload.sessionId || null
    }

    // 3b. 从 jsonl 取 latest assistant turn（这是首选源）
    let turnText = null
    let turnRaw = null            // 给 footer 算本轮 usage 用
    let jsonlPath = null          // 给 footer 算 session 累计用
    const rawHookTranscriptPath = hookPayload && typeof hookPayload === 'object' && typeof hookPayload.transcript_path === 'string'
      ? hookPayload.transcript_path
      : null
    const hookTranscriptPath = hookTranscriptMatchesSession(rawHookTranscriptPath, nativeId)
      ? rawHookTranscriptPath
      : null
    if (rawHookTranscriptPath && !hookTranscriptPath) {
      logger.warn?.(`[openclaw-hook] ignoring transcript path that does not match native session id: nativeId=${nativeId || 'null'} path=${rawHookTranscriptPath}`)
    }
    if (hookTranscriptPath || (nativeId && pty?.findClaudeSession)) {
      try {
        const loc = hookTranscriptPath ? { filePath: hookTranscriptPath } : pty.findClaudeSession(nativeId)
        if (loc?.filePath) {
          jsonlPath = loc.filePath
          // **关键**：用 Fresh 版，等 jsonl 写完最新 turn 再读
          // 避免 Stop hook 触发但 jsonl 还没 flush，导致读到上一轮（"每条回复都是上一次的"）
          const turn = evt === 'session-end'
            ? readLatestAssistantTurn(loc.filePath)   // session 结束没必要等
            : await readLatestAssistantTurnFresh(loc.filePath)
          if (turn?.text) {
            turnText = turn.text
            turnRaw = turn.raw
            if (turn.fresh === false) {
              logger.warn?.(`[openclaw-hook] jsonl still stale after retries for ${nativeId || 'hook-payload'} (event=${evt}); using stale content as fallback`)
            }
          }
          // SessionEnd 时额外做 full transcript 附件
          if (evt === 'session-end') {
            const full = buildFullTranscript(loc.filePath)
            if (full.markdown) {
              attachmentPath = writeTranscriptTmp(full.markdown, sessionId, 'full')
            }
          } else if (turnText && turnText.length > INLINE_MAX_CHARS) {
            // Stop / Notification：长 turn 拆成 inline + 附件
            attachmentPath = writeTranscriptTmp(turnText, sessionId, 'turn')
          }
        } else {
          logger.warn?.(`[openclaw-hook] no jsonl found for nativeId=${nativeId}; falling back to PTY snippet`)
        }
      } catch (e) {
        logger.warn?.(`[openclaw-hook] read transcript failed: ${e.message}`)
      }
    } else if (sessionId) {
      logger.warn?.(`[openclaw-hook] cannot resolve transcript for sessionId=${sessionId} (nativeId=${nativeId} transcript_path=${hookTranscriptPath || 'null'} pty.findClaudeSession=${!!pty?.findClaudeSession}); falling back to PTY snippet`)
    }

    // 3b'. Stop hook 校验门：只有当 JSONL 末行 assistant.stop_reason === 'end_turn'
    //      才视为"本轮真的结束"。Claude 自家 Stop hook 在 sub-agent 完成 / 中间停顿 /
    //      内部 transition 等场景下也会 fire，stop_reason 会是 'tool_use' / 'max_tokens' / null。
    //      读不到 jsonl（nativeId 缺失 / 文件没找到）则兜底 true，保持旧行为，不阻塞 dispatcher。
    let turnEndedNormally = true
    if (evt === 'stop' && nativeId && jsonlPath) {
      const stopReason = turnRaw?.message?.stop_reason ?? null
      if (stopReason !== 'end_turn') {
        turnEndedNormally = false
        logger.warn?.(`[openclaw-hook] Stop hook deferred: stopReason=${stopReason || 'null'} sid=${sessionId} nativeId=${nativeId} — waiting for jsonl watcher to fire on real end_turn`)
      }
    }

    // 3b''. notifyWebTurnDone：向浏览器广播 turn_done。仅在确认 end_turn 时触发，避免
    //       前端的 markSessionTurnDone（store/aiSessionStore.ts）把状态错误地翻成 idle。
    if (evt === 'stop' && turnEndedNormally) {
      notifyWebTurnDone(sessionId, todoTitle)
    }

    // 3c. 决定 cleanContent（jsonl 命中时优先；长内容截短）
    if (turnText) {
      cleanContent = turnText.length > INLINE_MAX_CHARS
        ? turnText.slice(0, INLINE_MAX_CHARS - 200) + '\n\n…（完整内容见附件）'
        : turnText
      // jsonl 命中时不传 PTY 内容，避免 buildMessage 再次回退到脏数据
      snippet = null
      historicalRaw = null
    } else if (!snippet && hookPayload && typeof hookPayload === 'object') {
      const hint = hookPayload.message || hookPayload.summary || null
      if (hint && typeof hint === 'string') snippet = hint.trim()
    }

    // 3d. token usage footer ——
    // 仅 Stop / SessionEnd 推送时附加（notification 是 idle 心跳，没新轮次，无意义）
    // 配置开关：pricing.showInPush（默认 false，需 UI 打开）/ pricing.showCnyInPush（默认 true）
    let usageFooter = ''
    if ((evt === 'stop' || evt === 'session-end') && jsonlPath && shouldShowUsage()) {
      try {
        const turnUsage = extractTurnUsage(turnRaw)
        let sessionUsage = null
        try {
          const lines = readJsonlLines(jsonlPath)
          if (lines.length > 0) sessionUsage = extractSessionUsageFromLines(lines)
        } catch (e) {
          logger.warn?.(`[openclaw-hook] read session usage failed: ${e.message}`)
        }
        usageFooter = formatUsageFooter({
          turn: turnUsage,
          session: sessionUsage,
          showCny: shouldShowUsageCny(),
          pricing: getPricingConfig(),
        })
      } catch (e) {
        logger.warn?.(`[openclaw-hook] format usage footer failed: ${e.message}`)
      }
    }

    let message = buildMessage({
      event: evt, todoId, todoTitle,
      cleanContent,
      snippet,
      historicalRaw,
    })

    // Claude Code Notification hook fire 本身就是"需要用户介入"的可信信号——
    // 不再用正则/关键词反推 message 内容是不是"权限相关"。任何 Notification 都
    // 调用 markPendingConfirm；状态机自己根据 session.status 决定要不要翻转：
    //   - running → 翻 pending_confirm（mid-turn Notification = 真权限请求）
    //   - idle    → no-op（Stop 之后的 idle 提醒，不是权限）
    //   - pending_confirm → 幂等
    //   - bypass 模式工具预授权，运行期不会 fire 权限 Notification；如果 fire，状态机
    //     也会因为不在 running 而拒绝翻转。
    if (evt === 'notification' && sessionId) {
      try { aiTerminal?.markPendingConfirm?.(sessionId, { source: 'claude-notification' }) } catch { /* ignore */ }
    }

    // 1b-pre) bypass 模式下 session 不会真的卡在等用户，Notification 是 idle 心跳噪音，
    // 默认抑制。非 bypass session 的 Notification 直接放过（不再做文本侧筛选）。
    if (evt === 'notification' && notificationSuppressed() && !permissionReminderEligible) {
      return { ok: true, action: 'skipped', reason: 'notification_suppressed' }
    }

    // 1b) Notification cooldown（同一 session 单位时间内只推一次，默认 10 分钟）
    if (evt === 'notification') {
      const cd = notificationCooldownMs()
      if (cd > 0 && isOnCooldown(sessionId, evt, cd)) {
        return { ok: true, action: 'skipped', reason: 'notification_cooldown', cooldownMs: cd }
      }
    }

    let replyMarkup = null
    if (evt === 'notification' && permissionReminderEligible) {
      // 非 bypass session 收到 Notification：附 Enter/Esc 快速响应按钮。
      // 即便不是授权请求（例如 idle 提醒），点 Enter 给 Claude 一个空 line 也是无害的。
      message = buildPermissionNotificationMessage(message)
      replyMarkup = buildPermissionReplyMarkup(sessionId)
    }
    // footer 永远附在最末尾（即使消息被截短到附件也要保留，让用户能看到费用）
    if (usageFooter) message = `${message}\n\n${usageFooter}`

    // 4) 推送（broadcastText 扇出到 session 所有绑定 channel；接受可选 attachment）
    const result = await openclaw.broadcastText({
      sessionId,
      message,
      attachment: attachmentPath,    // bridge 转给 telegramBot.sendDocument
      replyMarkup,
    })

    // 5) SessionEnd 后处理：close topic + 改名 ✅ + 清状态
    if (evt === 'session-end') {
      const route = openclaw.resolveRoute?.(sessionId, 'telegram')
      if (route?.threadId && telegramBot) {
        try {
          await telegramBot.closeForumTopic({ chatId: route.targetUserId, threadId: route.threadId })
          if (route.topicName) {
            await telegramBot.editForumTopic({
              chatId: route.targetUserId,
              threadId: route.threadId,
              name: `✅ ${route.topicName}`.slice(0, 128),
            })
          }
        } catch (e) {
          logger.warn?.(`[openclaw-hook] close/edit topic failed: ${e.message}`)
        }
      }
      openclaw.clearLastPushForSession?.(sessionId)
      openclaw.clearSessionRoute?.(sessionId, 'session-end')
      if (sessionInputDispatcher?.onSessionEnd) {
        Promise.resolve(sessionInputDispatcher.onSessionEnd(sessionId))
          .catch((e) => logger.warn?.(`[openclaw-hook] dispatcher.onSessionEnd failed: ${e.message}`))
      }
    }

    // Stop 事件 = Claude 完成一轮回复 → 更新 idle 状态 + flush dispatcher 队列。
    // 这里不受 result.ok 左右，原因仍然成立：
    //   - awaitingReply 描述的是 Claude 自身状态（finished a turn），跟"我们有没有把回复
    //     成功推到 telegram/lark"无关；
    //   - 推送失败（route 缺失、TG 限流、网络错）一旦把这两步吞掉，dispatcher 就永远以为
    //     busy，后续用户消息全部回 "🔄 已排队"，队列也不 flush，直到进程重启都不能恢复。
    // 但额外加了 turnEndedNormally 门：JSONL 末行 stop_reason !== 'end_turn' 时 defer
    // 这两个 mutation —— Claude 自家 Stop hook 在中间停顿 / sub-agent 完成 / 内部
    // transition 等场景会假阳性 fire，把状态翻成 idle 后用户瞄一眼把 unread 清掉，徽标
    // 消失，等真正 end_turn 时再 fire 一次又变"待确认"，体验劣化。jsonl watcher 会在
    // 真 end_turn 时兜底走相同的状态翻转，dispatcher 不会卡住。
    if (evt === 'stop' && turnEndedNormally && sessionId && aiTerminal?.markSessionAwaitingReply) {
      try {
        const ok = aiTerminal.markSessionAwaitingReply(sessionId, true)
        // mark 返回 false = no-op：session 不在 ait.sessions / status 不是 running|pending_confirm
        // / 已经是目标值。出现这种情况说明之后 dispatcher 会把后续用户消息一直 queue 不投递
        // → 显式 warn 让 ops 知道 root cause（session lifecycle 跟 hook 不一致）。
        if (!ok) {
          const sess = aiTerminal?.sessions?.get?.(sessionId)
          logger.warn?.(`[openclaw-hook] markSessionAwaitingReply(true) NO-OP sid=${sessionId} sessionExists=${!!sess} status=${sess?.status || 'null'} awaitingReply=${sess?.awaitingReply}`)
        }
      } catch (e) { logger.warn?.(`[openclaw-hook] markSessionAwaitingReply failed: ${e.message}`) }
    }
    // 顺序：上面已 markSessionAwaitingReply(true) 让 dispatcher 看到 idle，再 flush
    if (evt === 'stop' && turnEndedNormally && sessionId && sessionInputDispatcher?.onSessionIdle) {
      Promise.resolve(sessionInputDispatcher.onSessionIdle(sessionId))
        .catch((e) => logger.warn?.(`[openclaw-hook] dispatcher.onSessionIdle failed: ${e.message}`))
    }

    if (result.ok) {
      recordSent(sessionId, evt)
      // Stop 事件 = Claude 完成一轮回复 → 标题切到 💤（在 push 成功后才切，
      // 避免推送失败时标题先变 💤 但消息没到）
      if (evt === 'stop' && sessionId && loadingTracker?.markIdle) {
        loadingTracker.markIdle(sessionId).catch((e) => logger.warn?.(`[openclaw-hook] markIdle failed: ${e.message}`))
      }
      // Stop / session-end → 清掉 lark "在思考" reaction（如果是 lark route）
      if ((evt === 'stop' || evt === 'session-end') && sessionId && larkBot?.clearReactionsForSession) {
        const route = openclaw.resolveRoute?.(sessionId, 'lark')
        if (route?.channel === 'lark') {
          larkBot.clearReactionsForSession(sessionId).catch((e) => logger.warn?.(`[openclaw-hook] clearReactionsForSession failed: ${e.message}`))
        }
      }
      // Stop / session-end → 清掉 telegram "✍" reaction（如果是 telegram route）
      if ((evt === 'stop' || evt === 'session-end') && sessionId && reactionTracker?.clearReactionsForSession) {
        const route = openclaw.resolveRoute?.(sessionId, 'telegram')
        if (route?.channel === 'telegram') {
          reactionTracker.clearReactionsForSession(sessionId).catch((e) => logger.warn?.(`[openclaw-hook] tg clearReactionsForSession failed: ${e.message}`))
        }
      }
      return { ok: true, action: 'sent', message, attachment: attachmentPath }
    }
    return { ok: false, action: 'failed', reason: result.reason || 'unknown', detail: result }
  }

  function describe() {
    return {
      cooldownMs,
      activeDedups: lastSentAt.size,
    }
  }

  // 测试 / 调试钩子
  function _reset() { lastSentAt.clear() }

  return {
    handle,
    describe,
    _reset,
  }
}

export const __test__ = { buildMessage, shortTodoId, extractTailSnippet }
