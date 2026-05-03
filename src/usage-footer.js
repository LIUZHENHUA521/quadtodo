/**
 * Telegram 推送 footer：把"本轮 token 用量 + session 累计费用"拼成两行信息，
 * 让用户每次收到 AI 回复时都能立刻看到这一轮和这个 task 总共烧了多少钱。
 *
 * 数据流：
 *   - turn usage: 由 openclaw-hook 从 readLatestAssistantTurn().raw.message 拿
 *     （usage / model 直接是 Claude 写到 jsonl 里的字段）
 *   - session usage: 扫整个 jsonl 文件，调 usage-parser.extractUsage('claude', lines)
 *     拿到 session 内所有 assistant 消息的累加值
 *
 * 输出格式（紧凑两行，第三方 client 也好渲染）：
 *
 *   ———— 💸 ————
 *   turn:    in 1.2k · out 350 · cache 1.0k → $0.012 (¥0.09)
 *   session: $0.34 (¥2.46) · 12 turns
 *
 * 边界：
 *   - 任何字段缺失 / 全 0 → 那一行直接省略
 *   - turn 和 session 都没数据 → 返回空字符串（caller 直接不附 footer）
 *   - showCny=false → 省略 ¥…
 *   - cnyRate 缺省 → 用 DEFAULT_PRICING.cnyRate (7.2)
 *
 * 纯函数，无 IO；所有依赖（lines / pricing / cnyRate）都从入参传入，方便测试。
 */

import { extractUsage } from './usage-parser.js'
import { estimateCost, DEFAULT_PRICING } from './pricing.js'

const FOOTER_DIVIDER = '———— 💸 ————'

/**
 * 数字格式化：1234 → "1.2k", 999 → "999", 12345 → "12k", 1234567 → "1.2M"
 * 主要给 token 数用，目的是节省 Telegram 显示空间。
 */
export function formatTokenCount(n) {
  const v = Number(n) || 0
  if (v < 0) return '0'
  if (v < 1000) return String(v)
  if (v < 10000) return (v / 1000).toFixed(1) + 'k'
  if (v < 1_000_000) return Math.round(v / 1000) + 'k'
  return (v / 1_000_000).toFixed(2) + 'M'
}

/**
 * 钱数格式化：自适应位数。
 *   < $0.001 → "<$0.001"     （太少不值显示具体）
 *   < $0.01  → "$0.0042"     （4 位小数）
 *   < $1     → "$0.123"      （3 位小数）
 *   ≥ $1     → "$3.45"       （2 位小数）
 *
 * 同样规则套到 ¥ 上（CNY 数值通常是 USD * 7.2，量级类似）。
 */
function formatMoney(amount, symbol) {
  const v = Math.abs(Number(amount) || 0)
  if (v < 0.001) return `<${symbol}0.001`
  let s
  if (v < 0.01) s = v.toFixed(4)
  else if (v < 1) s = v.toFixed(3)
  else s = v.toFixed(2)
  return `${symbol}${s}`
}

/**
 * 拼"$0.012 (¥0.09)" 或单 USD/CNY，按 showCny 控制。
 */
export function formatCost({ usd, cny, showCny = true } = {}) {
  const usdStr = formatMoney(usd, '$')
  if (!showCny) return usdStr
  const cnyStr = formatMoney(cny, '¥')
  return `${usdStr} (${cnyStr})`
}

/**
 * 从 readLatestAssistantTurn().raw 里抽出本轮 usage。
 * 返回 { input, output, cacheRead, cacheCreation, model } —— 字段都是 number / string。
 *
 * 注意：单条 assistant message 的 usage 已经是 Claude 算好的"这次调用消耗"。
 * 一个 turn 可能包含多条 assistant message（tool_use 跟 final response 分开），
 * 但 readLatestAssistantTurn 取的是最后一条（final response），所以本轮 usage 就用这条。
 *
 * 如果 raw 没 usage（极端情况，例如 Claude Code 老版本），返回 null。
 */
