import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  installHooks,
  uninstallHooks,
  inspectHooks,
  deployHookScript,
  bootstrapHooks,
  __test__ as internals,
} from '../src/openclaw-hook-installer.js'

describe('openclaw-hook-installer', () => {
  let tmp, settingsPath, hookScriptPath

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'qt-hook-installer-'))
    settingsPath = join(tmp, 'settings.json')
    hookScriptPath = join(tmp, 'notify.js')
    writeFileSync(hookScriptPath, '#!/usr/bin/env node\n')
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('installs all 3 hooks when settings.json does not exist', () => {
    const r = installHooks({ settingsPath, hookScriptPath })
    expect(r.added).toEqual(['Stop', 'Notification', 'SessionEnd'])
    expect(existsSync(settingsPath)).toBe(true)
    const data = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(data.hooks.Stop).toHaveLength(1)
    expect(data.hooks.Notification).toHaveLength(1)
    expect(data.hooks.SessionEnd).toHaveLength(1)
    // 验证 _quadtodoManaged 标记
    expect(data.hooks.Stop[0]._quadtodoManaged).toBe(true)
    expect(data.hooks.Stop[0].hooks[0].command).toContain('notify.js')
    expect(data.hooks.Stop[0].hooks[0].command).toContain('stop')
    expect(data.hooks.SessionEnd[0].hooks[0].command).toContain('session-end')
    expect(data.hooks.Notification[0].hooks[0].command).toContain('notification')
  })

  it('preserves user existing hooks when installing', () => {
    writeFileSync(settingsPath, JSON.stringify({
      env: { CUSTOM: 'x' },
      hooks: {
        Stop: [
          { matcher: '*', hooks: [{ type: 'command', command: 'echo userhook' }] },
        ],
        UserPromptSubmit: [
          { matcher: '*', hooks: [{ type: 'command', command: 'echo prompt' }] },
        ],
      },
    }, null, 2))
    installHooks({ settingsPath, hookScriptPath })
    const data = JSON.parse(readFileSync(settingsPath, 'utf8'))
    // 既有 user hook 还在
    expect(data.hooks.Stop).toHaveLength(2)
    expect(data.hooks.Stop[0].hooks[0].command).toBe('echo userhook')
    expect(data.hooks.Stop[1]._quadtodoManaged).toBe(true)
    // env 字段没动
    expect(data.env.CUSTOM).toBe('x')
    // UserPromptSubmit 没动
    expect(data.hooks.UserPromptSubmit).toHaveLength(1)
  })

  it('is idempotent — repeated install does not duplicate quadtodo entries', () => {
    installHooks({ settingsPath, hookScriptPath })
    installHooks({ settingsPath, hookScriptPath })
    installHooks({ settingsPath, hookScriptPath })
    const data = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(data.hooks.Stop).toHaveLength(1)
    expect(data.hooks.Notification).toHaveLength(1)
    expect(data.hooks.SessionEnd).toHaveLength(1)
  })

  it('creates a backup file before writing', () => {
    writeFileSync(settingsPath, JSON.stringify({ hooks: {} }))
    const r = installHooks({ settingsPath, hookScriptPath })
    expect(r.backup).toBeTruthy()
    expect(existsSync(r.backup)).toBe(true)
  })

  it('throws hook_script_missing if script does not exist', () => {
    expect(() => installHooks({ settingsPath, hookScriptPath: '/no/such/file' })).toThrow(/not found/)
  })

  it('throws on malformed JSON instead of overwriting', () => {
    writeFileSync(settingsPath, 'not valid {{{ json')
    expect(() => installHooks({ settingsPath, hookScriptPath })).toThrow(/malformed/)
    // 文件没被改
    expect(readFileSync(settingsPath, 'utf8')).toBe('not valid {{{ json')
  })

  it('uninstall removes only quadtodo entries, keeps user entries', () => {
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        Stop: [
          { matcher: '*', hooks: [{ type: 'command', command: 'echo userhook' }] },
        ],
      },
    }))
    installHooks({ settingsPath, hookScriptPath })
    const r = uninstallHooks({ settingsPath })
    const data = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(data.hooks.Stop).toHaveLength(1)
    expect(data.hooks.Stop[0].hooks[0].command).toBe('echo userhook')
    expect(data.hooks.Notification).toBeUndefined()
    expect(data.hooks.SessionEnd).toBeUndefined()
    expect(r.removed.length).toBeGreaterThan(0)
  })

  it('uninstall on empty / non-existent settings is a no-op', () => {
    const r = uninstallHooks({ settingsPath })
    expect(r.removed).toEqual([])
  })

  it('inspect returns installed:false on fresh state', () => {
    const r = inspectHooks({ settingsPath, hookScriptPath })
    expect(r.installed).toBe(false)
    expect(r.eventsInstalled).toEqual([])
    expect(r.scriptExists).toBe(true)
  })

  it('inspect returns installed:true after install', () => {
    installHooks({ settingsPath, hookScriptPath })
    const r = inspectHooks({ settingsPath, hookScriptPath })
    expect(r.installed).toBe(true)
    expect(r.eventsInstalled.sort()).toEqual(['Notification', 'SessionEnd', 'Stop'])
  })

  it('inspect catches malformed JSON', () => {
    writeFileSync(settingsPath, 'broken {{')
    const r = inspectHooks({ settingsPath, hookScriptPath })
    expect(r.installed).toBe(false)
    expect(r.error).toBe('malformed_settings')
  })

  it('buildHookEntry maps event names to lowercased dashed forms', () => {
    expect(internals.buildHookEntry('Stop', '/tmp/x.js').hooks[0].command).toMatch(/stop$/)
    expect(internals.buildHookEntry('Notification', '/tmp/x.js').hooks[0].command).toMatch(/notification$/)
    expect(internals.buildHookEntry('SessionEnd', '/tmp/x.js').hooks[0].command).toMatch(/session-end$/)
  })

  it('install clears uninstall marker', () => {
    const markerPath = join(tmp, '.uninstalled')
    writeFileSync(markerPath, 'rejected\n')
    const r = installHooks({ settingsPath, hookScriptPath, uninstallMarkerPath: markerPath })
    expect(r.markerCleared).toBe(true)
    expect(existsSync(markerPath)).toBe(false)
  })

  it('uninstall writes marker by default', () => {
    const markerPath = join(tmp, '.uninstalled')
    installHooks({ settingsPath, hookScriptPath, uninstallMarkerPath: markerPath })
    const r = uninstallHooks({ settingsPath, uninstallMarkerPath: markerPath })
    expect(r.markerWritten).toBe(true)
    expect(existsSync(markerPath)).toBe(true)
  })

  it('uninstall with writeUninstallMarker=false skips marker', () => {
    const markerPath = join(tmp, '.uninstalled')
    installHooks({ settingsPath, hookScriptPath, uninstallMarkerPath: markerPath })
    const r = uninstallHooks({ settingsPath, uninstallMarkerPath: markerPath, writeUninstallMarker: false })
    expect(r.markerWritten).toBe(false)
    expect(existsSync(markerPath)).toBe(false)
  })

  it('uninstall on missing settings still writes marker', () => {
    const markerPath = join(tmp, '.uninstalled')
    const r = uninstallHooks({ settingsPath, uninstallMarkerPath: markerPath })
    expect(r.markerWritten).toBe(true)
    expect(existsSync(markerPath)).toBe(true)
  })
})

