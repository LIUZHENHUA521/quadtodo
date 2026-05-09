import type { ITheme } from '@xterm/xterm'

export type TerminalPresetName =
  | 'default'
  | 'dracula'
  | 'solarized-dark'
  | 'one-dark'
  | 'solarized-light'

export const PRESET_LABELS: Record<TerminalPresetName, string> = {
  'default': 'Quadtodo',
  'dracula': 'Dracula',
  'solarized-dark': 'Solarized Dark',
  'one-dark': 'One Dark',
  'solarized-light': 'Solarized Light',
}

export const PRESET_ORDER: TerminalPresetName[] = [
  'default',
  'dracula',
  'solarized-dark',
  'one-dark',
  'solarized-light',
]

export const TERMINAL_PRESETS: Record<TerminalPresetName, ITheme> = {
  'default': {
    background: '#1a1a2e',
    foreground: '#d4d4d4',
    cursor: '#569cd6',
    cursorAccent: '#1a1a2e',
    selectionBackground: '#264f78',
    selectionForeground: '#ffffff',
    black: '#000000',
    red: '#cd3131',
    green: '#0dbc79',
    yellow: '#e5e510',
    blue: '#2472c8',
    magenta: '#bc3fbc',
    cyan: '#11a8cd',
    white: '#e5e5e5',
    brightBlack: '#666666',
    brightRed: '#f14c4c',
    brightGreen: '#23d18b',
    brightYellow: '#f5f543',
    brightBlue: '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan: '#29b8db',
    brightWhite: '#ffffff',
  },
  'dracula': {
    background: '#282a36',
    foreground: '#f8f8f2',
    cursor: '#f8f8f2',
    cursorAccent: '#282a36',
    selectionBackground: '#44475a',
    selectionForeground: '#f8f8f2',
    black: '#21222c',
    red: '#ff5555',
    green: '#50fa7b',
    yellow: '#f1fa8c',
    blue: '#bd93f9',
    magenta: '#ff79c6',
    cyan: '#8be9fd',
    white: '#f8f8f2',
    brightBlack: '#6272a4',
    brightRed: '#ff6e6e',
    brightGreen: '#69ff94',
    brightYellow: '#ffffa5',
    brightBlue: '#d6acff',
    brightMagenta: '#ff92df',
    brightCyan: '#a4ffff',
    brightWhite: '#ffffff',
  },
  'solarized-dark': {
    background: '#002b36',
    foreground: '#839496',
    cursor: '#93a1a1',
    cursorAccent: '#002b36',
    selectionBackground: '#073642',
    selectionForeground: '#93a1a1',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#586e75',
    brightRed: '#cb4b16',
    brightGreen: '#586e75',
    brightYellow: '#657b83',
    brightBlue: '#839496',
    brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1',
    brightWhite: '#fdf6e3',
  },
  'one-dark': {
    background: '#282c34',
    foreground: '#abb2bf',
    cursor: '#528bff',
    cursorAccent: '#282c34',
    selectionBackground: '#3e4451',
    selectionForeground: '#abb2bf',
    black: '#282c34',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#abb2bf',
    brightBlack: '#5c6370',
    brightRed: '#e06c75',
    brightGreen: '#98c379',
    brightYellow: '#e5c07b',
    brightBlue: '#61afef',
    brightMagenta: '#c678dd',
    brightCyan: '#56b6c2',
    brightWhite: '#ffffff',
  },
  'solarized-light': {
    background: '#fdf6e3',
    foreground: '#657b83',
    cursor: '#586e75',
    cursorAccent: '#fdf6e3',
    selectionBackground: '#eee8d5',
    selectionForeground: '#586e75',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#002b36',
    brightRed: '#cb4b16',
    brightGreen: '#586e75',
    brightYellow: '#657b83',
    brightBlue: '#839496',
    brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1',
    brightWhite: '#fdf6e3',
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
  // 30% bg / 70% fg：保留 fg 主导色，避免低饱和主题（solarized-dark 等）混色后对比度过低
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
