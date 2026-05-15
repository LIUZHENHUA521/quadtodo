/**
 * 从 PTY 尾部抽出 Claude Code / Codex 的"授权弹窗"文本与候选选项。
 *
 * 双源策略：
 *   - 主源 raw：session.recentOutput（4KB 滑窗，新鲜但被 TUI redraw 噪声覆盖）
 *               或 codex-prompt-detector 已经 ANSI-strip 过的短串。
 *   - 兜底 historicalRaw：session.outputHistory join 后的尾部（更大，旧但完整）。
 *
 * 输出 { text, options }：
 *   - text: 清洗 + 噪声过滤 + 锚定窗口后的多行字符串，给前端 PermissionCard 渲染。
 *   - options: 形如 [{ index: 1, label: 'Yes' }, ...]，按 index 升序。
 *
 * 设计：与 openclaw-hook.js 推 IM 时的清洗管线职责相似，但目标是"短而干净"——
 * IM 那边整轮 transcript 都要，这里只要授权弹窗那几行。规则同源（spinner /
 * status verb / prompt prefix / border 都过滤），避免两边漂移。
 */

const ANSI_OSC = /\x1b\][^\x07]*(\x07|\x1b\\)/g
const ANSI_CSI = /\x1b\[[0-9;?]*[A-Za-z~]/g
const ANSI_OTHER = /\x1b[()#][A-Za-z0-9]|\x1b[>=<cDEHMNOPZ78]/g
const CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g

const BOX_HORIZONTAL = /[─━┄┅┈┉═]/g
const BOX_VERTICAL = /[│┃┆┇┊┋║]/g
const BOX_CORNERS = /[┌┍┎┏┐┑┒┓└┕┖┗┘┙┚┛╭╮╯╰╓╒╕╖╙╘╛╜╔╗╚╝]/g
const BOX_TEES = /[├┝┞┟┠┡┢┣┤┥┦┧┨┩┪┫┬┭┮┯┰┱┲┳┴┵┶┷┸┹┺┻┼┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋╠╣╦╩╬]/g

// Claude TUI 噪声 —— 与 openclaw-hook.js 保持同步
const SPINNER_CHARS_STR = '✶✳✻✽★⚙∗⠁⠂⠄⡀⢀⠠⠐⠈'
// "Brewing for 3m" / "Skedaddled for 5s" / "Cooked." 这类 spinner 状态行
const STATUS_KEYWORDS = /\b[A-Z][a-z]{2,19}(?:ing|ed)\s+for\s+/
const STATUS_VERB_LINE = /^\s*[*✶✳✻✽★⚙∗⠁⠂⠄⡀⢀⠠⠐⠈]*\s*[A-Z][a-z]{2,19}(?:ing|ed)\s*(…|\.\.\.|\.\.|\.)\s*$/
// 行首单独的指示符行（不带任何内容）
const TUI_PROMPT_LINE = /^\s*[❯⏵►→]\s*$/
const AUTO_MODE_LINE = /(auto mode (on|off)|shift\+tab to cycle|ctrl\+[a-z]\b)/i
const BORDER_ONLY = /^[\s\-=_|+~]+$/

// 已知的"该停下来等用户"锚点。命中后我们围绕它取窗口，避免把锚点前的 prompt
// 文本（Bash 命令、文件路径、warning 等）切掉。多语言都列上，省得后续再扩。
const PERMISSION_ANCHORS = [
  /Do you want to proceed/i,
  /Do you want to make this edit/i,
  /Do you want to make this change/i,
  /Do you want to create/i,
  /Allow this/i,
  /apply patch\?/i,
  /run this command\?/i,
  /Approve\??/i,
  /\?\s*\[[yYnN]\/[yYnN]\]/,
  /(允许|批准|授权).*\?/,
]

function stripAnsi(s) {
  return String(s || '')
    .replace(ANSI_OSC, '')
    .replace(ANSI_CSI, '')
    .replace(ANSI_OTHER, '')
    .replace(CTRL, '')
}

function stripBoxDrawing(s) {
  return String(s || '')
    .replace(BOX_HORIZONTAL, '')
    .replace(BOX_VERTICAL, '')
    .replace(BOX_CORNERS, '')
    .replace(BOX_TEES, '')
}

function compactBlankLines(s) {
  return String(s || '').replace(/\n[ \t]*\n+/g, '\n\n')
}

function isSpinnerOnly(line) {
  const trimmed = line.replace(/\s+/g, '')
  if (!trimmed) return true
  for (const ch of trimmed) {
    if (!SPINNER_CHARS_STR.includes(ch) && !/\d/.test(ch)) return false
  }
  return true
}

function isNoiseLine(line) {
  if (STATUS_VERB_LINE.test(line)) return true
  if (STATUS_KEYWORDS.test(line)) return true
  if (TUI_PROMPT_LINE.test(line)) return true
  if (AUTO_MODE_LINE.test(line)) return true
  if (BORDER_ONLY.test(line)) return true
  return false
}

export function cleanPtyTail(raw) {
  if (!raw) return ''
  let s = stripAnsi(raw)
  s = stripBoxDrawing(s)
  // 去掉行尾空白
  s = s.split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n')
  // 过滤纯噪声行；保留空行（后面 compactBlankLines 再合并）
  s = s
    .split('\n')
    .filter((l) => {
      if (!l.trim()) return true
      if (isSpinnerOnly(l)) return false
      if (isNoiseLine(l)) return false
      return true
    })
    .join('\n')
  // 去掉行首 ❯ / > 标记（保留内容，比如 "❯ 1. Yes" → "1. Yes"）
  s = s.split('\n').map((l) => l.replace(/^(\s*)(?:❯|>)\s+/, '$1')).join('\n')
  return compactBlankLines(s).trim()
}

/**
 * 在文本里找形如 "1. Yes" / "2. No, suggest changes" 的枚举选项。
 * 找不到 → []。重复 index 仅保留首条。
 */
export function parsePermissionOptions(cleaned) {
  if (!cleaned) return []
  const seen = new Map()
  for (const l of cleaned.split('\n')) {
    const m = l.match(/^\s*([1-9])\.\s+(\S.{0,79}?)\s*$/)
    if (!m) continue
    const idx = parseInt(m[1], 10)
    const label = m[2].trim()
    if (!label) continue
    if (!seen.has(idx)) seen.set(idx, label)
  }
  return [...seen.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, label]) => ({ index, label }))
}

