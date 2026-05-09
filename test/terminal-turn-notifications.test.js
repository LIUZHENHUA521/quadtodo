import { describe, it, expect } from 'vitest'
import * as turnNotifications from '../web/src/terminalTurnNotifications.ts'

const {
  TURN_DONE_TEXT,
  TURN_DONE_NOTIFICATION_BUTTON_LABEL,
  TURN_DONE_NOTIFICATION_BUTTON_STYLE,
  getBrowserNotificationPermission,
  shouldSendTurnDoneSystemNotification,
} = turnNotifications

describe('terminal turn notification helpers', () => {
  it('does not expose an xterm output banner for turn completion reminders', () => {
    expect(TURN_DONE_TEXT).toBe('AI 回复完成，请验收')
    expect(turnNotifications).not.toHaveProperty('TURN_DONE_BANNER')
  })

  it('keeps the notification permission affordance compact and readable for the toolbar', () => {
    expect(TURN_DONE_NOTIFICATION_BUTTON_LABEL).toBe('通知')
    expect(TURN_DONE_NOTIFICATION_BUTTON_STYLE).toEqual({
      height: 20,
      minWidth: 34,
      paddingInline: 6,
      fontSize: 11,
      lineHeight: '18px',
    })
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
