import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shouldRunWizard, runFirstRunWizard } from '../src/first-run-wizard.js'

describe('shouldRunWizard', () => {
  let dir
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aq-wiz-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('returns false when config.json exists (not first run)', () => {
    writeFileSync(join(dir, 'config.json'), '{}')
    expect(shouldRunWizard({ rootDir: dir, isTTY: true, env: {}, flags: {} })).toBe(false)
  })

  it('returns false when data.db exists (not first run)', () => {
    writeFileSync(join(dir, 'data.db'), '')
    expect(shouldRunWizard({ rootDir: dir, isTTY: true, env: {}, flags: {} })).toBe(false)
  })

  it('returns false when stdin is not TTY', () => {
    expect(shouldRunWizard({ rootDir: dir, isTTY: false, env: {}, flags: {} })).toBe(false)
  })

  it('returns false when AGENTQUAD_SKIP_WIZARD=1', () => {
    expect(shouldRunWizard({ rootDir: dir, isTTY: true, env: { AGENTQUAD_SKIP_WIZARD: '1' }, flags: {} })).toBe(false)
  })

  it('returns false when AGENTQUAD_SKIP_WIZARD=true', () => {
    expect(shouldRunWizard({ rootDir: dir, isTTY: true, env: { AGENTQUAD_SKIP_WIZARD: 'true' }, flags: {} })).toBe(false)
  })

  it('returns false when --no-wizard flag set (flags.wizard === false)', () => {
    expect(shouldRunWizard({ rootDir: dir, isTTY: true, env: {}, flags: { wizard: false } })).toBe(false)
  })

  it('returns true when first-run + TTY + no skip', () => {
    expect(shouldRunWizard({ rootDir: dir, isTTY: true, env: {}, flags: {} })).toBe(true)
  })
})

describe('runFirstRunWizard', () => {
  it('skips install prompt when both tools already present', async () => {
    const checks = { claude: vi.fn(() => true), codex: vi.fn(() => true) }
    const installTools = vi.fn()
    const ask = vi.fn()
    const r = await runFirstRunWizard({ checks, installTools, ask, log: () => {} })
    expect(installTools).not.toHaveBeenCalled()
    expect(ask).not.toHaveBeenCalled()
    expect(r.installedTools).toEqual([])
    expect(r.defaultTool).toBeUndefined()
  })

  it('prompts to install when claude missing, user says Y → installs', async () => {
    const checks = { claude: vi.fn(() => false), codex: vi.fn(() => true) }
    const installTools = vi.fn(async () => 0)
    const ask = vi.fn().mockResolvedValueOnce('y')   // install?
    const r = await runFirstRunWizard({ checks, installTools, ask, log: () => {} })
    expect(installTools).toHaveBeenCalledOnce()
    expect(r.installedTools).toContain('claude')
    expect(r.skippedInstall).toBeFalsy()
  })

  it('continues startup even when user declines install', async () => {
    const checks = { claude: vi.fn(() => false), codex: vi.fn(() => false) }
    const installTools = vi.fn()
    const ask = vi.fn().mockResolvedValueOnce('n')
    const r = await runFirstRunWizard({ checks, installTools, ask, log: () => {} })
    expect(installTools).not.toHaveBeenCalled()
    expect(r.skippedInstall).toBe(true)
  })

  it('continues when installTools throws', async () => {
    const checks = { claude: vi.fn(() => false), codex: vi.fn(() => true) }
    const installTools = vi.fn(async () => { throw new Error('network fail') })
    const ask = vi.fn().mockResolvedValueOnce('y')
    const r = await runFirstRunWizard({ checks, installTools, ask, log: () => {} })
    expect(installTools).toHaveBeenCalledOnce()
    expect(r.installedTools).toEqual([])
  })

  it('Y is the default answer (empty input = install)', async () => {
    const checks = { claude: vi.fn(() => false), codex: vi.fn(() => true) }
    const installTools = vi.fn(async () => 0)
    const ask = vi.fn().mockResolvedValueOnce('')   // empty = Y
    const r = await runFirstRunWizard({ checks, installTools, ask, log: () => {} })
    expect(installTools).toHaveBeenCalledOnce()
  })
})
