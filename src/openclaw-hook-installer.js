/**
 * Claude Code hooks 安装器：把 quadtodo 的 3 个 hook entry 合并写入
 * `~/.claude/settings.json`，不破坏用户现有 hooks 配置。
 *
 * 合并策略：
 *   - 已有 hooks.<event> 数组 → append；不删除已有 entry
 *   - quadtodo 加的 entry 用 `_quadtodoManaged: true` 字段标记，方便 uninstall
 *   - 卸载时仅删带这个标记的 entry，其他保留不动
 *   - settings.json 不存在 → 创建
 *   - settings.json 损坏 → 抛错让用户修，绝不擅自覆盖
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const QUADTODO_MANAGED_KEY = '_quadtodoManaged'
const HOOK_EVENTS = ['Stop', 'Notification', 'SessionEnd']

function defaultHookScriptPath() {
  return join(homedir(), '.quadtodo', 'claude-hooks', 'notify.js')
}

function defaultSettingsPath() {
  return join(homedir(), '.claude', 'settings.json')
}

function buildHookEntry(event, hookScriptPath) {
  // Claude Code hook 格式（参考其文档）：matchers 数组里每项有 type+command
  const eventLower = event === 'SessionEnd' ? 'session-end'
    : event === 'Notification' ? 'notification'
    : 'stop'
  return {
    matcher: '*',
    hooks: [
      {
        type: 'command',
        command: `node ${hookScriptPath} ${eventLower}`,
        [QUADTODO_MANAGED_KEY]: true,
      },
    ],
    [QUADTODO_MANAGED_KEY]: true,
  }
}

function loadSettings(path) {
  if (!existsSync(path)) return {}
  const raw = readFileSync(path, 'utf8')
  try {
    return JSON.parse(raw)
  } catch (e) {
    const err = new Error(`settings.json malformed: ${e.message}`)
    err.code = 'malformed_settings'
    err.path = path
    throw err
  }
}

function saveSettings(path, data) {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
}

function backupSettings(path) {
  if (!existsSync(path)) return null
  const bak = `${path}.bak.${Date.now()}`
  copyFileSync(path, bak)
  return bak
}

/**
 * 把 quadtodo 的 3 个 hook entry 合并到 settings.json。
 * 重复安装是幂等的：如果已经有 quadtodo-managed 同名 entry，先清掉再加，避免重复 fire。
 *
 * 返回 { settingsPath, backup, added: [event...], skipped: [event...] }
 */
export function installHooks({
  settingsPath = defaultSettingsPath(),
  hookScriptPath = defaultHookScriptPath(),
  events = HOOK_EVENTS,
} = {}) {
  if (!existsSync(hookScriptPath)) {
    const err = new Error(`hook script not found: ${hookScriptPath}`)
    err.code = 'hook_script_missing'
    throw err
  }

  const data = loadSettings(settingsPath)
  const backup = backupSettings(settingsPath)
  if (!data.hooks || typeof data.hooks !== 'object') data.hooks = {}

  const added = []
  for (const event of events) {
    if (!Array.isArray(data.hooks[event])) data.hooks[event] = []
    // 移除旧的 quadtodo-managed entry（避免重复 install 累加）
    data.hooks[event] = data.hooks[event].filter((entry) => !entry?.[QUADTODO_MANAGED_KEY])
    data.hooks[event].push(buildHookEntry(event, hookScriptPath))
    added.push(event)
  }

  saveSettings(settingsPath, data)
  return { settingsPath, backup, added, skipped: [] }
}

/**
 * 移除 quadtodo 加的所有 hook entry（按 _quadtodoManaged 标记）。
 * 不动其他 entry。
 */
export function uninstallHooks({ settingsPath = defaultSettingsPath() } = {}) {
  if (!existsSync(settingsPath)) return { settingsPath, removed: [], backup: null }

  const data = loadSettings(settingsPath)
  const backup = backupSettings(settingsPath)
  const removed = []

  if (data.hooks && typeof data.hooks === 'object') {
    for (const event of Object.keys(data.hooks)) {
      if (!Array.isArray(data.hooks[event])) continue
      const before = data.hooks[event].length
      data.hooks[event] = data.hooks[event].filter((entry) => !entry?.[QUADTODO_MANAGED_KEY])
      if (data.hooks[event].length !== before) {
        removed.push({ event, removedCount: before - data.hooks[event].length })
      }
      // 空数组干净掉
      if (data.hooks[event].length === 0) delete data.hooks[event]
    }
    if (Object.keys(data.hooks).length === 0) delete data.hooks
  }

  saveSettings(settingsPath, data)
  return { settingsPath, removed, backup }
}

/**
 * 查询当前 quadtodo hook 安装状态。返回 {installed: bool, eventsInstalled: [], settingsPath, scriptExists}
 */
export function inspectHooks({
  settingsPath = defaultSettingsPath(),
  hookScriptPath = defaultHookScriptPath(),
} = {}) {
  const scriptExists = existsSync(hookScriptPath)
  if (!existsSync(settingsPath)) {
    return { installed: false, eventsInstalled: [], settingsPath, hookScriptPath, scriptExists }
  }
  let data
  try {
    data = loadSettings(settingsPath)
  } catch (e) {
    return { installed: false, eventsInstalled: [], settingsPath, hookScriptPath, scriptExists, error: e.code }
  }
  const eventsInstalled = []
  for (const event of HOOK_EVENTS) {
    const arr = data?.hooks?.[event]
    if (!Array.isArray(arr)) continue
    if (arr.some((entry) => entry?.[QUADTODO_MANAGED_KEY])) eventsInstalled.push(event)
  }
  return {
    installed: eventsInstalled.length === HOOK_EVENTS.length,
    eventsInstalled,
    settingsPath,
    hookScriptPath,
    scriptExists,
  }
}

export const __test__ = { buildHookEntry, QUADTODO_MANAGED_KEY, HOOK_EVENTS }
