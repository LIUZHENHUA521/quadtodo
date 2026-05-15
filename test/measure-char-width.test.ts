// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'

describe('measureCharWidth', () => {
  it('returns fallback when document.fonts is unavailable', async () => {
    const { measureCharWidth } = await import('../web/src/utils/measureCharWidth.ts')
    // jsdom 没有 document.fonts —— 应该 fallback
    const w = await measureCharWidth()
    expect(w).toBeGreaterThan(0)
    // 7.8 ± 1
    expect(w).toBeLessThanOrEqual(10)
  })

  it('returns positive cached value on second call', async () => {
    const { measureCharWidth, _resetMeasureCharWidthCache } = await import('../web/src/utils/measureCharWidth.ts')
    _resetMeasureCharWidthCache()
    const w1 = await measureCharWidth()
    const w2 = await measureCharWidth()
    expect(w2).toBe(w1)
  })
})
