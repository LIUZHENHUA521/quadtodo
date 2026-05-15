import { describe, expect, it } from 'vitest'
import { isMarkdownLike, toLarkPost } from '../src/lark-post.js'

describe('isMarkdownLike', () => {
  it('flags block headings', () => {
    expect(isMarkdownLike('# 一级标题')).toBe(true)
    expect(isMarkdownLike('正文\n## 子标题\n更多正文')).toBe(true)
  })

  it('flags markdown tables (header + separator required)', () => {
    expect(isMarkdownLike('| a | b |\n|---|---|\n| 1 | 2 |')).toBe(true)
  })

  it('does NOT flag stray pipes without separator', () => {
    expect(isMarkdownLike('用法：a | b | c 都行')).toBe(false)
  })

  it('flags fenced code blocks', () => {
    expect(isMarkdownLike('```js\nlet x = 1\n```')).toBe(true)
  })

  it('flags unordered + ordered lists', () => {
    expect(isMarkdownLike('- 项一\n- 项二')).toBe(true)
    expect(isMarkdownLike('1. 步骤一\n2. 步骤二')).toBe(true)
  })

  it('flags blockquotes', () => {
    expect(isMarkdownLike('> 引用')).toBe(true)
  })

  it('does NOT flag plain text with inline emphasis', () => {
    expect(isMarkdownLike('这是 **粗体** 和 *斜体*，但没有块级特征')).toBe(false)
    expect(isMarkdownLike('hello world')).toBe(false)
  })

  it('handles empty / non-string safely', () => {
    expect(isMarkdownLike('')).toBe(false)
    expect(isMarkdownLike(null)).toBe(false)
    expect(isMarkdownLike(undefined)).toBe(false)
    expect(isMarkdownLike(123)).toBe(false)
  })
})

describe('toLarkPost — headings', () => {
  it('maps # → bold with horizontal bars', () => {
    const ast = toLarkPost('# 变更摘要')
    expect(ast).toEqual({
      zh_cn: {
        content: [[{ tag: 'text', text: '━━━ 变更摘要 ━━━', style: ['bold'] }]],
      },
    })
  })

  it('maps ## → bold with left-bar prefix', () => {
    const ast = toLarkPost('## 计划骨架')
    expect(ast.zh_cn.content[0][0]).toEqual({ tag: 'text', text: '▎计划骨架', style: ['bold'] })
  })

  it('maps ### → bold with bullet prefix', () => {
    const ast = toLarkPost('### 细节')
    expect(ast.zh_cn.content[0][0]).toEqual({ tag: 'text', text: '· 细节', style: ['bold'] })
  })
})

describe('toLarkPost — tables', () => {
  it('renders markdown table header bold and rows with bold first column', () => {
    const md = '| Phase | Task | 说明 |\n|---|---|---|\n| A | 1-5 | 共享工具 |\n| B | 6 | 统一 install |'
    const ast = toLarkPost(md)
    const c = ast.zh_cn.content
    // header row
    expect(c[0]).toEqual([
      { tag: 'text', text: 'Phase', style: ['bold'] },
      { tag: 'text', text: ' | ' },
      { tag: 'text', text: 'Task', style: ['bold'] },
      { tag: 'text', text: ' | ' },
      { tag: 'text', text: '说明', style: ['bold'] },
    ])
    // data row 1: 'A' bold + middot separators
    expect(c[1]).toEqual([
      { tag: 'text', text: 'A', style: ['bold'] },
      { tag: 'text', text: ' · ' },
      { tag: 'text', text: '1-5' },
      { tag: 'text', text: ' · ' },
      { tag: 'text', text: '共享工具' },
    ])
    expect(c[2][0]).toEqual({ tag: 'text', text: 'B', style: ['bold'] })
  })

  it('fills empty cells with em-dash', () => {
    const md = '| a | b |\n|---|---|\n|  | x |'
    const ast = toLarkPost(md)
    const dataRow = ast.zh_cn.content[1]
    expect(dataRow[0]).toEqual({ tag: 'text', text: '—', style: ['bold'] })
    expect(dataRow.slice(-1)[0]).toEqual({ tag: 'text', text: 'x' })
  })

  it('skips separator row from output', () => {
    const md = '| a | b |\n|---|---|\n| 1 | 2 |'
    const ast = toLarkPost(md)
    // 仅 2 段：表头 + 数据
    expect(ast.zh_cn.content.length).toBe(2)
  })

  it('does NOT treat pipe-only line without separator as a table', () => {
    const md = '用法：a | b | c\n继续'
    const ast = toLarkPost(md)
    // 两个普通段落
    expect(ast.zh_cn.content.length).toBe(2)
    expect(ast.zh_cn.content[0][0].text).toBe('用法：a | b | c')
  })
})

