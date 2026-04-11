import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doctorReport, buildDoctorChecks } from '../src/cli.js'
import { loadConfig, setConfigValue, getConfigValue } from '../src/config.js'

describe('cli helpers', () => {
  let rootDir
  beforeEach(() => { rootDir = mkdtempSync(join(tmpdir(), 'quadtodo-cli-')) })
  afterEach(() => { rmSync(rootDir, { recursive: true, force: true }) })

  it('config round-trip via setConfigValue / getConfigValue', () => {
    loadConfig({ rootDir })
    setConfigValue('tools.claude.bin', '/opt/claude', { rootDir })
    expect(getConfigValue('tools.claude.bin', { rootDir })).toBe('/opt/claude')
  })

  it('setConfigValue coerces integer for port', () => {
    loadConfig({ rootDir })
    setConfigValue('port', '6789', { rootDir })
    expect(getConfigValue('port', { rootDir })).toBe(6789)
    // verify on-disk
    const raw = JSON.parse(readFileSync(join(rootDir, 'config.json'), 'utf8'))
    expect(raw.port).toBe(6789)
  })

  it('doctorReport returns a checklist object', async () => {
    const report = await doctorReport({ rootDir })
    expect(Array.isArray(report.checks)).toBe(true)
    expect(typeof report.ok).toBe('boolean')
    const names = report.checks.map(c => c.name)
    expect(names).toContain('rootDir exists')
    expect(names).toContain('config.json parseable')
    expect(names).toContain('better-sqlite3 loadable')
  })

  it('buildDoctorChecks is pure and sync-returns a predictable set of names', () => {
    const names = buildDoctorChecks()
    expect(names).toEqual([
      'rootDir exists',
      'config.json parseable',
      'better-sqlite3 loadable',
      'node-pty loadable',
      'claude binary',
      'codex binary',
    ])
  })
})
