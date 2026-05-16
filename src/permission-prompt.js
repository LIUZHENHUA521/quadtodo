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
// Unicode Block Elements (U+2580-259F)：▀▁▂▃▄▅▆▇█ ▉▊▋▌▍▎▏ ▐░▒▓▔▕▖▗▘▙▚▛▜▝▞▟
// Cursor TUI 用这些字符画状态栏 / 进度条 / 边框，连一串看起来就是大片黑条。
const BOX_BLOCK = /[▀-▟]/g

// Claude TUI 噪声 —— 与 openclaw-hook.js 保持同步
const SPINNER_CHARS_STR = '✶✳✻✽★⚙∗⠁⠂⠄⡀⢀⠠⠐⠈'
// "Brewing for 3m" / "Skedaddled for 5s" / "Cooked." 这类 spinner 状态行
const STATUS_KEYWORDS = /\b[A-Z][a-z]{2,19}(?:ing|ed)\s+for\s+/
const STATUS_VERB_LINE = /^\s*[*✶✳✻✽★⚙∗⠁⠂⠄⡀⢀⠠⠐⠈]*\s*[A-Z][a-z]{2,19}(?:ing|ed)\s*(…|\.\.\.|\.\.|\.)\s*$/
// 真实形态："✽ Embellishing…   7      303          thinking more"——spinner + 动词 + 后面一堆杂物
// 老的 STATUS_VERB_LINE 要求整行只有 spinner+verb，匹配不上。这条更宽松：spinner 起头 + 动词，
// 后面爱写啥写啥都丢掉。
const SPINNER_PROGRESS_LINE = /^\s*[*✶✳✻✽★⚙∗⠁⠂⠄⡀⢀⠠⠐⠈]\s+[A-Z][a-z]{2,19}(?:ing|ed)\b/
// 行首单独的指示符行（不带任何内容）
const TUI_PROMPT_LINE = /^\s*[❯⏵►→]\s*$/
const AUTO_MODE_LINE = /(auto mode (on|off)|shift\+tab to cycle|ctrl\+[a-z]\b)/i
const BORDER_ONLY = /^[\s\-=_|+~]+$/

// Claude 真权限框/选择器底部固定 footer（cleanPtyTail 不会过滤掉这行）。
// 跟 claude-prompt-detector 里的 CLAUDE_PERMISSION_FOOTER 是同一份语义。
const CLAUDE_FOOTER_RE = /Esc\s+to\s+cancel|Tab\s+to\s+amend|Tab\s+to\s+select/i

// 已知的"该停下来等用户"锚点。命中后我们围绕它取窗口，避免把锚点前的 prompt
// 文本（Bash 命令、文件路径、warning 等）切掉。
//
// 通用化（用户回归：edit pty.js 那条没命中，因为老 whitelist 漏了一些措辞）：
// Claude 的标准提问全部是 "Do you want to <verb> ...?" 句型——proceed / make this
// edit / make this change / create / write / install / run / ... whitelist 永远追不
// 上 Claude 的新词。直接放宽成 `/Do you want to/i` 这一条通用 pattern，配合
// footer-at-bottom + ≥2 数字选项的强守卫已经够区分 AI 自由回复（AI 回复不会
// 末尾带字面 "Esc to cancel · Tab to amend"）。
//
// 老的 Codex 单行 `[y/N]` / `apply patch?` 也留着；不影响 Claude 路径。
const PERMISSION_ANCHORS = [
  /Do you want to\b/i,                            // 通用 Claude 提问
  /Allow this/i,
  /apply patch\?/i,                               // legacy codex
  /run this command\?/i,                          // legacy codex
  /Approve\??/i,
  /\?\s*\[[yYnN]\/[yYnN]\]/,                      // legacy codex y/N
  /(允许|批准|授权).*\?/,
]

