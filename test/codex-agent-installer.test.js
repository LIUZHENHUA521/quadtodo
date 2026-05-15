import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  installAgent,
  uninstallAgent,
  inspectAgent,
} from '../src/codex-agent-installer.js'

describe('codex-agent-installer', () => {
  let dir, configTomlPath, skillsDir, skillTemplatePath
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aq-codex-agent-'))
    configTomlPath = join(dir, 'config.toml')
    skillsDir = join(dir, 'skills')
    skillTemplatePath = join(dir, 'skill-template.md')
    writeFileSync(skillTemplatePath, '# fake skill\n')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('creates config.toml with marker block containing [mcp_servers.agentquad]', () => {
    const r = installAgent({ configTomlPath, skillsDir, skillTemplatePath, port: 5677, version: '0.4.0' })
    expect(r.ok).toBe(true)
    expect(r.changes).toContain('mcp_registered')
    const raw = readFileSync(configTomlPath, 'utf8')
    expect(raw).toMatch(/# <<< agentquad managed start/)
    expect(raw).toMatch(/# <<< agentquad managed end/)
    expect(raw).toMatch(/\[mcp_servers\.agentquad\]/)
    expect(raw).toMatch(/url\s*=\s*"http:\/\/127\.0\.0\.1:5677\/mcp"/)
    expect(raw).toMatch(/# agentquad-version: 0\.4\.0/)
    expect(raw).toMatch(/# agentquad-port: 5677/)
  })

  it('preserves pre-existing config content outside marker block', () => {
    writeFileSync(configTomlPath, 'model = "gpt-5"\n[features]\ncodex_hooks = true\n')
    installAgent({ configTomlPath, skillsDir, skillTemplatePath, port: 5677, version: '0.4.0' })
    const raw = readFileSync(configTomlPath, 'utf8')
    expect(raw).toMatch(/model = "gpt-5"/)
    expect(raw).toMatch(/codex_hooks = true/)
    expect(raw).toMatch(/\[mcp_servers\.agentquad\]/)
  })

  it('preserves user-written other [mcp_servers.X] outside marker', () => {
    writeFileSync(configTomlPath, '[mcp_servers.other]\nurl = "http://x"\n')
    installAgent({ configTomlPath, skillsDir, skillTemplatePath, port: 5677, version: '0.4.0' })
    const raw = readFileSync(configTomlPath, 'utf8')
    expect(raw).toMatch(/\[mcp_servers\.other\]/)
    expect(raw).toMatch(/\[mcp_servers\.agentquad\]/)
  })

  it('idempotent', () => {
    installAgent({ configTomlPath, skillsDir, skillTemplatePath, port: 5677, version: '0.4.0' })
    const a = readFileSync(configTomlPath, 'utf8')
    installAgent({ configTomlPath, skillsDir, skillTemplatePath, port: 5677, version: '0.4.0' })
    const b = readFileSync(configTomlPath, 'utf8')
    expect(b).toBe(a)
  })

  it('updates port on re-install', () => {
    installAgent({ configTomlPath, skillsDir, skillTemplatePath, port: 5677, version: '0.4.0' })
    installAgent({ configTomlPath, skillsDir, skillTemplatePath, port: 5678, version: '0.4.0' })
    const raw = readFileSync(configTomlPath, 'utf8')
    expect(raw).toMatch(/127\.0\.0\.1:5678/)
    expect(raw).not.toMatch(/127\.0\.0\.1:5677/)
  })

  it('uninstall removes only the marker block', () => {
    writeFileSync(configTomlPath, '[mcp_servers.other]\nurl = "http://x"\n')
    installAgent({ configTomlPath, skillsDir, skillTemplatePath, port: 5677, version: '0.4.0' })
    uninstallAgent({ configTomlPath, skillsDir })
    const raw = readFileSync(configTomlPath, 'utf8')
    expect(raw).not.toMatch(/\[mcp_servers\.agentquad\]/)
    expect(raw).toMatch(/\[mcp_servers\.other\]/)
  })

  it('inspect drift on port mismatch', () => {
    installAgent({ configTomlPath, skillsDir, skillTemplatePath, port: 5677, version: '0.4.0' })
    const r = inspectAgent({ configTomlPath, skillsDir, expectedPort: 9999 })
    expect(r.mcpRegistered).toBe(true)
    expect(r.drift).toBe(true)
  })
})
