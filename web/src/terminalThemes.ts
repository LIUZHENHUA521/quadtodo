import type { ITheme } from '@xterm/xterm'
import { tokensByMode, type ThemeMode } from './design/tokens'

export type TerminalPresetName =
  | 'default'
  | 'catppuccin-mocha'
  | 'catppuccin-macchiato'
  | 'catppuccin-frappe'
  | 'catppuccin-latte'
  | 'tokyo-night-storm'

export const PRESET_LABELS: Record<TerminalPresetName, string> = {
  'default': 'Quadtodo',
  'catppuccin-mocha': 'Catppuccin Mocha',
  'catppuccin-macchiato': 'Catppuccin Macchiato',
  'catppuccin-frappe': 'Catppuccin Frappé',
  'catppuccin-latte': 'Catppuccin Latte',
  'tokyo-night-storm': 'Tokyo Night Storm',
}

export const PRESET_ORDER: TerminalPresetName[] = [
  'default',
  'catppuccin-mocha',
  'catppuccin-macchiato',
  'catppuccin-frappe',
  'catppuccin-latte',
  'tokyo-night-storm',
]

export const TERMINAL_PRESETS: Record<TerminalPresetName, ITheme> = {
  // Quadtodo (rebuilt): 保留品牌 background 与 cursor，ANSI 16 色向 Catppuccin Mocha 美学靠拢
  'default': {
    background: '#1a1a2e',
    foreground: '#e4e6f1',
    cursor: '#569cd6',
    cursorAccent: '#1a1a2e',
    selectionBackground: '#264f78',
    selectionForeground: '#ffffff',
    black: '#2a2a44',
    red: '#f06292',
    green: '#82d779',
    yellow: '#f1c987',
    blue: '#6da8f5',
    magenta: '#c084fc',
    cyan: '#5dd9c5',
    white: '#d6d8e8',
    brightBlack: '#4a4d72',
    brightRed: '#ff7aa6',
    brightGreen: '#9ce28f',
    brightYellow: '#ffd89b',
    brightBlue: '#88baff',
    brightMagenta: '#d5a3ff',
    brightCyan: '#7eebd7',
    brightWhite: '#ffffff',
  },
  // Catppuccin Mocha — github.com/catppuccin/catppuccin palette.json
  'catppuccin-mocha': {
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    cursor: '#f5e0dc',
    cursorAccent: '#1e1e2e',
    selectionBackground: '#585b70',
    selectionForeground: '#cdd6f4',
    black: '#45475a',
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#f5c2e7',
    cyan: '#94e2d5',
    white: '#bac2de',
    brightBlack: '#585b70',
    brightRed: '#f38ba8',
    brightGreen: '#a6e3a1',
    brightYellow: '#f9e2af',
    brightBlue: '#89b4fa',
    brightMagenta: '#f5c2e7',
    brightCyan: '#94e2d5',
    brightWhite: '#a6adc8',
  },
  // Catppuccin Macchiato
  'catppuccin-macchiato': {
    background: '#24273a',
    foreground: '#cad3f5',
    cursor: '#f4dbd6',
    cursorAccent: '#24273a',
    selectionBackground: '#5b6078',
    selectionForeground: '#cad3f5',
    black: '#494d64',
    red: '#ed8796',
    green: '#a6da95',
    yellow: '#eed49f',
    blue: '#8aadf4',
    magenta: '#f5bde6',
    cyan: '#8bd5ca',
    white: '#b8c0e0',
    brightBlack: '#5b6078',
    brightRed: '#ed8796',
    brightGreen: '#a6da95',
    brightYellow: '#eed49f',
    brightBlue: '#8aadf4',
    brightMagenta: '#f5bde6',
    brightCyan: '#8bd5ca',
    brightWhite: '#a5adcb',
  },
  // Catppuccin Frappé
  'catppuccin-frappe': {
    background: '#303446',
    foreground: '#c6d0f5',
    cursor: '#f2d5cf',
    cursorAccent: '#303446',
    selectionBackground: '#626880',
    selectionForeground: '#c6d0f5',
    black: '#51576d',
    red: '#e78284',
    green: '#a6d189',
    yellow: '#e5c890',
    blue: '#8caaee',
    magenta: '#f4b8e4',
    cyan: '#81c8be',
    white: '#b5bfe2',
    brightBlack: '#626880',
    brightRed: '#e78284',
    brightGreen: '#a6d189',
    brightYellow: '#e5c890',
    brightBlue: '#8caaee',
    brightMagenta: '#f4b8e4',
    brightCyan: '#81c8be',
    brightWhite: '#a5adce',
  },
  // Catppuccin Latte — 浅色；cursor 用 subtext1 覆盖官方 rosewater，确保对 light bg ≥ 3:1
  'catppuccin-latte': {
    background: '#eff1f5',
    foreground: '#4c4f69',
    cursor: '#5c5f77',
    cursorAccent: '#eff1f5',
    selectionBackground: '#acb0be',
    selectionForeground: '#4c4f69',
    black: '#bcc0cc',
    red: '#d20f39',
    green: '#40a02b',
    yellow: '#df8e1d',
    blue: '#1e66f5',
    magenta: '#ea76cb',
    cyan: '#179299',
    white: '#5c5f77',
    brightBlack: '#acb0be',
    brightRed: '#d20f39',
    brightGreen: '#40a02b',
    brightYellow: '#df8e1d',
    brightBlue: '#1e66f5',
    brightMagenta: '#ea76cb',
    brightCyan: '#179299',
    brightWhite: '#6c6f85',
  },
  // Tokyo Night Storm — github.com/folke/tokyonight.nvim/blob/main/lua/tokyonight/colors/storm.lua
  'tokyo-night-storm': {
    background: '#24283b',
    foreground: '#c0caf5',
    cursor: '#c0caf5',
    cursorAccent: '#24283b',
    selectionBackground: '#364a82',
    selectionForeground: '#c0caf5',
    black: '#1d202f',
    red: '#f7768e',
    green: '#9ece6a',
    yellow: '#e0af68',
    blue: '#7aa2f7',
    magenta: '#bb9af7',
    cyan: '#7dcfff',
    white: '#a9b1d6',
    brightBlack: '#414868',
    brightRed: '#f7768e',
    brightGreen: '#9ece6a',
    brightYellow: '#e0af68',
    brightBlue: '#7aa2f7',
    brightMagenta: '#bb9af7',
    brightCyan: '#7dcfff',
    brightWhite: '#c0caf5',
  },
}

