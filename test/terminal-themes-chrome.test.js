import { describe, it, expect } from 'vitest'
import { deriveChrome, TERMINAL_PRESETS } from '../web/src/terminalThemes.ts'

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

describe('deriveChrome', () => {
  it('深色主题：surface 比 background 更亮（raised）', () => {
    const dark = TERMINAL_PRESETS['default']
    const c = deriveChrome(dark)
    expect(c.isLight).toBe(false)
    expect(relLum(parseHex(c.surface))).toBeGreaterThan(relLum(parseHex(dark.background)))
    expect(relLum(parseHex(c.border))).toBeGreaterThan(relLum(parseHex(c.surface)))
  })

  it('浅色主题：surface 比 background 更暗（sunken）', () => {
    const light = TERMINAL_PRESETS['solarized-light']
    const c = deriveChrome(light)
    expect(c.isLight).toBe(true)
    expect(relLum(parseHex(c.surface))).toBeLessThan(relLum(parseHex(light.background)))
    expect(relLum(parseHex(c.border))).toBeLessThan(relLum(parseHex(c.surface)))
  })

  it('outer 颜色直接采用 background，避免与内容区出现双层夹色', () => {
    for (const name of ['default', 'dracula', 'solarized-dark', 'one-dark', 'solarized-light']) {
      const t = TERMINAL_PRESETS[name]
      expect(deriveChrome(t).outer.toLowerCase()).toBe(t.background.toLowerCase())
    }
  })

  it('mutedText 对 surface 的对比度足够区分但不抢眼（≥ 2.0）', () => {
    for (const name of ['default', 'dracula', 'solarized-dark', 'one-dark', 'solarized-light']) {
      const c = deriveChrome(TERMINAL_PRESETS[name])
      expect(contrast(c.mutedText, c.surface)).toBeGreaterThanOrEqual(2.0)
    }
  })

  it('accent 对所选 surface 满足对比度 ≥ 4.5；不满足时降级到深蓝 fallback', () => {
    for (const name of ['default', 'dracula', 'solarized-dark', 'one-dark', 'solarized-light']) {
      const c = deriveChrome(TERMINAL_PRESETS[name])
      expect(contrast(c.accent, c.surface)).toBeGreaterThanOrEqual(4.5)
    }
    // solarized-light 浅色背景应触发 accent 降级到深蓝
    const lightC = deriveChrome(TERMINAL_PRESETS['solarized-light'])
    expect(lightC.accent).toBe('#155b9b')
    // 默认 quadtodo 深色 + 高饱和品牌蓝对比度足够，保留品牌蓝
    const darkC = deriveChrome(TERMINAL_PRESETS['default'])
    expect(darkC.accent).toBe('#569cd6')
    // dracula / one-dark / solarized-dark 的 surface 不够暗，应切到更亮的蓝
    expect(deriveChrome(TERMINAL_PRESETS['dracula']).accent).toBe('#7cc1ff')
  })

  it('用户自定义主题（仅 background/foreground）也能产出有效 chrome', () => {
    const custom = { background: '#fafafa', foreground: '#222222' }
    const c = deriveChrome(custom)
    expect(c.isLight).toBe(true)
    expect(c.outer).toBe('#fafafa')
    expect(/^#[0-9a-f]{6}$/i.test(c.surface)).toBe(true)
    expect(/^#[0-9a-f]{6}$/i.test(c.border)).toBe(true)
    expect(/^#[0-9a-f]{6}$/i.test(c.mutedText)).toBe(true)
  })

  it('background / foreground 非合法 hex 时退化为稳定的深色 fallback', () => {
    const c = deriveChrome({ background: 'rgb(0,0,0)', foreground: 'red' })
    expect(c.outer).toBe('#1a1a2e')
    expect(c.surface).toBe('#16213e')
    expect(c.isLight).toBe(false)
  })
})
