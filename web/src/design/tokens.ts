// Design tokens — single source of truth.
// Mirror these in tokens.css as CSS variables.
// Mirror these in antd-theme.ts as AntD ThemeConfig.

export type ThemeMode = 'dark' | 'light'

export interface DesignTokens {
  surface: { 0: string; 1: string; 2: string; 3: string }
  border: { subtle: string; default: string; strong: string }
  text: { primary: string; secondary: string; tertiary: string; disabled: string }
  accent: { electric: string; electricSoft: string; electricGlow: string }
  quadrant: { q1: string; q2: string; q3: string; q4: string }
  ai: {
    running: string
    thinking: string
    pendingConfirm: string
    idle: string
    error: string
  }
  shadow: { subtle: string; elevated: string; floating: string }
}

export const darkTokens: DesignTokens = {
  surface: { 0: '#0a0d12', 1: '#13171f', 2: '#1a1f2a', 3: '#1f2532' },
  border: {
    subtle: 'rgba(255, 255, 255, 0.06)',
    default: 'rgba(255, 255, 255, 0.10)',
    strong: 'rgba(255, 255, 255, 0.18)',
  },
  text: {
    primary: '#e5e9f0',
    secondary: '#a0a8b8',
    tertiary: '#6b7280',
    disabled: '#4a5160',
  },
  accent: {
    electric: '#4DE5FF',
    electricSoft: 'rgba(77, 229, 255, 0.12)',
    electricGlow: 'rgba(77, 229, 255, 0.45)',
  },
  quadrant: { q1: '#ff5cb1', q2: '#4DE5FF', q3: '#ffb84d', q4: '#8a93a5' },
  ai: {
    running: '#4ade80',
    thinking: '#4DE5FF',
    pendingConfirm: '#ffb84d',
    idle: '#6b7280',
    error: '#ef4444',
  },
  shadow: {
    subtle: '0 1px 2px rgba(0,0,0,0.30)',
    elevated: '0 6px 18px rgba(0,0,0,0.45)',
    floating: '0 18px 40px rgba(0,0,0,0.55)',
  },
}

export const lightTokens: DesignTokens = {
  surface: { 0: '#f5f6f9', 1: '#ffffff', 2: '#eef0f5', 3: '#ffffff' },
  border: {
    subtle: 'rgba(0, 0, 0, 0.05)',
    default: 'rgba(0, 0, 0, 0.10)',
    strong: 'rgba(0, 0, 0, 0.18)',
  },
  text: {
    primary: '#0a0d12',
    secondary: '#4a5160',
    tertiary: '#6b7280',
    disabled: '#a0a8b8',
  },
  accent: {
    electric: '#00a3c4',
    electricSoft: 'rgba(0, 163, 196, 0.10)',
    electricGlow: 'rgba(0, 163, 196, 0.40)',
  },
  quadrant: { q1: '#d63384', q2: '#00a3c4', q3: '#d97706', q4: '#6b7280' },
  ai: {
    running: '#16a34a',
    thinking: '#00a3c4',
    pendingConfirm: '#d97706',
    idle: '#6b7280',
    error: '#dc2626',
  },
  shadow: {
    subtle: '0 1px 2px rgba(0,0,0,0.04)',
    elevated: '0 6px 18px rgba(0,0,0,0.08)',
    floating: '0 18px 40px rgba(0,0,0,0.14)',
  },
}

export const tokensByMode: Record<ThemeMode, DesignTokens> = {
  dark: darkTokens,
  light: lightTokens,
}

// Spacing / radius / motion are mode-independent (same in dark & light)
export const spacing = {
  1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 7: 32, 8: 48, 9: 64,
} as const

export const radius = {
  sm: 4, md: 6, lg: 8, xl: 12, full: 999,
} as const

export const fontFamily = {
  sans: `'Inter', -apple-system, system-ui, sans-serif`,
  mono: `'JetBrains Mono', 'SF Mono', Menlo, Monaco, Consolas, monospace`,
} as const

export const fontSize = {
  xs: 11, sm: 12, base: 13, md: 14, lg: 16, xl: 20, '2xl': 24,
} as const

export const motion = {
  duration: { fast: 120, normal: 200, slow: 320 },
  easing: {
    standard: 'cubic-bezier(0.4, 0, 0.2, 1)',
    in: 'cubic-bezier(0.4, 0, 1, 1)',
    out: 'cubic-bezier(0, 0, 0.2, 1)',
    spring: 'cubic-bezier(0.2, 0.9, 0.3, 1.2)',
  },
} as const