export function extractTurnUsage(raw) {
  const msg = raw?.message
  if (!msg) return null
  const u = msg.usage
  if (!u) return null
  return {
    input: Number(u.input_tokens) || 0,
    output: Number(u.output_tokens) || 0,
    cacheRead: Number(u.cache_read_input_tokens) || 0,
    cacheCreation: Number(u.cache_creation_input_tokens) || 0,
    model: msg.model || null,
  }
}

/**
 * 从 jsonl lines 算 session 累计 usage。
 * 仅 Claude（codex 暂不在 footer 范围；Codex 推送目前没走 hook 路径）。
 *
 * 返回 { input, output, cacheRead, cacheCreation, primaryModel, turnCount }
 *   - turnCount = jsonl 里 role=assistant 的消息数（≈ AI 回话轮数）
 */
export function extractSessionUsageFromLines(lines) {
  const summary = extractUsage('claude', lines)
  // turn count: 数 jsonl 里 type=assistant 的有效 record（usage-parser 没暴露，自己数）
  let turnCount = 0
  for (const line of lines) {
    if (!line || !line.trim()) continue
    try {
      const j = JSON.parse(line)
      if (j?.message?.role === 'assistant') turnCount++
    } catch { /* 忽略坏行 */ }
  }
  return {
    input: summary.inputTokens,
    output: summary.outputTokens,
    cacheRead: summary.cacheReadTokens,
    cacheCreation: summary.cacheCreationTokens,
    primaryModel: summary.primaryModel,
    turnCount,
  }
}

/**
 * 把 turn / session 拼成 Telegram footer 文本。
 *
 * 入参：
 *   - turn:    { input, output, cacheRead, cacheCreation, model } 或 null
 *   - session: { input, output, cacheRead, cacheCreation, primaryModel, turnCount } 或 null
 *   - showCny: 是否显示人民币（默认 true）
 *   - pricing: 同 estimateCost；默认 DEFAULT_PRICING
 *
 * 返回：footer 字符串，或 '' 表示不要附加。
 *
 * 单测覆盖各种 0 / null / 缺字段的退化路径。
 */
export function formatUsageFooter({ turn = null, session = null, showCny = true, pricing = DEFAULT_PRICING } = {}) {
  const lines = []

  // ── turn line ─────────────────────────────
  if (turn && (turn.input || turn.output || turn.cacheRead || turn.cacheCreation)) {
    const parts = []
    if (turn.input)  parts.push(`in ${formatTokenCount(turn.input)}`)
    if (turn.output) parts.push(`out ${formatTokenCount(turn.output)}`)
    const cache = (turn.cacheRead || 0) + (turn.cacheCreation || 0)
    if (cache > 0) parts.push(`cache ${formatTokenCount(cache)}`)
    const cost = estimateCost(
      { input: turn.input, output: turn.output, cacheRead: turn.cacheRead, cacheCreation: turn.cacheCreation },
      turn.model,
      pricing,
    )
    lines.push(`turn:    ${parts.join(' · ')} → ${formatCost({ usd: cost.usd, cny: cost.cny, showCny })}`)
  }

  // ── session line ──────────────────────────
  if (session && (session.input || session.output || session.cacheRead || session.cacheCreation)) {
    const cost = estimateCost(
      { input: session.input, output: session.output, cacheRead: session.cacheRead, cacheCreation: session.cacheCreation },
      session.primaryModel,
      pricing,
    )
    const turnTag = session.turnCount ? ` · ${session.turnCount} turns` : ''
    lines.push(`session: ${formatCost({ usd: cost.usd, cny: cost.cny, showCny })}${turnTag}`)
  }

  if (lines.length === 0) return ''
  return `${FOOTER_DIVIDER}\n${lines.join('\n')}`
}

export const __test__ = { FOOTER_DIVIDER, formatMoney }