// Claude Code (ink/yoga) TUI 用 CUF（cursor forward, `\x1b[NC`）和 CUD（cursor down,
// `\x1b[NB`）做空白对齐，而不是直接打空格/换行。如果先无脑 strip 掉 CSI，对齐空白
// 就跟着没了——"Do you want to proceed" 会变成 "Doyouwanttoproceed"，PERMISSION_ANCHORS
// 这种带字面量空格的 regex 全部失配，detector 永远 emit 不出来。
// 修复：strip CSI 之前先把 CUF/CUD 还原成对应数量的空格/换行；缺省参数 N 视作 1。
function expandCursorMoves(s) {
  return String(s || '')
    .replace(/\x1b\[(\d*)C/g, (_m, n) => ' '.repeat(Math.min(parseInt(n, 10) || 1, 200)))
    .replace(/\x1b\[(\d*)B/g, (_m, n) => '\n'.repeat(Math.min(parseInt(n, 10) || 1, 50)))
}

function stripAnsi(s) {
  return expandCursorMoves(s)
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
    .replace(BOX_BLOCK, '')
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
  if (SPINNER_PROGRESS_LINE.test(line)) return true
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
 * 严格的"真权限框"窗口定位：
 *
 *   1. footer (Esc to cancel · Tab to amend) 必须在最后 5 行 —— 屏幕**当前**正在显示
 *      权限框，不是缓冲深处某次老 prompt 的残骸；
 *   2. footer 上面 maxBack 行内必须找到 anchor (Do you want to ...)；
 *   3. anchor 和 footer 之间必须有 ≥2 个数字选项 (1. Yes / 2. No)。
 *
 * 三个信号全在一个紧凑、顺序正确的窗口里才认。这条规则把
 *   "AI 自由回复里恰好出现 anchor、缓冲老地方有 footer、又有 markdown 数字列表"
 * 这种零散信号拼出来的假阳性挡掉。
 *
 * 命中：返回 { startIdx, footerIdx, options }；不命中：null。
 */
function findStrictPermissionWindow(lines, { maxBack = 15, footerTailRange = 5, contextLinesBeforeAnchor = 8 } = {}) {
  // 1) 找最末 5 行内的 footer
  let footerIdx = -1
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - footerTailRange); i--) {
    if (CLAUDE_FOOTER_RE.test(lines[i])) { footerIdx = i; break }
  }
  if (footerIdx < 0) return null

  // 2) footer 上方 maxBack 行内找 anchor
  const searchFloor = Math.max(0, footerIdx - maxBack)
  let anchorIdx = -1
  for (let i = footerIdx - 1; i >= searchFloor; i--) {
    if (PERMISSION_ANCHORS.some((re) => re.test(lines[i]))) { anchorIdx = i; break }
  }
  if (anchorIdx < 0) return null

  // 3) anchor → footer 之间 ≥2 数字选项
  const options = []
  const seen = new Map()
  for (let i = anchorIdx + 1; i < footerIdx; i++) {
    const m = lines[i].match(/^\s*([1-9])\.\s+(\S.{0,79}?)\s*$/)
    if (!m) continue
    const idx = parseInt(m[1], 10)
    const label = m[2].trim()
    if (!label || seen.has(idx)) continue
    seen.set(idx, label)
    options.push({ index: idx, label })
  }
  if (options.length < 2) return null

  // 4) 起点往 anchor 上方再退一段（典型形态：Bash command / Edit file path / description
  //    等几行在 anchor 上方）。stop 在空行或第二个连续空行，避免把上一帧 chat 内容卷进来。
  let startIdx = anchorIdx
  let blanksSeen = 0
  for (let i = anchorIdx - 1; i >= Math.max(0, anchorIdx - contextLinesBeforeAnchor); i--) {
    const isBlank = !lines[i].trim()
    if (isBlank) {
      blanksSeen++
      if (blanksSeen >= 2) break          // 两个空行 = 工具盒上面，截断
      startIdx = i
      continue
    }
    blanksSeen = 0
    startIdx = i
  }

  return { startIdx, footerIdx, options }
}

/**
 * extractPermissionPrompt(raw, opts):
 *   - raw          : 主 PTY tail / detector promptText
 *   - opts.historicalRaw : recentOutput 洗完仍过瘦时回退的更大原始串
 *                          （建议传入 session.outputHistory.join('') 的尾部）
 *
 * 返回 { text, options }；text 不超过 maxChars，options 默认 maxLines=30。
 */
/**
 * 把 jsonl 里的 pending tool_use 块渲染成 PermissionCard 要显示的 prompt 文本。
 *
 * Claude Code 的工具有十几种，这里只把"用户最关心的字段"挑出来：
 *   Bash       → input.command（完整命令，最多 1200 字）
 *   Edit/Write → input.file_path
 *   Read       → input.file_path
 *   Glob/Grep  → input.pattern / input.glob_pattern
 *   WebFetch   → input.url
 *   其它       → JSON.stringify(input)
 * + 如果 input.description 存在，补一行说明。
 */
export function formatToolUseAsPrompt(toolUse, { maxChars = 1200 } = {}) {
  if (!toolUse || typeof toolUse !== 'object') return ''
  const name = String(toolUse.name || 'tool')
  const input = toolUse.input || {}
  let body = ''
  if (typeof input.command === 'string') body = input.command
  else if (typeof input.cmd === 'string') body = input.cmd
  else if (typeof input.file_path === 'string') body = input.file_path
  else if (typeof input.path === 'string') body = input.path
  else if (typeof input.url === 'string') body = input.url
  else if (typeof input.pattern === 'string') body = input.pattern
  else if (typeof input.glob_pattern === 'string') body = input.glob_pattern
  else if (typeof input.query === 'string') body = input.query
  else {
    try { body = JSON.stringify(input, null, 2) } catch { body = String(input) }
  }
  if (body.length > maxChars) body = body.slice(0, maxChars) + ' …(truncated)'
  const desc = typeof input.description === 'string' && input.description.trim()
    ? `\n\n${input.description.trim()}`
    : ''
  return `${name}:\n${body}${desc}`
}

// Claude Code 标准 3 选项授权弹窗。当我们从 jsonl 拿到 pending tool_use 时，
// 选项是固定的——不必再去 PTY 里猜。前端按这三项渲染。
// 文案保持英文原样，与 TUI 一致，方便用户对照终端确认。
export const CLAUDE_DEFAULT_PERMISSION_OPTIONS = [
  { index: 1, label: 'Yes' },
  { index: 2, label: "Yes, and don't ask again this session" },
  { index: 3, label: 'No, and tell Claude what to do differently' },
]

export function extractPermissionPrompt(
  raw,
  { historicalRaw = null, maxLines = 30, maxChars = 1200 } = {},
) {
  function extract(source) {
    const cleaned = cleanPtyTail(source)
    if (!cleaned) return { text: '', options: [] }
    const lines = cleaned.split('\n')
    const m = findStrictPermissionWindow(lines, { maxBack: maxLines, footerTailRange: 5 })
    if (!m) return { text: '', options: [] }
    let text = lines.slice(m.startIdx, m.footerIdx + 1).join('\n').trim()
    if (text.length > maxChars) text = text.slice(-maxChars)
    return { text, options: m.options }
  }

  let { text, options } = extract(raw)
  // 主源里 strict window 没命中 → 回退完整历史尾部再试一次
  if ((!text || options.length < 2) && historicalRaw) {
    const fallback = extract(historicalRaw)
    if (fallback.text && fallback.options.length >= 2) {
      text = fallback.text
      options = fallback.options
    }
  }
  return { text, options }
}
