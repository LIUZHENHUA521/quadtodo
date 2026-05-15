const FALLBACK_PX = 7.8
const SAMPLE_COUNT = 100

let cached: number | null = null

export function _resetMeasureCharWidthCache(): void {
  cached = null
}

export async function measureCharWidth(): Promise<number> {
  if (cached !== null) return cached
  try {
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      await Promise.race([
        document.fonts.ready,
        new Promise<void>(r => setTimeout(r, 500)),
      ])
    }
    if (typeof document === 'undefined' || !document.body) {
      cached = FALLBACK_PX
      return cached
    }
    const probe = document.createElement('span')
    probe.style.cssText = [
      'position:absolute',
      'visibility:hidden',
      'top:-9999px',
      'left:-9999px',
      'font:13px "JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
      'white-space:pre',
      'padding:0',
      'border:0',
      'margin:0',
    ].join(';')
    probe.textContent = 'M'.repeat(SAMPLE_COUNT)
    document.body.appendChild(probe)
    const rect = probe.getBoundingClientRect()
    document.body.removeChild(probe)
    const w = rect.width > 0 ? rect.width / SAMPLE_COUNT : FALLBACK_PX
    cached = w
    return w
  } catch {
    cached = FALLBACK_PX
    return cached
  }
}
