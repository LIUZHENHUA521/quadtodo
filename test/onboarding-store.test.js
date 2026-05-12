import { describe, it, expect, beforeEach } from 'vitest'
import {
  readWelcomeDismissed,
  writeWelcomeDismissed,
  WELCOME_DISMISSED_KEY,
} from '../web/src/onboarding/onboardingStore.ts'

function makeMockStorage({ throwOnRead = false, throwOnWrite = false } = {}) {
  let store = {}
  return {
    getItem(k) {
      if (throwOnRead) throw new Error('boom')
      return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null
    },
    setItem(k, v) {
      if (throwOnWrite) throw new Error('boom')
      store[k] = String(v)
    },
    removeItem(k) {
      if (throwOnWrite) throw new Error('boom')
      delete store[k]
    },
  }
}

beforeEach(() => {
  globalThis.localStorage = makeMockStorage()
})

describe('onboardingStore', () => {
  it('exports the expected key constant', () => {
    expect(WELCOME_DISMISSED_KEY).toBe('agentquad:welcome:dismissed')
  })

  it('returns false when no key is set', () => {
    expect(readWelcomeDismissed()).toBe(false)
  })

  it('writes "1" and reads true after writeWelcomeDismissed(true)', () => {
    writeWelcomeDismissed(true)
    expect(globalThis.localStorage.getItem(WELCOME_DISMISSED_KEY)).toBe('1')
    expect(readWelcomeDismissed()).toBe(true)
  })

  it('removes the key after writeWelcomeDismissed(false)', () => {
    writeWelcomeDismissed(true)
    writeWelcomeDismissed(false)
    expect(globalThis.localStorage.getItem(WELCOME_DISMISSED_KEY)).toBe(null)
    expect(readWelcomeDismissed()).toBe(false)
  })

  it('writeWelcomeDismissed swallows storage exceptions', () => {
    globalThis.localStorage = makeMockStorage({ throwOnWrite: true })
    expect(() => writeWelcomeDismissed(true)).not.toThrow()
    expect(() => writeWelcomeDismissed(false)).not.toThrow()
  })

  it('readWelcomeDismissed returns false when storage throws', () => {
    globalThis.localStorage = makeMockStorage({ throwOnRead: true })
    expect(readWelcomeDismissed()).toBe(false)
  })

  it('readWelcomeDismissed returns false when localStorage is missing', () => {
    globalThis.localStorage = undefined
    expect(readWelcomeDismissed()).toBe(false)
  })
})
