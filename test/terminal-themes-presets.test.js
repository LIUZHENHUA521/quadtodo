// test/terminal-themes-presets.test.js
import { describe, it, expect } from 'vitest'
import {
  TERMINAL_PRESETS,
  PRESET_LABELS,
  PRESET_ORDER,
} from '../web/src/terminalThemes.ts'

const EXPECTED_KEYS = [
  'default',
  'catppuccin-mocha',
  'catppuccin-macchiato',
  'catppuccin-frappe',
  'catppuccin-latte',
  'tokyo-night-storm',
]

const REQUIRED_FIELDS = [
  'background', 'foreground', 'cursor', 'cursorAccent',
  'selectionBackground', 'selectionForeground',
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
]

const HEX_RE = /^#[0-9a-f]{6}$/i

describe('TERMINAL_PRESETS structure', () => {
  it('PRESET_ORDER 包含 6 个新 key 且顺序正确', () => {
    expect(PRESET_ORDER).toEqual(EXPECTED_KEYS)
  })

  it('每个 PRESET_ORDER 中的 key 都在 PRESET_LABELS 和 TERMINAL_PRESETS 中', () => {
    for (const key of PRESET_ORDER) {
      expect(PRESET_LABELS[key]).toBeTruthy()
      expect(TERMINAL_PRESETS[key]).toBeTruthy()
    }
  })

  it('每个 preset 拥有完整的 22 个色彩字段，且都是合法 hex', () => {
    for (const key of EXPECTED_KEYS) {
      const theme = TERMINAL_PRESETS[key]
      for (const field of REQUIRED_FIELDS) {
        expect(theme[field], `${key}.${field}`).toMatch(HEX_RE)
      }
    }
  })
})

function parseHex(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return null
  const v = m[1]
  return [
    parseInt(v.slice(0, 2), 16),
    parseInt(v.slice(2, 4), 16),
    parseInt(v.slice(4, 6), 16),
  ]
}

function relLum([r, g, b]) {
  const f = (c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

function contrast(a, b) {
  const la = relLum(parseHex(a)) + 0.05
  const lb = relLum(parseHex(b)) + 0.05
  return la > lb ? la / lb : lb / la
}

describe('TERMINAL_PRESETS WCAG contrast', () => {
  it('每个主题的 foreground 对 background 对比度 ≥ 4.5（WCAG AA）', () => {
    for (const key of EXPECTED_KEYS) {
      const t = TERMINAL_PRESETS[key]
      expect(contrast(t.foreground, t.background), `${key} fg/bg`)
        .toBeGreaterThanOrEqual(4.5)
    }
  })

  it('default（Quadtodo）作为默认主题要求 fg/bg 对比度 ≥ 7（WCAG AAA）', () => {
    const t = TERMINAL_PRESETS['default']
    expect(contrast(t.foreground, t.background)).toBeGreaterThanOrEqual(7)
  })

  it('每个主题的 cursor 对 background 对比度 ≥ 3', () => {
    for (const key of EXPECTED_KEYS) {
      const t = TERMINAL_PRESETS[key]
      expect(contrast(t.cursor, t.background), `${key} cursor/bg`)
        .toBeGreaterThanOrEqual(3)
    }
  })

  it('每个主题的 selectionBackground 与 background 相对亮度绝对差 ≥ 0.05（选区可见）', () => {
    for (const key of EXPECTED_KEYS) {
      const t = TERMINAL_PRESETS[key]
      const dl = Math.abs(relLum(parseHex(t.background)) - relLum(parseHex(t.selectionBackground)))
      expect(dl, `${key} selection luminance delta`).toBeGreaterThanOrEqual(0.05)
    }
  })
})
