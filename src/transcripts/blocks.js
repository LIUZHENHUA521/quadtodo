/**
 * Shared content-block helpers for Claude / Codex transcript renderers.
 *
 * 历史上 src/claude-transcript.js (Stop hook 用) 和 src/transcripts/scanner.js (历史会话找回的索引/预览用)
 * 各写了一份 block→text 逻辑，scanner 那一份只挑 text 字段，遇到 tool_use / tool_result 就静默丢失整轮，
 * 导致预览里看不到夹在工具调用之间的 user 输入。这里把渲染逻辑统一到一处，两边共用。
 */

/** 把 message.content 拍平成 array<block>，无论它是 string、array 还是缺省。 */
export function normalizeContent(content) {
  if (!content) return []
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (Array.isArray(content)) return content
  return []
}

/** 把单个 content block 渲染成人类可读文本。 */
export function blockToText(block, opts = {}) {
  if (!block || typeof block !== 'object') return ''
  if (block.type === 'text') return String(block.text || '')
  // codex 的 message.content 块可能是 {type:'input_text'|'output_text', text} 或裸 {text}
  if (block.type === 'input_text' || block.type === 'output_text') return String(block.text || '')
  if (!block.type && typeof block.text === 'string') return String(block.text)
  if (block.type === 'tool_use') {
    if (opts.includeToolUse === false) return ''
    const name = block.name || 'tool'
    const input = block.input
    let summary = ''
    if (input && typeof input === 'object') {
      const cmd = input.command || input.cmd
      const fp = input.file_path || input.path || input.filePath
      const url = input.url
      const pat = input.pattern || input.query
      const desc = input.description
      if (cmd) summary = String(cmd).slice(0, 200)
      else if (fp) summary = String(fp).slice(0, 200)
      else if (url) summary = String(url).slice(0, 200)
      else if (pat) summary = String(pat).slice(0, 200)
      else if (desc) summary = String(desc).slice(0, 120)
      else summary = JSON.stringify(input).slice(0, 200)
    }
    return `🔧 ${name}${summary ? ': ' + summary : ''}`
  }
  if (block.type === 'tool_result') {
    if (!opts.includeToolResult) return ''
    const c = block.content
    let text = ''
    if (typeof c === 'string') text = c
    else if (Array.isArray(c)) text = c.map((b) => b?.text || JSON.stringify(b)).join('\n')
    const max = opts.toolResultMaxChars || 300
    if (text.length > max) text = text.slice(0, max) + ` …(${text.length - max} more chars)`
    return `📋 result: ${text}`
  }
  if (block.type === 'thinking') return ''
  return ''
}
