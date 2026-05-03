import { describe, it, expect } from 'vitest'
import { toTelegramV2, toPlainText } from '../src/telegram-markdown.js'

describe('toTelegramV2', () => {
  it('returns input as-is for empty / non-string', () => {
    expect(toTelegramV2('')).toBe('')
    expect(toTelegramV2(null)).toBe(null)
    expect(toTelegramV2(undefined)).toBe(undefined)
    expect(toTelegramV2(42)).toBe(42)
  })

  it('preserves plain text', () => {
    expect(toTelegramV2('hi')).toBe('hi')
    expect(toTelegramV2('broadcast message')).toBe('broadcast message')
  })

  it('strips trailing newline (library quirk)', () => {
    // telegramify 默认在末尾加 \n；helper 帮忙去掉
    expect(toTelegramV2('hello').endsWith('\n')).toBe(false)
  })

  it('converts ## headers to bold', () => {
    const r = toTelegramV2('## 修复方案')
    // V2 粗体是 *...*；标题应该被转成 *修复方案*
    expect(r).toMatch(/^\*修复方案\*$/)
  })

  it('converts **bold** to *bold*', () => {
    const r = toTelegramV2('Mixed **bold** here')
    // V2 用单 *
    expect(r).toContain('*bold*')
    expect(r).not.toContain('**')
  })

  it('preserves inline code untouched', () => {
    const r = toTelegramV2('use `function_name()` to call')
    expect(r).toContain('`function_name()`')
    // code 内的 _ 和 ( 不应该被转义
  })

  it('preserves code blocks', () => {
    const r = toTelegramV2('```\nconst x = 1\n```')
    expect(r).toContain('```')
    expect(r).toContain('const x = 1')
  })

  it('escapes special chars in plain text (V2 requirements)', () => {
    // V2 中 . ( ) _ 等需要转义；不转义就 parse fail
    const r = toTelegramV2('function_name() ends with dot.')
    expect(r).toContain('\\_')
    expect(r).toContain('\\(')
    expect(r).toContain('\\)')
    expect(r).toContain('\\.')
  })

  it('does NOT escape special chars inside URL part of links', () => {
    const r = toTelegramV2('See [docs](https://x.com/a_b?c=d)')
    // 链接的 URL 部分应该保留原始字符
    expect(r).toContain('https://x.com/a_b?c=d')
  })

  it('converts bullet list - to •', () => {
    const r = toTelegramV2('- one\n- two\n- three')
    expect(r).toContain('•')
    expect(r).toContain('one')
    expect(r).toContain('three')
  })

  it('handles tables by escaping (no parse error, lossy render)', () => {
    // 没有 parse error 就是 success；表格不可能在 telegram 渲染成网格，但至少不丢消息
    const r = toTelegramV2('| a | b |\n|---|---|\n| 1 | 2 |')
    expect(typeof r).toBe('string')
    expect(r.length).toBeGreaterThan(0)
  })

  it('mixed Claude-style output (smoke test)', () => {
    const claudeReply = `## 实现完成

我刚才做了**三件事**：

1. 改了 \`bridge.resolveRoute\` 的 fallback
2. 加了诊断 log（共 3 处）
3. 写了单测覆盖 race scenario

详情见 [PR #42](https://github.com/x/y/pull/42).`
    const r = toTelegramV2(claudeReply)
    // 关键点：能转换、不抛错、含核心字符
    expect(r).toContain('*实现完成*')
    expect(r).toContain('*三件事*')
    expect(r).toContain('`bridge.resolveRoute`')
    expect(r).toContain('https://github.com/x/y/pull/42')
  })

  it('returns raw text on library error (defensive)', () => {
    // 哪怕传一些诡异输入也不抛
    expect(() => toTelegramV2('x'.repeat(50000))).not.toThrow()
  })

  it('wraps markdown tables as ``` code block (preserve column alignment)', () => {
    const input = '| col1 | col2 |\n|------|------|\n| a | b |\n| c | d |'
    const out = toTelegramV2(input)
    // 应该被包进 ```...```，原始 | 行保留
    expect(out).toContain('```')
    expect(out).toMatch(/```[\s\S]*\| col1 \| col2 \|[\s\S]*```/)
  })

  it('only wraps real tables (≥2 lines of |...|)，单行 | 不当作 table', () => {
    const input = '正文 | 不是表格 | 一行而已\n下一行普通文本'
    const out = toTelegramV2(input)
    expect(out).not.toContain('```')
  })

  it('preserves inline code backticks outside tables', () => {
    const input = '调用 `botToken` 看看'
    const out = toTelegramV2(input)
    // V2 inline code 仍然是 backticks 包着，让 Telegram 渲染高亮
    expect(out).toMatch(/`botToken`/)
  })

  it('table + inline code mixed: table wrapped, outside inline code stays', () => {
    const input = '前文 `code1`\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n后文 `code2`'
    const out = toTelegramV2(input)
    expect(out).toContain('```')
    expect(out).toMatch(/`code1`/)
    expect(out).toMatch(/`code2`/)
  })
})

describe('toPlainText (markdown-stripped fallback)', () => {
  it('returns input as-is for empty / non-string', () => {
    expect(toPlainText('')).toBe('')
    expect(toPlainText(null)).toBe(null)
    expect(toPlainText(undefined)).toBe(undefined)
  })

  it('strips heading hashes', () => {
    const r = toPlainText('#### ② 晒历史收益（你的方向）')
    expect(r).not.toContain('#### ')
    expect(r).toContain('② 晒历史收益')
  })

  it('strips bold markers', () => {
    const r = toPlainText('**风险**：小红书严格')
    expect(r).not.toMatch(/\*\*/)
    expect(r).toContain('风险')
    expect(r).toContain('小红书严格')
  })

  it('strips blockquote prefix', () => {
    const r = toPlainText('> 引用一行\n> 又一行')
    expect(r).not.toMatch(/^>/m)
    expect(r).toContain('引用一行')
    expect(r).toContain('又一行')
  })

  it('preserves inline code backticks (visual hint that "this is code")', () => {
    const r = toPlainText('调用 `bridge.resolveRoute` 函数')
    expect(r).toMatch(/`bridge\.resolveRoute`/)
  })

  it('does not throw on extreme input', () => {
    expect(() => toPlainText('x'.repeat(50000))).not.toThrow()
  })
})