describe('deployHookScript', () => {
  let tmp, scriptPath, templatePath

  const TEMPLATE_V1 = '#!/usr/bin/env node\n// quadtodo-hook-version: 1\nconsole.log("v1")\n'
  const TEMPLATE_V2 = '#!/usr/bin/env node\n// quadtodo-hook-version: 2\nconsole.log("v2")\n'

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'qt-deploy-'))
    scriptPath = join(tmp, 'sub', 'notify.js')
    templatePath = join(tmp, 'template.js')
    writeFileSync(templatePath, TEMPLATE_V1)
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('installs script when target missing (and creates parent dir)', () => {
    const r = deployHookScript({ scriptPath, templatePath })
    expect(r.action).toBe('installed')
    expect(r.version).toBe(1)
    expect(r.previousVersion).toBeNull()
    expect(r.backup).toBeNull()
    expect(readFileSync(scriptPath, 'utf8')).toBe(TEMPLATE_V1)
  })

  it('returns unchanged when versions match', () => {
    deployHookScript({ scriptPath, templatePath })
    const r = deployHookScript({ scriptPath, templatePath })
    expect(r.action).toBe('unchanged')
    expect(r.previousVersion).toBe(1)
    expect(r.backup).toBeNull()
  })

  it('upgrades and backs up when template version is higher', () => {
    deployHookScript({ scriptPath, templatePath })
    writeFileSync(templatePath, TEMPLATE_V2)
    const r = deployHookScript({ scriptPath, templatePath })
    expect(r.action).toBe('upgraded')
    expect(r.previousVersion).toBe(1)
    expect(r.version).toBe(2)
    expect(r.backup).toBeTruthy()
    expect(existsSync(r.backup)).toBe(true)
    expect(readFileSync(r.backup, 'utf8')).toBe(TEMPLATE_V1)
    expect(readFileSync(scriptPath, 'utf8')).toBe(TEMPLATE_V2)
  })

  it('treats unversioned legacy script as v0 and upgrades', () => {
    mkdirSync(join(tmp, 'sub'), { recursive: true })
    writeFileSync(scriptPath, '#!/usr/bin/env node\nconsole.log("legacy")\n')
    const r = deployHookScript({ scriptPath, templatePath })
    expect(r.action).toBe('upgraded')
    expect(r.previousVersion).toBe(0)
    expect(r.version).toBe(1)
    expect(r.backup).toBeTruthy()
  })

  it('throws hook_template_missing when template absent', () => {
    expect(() => deployHookScript({ scriptPath, templatePath: '/no/such/template.js' }))
      .toThrow(/template not found/)
  })

  it('parseHookVersion handles empty / unversioned / v3 inputs', () => {
    const { parseHookVersion } = internals
    expect(parseHookVersion(null)).toBeNull()
    expect(parseHookVersion('')).toBeNull()
    expect(parseHookVersion('// no version\nconsole.log(1)')).toBe(0)
    expect(parseHookVersion('// quadtodo-hook-version: 3')).toBe(3)
  })
})