const COLOR_RE = /^(#[0-9a-f]{6}([0-9a-f]{2})?|rgba?\([^)]+\))$/i

export function isValidColor(value: unknown): value is string {
  return typeof value === 'string' && COLOR_RE.test(value.trim())
}

export function isPresetName(name: unknown): name is TerminalPresetName {
  return typeof name === 'string' && name in TERMINAL_PRESETS
}

export interface ChromePalette {
  /** 工具栏 / 拖拽手柄 / 全屏底栏的底色 */
  surface: string
  /** 外壳容器底色（与 xterm 内容区一致，避免双层差异） */
  outer: string
  /** chrome 与内容之间的描边色 */
  border: string
  /** 工具栏次要文字（替代原硬编码 #888） */
  mutedText: string
  /** "AI" 标签前缀色，浅色主题下自动加深以保对比度 */
  accent: string
  /** background 是否被判定为浅色（luminance > 0.5） */
  isLight: boolean
}

type Rgb = [number, number, number]

function parseHexColor(hex: string): Rgb | null {
  if (typeof hex !== 'string') return null
  const m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(hex.trim())
  if (!m) return null
  const v = m[1]
  return [
    parseInt(v.slice(0, 2), 16),
    parseInt(v.slice(2, 4), 16),
    parseInt(v.slice(4, 6), 16),
  ]
}

function rgbToHex(rgb: Rgb): string {
  const c = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0')
  return `#${c(rgb[0])}${c(rgb[1])}${c(rgb[2])}`
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ]
}

function lightenHex(hex: string, amount: number): string {
  const rgb = parseHexColor(hex)
  if (!rgb) return hex
  return rgbToHex(mixRgb(rgb, [255, 255, 255], amount))
}

