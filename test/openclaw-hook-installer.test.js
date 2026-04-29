import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  installHooks,
  uninstallHooks,
  inspectHooks,
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
})
