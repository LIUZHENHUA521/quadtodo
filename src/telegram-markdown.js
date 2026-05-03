/**
 * 把 LLM 风格的 Markdown（标题、粗体、列表、code block）转成 Telegram MarkdownV2。
 *
 * 为什么用 V2 而不是 legacy：
 *   - legacy Markdown：标题 / 列表无渲染；`**bold**` 字面显示
 *   - MarkdownV2：标题→粗体、`**`→`*`、`-`→`•`、code block 内不转义
 * 但 V2 的副作用是正文里的 `_*[]()~`>#+-=|{}.!` 都要转义，错一个就 parse fail。
 * 所以走 `telegramify-markdown` 这个专门给 LLM 输出做的转换器。
 *
 * 用法：在所有 sendMessage / sendDocument(caption) 入口的 text 上跑一遍。
 * parseMode 同步切到 'MarkdownV2'。
 */
import telegramifyMarkdown from 'telegramify-markdown'

/**
 * 把 markdown 表格行（连续 ≥2 行 `|...|`）包进 ``` 代码块。
 * 原因：Telegram MarkdownV2 没有 table 渲染，但 fenced code block 能用等宽字体保留对齐
 * —— 所以我们把表格"伪装"成 code block 让 telegramify 后续按 pre 出。
 */
function wrapTablesAsCodeBlock(text) {
  const lines = String(text).split('\n')
  const out = []
  let buf = []
  const isTableLine = (l) => /^\s*\|.*\|\s*$/.test(l)
  const flush = () => {
    if (buf.length >= 2) {
      out.push('```')
      for (const l of buf) out.push(l)
      out.push('```')
    } else {
      for (const l of buf) out.push(l)
    }
    buf = []
  }
  for (const line of lines) {
    if (isTableLine(line)) {
      buf.push(line)
    } else {
      if (buf.length) flush()
      out.push(line)
    }
  }
  if (buf.length) flush()
  return out.join('\n')
}

/**
 * 转成 V2-safe 文本。空/非字符串原样返回。库异常时也回退原文，
 * 让上游 sendMessage 的 plain-text fallback 兜底。
 *
 * 表格预处理：先把 markdown 表格包进 ``` code block，让 Telegram 用等宽渲染保留对齐。
 */
export function toTelegramV2(text) {
  if (!text || typeof text !== 'string') return text
  try {
    const tablesAsPre = wrapTablesAsCodeBlock(text)
    // telegramify 会在末尾加一个 '\n' —— 去掉，免得每条消息多一个空行
    return telegramifyMarkdown(tablesAsPre, 'escape').replace(/\n$/, '')
  } catch {
    return text
  }
}

/**
 * V2 解析失败的兜底用：把 markdown 标记**删掉**，正文保留。
 * 比直接发 raw text（满屏 #### / ** / >）干净得多。
 *
 * telegramify 'remove' 只剥 HTML 这种 unsupported tag，markdown 标记会被转成 V2
 * syntax（*..*、>..），在 plain-text 模式下还是字面字符 — 所以这里直接做正则清洗。
 *
 * 注意：inline code（`code`）的 backticks **保留**——plain text 模式下没法显示
 * 高亮，但留着 backticks 用户至少能识别"这是代码"。比把 `code` 剥成 code 强。
 */
export function toPlainText(text) {
  if (!text || typeof text !== 'string') return text
  return String(text)
    .replace(/^#{1,6}\s+/gm, '')             // # / ## / #### 等标题前缀
    .replace(/\*\*(.+?)\*\*/g, '$1')          // **bold**
    .replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '$1')  // _italic_
    // inline code `code` 不剥 backticks（保留视觉提示）
    .replace(/^>\s?/gm, '')                   // > blockquote 前缀
}
