import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('AiTerminalMini scrollback depth', () => {
  it('configures xterm with 30000 lines of scrollback', () => {
    const source = readFileSync('web/src/AiTerminalMini.tsx', 'utf8')

    expect(source).toMatch(/scrollback:\s*30000/)
  })
})
