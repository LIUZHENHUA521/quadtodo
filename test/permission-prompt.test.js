import { describe, it, expect } from 'vitest'
import { cleanPtyTail, parsePermissionOptions, extractPermissionPrompt, formatToolUseAsPrompt, CLAUDE_DEFAULT_PERMISSION_OPTIONS } from '../src/permission-prompt.js'

describe('permission-prompt', () => {
  describe('cleanPtyTail', () => {
    it('strips ANSI CSI/OSC sequences', () => {
      const raw = '\x1b[1;32mHello\x1b[0m \x1b]0;title\x07world'
      expect(cleanPtyTail(raw)).toBe('Hello world')
    })

    it('strips box-drawing characters but preserves inner text', () => {
      const raw = '╭───────────╮\n│ Hello box │\n╰───────────╯'
      const out = cleanPtyTail(raw)
      expect(out).toContain('Hello box')
      expect(out).not.toMatch(/[│╭╮╯╰─]/)
    })

    // 用户回归：Cursor TUI 用 Unicode Block Elements (U+2580-259F) 画状态栏 / 边框
    // ▄▄▄▄▄ 一串发到飞书 / Telegram，渲染就是大片"黑线"。strip 掉。
    it('strips Unicode Block Elements (▄▆█▌▐ ...) used by Cursor TUI', () => {
      const raw = '▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄\n▌ Cursor status ▐\n████████████\nReal text here'
      const out = cleanPtyTail(raw)
      expect(out).toContain('Cursor status')
      expect(out).toContain('Real text here')
      expect(out).not.toMatch(/[▀-▟]/)
    })

    it('drops decorative ❯ marker lines and trims marker prefix', () => {
      const raw = '❯ 1. Yes\n  2. No\n❯'
      const out = cleanPtyTail(raw)
      expect(out).toContain('1. Yes')
      expect(out).toContain('2. No')
      // 末尾光秃的 ❯ 行被丢弃
      expect(out.trim().endsWith('❯')).toBe(false)
    })

    it('collapses multiple blank lines', () => {
      const raw = 'a\n\n\n\nb'
      expect(cleanPtyTail(raw)).toBe('a\n\nb')
    })

    // 回归（claude-prompt-detector 在 bypass 模式实战失火）：
    // Claude/ink TUI 用 CUF（`\x1b[NC`，cursor forward N）做对齐而不是直接打空格。
    // 若先无脑 strip CSI，"Do you want to proceed?" 会被压成 "Doyouwanttoproceed?"，
    // 所有 PERMISSION_ANCHORS 全部失配。
    it('CUF 还原成空格（用 PTY 真实捕获的 spacing 形态做回归）', () => {
      // 真实数据形态：每个 word 之间 \x1b[1C 而不是空格
      const raw = 'Do\x1b[1Cyou\x1b[1Cwant\x1b[1Cto\x1b[1Cproceed?'
      const out = cleanPtyTail(raw)
      // 关键：words 之间必须有空格，否则下游 anchor regex 全瞎
      expect(out).toBe('Do you want to proceed?')
    })

    it('CUD 还原成换行（连续多行被 cursor down 压扁的场景）', () => {
      const raw = 'first line\x1b[2Bsecond line'
      const out = cleanPtyTail(raw)
      expect(out).toContain('first line')
      expect(out).toContain('second line')
      // 中间必须有换行（cleanPtyTail 会把多余空行 compact 成 2 个）
      expect(out).toMatch(/first line\n.*second line/s)
    })

    it('Claude 权限框（带 CUF 间距）→ extractor 能找到 anchor + 数字选项', () => {
      // 模拟真实 Claude TUI 弹权限框的 PTY 形态（末尾必须带 Esc to cancel footer，
      // 新的严格 detector 用它锁定"屏幕当前正在显示权限框"，不是缓冲深处的残骸）
      const raw = [
        '\x1b[2CBash\x1b[1Ccommand',
        '\x1b[2Ctouch\x1b[1C/tmp/foo.txt',
        '\x1b[2CDo\x1b[1Cyou\x1b[1Cwant\x1b[1Cto\x1b[1Cproceed?',
        '\x1b[2C\x1b[38;2;100;200;100m❯\x1b[39m\x1b[1C1.\x1b[1CYes',
        '\x1b[2C\x1b[1C2.\x1b[1CNo',
        '\x1b[2CEsc\x1b[1Cto\x1b[1Ccancel\x1b[1C·\x1b[1CTab\x1b[1Cto\x1b[1Camend',
      ].join('\r\n')
      const { text, options } = extractPermissionPrompt(raw)
      expect(text).toContain('Do you want to proceed?')
      expect(options.length).toBeGreaterThanOrEqual(2)
      expect(options.find(o => o.index === 1)?.label).toBe('Yes')
      expect(options.find(o => o.index === 2)?.label).toBe('No')
    })
  })

  describe('parsePermissionOptions', () => {
    it('extracts numbered options', () => {
      const text = 'Do you want to proceed?\n1. Yes\n2. Yes, and don\'t ask again\n3. No, suggest changes'
      const opts = parsePermissionOptions(text)
      expect(opts).toEqual([
        { index: 1, label: 'Yes' },
        { index: 2, label: "Yes, and don't ask again" },
        { index: 3, label: 'No, suggest changes' },
      ])
    })

    it('returns empty when no enumerated choices (Codex y/n style)', () => {
      const text = 'apply patch?\n[Y/n]'
      expect(parsePermissionOptions(text)).toEqual([])
    })

    it('de-duplicates repeated index, keeps first', () => {
      const text = '1. First\n1. Second'
      expect(parsePermissionOptions(text)).toEqual([{ index: 1, label: 'First' }])
    })
  })

  describe('extractPermissionPrompt', () => {
    it('returns trimmed text + options for a typical Claude permission prompt', () => {
      const raw = [
        '\x1b[36m╭────────────────────────────╮\x1b[0m',
        '│ Bash command               │',
        '│   curl -s ...              │',
        '│                            │',
        '│ Do you want to proceed?    │',
        '│ \x1b[33m❯\x1b[0m 1. Yes                  │',
        '│   2. No, suggest changes   │',
        '╰────────────────────────────╯',
        'Esc to cancel · Tab to amend',
      ].join('\n')
      const { text, options } = extractPermissionPrompt(raw)
      expect(text).toContain('Do you want to proceed?')
      expect(text).toContain('1. Yes')
      expect(text).toContain('2. No, suggest changes')
      expect(options).toEqual([
        { index: 1, label: 'Yes' },
        { index: 2, label: 'No, suggest changes' },
      ])
    })

    it('returns empty {} for empty input', () => {
      expect(extractPermissionPrompt('')).toEqual({ text: '', options: [] })
      expect(extractPermissionPrompt(null)).toEqual({ text: '', options: [] })
    })

    it('caps text by maxLines + maxChars', () => {
      const long = Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n')
      const { text } = extractPermissionPrompt(long, { maxLines: 5, maxChars: 100 })
      const lines = text.split('\n')
      expect(lines.length).toBeLessThanOrEqual(5)
      expect(text.length).toBeLessThanOrEqual(100)
    })

    it('Codex [Y/n] 样式现在不再被 Claude extractor 命中（Codex 走 codex-prompt-detector）', () => {
      // 新规则：extractor 是 Claude 专用，必须带 Claude footer (Esc to cancel · Tab to amend)。
      // Codex 的 "apply patch? [Y/n]" 没这个 footer → 返回空。Codex 的检测路径在
      // codex-prompt-detector 那一支，跟 Claude 解耦。
      const raw = 'apply patch?\n[Y/n]'
      expect(extractPermissionPrompt(raw)).toEqual({ text: '', options: [] })
    })

    it('用 historicalRaw 兜底：recentOutput 全是 spinner，历史里有真 prompt', () => {
      // recentOutput 模拟：被 spinner 反复刷屏覆盖到只剩噪声
      const noisy = Array.from({ length: 30 }, () => '✶ Skedaddling for 12s ✶').join('\n')
      // 5MB outputHistory 的尾部模拟：完整的 Claude 授权弹窗
      const real = [
        '\x1b[36m╭────────────────────────────╮\x1b[0m',
        '│ Bash command               │',
        '│   curl -s -X POST https://api/x.com -d \'{"a":1}\' │',
        '│   Contains shell syntax    │',
        '│                            │',
        '│ Do you want to proceed?    │',
        '│ ❯ 1. Yes                   │',
        '│   2. No, suggest changes   │',
        '╰────────────────────────────╯',
        'Esc to cancel · Tab to amend',
      ].join('\n')
      const { text, options } = extractPermissionPrompt(noisy, { historicalRaw: real })
      expect(text).toContain('curl -s -X POST')
      expect(text).toContain('Do you want to proceed?')
      expect(options).toEqual([
        { index: 1, label: 'Yes' },
        { index: 2, label: 'No, suggest changes' },
      ])
    })

    it('锚点定位：prompt 在中间时窗口包含上下文（Bash 命令文本）', () => {
      // 真实 PTY 场景：上方是 prompt + 选项 + footer，下方 spinner 是 cleanPtyTail
      // 过滤后被丢弃的噪声（不影响 footer 在末尾的 footerTailRange 判定）
      const raw = [
        'Bash command',
        '  curl https://example.com/foo',
        '  Contains shell syntax',
        '',
        'Do you want to proceed?',
        '1. Yes',
        '2. No',
        'Esc to cancel · Tab to amend',
        '✶ Cooking for 3s ✶',
        '✶ Cooking for 5s ✶',
        '✶ Cooking for 8s ✶',
      ].join('\n')
      const { text, options } = extractPermissionPrompt(raw)
      expect(text).toContain('Bash command')
      expect(text).toContain('curl https://example.com/foo')
      expect(text).toContain('Do you want to proceed?')
      expect(options.map(o => o.label)).toEqual(['Yes', 'No'])
    })

    it('formatToolUseAsPrompt: Bash 命令直出', () => {
      const out = formatToolUseAsPrompt({
        name: 'Bash',
        input: { command: 'echo "test-$(uname -s)" && find /tmp -maxdepth 1 -type f | head -3', description: 'Demo command' },
      })
      expect(out).toContain('Bash:')
      expect(out).toContain('echo "test-$(uname -s)"')
      expect(out).toContain('Demo command')
    })

    it('formatToolUseAsPrompt: Edit/Write 用 file_path', () => {
      const out = formatToolUseAsPrompt({ name: 'Edit', input: { file_path: '/repo/src/foo.js' } })
      expect(out).toBe('Edit:\n/repo/src/foo.js')
    })

    it('formatToolUseAsPrompt: 未知工具回退到 JSON', () => {
      const out = formatToolUseAsPrompt({ name: 'Weird', input: { weird_field: 'x', other: 42 } })
      expect(out).toContain('Weird:')
      expect(out).toContain('weird_field')
    })

    it('CLAUDE_DEFAULT_PERMISSION_OPTIONS 包含 3 个标准选项', () => {
      expect(CLAUDE_DEFAULT_PERMISSION_OPTIONS).toHaveLength(3)
      expect(CLAUDE_DEFAULT_PERMISSION_OPTIONS[0]).toEqual({ index: 1, label: 'Yes' })
    })

    it('过滤 spinner / status verb / auto mode / TUI 前缀单独行', () => {
      const raw = [
        '✶ ✶ ✶',
        'Brewing for 30s',
        'Reading…',
        '❯',
        'auto mode on',
        'shift+tab to cycle',
        'Real content here',
        'Do you want to proceed?',
        '1. Yes',
        '2. No',
        'Esc to cancel · Tab to amend',
      ].join('\n')
      const { text } = extractPermissionPrompt(raw)
      expect(text).toContain('Real content here')
      expect(text).toContain('Do you want to proceed?')
      expect(text).not.toMatch(/Brewing for/)
      expect(text).not.toMatch(/Reading…/)
      expect(text).not.toMatch(/auto mode/i)
    })

    // 用户回归：edit pty.js 的提问没命中。老 PERMISSION_ANCHORS 是 whitelist
    //   (proceed / make this edit / make this change / create / ...) 一旦 Claude 加
    //   新措辞就漏。通用化成 `/Do you want to/i` 一条 + footer-at-bottom + ≥2 options
    //   守卫，能盖住 Claude 全部"Do you want to <verb> ...?"句型。
    it('Edit 提问 (Do you want to make this edit to <file>?) 命中 + 选项带 hotkey 后缀也解析', () => {
      const raw = [
        '⏺ Update(src/pty.js)',
        '  ⎿  Updated 1 addition',
        '',
        'Do you want to make this edit to pty.js?',
        '> 1. Yes',
        '  2. Yes, allow all edits in src/ during this session (shift+tab)',
        '  3. No',
        '',
        'Esc to cancel · Tab to amend',
      ].join('\n')
      const { text, options } = extractPermissionPrompt(raw)
      expect(text).toContain('Do you want to make this edit to pty.js?')
      expect(options.find(o => o.index === 1)?.label).toBe('Yes')
      expect(options.find(o => o.index === 2)?.label).toContain('shift+tab')
      expect(options.find(o => o.index === 3)?.label).toBe('No')
    })

    it('未知措辞 Do you want to <verb> ...? 也命中（whitelist → 通用 pattern 的迁移）', () => {
      // 假设 Claude 未来加 "Do you want to install this dependency?"
      const raw = [
        'npm install foo',
        '',
        'Do you want to install this dependency?',
        '1. Yes',
        '2. No',
        'Esc to cancel · Tab to amend',
      ].join('\n')
      const { text, options } = extractPermissionPrompt(raw)
      expect(text).toContain('install this dependency')
      expect(options.length).toBeGreaterThanOrEqual(2)
    })

    // Bug 2 回归：AI 自由回复里如果恰好出现 anchor + 数字列表 + 老 footer 残骸，
    // 旧 detector 会误命中。新规则要求 footer 在屏幕末尾（lines 末 5 行内）才认。
    it('AI 自由回复带数字列表 + 缓冲深处的老 footer → 不应误命中', () => {
      // 模拟：缓冲里上面有老 prompt 的 footer 残骸，下面是当前的 AI 回复
      const raw = [
        'Bash command',
        'Do you want to proceed?',
        '1. Yes',
        '2. No',
        'Esc to cancel · Tab to amend',   // ← 老 footer 残骸（不在末尾 5 行）
        '',
        'Claude reply: 成功了！日志里：',     // ← 当前回复
        '1. b35b411 — cleanPtyTail 展开 CUF/CUD',
        '2. 09a8814 — detector 必须看到 Esc to cancel · Tab to amend footer',
        '3. 7e21396 — adaptWizardResponseToLark 把 toast: string 转 Lark 期望的',
        '4. fab8d09 — server.js 给 createLarkBot 注入 wizard.handleCallback',
        '5. e2ddc5b — channel hint',
        '6. 22a983a — lark 渠道下放过 sameThread',
        '',
        '完成。',                              // ← 末尾不是 footer
      ].join('\n')
      expect(extractPermissionPrompt(raw)).toEqual({ text: '', options: [] })
    })
  })
})
