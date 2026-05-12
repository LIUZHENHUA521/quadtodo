export const WELCOME_DISMISSED_KEY = 'agentquad:welcome:dismissed'

export function readWelcomeDismissed(): boolean {
  try {
    return globalThis.localStorage?.getItem(WELCOME_DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

export function writeWelcomeDismissed(v: boolean): void {
  try {
    if (v) globalThis.localStorage?.setItem(WELCOME_DISMISSED_KEY, '1')
    else globalThis.localStorage?.removeItem(WELCOME_DISMISSED_KEY)
  } catch {
    /* localStorage 不可用（隐私模式等）静默失败 */
  }
}
