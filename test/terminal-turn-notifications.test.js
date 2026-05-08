import { describe, it, expect } from 'vitest'
import {
  TURN_DONE_BANNER,
  TURN_DONE_TEXT,
  getBrowserNotificationPermission,
  shouldSendTurnDoneSystemNotification,
} from '../web/src/terminalTurnNotifications.ts'

describe('terminal turn notification helpers', () => {
  it('provides an ANSI banner with the approved copy', () => {
    expect(TURN_DONE_TEXT).toBe('AI 回复完成，请验收')
    expect(TURN_DONE_BANNER).toContain(TURN_DONE_TEXT)
    expect(TURN_DONE_BANNER).toContain('\x1b[')
  })

  it('reports browser notification support as unsupported without the browser Notification API', () => {
    expect(getBrowserNotificationPermission()).toBe('unsupported')
  })

  it('returns the mocked browser notification permission', () => {
    const originalWindow = globalThis.window

    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
          Notification: {
            permission: 'denied',
          },
        },
      })

      expect(getBrowserNotificationPermission()).toBe('denied')
    } finally {
      if (originalWindow === undefined) {
        delete globalThis.window
      } else {
        Object.defineProperty(globalThis, 'window', {
          configurable: true,
          value: originalWindow,
        })
      }
    }
  })

  it('sends system notifications when granted and document is hidden', () => {
    expect(shouldSendTurnDoneSystemNotification({
      permission: 'granted',
      documentHidden: true,
      windowFocused: true,
    })).toBe(true)
  })

  it('sends system notifications when granted and window is unfocused', () => {
    expect(shouldSendTurnDoneSystemNotification({
      permission: 'granted',
      documentHidden: false,
      windowFocused: false,
    })).toBe(true)
  })

  it('does not send system notifications when page is visible and focused', () => {
    expect(shouldSendTurnDoneSystemNotification({
      permission: 'granted',
      documentHidden: false,
      windowFocused: true,
    })).toBe(false)
  })

  it('does not send system notifications without granted permission', () => {
    for (const permission of ['default', 'denied', 'unsupported']) {
      expect(shouldSendTurnDoneSystemNotification({
        permission,
        documentHidden: true,
        windowFocused: false,
      })).toBe(false)
    }
  })
})
