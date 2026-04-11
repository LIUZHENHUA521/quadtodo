import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('config', () => {
  let tmpRoot

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'quadtodo-'))
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('loadConfig returns defaults on first run and creates the directory', async () => {
    const { loadConfig } = await import('../src/config.js')
    const cfg = loadConfig({ rootDir: tmpRoot })

    expect(cfg.port).toBe(5677)
    expect(cfg.defaultTool).toBe('claude')
    expect(cfg.tools.claude.bin).toBeDefined()
    expect(cfg.tools.codex.bin).toBeDefined()
    expect(existsSync(join(tmpRoot, 'config.json'))).toBe(true)
    expect(existsSync(join(tmpRoot, 'logs'))).toBe(true)
  })

  it('loadConfig preserves user edits across calls', async () => {
    const { loadConfig, saveConfig } = await import('../src/config.js')
    const cfg = loadConfig({ rootDir: tmpRoot })
    cfg.port = 9999
    saveConfig(cfg, { rootDir: tmpRoot })

    const reloaded = loadConfig({ rootDir: tmpRoot })
    expect(reloaded.port).toBe(9999)
  })

  it('setConfigValue supports dot paths', async () => {
    const { loadConfig, setConfigValue } = await import('../src/config.js')
    loadConfig({ rootDir: tmpRoot })
    setConfigValue('tools.claude.bin', '/opt/claude', { rootDir: tmpRoot })

    const data = JSON.parse(readFileSync(join(tmpRoot, 'config.json'), 'utf8'))
    expect(data.tools.claude.bin).toBe('/opt/claude')
  })

  it('getConfigValue returns nested values via dot path', async () => {
    const { loadConfig, getConfigValue } = await import('../src/config.js')
    loadConfig({ rootDir: tmpRoot })
    expect(getConfigValue('port', { rootDir: tmpRoot })).toBe(5677)
    expect(getConfigValue('tools.claude.bin', { rootDir: tmpRoot })).toBeTruthy()
  })

  it('loadConfig preserves corrupted user config by backing up instead of clobbering', async () => {
    mkdirSync(tmpRoot, { recursive: true })
    writeFileSync(join(tmpRoot, 'config.json'), '{ this is not json')
    const { loadConfig } = await import('../src/config.js')
    const cfg = loadConfig({ rootDir: tmpRoot })
    expect(cfg.port).toBe(5677)
    expect(existsSync(join(tmpRoot, 'config.json.corrupt'))).toBe(true)
  })
})
