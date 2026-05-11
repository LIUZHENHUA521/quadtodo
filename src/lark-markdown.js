/**
 * 飞书 text 消息不渲染 markdown，把常见 markdown 语法降级为可读纯文本。
 * 主线场景：把 LLM/AgentQuad 输出的 markdown 长文本干净地推到飞书 thread。
 *
 * 处理范围（按顺序）：
 *   - 代码块 ```lang ... ``` → 去掉栅栏，保留内容
 *   - 图片 ![alt](url)        → 删掉
 *   - 链接 [text](url)        → "text (url)"，text==url 时只保留 url
 *   - 标题 #..######          → 去掉 # 前缀
 *   - 引用 >                  → 去掉 > 前缀
 *   - 粗体 **x** / __x__      → x
 *   - 斜体 *x* / _x_          → x（用前后界判断避免吃 list bullet）
 *   - 删除线 ~~x~~            → x
 *   - 水平线 --- / *** / ___  → ——————
 *   - 转义 \* \_ \` 等         → * _ `
 *
 * 不处理：
 *   - inline code `code` 保留 backticks（视觉提示），飞书原样显示
 *   - 表格 | a | b |            保留原样（飞书不渲染但能读）
 *   - 列表标记 - / * / 1.      保留
 */
export function toLarkText(text) {
  if (text == null) return ''
  if (typeof text !== 'string') return String(text)
  let out = text
  // 代码块（带或不带语言）
  out = out.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, '$1')
  // 图片
  out = out.replace(/!\[[^\]]*\]\([^)]+\)/g, '')
  // 链接
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) =>
    label === url ? url : `${label} (${url})`
  )
  // 标题（行首 1-6 个 #）
  out = out.replace(/^#{1,6}\s+/gm, '')
  // 引用
  out = out.replace(/^>\s?/gm, '')
  // 粗体 **x** / __x__
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, '$1')
  out = out.replace(/__([^_\n]+?)__/g, '$1')
  // 斜体 *x* / _x_：用 lookbehind 避免吃 list bullet 和反斜杠转义的 *
  out = out.replace(/(?<![\\*\w])\*([^*\n]+?)(?<!\\)\*(?!\w)/g, '$1')
  out = out.replace(/(?<![\\_\w])_([^_\n]+?)(?<!\\)_(?!\w)/g, '$1')
  // 删除线
  out = out.replace(/~~([^~\n]+?)~~/g, '$1')
  // 水平线（整行只有 --- / *** / ___ 至少 3 个）
  out = out.replace(/^\s*([-*_])\1{2,}\s*$/gm, '——————————')
  // backslash 转义
  out = out.replace(/\\([\\*_`~\[\]()#+\-.!|>])/g, '$1')
  return out
}
