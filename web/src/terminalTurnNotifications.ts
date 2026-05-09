export type BrowserNotificationPermission = NotificationPermission | 'unsupported'

export const TURN_DONE_TEXT = 'AI 回复完成，请验收'

export function getBrowserNotificationPermission(): BrowserNotificationPermission {
  if (typeof window === 'undefined' || typeof window.Notification === 'undefined') return 'unsupported'
  return window.Notification.permission
}

export function shouldSendTurnDoneSystemNotification({
  permission,
  documentHidden,
  windowFocused,
}: {
  permission: BrowserNotificationPermission | string
  documentHidden: boolean
  windowFocused: boolean
}): boolean {
  return permission === 'granted' && (documentHidden || !windowFocused)
}
