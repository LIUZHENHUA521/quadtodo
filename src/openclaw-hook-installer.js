/**
 * Claude Code hooks 安装器：把 AgentQuad 的 3 个 hook entry 合并写入
 * `~/.claude/settings.json`，不破坏用户现有 hooks 配置。
 *
 * 合并策略：
 *   - 已有 hooks.<event> 数组 → append；不删除已有 entry
 *   - AgentQuad 加的 entry 用 `_quadtodoManaged: true` 字段标记，方便 uninstall
 *   - 卸载时仅删带这个标记的 entry，其他保留不动
 *   - settings.json 不存在 → 创建
 *   - settings.json 损坏 → 抛错让用户修，绝不擅自覆盖
 *
 * 启动期 bootstrap（bootstrapHooks）：
 *   - 部署/升级 ~/.agentquad/claude-hooks/notify.js（带版本号比对）
 *   - 合并 hooks 到 settings.json（已装则 noop，避免 .bak 刷屏）
 *   - 用户跑过 uninstall-hook → 留 .uninstalled marker，bootstrap 默认尊重；
 *     `agentquad openclaw bootstrap` 显式忽略 marker 强制装回
 *   - settings.json 损坏 → warn-skip，不让 agentquad start 挂掉
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { DEFAULT_ROOT_DIR } from './config.js'

const QUADTODO_MANAGED_KEY = '_quadtodoManaged'
const HOOK_EVENTS = ['Stop', 'Notification', 'SessionEnd']
const HOOK_VERSION_RE = /quadtodo-hook-version:\s*(\d+)/

function defaultHookScriptPath() {
  return join(DEFAULT_ROOT_DIR, 'claude-hooks', 'notify.js')
}

function defaultSettingsPath() {
  return join(homedir(), '.claude', 'settings.json')
}

function defaultTemplatePath() {
  return fileURLToPath(new URL('./templates/claude-hooks/notify.js', import.meta.url))
}

function defaultUninstallMarkerPath() {
  return join(DEFAULT_ROOT_DIR, 'claude-hooks', '.uninstalled')
}

function parseHookVersion(content) {
  if (!content) return null
  const m = content.match(HOOK_VERSION_RE)
  return m ? Number(m[1]) : 0 // 0 = unversioned legacy script
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
 * 把 AgentQuad 的 3 个 hook entry 合并到 settings.json。
 * 重复安装是幂等的：如果已经有 quadtodo-managed 同名 entry，先清掉再加，避免重复 fire。
 *
 * 返回 { settingsPath, backup, added: [event...], skipped: [event...] }
 */
export function installHooks({
  settingsPath = defaultSettingsPath(),
  hookScriptPath = defaultHookScriptPath(),
  events = HOOK_EVENTS,
  uninstallMarkerPath = defaultUninstallMarkerPath(),
  clearUninstallMarker = true,
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
    // 移除旧的 _quadtodoManaged entry（避免重复 install 累加）
    data.hooks[event] = data.hooks[event].filter((entry) => !entry?.[QUADTODO_MANAGED_KEY])
    data.hooks[event].push(buildHookEntry(event, hookScriptPath))
    added.push(event)
  }

  saveSettings(settingsPath, data)
  // 用户重新装 = 收回之前的 uninstall 拒绝；下次 start 不再被 marker 拦
  let markerCleared = false
  if (clearUninstallMarker && existsSync(uninstallMarkerPath)) {
    try { unlinkSync(uninstallMarkerPath); markerCleared = true } catch { /* 不阻塞 */ }
  }
  return { settingsPath, backup, added, skipped: [], markerCleared }
}

/**
 * 移除 AgentQuad 加的所有 hook entry（按 _quadtodoManaged 标记）。
 * 不动其他 entry。默认会写一个 .uninstalled marker，让后续 `agentquad start` 自检不再回写。
 */
