/**
 * Helpers for StatsPanel: CSS-var palette reading, delta math, timeline gap-fill.
 *
 * Charts are rendered to <canvas>, so CSS variables can't be passed through
 * style props — they must be resolved to concrete RGB strings.
 */

export interface PaletteSnapshot {
  q1: string
  q2: string
  q3: string
  q4: string
  accent: string
  textPrimary: string
  textSecondary: string
  textTertiary: string
  borderSubtle: string
  surface1: string
  surface2: string
  aiRunning: string
  aiError: string
}

const VARS: Record<keyof PaletteSnapshot, string> = {
  q1: '--q1',
  q2: '--q2',
  q3: '--q3',
  q4: '--q4',
  accent: '--accent-electric',
  textPrimary: '--text-primary',
  textSecondary: '--text-secondary',
  textTertiary: '--text-tertiary',
  borderSubtle: '--border-subtle',
  surface1: '--surface-1',
  surface2: '--surface-2',
  aiRunning: '--ai-running',
  aiError: '--ai-error',
}

export function readPalette(): PaletteSnapshot {
  const cs = getComputedStyle(document.documentElement)
  const out = {} as PaletteSnapshot
  for (const k of Object.keys(VARS) as (keyof PaletteSnapshot)[]) {
    out[k] = cs.getPropertyValue(VARS[k]).trim() || '#000'
  }
  return out
}

export interface TimelinePoint {
  t: number
  activeMs: number
  wallClockMs: number
}

/**
 * Fill in missing days between the first and last timeline point with zero values.
 * Avoids the "isolated spike" look when sparse data is rendered as a line chart.
 */
export function fillTimelineGaps(timeline: TimelinePoint[], since: number, until: number): TimelinePoint[] {
  const DAY = 86400_000
  const startDay = Math.floor(since / DAY) * DAY
  const endDay = Math.floor(until / DAY) * DAY
  const byDay = new Map<number, TimelinePoint>()
  for (const p of timeline) {
    const day = Math.floor(p.t / DAY) * DAY
    byDay.set(day, p)
  }
  const out: TimelinePoint[] = []
  for (let d = startDay; d <= endDay; d += DAY) {
    const existing = byDay.get(d)
    out.push(existing ?? { t: d, activeMs: 0, wallClockMs: 0 })
  }
  return out
}

export interface DeltaResult {
  pct: number | null      // null when baseline too small / missing
  direction: 'up' | 'down' | 'flat' | 'none'
  baselineMissing: boolean
}

/**
 * Compare current vs previous value. Returns null pct when baseline is below
 * threshold (default 30 min in ms) to avoid misleading huge percentages.
 */
export function computeDelta(current: number, previous: number | undefined, baselineThreshold = 30 * 60_000): DeltaResult {
  if (previous == null) return { pct: null, direction: 'none', baselineMissing: true }
  if (previous < baselineThreshold) {
    if (current > previous) return { pct: null, direction: 'up', baselineMissing: true }
    if (current < previous) return { pct: null, direction: 'down', baselineMissing: true }
    return { pct: null, direction: 'flat', baselineMissing: true }
  }
  const pct = ((current - previous) / previous) * 100
  if (Math.abs(pct) < 0.5) return { pct: 0, direction: 'flat', baselineMissing: false }
  return {
    pct,
    direction: pct > 0 ? 'up' : 'down',
    baselineMissing: false,
  }
}

export function shiftRangeBackwards(since: number, until: number): [number, number] {
  const span = until - since
  return [since - span, since]
}

export function rangeLabel(range: 'week' | 'month' | '30d' | 'custom'): string {
  if (range === 'week') return '上周'
  if (range === 'month') return '上月'
  if (range === '30d') return '前 30 天'
  return '前一周期'
}