describe('bootstrapHooks', () => {
  let tmp, settingsPath, scriptPath, templatePath, markerPath
  const TEMPLATE = '#!/usr/bin/env node\n// quadtodo-hook-version: 1\n'

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'qt-bootstrap-'))
    settingsPath = join(tmp, 'settings.json')
    scriptPath = join(tmp, 'claude-hooks', 'notify.js')
    templatePath = join(tmp, 'template.js')
    markerPath = join(tmp, 'claude-hooks', '.uninstalled')
    writeFileSync(templatePath, TEMPLATE)
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('full bootstrap on fresh state: deploys script + installs hooks', () => {
    const r = bootstrapHooks({ settingsPath, scriptPath, templatePath, uninstallMarkerPath: markerPath })
    expect(r.skipped).toBe(false)
    expect(r.alreadyInstalled).toBe(false)
    expect(r.scriptResult.action).toBe('installed')
    expect(r.hookResult).toBeTruthy()
    expect(r.hookResult.added).toEqual(['Stop', 'Notification', 'SessionEnd'])
    expect(existsSync(scriptPath)).toBe(true)
    const data = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(data.hooks.Stop).toHaveLength(1)
  })

  it('idempotent: second call leaves alreadyInstalled=true and does not rewrite settings', () => {
    bootstrapHooks({ settingsPath, scriptPath, templatePath, uninstallMarkerPath: markerPath })
    const beforeMtime = readFileSync(settingsPath, 'utf8')
    const r = bootstrapHooks({ settingsPath, scriptPath, templatePath, uninstallMarkerPath: markerPath })
    expect(r.alreadyInstalled).toBe(true)
    expect(r.hookResult).toBeNull()
    expect(r.scriptResult.action).toBe('unchanged')
    expect(readFileSync(settingsPath, 'utf8')).toBe(beforeMtime)
  })

  it('respects uninstall marker by default', () => {
    mkdirSync(join(tmp, 'claude-hooks'), { recursive: true })
    writeFileSync(markerPath, 'rejected\n')
    const r = bootstrapHooks({ settingsPath, scriptPath, templatePath, uninstallMarkerPath: markerPath })
    expect(r.skipped).toBe(true)
    expect(r.reason).toBe('uninstall_marker')
    expect(existsSync(scriptPath)).toBe(false)
    expect(existsSync(settingsPath)).toBe(false)
  })

  it('respectUninstallMarker=false ignores marker and clears it', () => {
    mkdirSync(join(tmp, 'claude-hooks'), { recursive: true })
    writeFileSync(markerPath, 'rejected\n')
    const r = bootstrapHooks({
      settingsPath, scriptPath, templatePath, uninstallMarkerPath: markerPath,
      respectUninstallMarker: false,
    })
    expect(r.skipped).toBe(false)
    expect(r.markerCleared).toBe(true)
    expect(existsSync(markerPath)).toBe(false)
    expect(existsSync(scriptPath)).toBe(true)
  })

  it('warn-skips on malformed settings (does not throw, deploys script anyway)', () => {
    writeFileSync(settingsPath, 'not valid {{{')
    const r = bootstrapHooks({ settingsPath, scriptPath, templatePath, uninstallMarkerPath: markerPath })
    expect(r.skipped).toBe(true)
    expect(r.reason).toBe('malformed_settings')
    expect(r.scriptResult.action).toBe('installed') // 脚本仍部署，方便用户修好 settings 后立即可用
    // 损坏的 settings.json 没被覆盖
    expect(readFileSync(settingsPath, 'utf8')).toBe('not valid {{{')
  })

  it('after manual uninstall marker, regular start (respectUninstallMarker=true) leaves prior install intact', () => {
    // 第一次正常 bootstrap
    bootstrapHooks({ settingsPath, scriptPath, templatePath, uninstallMarkerPath: markerPath })
    // 用户 uninstall（写了 marker）
    uninstallHooks({ settingsPath, uninstallMarkerPath: markerPath })
    expect(existsSync(markerPath)).toBe(true)
    // 下次 start: 尊重 marker
    const r = bootstrapHooks({ settingsPath, scriptPath, templatePath, uninstallMarkerPath: markerPath })
    expect(r.skipped).toBe(true)
    expect(r.reason).toBe('uninstall_marker')
    // settings.json 里 quadtodo entry 还是空的
    const data = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(data.hooks?.Stop).toBeUndefined()
  })
})
