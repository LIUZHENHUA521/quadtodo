import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('manual pending confirmation', () => {
  it('does not auto-mark a session as seen when focus/live terminal is opened', () => {
    const focus = readFileSync('web/src/components/SessionFocus/SessionFocus.tsx', 'utf8')
    const terminal = readFileSync('web/src/AiTerminalMini.tsx', 'utf8')

    expect(focus).not.toMatch(/markSeen\(/)
    expect(terminal).not.toMatch(/markSeen\(/)
  })

  it('keeps the explicit confirm action in the focus subbar', () => {
    const subbar = readFileSync('web/src/components/SessionFocus/FocusSubbar.tsx', 'utf8')

    expect(subbar).toContain('focus-confirm-btn')
    expect(subbar).toMatch(/markSeen\(session\.sessionId,\s*session\.lastTurnDoneAt \|\| Date\.now\(\)\)/)
  })

  it('does not reuse the legacy auto-seen localStorage key', () => {
    const unreadStore = readFileSync('web/src/store/unreadStore.ts', 'utf8')

    expect(unreadStore).toContain("const STORAGE_KEY = 'quadtodo:sessionConfirmedTurn'")
    expect(unreadStore).not.toContain("const STORAGE_KEY = 'quadtodo:sessionLastSeen'")
  })
})
