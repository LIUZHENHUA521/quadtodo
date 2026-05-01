/**
 * Claude Code Hook 主动推送处理器。
 *
 * 接收 hook 脚本（~/.quadtodo/claude-hooks/notify.js）发来的事件，
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
import { homedir } from 'node:os'
import { readLatestAssistantTurn, readLatestAssistantTurnFresh, buildFullTranscript } from './claude-transcript.js'

const DEFAULT_COOLDOWN_MS = 30_000
const TRANSCRIPT_TMP_DIR = join(homedir(), '.quadtodo', 'tmp')
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

function cleanBoxDrawing(s) {
  return String(s || '')
    .replace(BOX_HORIZONTAL, '-')   // 横线 → -
    .replace(BOX_VERTICAL, '|')     // 竖线 → |
    .replace(BOX_CORNERS, '+')      // 角 → +
    .replace(BOX_TEES, '+')         // 三叉 → +
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
export function createOpenClawHookHandler({
  db, openclaw, aiTerminal = null,
  pty = null, telegramBot = null,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  getConfig = null,                  // () => app config（用于读 telegram.notificationCooldownMs）
  logger = console,
} = {}) {
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

  // 默认丢弃 Claude Code 的 idle Notification —— quadtodo bypass 模式下纯噪声。
  // 用户可在 config 里 telegram.suppressNotificationEvents = false 恢复旧 cooldown 行为。
  function notificationSuppressed() {
    try {
      const cfg = getConfig?.() || {}
      const raw = cfg.telegram?.suppressNotificationEvents
      if (raw === false) return false   // 显式 false → 不抑制
      return true                        // 默认 true / undefined → 抑制
    } catch { return true }
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

  /**
   * 处理一条 hook 事件。
   * 返回 { ok, action: 'sent'|'skipped'|'failed', reason? }
   */
  async function handle({ event, sessionId, todoId, todoTitle, hookPayload } = {}) {
    if (!event) return { ok: false, action: 'failed', reason: 'event_required' }
    const evt = String(event).toLowerCase()

    // 诊断：sessionId 给了但 bridge 没注册过 route → 99% 会触发 telegram fallback / General 泄漏
    // 用 warn 让 race 复现时直接在日志里抓到（A=spawn 抢跑 / B=clear 后尾巴 / D=close handler race）
    if (sessionId && openclaw?.hasExplicitRoute && !openclaw.hasExplicitRoute(sessionId)) {
      logger.warn?.(`[openclaw-hook] hook fired with no registered route: event=${evt} sid=${sessionId} todoId=${todoId || 'null'}`)
    }

    // 1) ask_user pending 时 Stop 静默
    if (evt === 'stop' && hasPendingAskUser(sessionId)) {
      return { ok: true, action: 'skipped', reason: 'ask_user_pending' }
    }

    // 1b-pre) 默认抑制 idle Notification（noise）—— 早于 cooldown / jsonl / postText
    if (evt === 'notification' && notificationSuppressed()) {
      return { ok: true, action: 'skipped', reason: 'notification_suppressed' }
    }

    // 1b) Notification cooldown（idle 提醒太频繁的关键修复）
    //     Notification 是 Claude Code 每隔 ~60s 触发一次的 idle 心跳；
    //     单 session 内默认 10 分钟内只发一次，可通过 telegram.notificationCooldownMs 调
    if (evt === 'notification') {
      const cd = notificationCooldownMs()
      if (cd > 0 && isOnCooldown(sessionId, evt, cd)) {
        return { ok: true, action: 'skipped', reason: 'notification_cooldown', cooldownMs: cd }
      }
    }

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

    // 3b. 从 jsonl 取 latest assistant turn（这是首选源）
    let turnText = null
    if (nativeId && pty?.findClaudeSession) {
      try {
        const loc = pty.findClaudeSession(nativeId)
        if (loc?.filePath) {
          // **关键**：用 Fresh 版，等 jsonl 写完最新 turn 再读
          // 避免 Stop hook 触发但 jsonl 还没 flush，导致读到上一轮（"每条回复都是上一次的"）
          const turn = evt === 'session-end'
            ? readLatestAssistantTurn(loc.filePath)   // session 结束没必要等
            : await readLatestAssistantTurnFresh(loc.filePath)
          if (turn?.text) {
            turnText = turn.text
            if (turn.fresh === false) {
              logger.warn?.(`[openclaw-hook] jsonl still stale after retries for ${nativeId} (event=${evt}); using stale content as fallback`)
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
      logger.warn?.(`[openclaw-hook] cannot resolve nativeId for sessionId=${sessionId} (nativeId=${nativeId} pty.findClaudeSession=${!!pty?.findClaudeSession}); falling back to PTY snippet`)
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

    const message = buildMessage({
      event: evt, todoId, todoTitle,
      cleanContent,
      snippet,
      historicalRaw,
    })

    // 4) 推送（postText 接受可选 attachment）
    const result = await openclaw.postText({
      sessionId,
      message,
      attachment: attachmentPath,    // bridge 转给 telegramBot.sendDocument
    })

    // 5) SessionEnd 后处理：close topic + 改名 ✅ + 清状态
    if (evt === 'session-end') {
      const route = openclaw.resolveRoute?.(sessionId)
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
    }

    if (result.ok) {
      recordSent(sessionId, evt)
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

export const __test__ = { buildMessage, shortTodoId }