function findAnchorIndex(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (PERMISSION_ANCHORS.some((re) => re.test(lines[i]))) return i
  }
  return -1
}

/**
 * 从清洗后的 lines 取一个"覆盖授权 prompt 的窗口"。
 * - 找到锚点：起点 = anchor - maxLines*0.7，终点 = anchor + maxLines*0.3 + 1
 *   （要把选项行也带进来）
 * - 没找到锚点：直接取尾部 maxLines
 */
function takeWindow(lines, maxLines) {
  const idx = findAnchorIndex(lines)
  if (idx >= 0) {
    const back = Math.floor(maxLines * 0.7)
    const fwd = Math.ceil(maxLines * 0.3)
    return lines.slice(Math.max(0, idx - back), Math.min(lines.length, idx + fwd + 1))
  }
  return lines.slice(-maxLines)
}

/**
 * extractPermissionPrompt(raw, opts):
 *   - raw          : 主 PTY tail / detector promptText
 *   - opts.historicalRaw : recentOutput 洗完仍过瘦时回退的更大原始串
 *                          （建议传入 session.outputHistory.join('') 的尾部）
 *
 * 返回 { text, options }；text 不超过 maxChars，options 默认 maxLines=30。
 */
export function extractPermissionPrompt(
  raw,
  { historicalRaw = null, maxLines = 30, maxChars = 1200 } = {},
) {
  function extract(source) {
    const cleaned = cleanPtyTail(source)
    if (!cleaned) return ''
    const lines = cleaned.split('\n')
    const window = takeWindow(lines, maxLines)
    let text = window.join('\n').trim()
    if (text.length > maxChars) text = text.slice(-maxChars)
    return text
  }

  let text = extract(raw)
  // 主源里没有锚点或太瘦 → 回退完整历史尾部
  const hasAnchor = (s) => PERMISSION_ANCHORS.some((re) => re.test(s))
  if ((!text || text.length < 40 || !hasAnchor(text)) && historicalRaw) {
    const fallback = extract(historicalRaw)
    if (fallback && (hasAnchor(fallback) || fallback.length > text.length)) {
      text = fallback
    }
  }
  const options = parsePermissionOptions(text)
  return { text, options }
}
