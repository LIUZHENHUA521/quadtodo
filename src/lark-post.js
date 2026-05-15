/**
 * Markdown → 飞书 post 富文本 AST。
 * 主线场景：LLM / plan 完成通知这类含表格 + 多级标题的长 markdown，发飞书时
 * 不再降级成纯文本被 toLarkText 摊平，改成 post 富文本，让飞书原生渲染粗体、
 * 链接、代码块。
 *
 * post 的能力边界：
 *   - text (style: bold/italic/underline/lineThrough), a, at, img, code_block, hr
 *   - 没有 heading 多级、没有 table、没有 list 原语，全部要自己用前缀/样式模拟
 *
 * 输出形状（飞书 im.message.create 直传）：
 *   { zh_cn: { title?: '', content: [[ {tag,...}, ... ], ...] } }
 *   content 是"段落数组"，每段是 tag 数组，段间飞书自动换行。
 */

// 块级 markdown 判据：只有命中"块级"特征才升级到 post，避免普通正文里偶尔
// 出现的 **bold** / *italic* 误触发。
const BLOCK_PATTERNS = [
  /^#{1,6}\s/m,            // 行首 1-6 个 # + 空格
  /^\|.*\|\s*$\n\s*\|\s*[-:|\s]+\|/m, // 表格：行首 | + 紧跟分隔行
  /^```/m,                 // 围栏代码块
  /^[-*]\s/m,              // 列表 - / *
  /^\d+\.\s/m,             // 列表 1.
  /^>\s/m,                 // 引用
]

export function isMarkdownLike(text) {
  if (typeof text !== 'string' || !text) return false
  return BLOCK_PATTERNS.some((re) => re.test(text))
}

const HEADER_PREFIX = ['━━━ ', '▎', '· ', '· ', '· ', '· ']

/**
 * 把行内 markdown（**bold**, *italic*, [text](url), `code`）切成 post tag 数组。
 * 不处理块级元素。
 */
function inlineTokens(line) {
  const tokens = []
  let i = 0
  const len = line.length

  function pushText(text, style) {
    if (!text) return
    const node = { tag: 'text', text }
    if (style && style.length) node.style = style
    tokens.push(node)
  }

  let buf = ''
  while (i < len) {
    // 链接 [label](url)
    const linkMatch = line.slice(i).match(/^\[([^\]]+)\]\(([^)]+)\)/)
    if (linkMatch) {
      pushText(buf); buf = ''
      tokens.push({ tag: 'a', text: linkMatch[1], href: linkMatch[2] })
      i += linkMatch[0].length
      continue
    }
    // 粗体 **x**
    if (line[i] === '*' && line[i + 1] === '*') {
      const end = line.indexOf('**', i + 2)
      if (end > i + 2) {
        pushText(buf); buf = ''
        pushText(line.slice(i + 2, end), ['bold'])
        i = end + 2
        continue
      }
    }
    // 粗体 __x__
    if (line[i] === '_' && line[i + 1] === '_') {
      const end = line.indexOf('__', i + 2)
      if (end > i + 2) {
        pushText(buf); buf = ''
        pushText(line.slice(i + 2, end), ['bold'])
        i = end + 2
        continue
      }
    }
    // 斜体 *x*（前后非字母/星号/反斜杠）
    if (line[i] === '*' && line[i - 1] !== '*' && line[i + 1] !== '*' && line[i + 1] !== ' ' && line[i - 1] !== '\\') {
      const rest = line.slice(i + 1)
      const m = rest.match(/^([^*\n]+?)\*(?!\w)/)
      if (m) {
        pushText(buf); buf = ''
        pushText(m[1], ['italic'])
        i += 1 + m[0].length
        continue
      }
    }
    // inline code `code` → post 无 inline code，用斜体近似（保留 backtick 视觉提示）
    if (line[i] === '`') {
      const end = line.indexOf('`', i + 1)
      if (end > i + 1) {
        pushText(buf); buf = ''
        pushText(line.slice(i + 1, end), ['italic'])
        i = end + 1
        continue
      }
    }
    buf += line[i]
    i += 1
  }
  pushText(buf)
  return tokens
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line)
}

function splitTableRow(line) {
  // 允许首尾 | 也允许没有；按未转义的 | 切
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim() || '—')
}

/**
 * 把一段连续表格行转成 post 段落数组：
 *   - 表头行 → "**h1** | **h2** | ..."
 *   - 数据行 → "**c1** · c2 · c3 · ..."（首列 bold 当行锚点）
 */
