import { useEffect, useState } from 'react'

const DEFAULT_BREAKPOINT = 768

/**
 * 响应式断点探测：宽度 <= breakpoint 时返回 true。
 * 监听 matchMedia 变化；SSR 下初始值回退到 false。
 */
export function useIsMobile(breakpoint: number = DEFAULT_BREAKPOINT): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false
    }
    return window.matchMedia(`(max-width: ${breakpoint}px)`).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }
    const mql = window.matchMedia(`(max-width: ${breakpoint}px)`)
    const handler = (event: MediaQueryListEvent) => setIsMobile(event.matches)
    // Safari < 14 uses addListener/removeListener
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', handler)
      return () => mql.removeEventListener('change', handler)
    }
    mql.addListener(handler)
    return () => mql.removeListener(handler)
  }, [breakpoint])

  return isMobile
}