describe('toLarkPost — code blocks', () => {
  it('emits code_block tag with language', () => {
    const md = '```js\nconst x = 1\nconst y = 2\n```'
    const ast = toLarkPost(md)
    expect(ast.zh_cn.content).toEqual([[{ tag: 'code_block', text: 'const x = 1\nconst y = 2', language: 'js' }]])
  })

  it('omits language when fence has none', () => {
    const md = '```\nplain text\n```'
    const ast = toLarkPost(md)
    expect(ast.zh_cn.content[0][0]).toEqual({ tag: 'code_block', text: 'plain text' })
  })
})

describe('toLarkPost — inline elements', () => {
  it('renders **bold** as bold text run', () => {
    const ast = toLarkPost('这是 **粗的** 字')
    expect(ast.zh_cn.content[0]).toEqual([
      { tag: 'text', text: '这是 ' },
      { tag: 'text', text: '粗的', style: ['bold'] },
      { tag: 'text', text: ' 字' },
    ])
  })

  it('renders [label](url) as a link tag', () => {
    const ast = toLarkPost('看 [文档](https://example.com) 链接')
    expect(ast.zh_cn.content[0]).toEqual([
      { tag: 'text', text: '看 ' },
      { tag: 'a', text: '文档', href: 'https://example.com' },
      { tag: 'text', text: ' 链接' },
    ])
  })

  it('renders inline `code` as italic (post has no inline code)', () => {
    const ast = toLarkPost('用 `npm test` 跑')
    const tokens = ast.zh_cn.content[0]
    expect(tokens.some((t) => t.text === 'npm test' && t.style?.includes('italic'))).toBe(true)
  })
})

describe('toLarkPost — lists, quotes, hr', () => {
  it('prefixes unordered list with • bullet', () => {
    const ast = toLarkPost('- 项一\n- 项二')
    expect(ast.zh_cn.content[0][0].text).toBe('• ')
    expect(ast.zh_cn.content[0][1]).toEqual({ tag: 'text', text: '项一' })
    expect(ast.zh_cn.content[1][1]).toEqual({ tag: 'text', text: '项二' })
  })

  it('preserves ordered list numbering', () => {
    const ast = toLarkPost('1. 一\n2. 二')
    expect(ast.zh_cn.content[0][0].text).toBe('1. ')
    expect(ast.zh_cn.content[1][0].text).toBe('2. ')
  })

  it('prefixes blockquote with left-bar', () => {
    const ast = toLarkPost('> 引用一句')
    expect(ast.zh_cn.content[0][0].text).toBe('▎ ')
  })

  it('emits hr tag for horizontal rule', () => {
    const ast = toLarkPost('上\n---\n下')
    const hrIndex = ast.zh_cn.content.findIndex((p) => p[0]?.tag === 'hr')
    expect(hrIndex).toBeGreaterThan(-1)
  })
})

describe('toLarkPost — edge cases', () => {
  it('handles empty string', () => {
    expect(toLarkPost('')).toEqual({ zh_cn: { content: [] } })
  })

  it('handles non-string input safely', () => {
    expect(toLarkPost(null)).toEqual({ zh_cn: { content: [] } })
    expect(toLarkPost(undefined)).toEqual({ zh_cn: { content: [] } })
  })

  it('drops standalone images', () => {
    const ast = toLarkPost('前\n![alt](https://x/y.png)\n后')
    const flat = JSON.stringify(ast)
    expect(flat).not.toContain('y.png')
    expect(flat).toContain('前')
    expect(flat).toContain('后')
  })

  it('trims trailing empty paragraphs', () => {
    const ast = toLarkPost('正文\n\n\n')
    expect(ast.zh_cn.content.length).toBe(1)
    expect(ast.zh_cn.content[0][0].text).toBe('正文')
  })

  it('keeps inter-paragraph blank lines as empty paragraphs (mid-document)', () => {
    const ast = toLarkPost('段1\n\n段2')
    expect(ast.zh_cn.content.length).toBe(3) // 段1, 空, 段2
    expect(ast.zh_cn.content[1][0].text).toBe('')
  })

  it('handles the screenshot scenario (mixed headings + table + code)', () => {
    const md = [
      '# 变更摘要',
      '- 改动一',
      '- 改动二',
      '',
      '## 计划骨架',
      '',
      '| Phase | Task | 说明 |',
      '|---|---|---|',
      '| A | 1-5 | 共享工具 |',
      '| B | 6-8 | 统一 install |',
      '',
      '### 仍需你确认',
      '看 commit `1687853`',
    ].join('\n')
    const ast = toLarkPost(md)
    const flat = JSON.stringify(ast)
    expect(flat).toContain('━━━ 变更摘要 ━━━')
    expect(flat).toContain('▎计划骨架')
    expect(flat).toContain('· 仍需你确认')
    // 表格分隔行不应出现
    expect(flat).not.toContain('---')
    // header bold + 数据行首列 bold
    expect(flat).toContain('"text":"Phase","style":["bold"]')
    expect(flat).toContain('"text":"A","style":["bold"]')
  })
})
