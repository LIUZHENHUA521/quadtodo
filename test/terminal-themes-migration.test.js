// test/terminal-themes-migration.test.js
import { describe, it, expect } from 'vitest'
import {
  migratePreset,
  LEGACY_PRESET_MIGRATION,
} from '../web/src/terminalThemes.ts'

describe('migratePreset', () => {
  it('dracula → catppuccin-mocha', () => {
    expect(migratePreset('dracula')).toEqual({ value: 'catppuccin-mocha', migrated: true })
  })

  it('solarized-dark → catppuccin-macchiato', () => {
    expect(migratePreset('solarized-dark')).toEqual({ value: 'catppuccin-macchiato', migrated: true })
  })

  it('one-dark → tokyo-night-storm', () => {
    expect(migratePreset('one-dark')).toEqual({ value: 'tokyo-night-storm', migrated: true })
  })

  it('solarized-light → catppuccin-latte', () => {
    expect(migratePreset('solarized-light')).toEqual({ value: 'catppuccin-latte', migrated: true })
  })

  it('已是新 key 时不迁移', () => {
    expect(migratePreset('catppuccin-mocha')).toEqual({ value: 'catppuccin-mocha', migrated: false })
    expect(migratePreset('default')).toEqual({ value: 'default', migrated: false })
  })

  it('custom: 前缀的自定义主题不被迁移', () => {
    expect(migratePreset('custom:my-theme')).toEqual({ value: 'custom:my-theme', migrated: false })
  })

  it('未知 key 原样返回（由后续 isPresetName 兜底回退到 default）', () => {
    expect(migratePreset('unknown-theme-xyz')).toEqual({ value: 'unknown-theme-xyz', migrated: false })
  })

  it('LEGACY_PRESET_MIGRATION 涵盖全部 4 个老 preset', () => {
    expect(Object.keys(LEGACY_PRESET_MIGRATION).sort()).toEqual(
      ['dracula', 'one-dark', 'solarized-dark', 'solarized-light']
    )
  })
})
