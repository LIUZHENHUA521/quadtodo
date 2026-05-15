import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  installAgent,
  uninstallAgent,
  inspectAgent,
} from '../src/cursor-agent-installer.js'

describe('cursor-agent-installer', () => {
  let dir, mcpJsonPath, rulesDir, mdcTemplatePath
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aq-cursor-agent-'))
    mcpJsonPath = join(dir, 'mcp.json')
    rulesDir = join(dir, 'rules')
    mdcTemplatePath = join(dir, 'rule-template.mdc')
    writeFileSync(mdcTemplatePath, '---\ndescription: fake\nalwaysApply: false\n---\n# rule\n')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('creates ~/.cursor/mcp.json with mcpServers.agentquad + marker', () => {
    const r = installAgent({ mcpJsonPath, rulesDir, mdcTemplatePath, port: 5677, version: '0.4.0' })
    expect(r.ok).toBe(true)
    expect(r.changes).toContain('mcp_registered')
    const j = JSON.parse(readFileSync(mcpJsonPath, 'utf8'))
    expect(j.mcpServers.agentquad.url).toBe('http://127.0.0.1:5677/mcp')
    expect(j._agentquadManaged.version).toBe('0.4.0')
  })

  it('writes rule file to rulesDir/agentquad.mdc', () => {
    installAgent({ mcpJsonPath, rulesDir, mdcTemplatePath, port: 5677, version: '0.4.0' })
    expect(existsSync(join(rulesDir, 'agentquad.mdc'))).toBe(true)
  })

  it('preserves user-defined mcpServers entries', () => {
    writeFileSync(mcpJsonPath, JSON.stringify({ mcpServers: { other: { url: 'http://x' } } }))
    installAgent({ mcpJsonPath, rulesDir, mdcTemplatePath, port: 5677, version: '0.4.0' })
    const j = JSON.parse(readFileSync(mcpJsonPath, 'utf8'))
    expect(j.mcpServers.other.url).toBe('http://x')
  })

  it('uninstall removes only agentquad entries and rule', () => {
    writeFileSync(mcpJsonPath, JSON.stringify({ mcpServers: { other: { url: 'http://x' } } }))
    installAgent({ mcpJsonPath, rulesDir, mdcTemplatePath, port: 5677, version: '0.4.0' })
    uninstallAgent({ mcpJsonPath, rulesDir })
    const j = JSON.parse(readFileSync(mcpJsonPath, 'utf8'))
    expect(j.mcpServers.agentquad).toBeUndefined()
    expect(j.mcpServers.other.url).toBe('http://x')
    expect(existsSync(join(rulesDir, 'agentquad.mdc'))).toBe(false)
  })

  it('uninstall on a file with no agentquad entries does not rewrite it', () => {
    const original = JSON.stringify({ mcpServers: { other: { url: 'http://x' } }, foo: 'bar' })
    writeFileSync(mcpJsonPath, original)
    uninstallAgent({ mcpJsonPath, rulesDir })
    expect(readFileSync(mcpJsonPath, 'utf8')).toBe(original)
  })

  it('inspect drift on port mismatch', () => {
    installAgent({ mcpJsonPath, rulesDir, mdcTemplatePath, port: 5677, version: '0.4.0' })
    const r = inspectAgent({ mcpJsonPath, rulesDir, expectedPort: 9999 })
    expect(r.drift).toBe(true)
    // expectedPort omitted → no drift
    const r2 = inspectAgent({ mcpJsonPath, rulesDir })
    expect(r2.drift).toBe(false)
  })
})
