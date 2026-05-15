import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  installAllAgents,
  uninstallAllAgents,
  inspectAllAgents,
  previewAllAgents,
} from '../src/agent-installer-dispatcher.js'

function makeTargets(dir) {
  return {
    claude: {
      claudeJsonPath: join(dir, 'claude.json'),
      skillsDir: join(dir, 'claude-skills'),
    },
    codex: {
      configTomlPath: join(dir, 'codex.toml'),
      skillsDir: join(dir, 'codex-skills'),
    },
    cursor: {
      mcpJsonPath: join(dir, 'cursor-mcp.json'),
      rulesDir: join(dir, 'cursor-rules'),
    },
  }
}

describe('agent-installer-dispatcher', () => {
  let dir
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aq-dispatch-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('installAllAgents writes all three with port/version, returns per-target ok', () => {
    const r = installAllAgents({ port: 5677, version: '0.4.0', overrides: makeTargets(dir) })
    expect(r.results.claude.ok).toBe(true)
    expect(r.results.codex.ok).toBe(true)
    expect(r.results.cursor.ok).toBe(true)
  })

  it('installAllAgents --target claude only writes claude', () => {
    const r = installAllAgents({ port: 5677, version: '0.4.0', overrides: makeTargets(dir), only: ['claude'] })
    expect(r.results.claude.ok).toBe(true)
    expect(r.results.codex).toBeUndefined()
    expect(r.results.cursor).toBeUndefined()
  })

  it('previewAllAgents returns changes list without writing files', () => {
    const t = makeTargets(dir)
    const p = previewAllAgents({ port: 5677, version: '0.4.0', overrides: t })
    expect(p.results.claude.changes.length).toBeGreaterThan(0)
    expect(existsSync(t.claude.claudeJsonPath)).toBe(false)
  })

  it('inspectAllAgents detects drift across three targets', () => {
    const t = makeTargets(dir)
    installAllAgents({ port: 5677, version: '0.4.0', overrides: t })
    const r = inspectAllAgents({ expectedPort: 9999, overrides: t })
    expect(r.results.claude.drift).toBe(true)
    expect(r.results.codex.drift).toBe(true)
    expect(r.results.cursor.drift).toBe(true)
  })

  it('continues installing other targets when one throws', () => {
    const t = makeTargets(dir)
    // Force codex to fail by passing an invalid path that will throw on mkdir/write
    t.codex.configTomlPath = '/proc/1/should-not-exist/config.toml'  // /proc/1 exists but is non-writable
    const r = installAllAgents({ port: 5677, version: '0.4.0', overrides: t })
    expect(r.results.claude.ok).toBe(true)
    expect(r.results.codex.ok).toBe(false)
    expect(r.results.cursor.ok).toBe(true)
    expect(r.summary.failed).toEqual(['codex'])
  })
})
