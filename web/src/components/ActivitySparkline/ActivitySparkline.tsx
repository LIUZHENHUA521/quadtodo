import { useEffect, useRef, useState } from 'react'
import { useAiSessionStore } from '../../store/aiSessionStore'
import './ActivitySparkline.css'

interface Props {
  sessionId?: string | null
  width?: number       // default 88
  height?: number      // default 18
  className?: string
}

const HISTORY_LEN = 12
const SAMPLE_INTERVAL_MS = 1000  // 1 sample/sec

export function ActivitySparkline({ sessionId, width = 88, height = 18, className }: Props) {
  const [samples, setSamples] = useState<number[]>(() => Array(HISTORY_LEN).fill(0))

  // Read current rate via subscription
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    if (!sessionId) {
      // No session: clear samples
      setSamples(Array(HISTORY_LEN).fill(0))
      return
    }
    // Sample every 1 second
    intervalRef.current = setInterval(() => {
      const rate = useAiSessionStore.getState().outputRates.get(sessionId) ?? 0
      setSamples((prev) => {
        const next = prev.slice(1)
        next.push(rate)
        return next
      })
    }, SAMPLE_INTERVAL_MS)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [sessionId])

  // Compute SVG polyline points
  // Map sample value (bytes/sec) to y coordinate (0 = bottom, height = top)
  const maxValue = Math.max(...samples, 1)  // avoid div-by-0
  const isIdle = !sessionId || samples.every(v => v === 0)
  const stepX = width / (HISTORY_LEN - 1)
  const points = samples
    .map((v, i) => {
      const x = i * stepX
      const yNorm = isIdle ? 0.5 : 1 - (v / maxValue)  // flat in middle when idle
      const y = yNorm * (height - 2) + 1
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  return (
    <svg
      className={`activity-sparkline${isIdle ? ' is-idle' : ''}${className ? ` ${className}` : ''}`}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      preserveAspectRatio="none"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}