export function uninstallHooks({
  settingsPath = defaultSettingsPath(),
  uninstallMarkerPath = defaultUninstallMarkerPath(),
  writeUninstallMarker = true,
} = {}) {
  let markerWritten = false
  const writeMarker = () => {
    if (!writeUninstallMarker) return
    try {
      const dir = dirname(uninstallMarkerPath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(uninstallMarkerPath, `${new Date().toISOString()}\n`)
      markerWritten = true
    } catch { /* 不阻塞 */ }
  }

  if (!existsSync(settingsPath)) {
    writeMarker()
    return { settingsPath, removed: [], backup: null, markerWritten }
  }

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
  writeMarker()
  return { settingsPath, removed, backup, markerWritten }
}

/**
 * 查询当前 AgentQuad hook 安装状态。返回 {installed: bool, eventsInstalled: [], settingsPath, scriptExists}
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

/**
 * 把仓库内置的 notify.js 模板部署到 ~/.agentquad/claude-hooks/notify.js。
 *
 * 行为：
 *   - 目标不存在 → 直接写（action: 'installed'）
 *   - 目标版本 < 模板版本 → 备份旧脚本，覆盖（action: 'upgraded'）
 *   - 目标版本 = 模板版本 → 不动（action: 'unchanged'）
 *   - 目标存在但解析不出版本号 → 视为 v0，按升级路径处理（保护用户改动）
 *
 * 返回 { action, version, previousVersion, scriptPath, backup }
 */
export function deployHookScript({
  scriptPath = defaultHookScriptPath(),
  templatePath = defaultTemplatePath(),
} = {}) {
  if (!existsSync(templatePath)) {
    const err = new Error(`hook template not found: ${templatePath}`)
    err.code = 'hook_template_missing'
    throw err
  }
  const templateContent = readFileSync(templatePath, 'utf8')
  const templateVersion = parseHookVersion(templateContent)

  const dir = dirname(scriptPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const previousVersion = existsSync(scriptPath)
    ? parseHookVersion(readFileSync(scriptPath, 'utf8'))
    : null

  if (previousVersion !== null && previousVersion === templateVersion) {
    return { action: 'unchanged', version: templateVersion, previousVersion, scriptPath, backup: null }
  }

  let backup = null
  if (previousVersion !== null) {
    backup = `${scriptPath}.bak.${Date.now()}`
    copyFileSync(scriptPath, backup)
  }
  writeFileSync(scriptPath, templateContent)
  return {
    action: previousVersion === null ? 'installed' : 'upgraded',
    version: templateVersion,
    previousVersion,
    scriptPath,
    backup,
  }
}

/**
 * `agentquad start` 启动时调用：部署 notify.js + 合入 settings.json hook entry。
 *
 * 设计要点：
 *   - 已经装好（inspectHooks.installed === true）→ 不重写 settings.json，避免每次 start 都生成 .bak
 *   - settings.json 损坏 → skip + 返回 reason，让调用方 warn 而不是让启动挂掉
 *   - 用户跑过 uninstall-hook 留下 marker → respectUninstallMarker=true 时 skip
 *     `agentquad openclaw bootstrap` 子命令传 false 强装回（同时清掉 marker）
 *
 * 返回 { skipped, reason?, scriptResult, hookResult, alreadyInstalled }
 */
export function bootstrapHooks({
  settingsPath = defaultSettingsPath(),
  scriptPath = defaultHookScriptPath(),
  templatePath = defaultTemplatePath(),
  uninstallMarkerPath = defaultUninstallMarkerPath(),
  respectUninstallMarker = true,
} = {}) {
  if (respectUninstallMarker && existsSync(uninstallMarkerPath)) {
    return { skipped: true, reason: 'uninstall_marker', uninstallMarkerPath }
  }

  // 显式 bootstrap 时清掉 marker（即便文件不存在也安全）
  let markerCleared = false
  if (!respectUninstallMarker && existsSync(uninstallMarkerPath)) {
    try { unlinkSync(uninstallMarkerPath); markerCleared = true } catch { /* 不阻塞 */ }
  }

  const scriptResult = deployHookScript({ scriptPath, templatePath })

  const inspect = inspectHooks({ settingsPath, hookScriptPath: scriptPath })
  if (inspect.error === 'malformed_settings') {
    return {
      skipped: true,
      reason: 'malformed_settings',
      settingsPath,
      scriptResult,
      markerCleared,
    }
  }

  if (inspect.installed) {
    return {
      skipped: false,
      alreadyInstalled: true,
      scriptResult,
      hookResult: null,
      markerCleared,
    }
  }

  const hookResult = installHooks({
    settingsPath,
    hookScriptPath: scriptPath,
    uninstallMarkerPath,
    clearUninstallMarker: false, // 已在上面处理
  })
  return {
    skipped: false,
    alreadyInstalled: false,
    scriptResult,
    hookResult,
    markerCleared,
  }
}

export const __test__ = {
  buildHookEntry,
  QUADTODO_MANAGED_KEY,
  HOOK_EVENTS,
  parseHookVersion,
  defaultTemplatePath,
  defaultUninstallMarkerPath,
}
