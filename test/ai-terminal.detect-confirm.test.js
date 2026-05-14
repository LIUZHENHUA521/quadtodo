import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { compactTerminalText, detectConfirmMatch } from '../src/routes/ai-terminal.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// 回归 fixture：Claude Code 新版 TUI 渲染 "Do you want to create song.md?" 权限对话框时
// 真实抓到的最后 4KB PTY 字节（来自 ws /ws/terminal/<sid> 的 replay）。
// ink 在单词间用 \x1b[1C / \x1b[<row>;<col>H 这类光标定位代替空格，
// 历史实现 .replace(CSI, '') 直接删 → "Doyouwantto"，导致所有 confirm 正则失效。
const RAW_LAST_4K = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'claude-code-permission-prompt-last4k.json'), 'utf8'))

describe('compactTerminalText', () => {
  it('把 CSI 光标定位序列替换为空格而非删除，恢复词边界', () => {
    // ink 风格："Do\x1b[1Cyou\x1b[1Cwant\x1b[1Cto"
    const inkLike = 'Do\x1b[1Cyou\x1b[1Cwant\x1b[1Cto'
    expect(compactTerminalText(inkLike)).toBe('Do you want to')
  })

  it('Claude Code 真实权限提示输出（来自 ws fixture）解出可读句子', () => {
    const compacted = compactTerminalText(RAW_LAST_4K)
    expect(compacted).toMatch(/Do you want to create song\.md ?\??/i)
    expect(compacted).toMatch(/Yes/)
  })
})

describe('detectConfirmMatch on Claude Code TUI raw output', () => {
  it('能从真实 4KB PTY 字节中匹配出 "Do you want to ..." 提示', () => {
    expect(detectConfirmMatch(RAW_LAST_4K)).toBeTruthy()
  })

  it('简单的 ink 风格输入也能命中 confirm pattern', () => {
    const inkLike = 'Do\x1b[1Cyou\x1b[1Cwant\x1b[1Cto\x1b[1Ccreate\x1b[1Cfile.txt?'
    expect(detectConfirmMatch(inkLike)).toBeTruthy()
  })

  it('无 confirm 内容时返回 null', () => {
    expect(detectConfirmMatch('普通输出 hello world')).toBeNull()
  })
})
