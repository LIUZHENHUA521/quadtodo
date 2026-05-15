import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureFeatureFlag,
  installHooks,
  uninstallHooks,
  inspectHooks,
  deployHookScript,
  bootstrapCodexHooks,
  __test__,
} from '../src/codex-hook-installer.js'

describe('codex-hook-installer', () => {
  let dir, configPath, hooksPath, scriptPath, templatePath, markerPath
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aq-codex-hook-'))
    configPath = join(dir, 'config.toml')
    hooksPath = join(dir, 'hooks.json')
    scriptPath = join(dir, 'notify.js')
    templatePath = join(dir, 'template-notify.js')
    markerPath = join(dir, '.uninstalled')
    writeFileSync(templatePath, '#!/usr/bin/env node\n// quadtodo-hook-version: 5\n')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  describe('ensureFeatureFlag', () => {
    it('creates config.toml with [features] when missing', () => {
      const r = ensureFeatureFlag({ configPath })
      expect(r.action).toBe('created')
      const raw = readFileSync(configPath, 'utf8')
      expect(raw).toMatch(/codex_hooks\s*=\s*true/)
      expect(raw).toMatch(/\[features\]/)
    })

    it('appends [features] section to existing config.toml that lacks it', () => {
      writeFileSync(configPath, 'model = "gpt-5"\n[projects."/foo"]\ntrust_level = "trusted"\n')
      const r = ensureFeatureFlag({ configPath })
      expect(r.action).toBe('added')
      expect(r.backup).toBeTruthy()
      const raw = readFileSync(configPath, 'utf8')
      expect(raw).toMatch(/codex_hooks\s*=\s*true/)
      // 原内容仍在
      expect(raw).toMatch(/model = "gpt-5"/)
      expect(raw).toMatch(/\[projects\."\/foo"\]/)
    })

    it('noop when codex_hooks already true anywhere', () => {
      writeFileSync(configPath, 'model = "x"\n[features]\ncodex_hooks = true\n')
      const r = ensureFeatureFlag({ configPath })
      expect(r.action).toBe('already_present')
    })

    it('idempotent across runs', () => {
      ensureFeatureFlag({ configPath })
      const after1 = readFileSync(configPath, 'utf8')
      const r2 = ensureFeatureFlag({ configPath })
      expect(r2.action).toBe('already_present')
      expect(readFileSync(configPath, 'utf8')).toBe(after1)
    })
  })

  describe('installHooks', () => {
    beforeEach(() => { writeFileSync(scriptPath, '// notify') })

    it('creates hooks.json with both Stop + UserPromptSubmit', () => {
      const r = installHooks({ hooksPath, configPath, hookScriptPath: scriptPath, uninstallMarkerPath: markerPath })
      expect(r.added).toEqual(['Stop', 'UserPromptSubmit'])
      const data = JSON.parse(readFileSync(hooksPath, 'utf8'))
      expect(data.hooks.Stop).toHaveLength(1)
      expect(data.hooks.UserPromptSubmit).toHaveLength(1)
      expect(data.hooks.Stop[0]._agentquadManaged).toBe(true)
      expect(data.hooks.Stop[0].hooks[0].command).toMatch(/notify\.js stop$/)
      expect(data.hooks.UserPromptSubmit[0].hooks[0].command).toMatch(/notify\.js user-prompt-submit$/)
    })

    it('preserves user-defined hooks', () => {
      writeFileSync(hooksPath, JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo user' }] }] } }))
      installHooks({ hooksPath, configPath, hookScriptPath: scriptPath, uninstallMarkerPath: markerPath })
      const data = JSON.parse(readFileSync(hooksPath, 'utf8'))
      expect(data.hooks.Stop).toHaveLength(2)
      expect(data.hooks.Stop.find(e => e.hooks[0].command === 'echo user')).toBeTruthy()
      expect(data.hooks.Stop.find(e => e._agentquadManaged)).toBeTruthy()
    })

    it('idempotent reinstall (no duplicate managed entries)', () => {
      installHooks({ hooksPath, configPath, hookScriptPath: scriptPath, uninstallMarkerPath: markerPath })
      installHooks({ hooksPath, configPath, hookScriptPath: scriptPath, uninstallMarkerPath: markerPath })
      const data = JSON.parse(readFileSync(hooksPath, 'utf8'))
      expect(data.hooks.Stop.filter(e => e._agentquadManaged)).toHaveLength(1)
      expect(data.hooks.UserPromptSubmit.filter(e => e._agentquadManaged)).toHaveLength(1)
    })

    it('clears uninstall marker on install', () => {
      writeFileSync(markerPath, 'old')
      installHooks({ hooksPath, configPath, hookScriptPath: scriptPath, uninstallMarkerPath: markerPath, clearUninstallMarker: true })
      expect(existsSync(markerPath)).toBe(false)
    })

    it('throws when script missing', () => {
      expect(() => installHooks({ hooksPath, configPath, hookScriptPath: join(dir, 'missing.js'), uninstallMarkerPath: markerPath }))
        .toThrow(/hook script not found/)
    })
  })

  describe('uninstallHooks', () => {
    beforeEach(() => {
      writeFileSync(scriptPath, '// notify')
      installHooks({ hooksPath, configPath, hookScriptPath: scriptPath, uninstallMarkerPath: markerPath })
    })

    it('removes only _agentquadManaged entries', () => {
      const data = JSON.parse(readFileSync(hooksPath, 'utf8'))
      data.hooks.Stop.push({ matcher: '', hooks: [{ type: 'command', command: 'echo user' }] })
      writeFileSync(hooksPath, JSON.stringify(data))
      uninstallHooks({ hooksPath, uninstallMarkerPath: markerPath })
      const after = JSON.parse(readFileSync(hooksPath, 'utf8'))
      expect(after.hooks.Stop).toHaveLength(1)
      expect(after.hooks.Stop[0]._agentquadManaged).toBeFalsy()
    })

    it('writes uninstall marker by default', () => {
      uninstallHooks({ hooksPath, uninstallMarkerPath: markerPath })
      expect(existsSync(markerPath)).toBe(true)
    })

    it('cleans empty hooks object', () => {
      uninstallHooks({ hooksPath, uninstallMarkerPath: markerPath })
      const after = JSON.parse(readFileSync(hooksPath, 'utf8'))
      expect(after.hooks).toBeUndefined()
    })
  })

  describe('inspectHooks', () => {
    it('returns installed=false when nothing set up', () => {
      writeFileSync(scriptPath, '// notify')
      const r = inspectHooks({ hooksPath, configPath, hookScriptPath: scriptPath })
      expect(r.installed).toBe(false)
      expect(r.featureFlagOk).toBe(false)
    })

    it('returns installed=true when fully installed', () => {
      writeFileSync(scriptPath, '// notify')
      installHooks({ hooksPath, configPath, hookScriptPath: scriptPath, uninstallMarkerPath: markerPath })
      const r = inspectHooks({ hooksPath, configPath, hookScriptPath: scriptPath })
      expect(r.installed).toBe(true)
      expect(r.eventsInstalled.sort()).toEqual(['Stop', 'UserPromptSubmit'])
      expect(r.featureFlagOk).toBe(true)
    })

    it('returns malformed error on broken hooks.json', () => {
      writeFileSync(scriptPath, '// notify')
      writeFileSync(hooksPath, '{not json')
      const r = inspectHooks({ hooksPath, configPath, hookScriptPath: scriptPath })
      expect(r.error).toBe('malformed_hooks_json')
    })
  })

  describe('deployHookScript', () => {
    it('installs on fresh machine', () => {
      const r = deployHookScript({ scriptPath, templatePath })
      expect(r.action).toBe('installed')
      expect(r.version).toBe(5)
      expect(existsSync(scriptPath)).toBe(true)
    })

    it('upgrades stale version with backup', () => {
      writeFileSync(scriptPath, '// quadtodo-hook-version: 2\n')
      const r = deployHookScript({ scriptPath, templatePath })
      expect(r.action).toBe('upgraded')
      expect(r.previousVersion).toBe(2)
      expect(r.backup).toBeTruthy()
      expect(existsSync(r.backup)).toBe(true)
    })

    it('unchanged when versions match', () => {
      writeFileSync(scriptPath, readFileSync(templatePath, 'utf8'))
      const r = deployHookScript({ scriptPath, templatePath })
      expect(r.action).toBe('unchanged')
    })
  })

  describe('bootstrapCodexHooks', () => {
    it('full happy path: deploys script + writes config + installs hooks', () => {
      const r = bootstrapCodexHooks({ hooksPath, configPath, scriptPath, templatePath, uninstallMarkerPath: markerPath })
      expect(r.skipped).toBe(false)
      expect(r.alreadyInstalled).toBe(false)
      expect(r.scriptResult.action).toBe('installed')
      expect(r.hookResult.added).toEqual(['Stop', 'UserPromptSubmit'])
      expect(readFileSync(configPath, 'utf8')).toMatch(/codex_hooks\s*=\s*true/)
    })

    it('respects uninstall marker', () => {
      writeFileSync(markerPath, 'x')
      const r = bootstrapCodexHooks({ hooksPath, configPath, scriptPath, templatePath, uninstallMarkerPath: markerPath })
      expect(r.skipped).toBe(true)
      expect(r.reason).toBe('uninstall_marker')
    })

    it('clears marker when respectUninstallMarker=false', () => {
      writeFileSync(markerPath, 'x')
      const r = bootstrapCodexHooks({ hooksPath, configPath, scriptPath, templatePath, uninstallMarkerPath: markerPath, respectUninstallMarker: false })
      expect(r.skipped).toBe(false)
      expect(r.markerCleared).toBe(true)
      expect(existsSync(markerPath)).toBe(false)
    })

    it('alreadyInstalled=true on second bootstrap', () => {
      bootstrapCodexHooks({ hooksPath, configPath, scriptPath, templatePath, uninstallMarkerPath: markerPath })
      const r2 = bootstrapCodexHooks({ hooksPath, configPath, scriptPath, templatePath, uninstallMarkerPath: markerPath })
      expect(r2.alreadyInstalled).toBe(true)
      expect(r2.hookResult).toBeNull()
    })

    it('warn-skips on malformed hooks.json', () => {
      writeFileSync(hooksPath, '{not json')
      const r = bootstrapCodexHooks({ hooksPath, configPath, scriptPath, templatePath, uninstallMarkerPath: markerPath })
      expect(r.skipped).toBe(true)
      expect(r.reason).toBe('malformed_hooks_json')
    })
  })

  it('buildHookEntry maps UserPromptSubmit → user-prompt-submit (not notification)', () => {
    const entry = __test__.buildHookEntry('UserPromptSubmit', '/tmp/x.js')
    expect(entry.hooks[0].command).toMatch(/x\.js user-prompt-submit$/)
    expect(entry.hooks[0].command).not.toMatch(/x\.js notification$/)
  })
})
