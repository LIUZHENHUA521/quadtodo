// test/terminal-themes-migration.test.js
import { describe, it, expect } from 'vitest'
import {
  migratePreset,
  LEGACY_PRESET_MIGRATION,
} from '../web/src/terminalThemes.ts'
import { shouldPersistMigration } from '../web/src/hooks/useTerminalTheme.ts'

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

describe('shouldPersistMigration', () => {
  it('raw = null（无存储）→ 返回 null，不需要写回', () => {
    expect(shouldPersistMigration(null)).toBeNull()
  })

  it('raw = "" → 返回 null', () => {
    expect(shouldPersistMigration('')).toBeNull()
  })

  it('非法 JSON → 返回 null', () => {
    expect(shouldPersistMigration('{not-json}')).toBeNull()
  })

  it('preset 已是新 key → 返回 null（不需要写回）', () => {
    const raw = JSON.stringify({ preset: 'catppuccin-mocha', override: {} })
    expect(shouldPersistMigration(raw)).toBeNull()
  })

  it('preset = "dracula" → 返回 { preset: "catppuccin-mocha", override: {} }', () => {
    const raw = JSON.stringify({ preset: 'dracula', override: {} })
    expect(shouldPersistMigration(raw)).toEqual({
      preset: 'catppuccin-mocha',
      override: {},
    })
  })

  it('迁移时保留 override 字段', () => {
    const raw = JSON.stringify({
      preset: 'one-dark',
      override: { background: '#123456' },
    })
    expect(shouldPersistMigration(raw)).toEqual({
      preset: 'tokyo-night-storm',
      override: { background: '#123456' },
    })
  })

  it('preset 字段缺失 → 返回 null', () => {
    const raw = JSON.stringify({ override: {} })
    expect(shouldPersistMigration(raw)).toBeNull()
  })

  it('custom: 前缀 → 返回 null（不需要迁移）', () => {
    const raw = JSON.stringify({ preset: 'custom:my-theme', override: {} })
    expect(shouldPersistMigration(raw)).toBeNull()
  })
})
