/**
 * ask_user 推送的 inline keyboard 拼装 + callback 路由解析。
 *
 * Telegram 的 callback_data 上限是 64 字节（含），所以编码必须紧凑：
 *   qt:ans:<ticket>:<idx>   ← 用户点选项
 *   qt:ext:<ticket>:<idx>   ← 用户点 ✏️ 补充
 *
 * ticket 是 3 字符 base32（pending-questions.js 生成），idx 是 0-7 单字符 → 总长 ≤ 16 字节，安全。
 *
 * 布局策略：
 *   - 选项数 ≤ 4 且每条选项文本长度（含 emoji 计 1）≤ 8 → 2 列
 *   - 否则 1 列
 *   - 每个选项下面单独一行 ✏️ 补充按钮（行内空间留给主选项）
 */

export const CB_PREFIX = 'qt'
export const CB_KIND_ANSWER = 'ans'
export const CB_KIND_EXTEND = 'ext'

const SHORT_TEXT_THRESHOLD = 8     // 用 ≤8 字符判断"短"
const TWO_COL_MAX_OPTIONS = 4      // 超过 4 个选项强制单列（视觉太挤）

/**
 * 截断按钮文字。Telegram 按钮文本最大 64 字节，超过会发不出去。
 * 我们更激进地砍到 24，保持可读 + 不撑屏。
 */
function truncateLabel(s, max = 24) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  return t.slice(0, max - 1) + '…'
}

/**
 * 用 [...str] 算"显示宽度"（Unicode code points），保证中文字符也按 1 计。
 * 不区分东亚宽度，只为粗略判断"按钮文字短/长"。
 */
function displayWidth(s) {
  return [...String(s || '')].length
}

/**
 * 构造 ask_user 的 inline keyboard。
 *
 * 入参：
 *   - ticket: 3 字符 ticket
 *   - options: 选项字符串数组（≥ 2，建议 ≤ 8）
 *
 * 返回：{ inline_keyboard: Button[][] }，可直接作为 reply_markup 传 sendMessage。
 *
 * 行布局：
 *   - 选项行：每行 1 个按钮（长选项）或 2 个按钮（短选项 + 选项数 ≤ 4）
 *   - 紧跟在选项行后面会跟一个"✏️" 按钮行（独占）
 *   注意：每个选项独立配一个 ✏️，让用户可以在选完之后单独补充。
 *   为了不让按钮翻倍变成"主+辅"竖排太长，✏️ 跟主按钮放同一行最右（如果主按钮也独占行）。
 *
 * 实际版本：选用 "选项 + ✏️ 共占一行" 布局，让总行数等于选项数 —— 视觉最紧凑。
 */
export function buildAskUserReplyMarkup(ticket, options) {
  if (!ticket || typeof ticket !== 'string') {
    throw new Error('ticket required')
  }
  if (!Array.isArray(options) || options.length === 0) {
    throw new Error('options required')
  }

  const allShort = options.every((o) => displayWidth(o) <= SHORT_TEXT_THRESHOLD)
  const useTwoCol = allShort && options.length <= TWO_COL_MAX_OPTIONS && options.length > 1

  const rows = []
  if (useTwoCol) {
    // 2 列：每行 [opt_i, ✏️_i, opt_{i+1}, ✏️_{i+1}] —— 4 列太挤，所以
    // 折中：选项一行（2 个），✏️ 一行（2 个），用前缀 ✏️ 1./2. 标识对应关系
    for (let i = 0; i < options.length; i += 2) {
      const optRow = [
        { text: truncateLabel(`${i + 1}. ${options[i]}`), callback_data: `${CB_PREFIX}:${CB_KIND_ANSWER}:${ticket}:${i}` },
      ]
      if (i + 1 < options.length) {
        optRow.push({ text: truncateLabel(`${i + 2}. ${options[i + 1]}`), callback_data: `${CB_PREFIX}:${CB_KIND_ANSWER}:${ticket}:${i + 1}` })
      }
      rows.push(optRow)
      const extRow = [
        { text: `✏️ 补充${i + 1}`, callback_data: `${CB_PREFIX}:${CB_KIND_EXTEND}:${ticket}:${i}` },
      ]
      if (i + 1 < options.length) {
        extRow.push({ text: `✏️ 补充${i + 2}`, callback_data: `${CB_PREFIX}:${CB_KIND_EXTEND}:${ticket}:${i + 1}` })
      }
      rows.push(extRow)
    }
  } else {
    // 1 列：每行 [opt_i, ✏️] —— 主按钮独占主体，✏️ 缩成右侧小按钮
    for (let i = 0; i < options.length; i++) {
      rows.push([
        { text: truncateLabel(`${i + 1}. ${options[i]}`), callback_data: `${CB_PREFIX}:${CB_KIND_ANSWER}:${ticket}:${i}` },
        { text: '✏️', callback_data: `${CB_PREFIX}:${CB_KIND_EXTEND}:${ticket}:${i}` },
      ])
    }
  }

  return { inline_keyboard: rows }
}

/**
 * 解析 callback_data。
 * 返回 { kind, ticket, idx } 或 null（不是 quadtodo 的 callback）。
 *
 * 对未知 prefix（包括老的 qt:wd / qt:q / qt:t wizard prefix）返回 null —— caller 决定 fallback。
 */
export function parseCallbackData(data) {
  const s = String(data || '')
  if (!s.startsWith(`${CB_PREFIX}:`)) return null
  const parts = s.split(':')
  if (parts.length !== 4) return null
  const [, kind, ticket, idxStr] = parts
  if (kind !== CB_KIND_ANSWER && kind !== CB_KIND_EXTEND) return null
  if (!ticket || ticket.length < 1) return null
  const idx = parseInt(idxStr, 10)
  if (!Number.isInteger(idx) || idx < 0 || idx > 99) return null
  return { kind, ticket, idx }
}

/**
 * 选项数字回填给 pending.submitReply 的纯文本（"1" / "2"…）
 * 老路径完全兼容（pending-questions.parseReply 的"1..N"分支）。
 */
export function buildAnswerReplyText(idx) {
  return String(idx + 1)
}

/**
 * 拼"选项 + 用户补充"的最终 answerText（透传给 AI）。
 * 例：选项是 "北京时间"，用户补 "用 +0800 不要 +08:00" → "北京时间 · 用 +0800 不要 +08:00"
 *
 * 用 ` · ` 分隔（中圆点）—— 视觉清晰，AI 上下文也能看出主+附结构。
 */
export function buildExtendedReplyText(optionLabel, extra) {
  const opt = String(optionLabel || '').trim()
  const ex = String(extra || '').trim()
  if (!opt && !ex) return ''
  if (!ex) return opt
  if (!opt) return ex
  return `${opt} · ${ex}`
}