function renderTable(headerLine, dataLines) {
  const paragraphs = []
  const headers = splitTableRow(headerLine)
  const headerTokens = []
  headers.forEach((h, idx) => {
    if (idx > 0) headerTokens.push({ tag: 'text', text: ' | ' })
    headerTokens.push({ tag: 'text', text: h, style: ['bold'] })
  })
  paragraphs.push(headerTokens)

  for (const row of dataLines) {
    const cells = splitTableRow(row)
    const rowTokens = []
    cells.forEach((c, idx) => {
      if (idx === 0) {
        rowTokens.push({ tag: 'text', text: c, style: ['bold'] })
      } else {
        rowTokens.push({ tag: 'text', text: ' · ' })
        // 单元格内的行内 markdown 也展开
        const inline = inlineTokens(c)
        for (const t of inline) rowTokens.push(t)
      }
    })
    paragraphs.push(rowTokens)
  }
  return paragraphs
}

/**
 * 主转换：markdown 字符串 → post AST { zh_cn: { content: [[...]] } }
 */
export function toLarkPost(markdown) {
  const text = typeof markdown === 'string' ? markdown : String(markdown ?? '')
  const lines = text.split('\n')
  const content = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trimEnd()

    // 围栏代码块
    const fenceMatch = trimmed.match(/^```([a-zA-Z0-9_+-]*)\s*$/)
    if (fenceMatch) {
      const language = fenceMatch[1] || ''
      const codeLines = []
      i += 1
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i])
        i += 1
      }
      i += 1 // 跳过闭合 ```
      const codeText = codeLines.join('\n')
      const node = { tag: 'code_block', text: codeText }
      if (language) node.language = language
      content.push([node])
      continue
    }

    // 水平线
    if (/^\s*([-*_])\1{2,}\s*$/.test(trimmed)) {
      content.push([{ tag: 'hr' }])
      i += 1
      continue
    }

    // 标题
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/)
    if (headingMatch) {
      const level = headingMatch[1].length
      const body = headingMatch[2].trim()
      const prefix = HEADER_PREFIX[level - 1] || '· '
      const suffix = level === 1 ? ' ━━━' : ''
      content.push([{ tag: 'text', text: `${prefix}${body}${suffix}`, style: ['bold'] }])
      i += 1
      continue
    }

    // 表格：当前行像 | a | b | 且下一行是分隔行
    if (/^\s*\|.*\|\s*$/.test(trimmed) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headerLine = trimmed
      const dataLines = []
      i += 2 // 跳过 header + 分隔
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        dataLines.push(lines[i].trimEnd())
        i += 1
      }
      const paragraphs = renderTable(headerLine, dataLines)
      for (const p of paragraphs) content.push(p)
      continue
    }

    // 引用 > x
    const quoteMatch = trimmed.match(/^>\s?(.*)$/)
    if (quoteMatch) {
      const inner = quoteMatch[1]
      content.push([
        { tag: 'text', text: '▎ ' },
        ...inlineTokens(inner),
      ])
      i += 1
      continue
    }

    // 列表项
    const ulMatch = line.match(/^(\s*)([-*])\s+(.*)$/)
    if (ulMatch) {
      const indent = ulMatch[1]
      const body = ulMatch[3]
      content.push([
        { tag: 'text', text: `${indent}• ` },
        ...inlineTokens(body),
      ])
      i += 1
      continue
    }
    const olMatch = line.match(/^(\s*)(\d+)\.\s+(.*)$/)
    if (olMatch) {
      const indent = olMatch[1]
      const num = olMatch[2]
      const body = olMatch[3]
      content.push([
        { tag: 'text', text: `${indent}${num}. ` },
        ...inlineTokens(body),
      ])
      i += 1
      continue
    }

    // 空行：插入一个空段落让飞书产生段间距
    if (trimmed === '') {
      content.push([{ tag: 'text', text: '' }])
      i += 1
      continue
    }

    // 图片：丢弃
    if (/^\s*!\[[^\]]*\]\([^)]+\)\s*$/.test(trimmed)) {
      i += 1
      continue
    }

    // 普通段落
    // 处理行内图片：删除
    const cleaned = line.replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    content.push(inlineTokens(cleaned))
    i += 1
  }

  // 修剪末尾的空段落
  while (content.length > 0) {
    const last = content[content.length - 1]
    if (last.length === 1 && last[0].tag === 'text' && last[0].text === '') {
      content.pop()
    } else {
      break
    }
  }

  return { zh_cn: { content } }
}