function darkenHex(hex: string, amount: number): string {
  const rgb = parseHexColor(hex)
  if (!rgb) return hex
  return rgbToHex(mixRgb(rgb, [0, 0, 0], amount))
}

function relativeLuminance(rgb: Rgb): number {
  const f = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2])
}

function contrastRatio(a: string, b: string): number {
  const ra = parseHexColor(a)
  const rb = parseHexColor(b)
  if (!ra || !rb) return 1
  const la = relativeLuminance(ra) + 0.05
  const lb = relativeLuminance(rb) + 0.05
  return la > lb ? la / lb : lb / la
}

const CHROME_FALLBACK: ChromePalette = {
  surface: '#16213e',
  outer: '#1a1a2e',
  border: '#303050',
  mutedText: '#888888',
  accent: '#569cd6',
  isLight: false,
}

/**
 * 从 xterm 主题派生工具栏 / 外壳 / 边框等 chrome 颜色。
 * 深色主题：surface 比 background 略亮（raised），border 更亮。
 * 浅色主题：surface 比 background 略暗（sunken），border 更暗。
 * background / foreground 非 hex 时返回稳定的深色 fallback。
 */
export function deriveChrome(theme: { background?: string; foreground?: string }): ChromePalette {
  const bgHex = typeof theme.background === 'string' ? theme.background : ''
  const fgHex = typeof theme.foreground === 'string' ? theme.foreground : ''
  const bgRgb = parseHexColor(bgHex)
  const fgRgb = parseHexColor(fgHex)
  if (!bgRgb || !fgRgb) return CHROME_FALLBACK

  const isLight = relativeLuminance(bgRgb) > 0.5
  const surface = isLight ? darkenHex(bgHex, 0.06) : lightenHex(bgHex, 0.08)
  const border = isLight ? darkenHex(bgHex, 0.14) : lightenHex(bgHex, 0.18)
  // 30% bg / 70% fg：保留 fg 主导色，避免低饱和主题混色后对比度过低
  const mutedText = rgbToHex(mixRgb(fgRgb, bgRgb, 0.3))

  // 浅色 surface 下用更深的品牌蓝；深色 surface 下若品牌色不够亮则切到更亮的蓝
  const ACCENT_DEFAULT = '#569cd6'
  const ACCENT_FOR_LIGHT_SURFACE = '#155b9b'
  const ACCENT_FOR_DARK_SURFACE = '#7cc1ff'
  const accent = contrastRatio(ACCENT_DEFAULT, surface) >= 4.5
    ? ACCENT_DEFAULT
    : isLight ? ACCENT_FOR_LIGHT_SURFACE : ACCENT_FOR_DARK_SURFACE

  return {
    surface,
    outer: bgHex,
    border,
    mutedText,
    accent,
    isLight,
  }
}

/** 旧版本内置 preset → 新版本对应主题。仅在 readStored 中改写返回值；持久化由 hook 的 useEffect 完成。 */
export const LEGACY_PRESET_MIGRATION: Record<string, TerminalPresetName> = {
  'dracula': 'catppuccin-mocha',
  'solarized-dark': 'catppuccin-macchiato',
  'one-dark': 'tokyo-night-storm',
  'solarized-light': 'catppuccin-latte',
}

/** 纯函数：把旧 preset key 映射到新 key；非 legacy 输入原样返回。 */
export function migratePreset(raw: string): { value: string; migrated: boolean } {
  const mapped = LEGACY_PRESET_MIGRATION[raw]
  if (mapped) return { value: mapped, migrated: true }
  return { value: raw, migrated: false }
}

/**
 * Build an xterm ITheme from active design tokens.
 * Spread base preset first so its ANSI 16-color palette (ansiRed, etc) is preserved.
 * Then override surface / foreground / cursor / selection from design tokens.
 */
export function getTokenDrivenTheme(mode: ThemeMode): ITheme {
  const t = tokensByMode[mode]
  return {
    ...TERMINAL_PRESETS['default'],
    background: t.surface[0],
    foreground: t.text.primary,
    cursor: t.accent.electric,
    cursorAccent: t.surface[0],
    selectionBackground: t.accent.electricSoft,
    selectionForeground: t.text.primary,
  }
}
