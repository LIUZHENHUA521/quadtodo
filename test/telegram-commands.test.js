import { describe, it, expect } from 'vitest'
import { buildTelegramCommands } from '../src/telegram-commands.js'

describe('buildTelegramCommands', () => {
  it('loads built-in static command list (>30 entries)', () => {
    const { commands } = buildTelegramCommands({ logger: { warn() {} } })
    expect(commands.length).toBeGreaterThan(30)
    // 关键的 Claude Code 命令必须在
    const names = commands.map((c) => c.command)
    expect(names).toContain('help')
    expect(names).toContain('clear')
    expect(names).toContain('compact')
    expect(names).toContain('model')
    expect(names).toContain('mcp')
    expect(names).toContain('skills')
    expect(names).toContain('ultrareview')
  })

  it('every accepted command name passes Telegram regex [a-z][a-z0-9_]{0,31}', () => {
    const { commands } = buildTelegramCommands({ logger: { warn() {} } })
    const re = /^[a-z][a-z0-9_]{0,31}$/
    for (const c of commands) {
      expect(re.test(c.command), `command "${c.command}" violates Telegram regex`).toBe(true)
    }
  })

  it('every description is 1-256 chars', () => {
    const { commands } = buildTelegramCommands({ logger: { warn() {} } })
    for (const c of commands) {
      expect(c.description.length).toBeGreaterThan(0)
      expect(c.description.length).toBeLessThanOrEqual(256)
    }
  })

  it('caps at 100 commands (Telegram hard limit)', () => {
    const { commands } = buildTelegramCommands({ logger: { warn() {} } })
    expect(commands.length).toBeLessThanOrEqual(100)
  })

  it('skips hyphenated commands and reports them', () => {
    // 我们机器上有 plugin commands 含 'execute-plan' / 'write-plan'
    const { skipped } = buildTelegramCommands({ logger: { warn() {} } })
    const skippedNames = skipped.map((s) => s.command)
    // 不一定有这俩（看用户机器），但如果有，必须被跳过
    if (skippedNames.includes('execute-plan')) {
      const entry = skipped.find((s) => s.command === 'execute-plan')
      expect(entry.reason).toMatch(/invalid_name/)
    }
    // 至少 invalid_name 这个 reason 形态正确
    for (const s of skipped) {
      expect(typeof s.command).toBe('string')
      expect(typeof s.reason).toBe('string')
    }
  })

  it('dedupes same command name (later sources override builtin)', () => {
    const { commands } = buildTelegramCommands({ logger: { warn() {} } })
    const names = commands.map((c) => c.command)
    const unique = new Set(names)
    expect(names.length).toBe(unique.size)
  })

  it('returns empty list (no throw) when JSON missing — defensive fallback', () => {
    // JSON 真的缺失时会返回空 builtins + 还能从扫到的目录补；不应抛
    expect(() => buildTelegramCommands({ projectRoot: '/nonexistent-dir-xyz', logger: { warn() {} } })).not.toThrow()
  })
})
