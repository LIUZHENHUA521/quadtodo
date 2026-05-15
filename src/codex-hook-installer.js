/**
 * OpenAI Codex CLI hooks 安装器：
 *   - 往 `~/.codex/config.toml` 末尾追加 `[features] codex_hooks = true`（若缺）
 *   - 把 hook entry 合并写入 `~/.codex/hooks.json`，不破坏用户现有 hook
 *
 * Codex 没有 SessionEnd 事件，仅装 Stop / UserPromptSubmit 两个。
 *
 * 合并策略：
 *   - 已有 hooks.<event> 数组 → append；不删除已有 entry
 *   - AgentQuad 加的 entry 用 `_agentquadManaged: true` 字段标记，方便 uninstall
 *   - 卸载时仅删带这个标记的 entry，其他保留不动
 *   - hooks.json 不存在 → 创建
 *   - hooks.json 损坏 → warn-skip 不擅自覆盖
 *
 * 启动期 bootstrap（bootstrapCodexHooks）：
 *   - 部署/升级 ~/.agentquad/codex-hooks/notify.js（带版本号比对）
 *   - 合并 hook 到 hooks.json + 写 feature flag
 *   - 用户跑过 hook uninstall → 留 .uninstalled marker，bootstrap 默认尊重
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { DEFAULT_ROOT_DIR } from './config.js'

const MANAGED_KEY = '_agentquadManaged'
const HOOK_EVENTS = ['Stop', 'UserPromptSubmit']
const HOOK_VERSION_RE = /quadtodo-hook-version:\s*(\d+)/
const FEATURE_FLAG_MARKER = '# agentquad-managed codex_hooks flag'

function defaultHookScriptPath() {
  return join(DEFAULT_ROOT_DIR, 'codex-hooks', 'notify.js')
}

function defaultConfigDir() {
  return join(homedir(), '.codex')
}

function defaultConfigTomlPath() {
  return join(defaultConfigDir(), 'config.toml')
}

function defaultHooksJsonPath() {
  return join(defaultConfigDir(), 'hooks.json')
}

function defaultTemplatePath() {
  return fileURLToPath(new URL('./templates/codex-hooks/notify.js', import.meta.url))
}

function defaultUninstallMarkerPath() {
  return join(DEFAULT_ROOT_DIR, 'codex-hooks', '.uninstalled')
}

function parseHookVersion(content) {
  if (!content) return null
  const m = content.match(HOOK_VERSION_RE)
  return m ? Number(m[1]) : 0
}

function buildHookEntry(event, hookScriptPath) {
  const eventLower = event === 'UserPromptSubmit' ? 'user-prompt-submit' : 'stop'
  return {
    matcher: '',
    hooks: [
      {
        type: 'command',
        command: `node ${hookScriptPath} ${eventLower}`,
        timeout: 30,
        [MANAGED_KEY]: true,
      },
    ],
    [MANAGED_KEY]: true,
  }
}

function loadHooksJson(path) {
  if (!existsSync(path)) return {}
  const raw = readFileSync(path, 'utf8')
  try {
    return JSON.parse(raw)
  } catch (e) {
    const err = new Error(`codex hooks.json malformed: ${e.message}`)
    err.code = 'malformed_hooks_json'
    err.path = path
    throw err
  }
}

function saveHooksJson(path, data) {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
}

function backupFile(path) {
  if (!existsSync(path)) return null
  const bak = `${path}.bak.${Date.now()}`
  copyFileSync(path, bak)
  return bak
}

/**
 * 在 config.toml 中确保 `[features] codex_hooks = true` 存在。
 * 行级别幂等：如果 file 里已经出现 `codex_hooks` 这个 key（任何位置），就不动；
 * 否则在末尾追加一个带标记注释的 [features] 段。
 *
 * 不解析 TOML、不动其它内容，避免破坏用户配置（如 [projects."..."] 列表）。
 *
 * 返回 { configPath, action: 'added' | 'already_present' | 'created', backup }
 */
export function ensureFeatureFlag({
  configPath = defaultConfigTomlPath(),
} = {}) {
  const dir = dirname(configPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  if (!existsSync(configPath)) {
    writeFileSync(
      configPath,
      `${FEATURE_FLAG_MARKER}\n[features]\ncodex_hooks = true\n`,
    )
    return { configPath, action: 'created', backup: null }
  }

  const raw = readFileSync(configPath, 'utf8')
  if (/^\s*codex_hooks\s*=\s*true/m.test(raw)) {
    return { configPath, action: 'already_present', backup: null }
  }

  const backup = backupFile(configPath)
  const sep = raw.endsWith('\n') ? '' : '\n'
  const appended = `${raw}${sep}\n${FEATURE_FLAG_MARKER}\n[features]\ncodex_hooks = true\n`
  writeFileSync(configPath, appended)
  return { configPath, action: 'added', backup }
}

/**
 * 把 AgentQuad 的 hook entry 合并到 hooks.json。幂等。
 *
 * 返回 { hooksPath, backup, added, configResult }
 */
export function installHooks({
  hooksPath = defaultHooksJsonPath(),
  configPath = defaultConfigTomlPath(),
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

  const configResult = ensureFeatureFlag({ configPath })
  const data = loadHooksJson(hooksPath)
  const backup = backupFile(hooksPath)
  if (!data.hooks || typeof data.hooks !== 'object') data.hooks = {}

  const added = []
  for (const event of events) {
    if (!Array.isArray(data.hooks[event])) data.hooks[event] = []
    data.hooks[event] = data.hooks[event].filter((entry) => !entry?.[MANAGED_KEY])
    data.hooks[event].push(buildHookEntry(event, hookScriptPath))
    added.push(event)
  }

  saveHooksJson(hooksPath, data)
  let markerCleared = false
  if (clearUninstallMarker && existsSync(uninstallMarkerPath)) {
    try { unlinkSync(uninstallMarkerPath); markerCleared = true } catch { /* ignore */ }
  }
  return { hooksPath, backup, added, skipped: [], configResult, markerCleared }
}

/**
 * 移除 AgentQuad 加的所有 hook entry（按 _agentquadManaged 标记）。
 * 不动用户的 feature flag（即便是我们写的也保留 — codex_hooks=true 是无害默认）。
 */
export function uninstallHooks({
  hooksPath = defaultHooksJsonPath(),
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
    } catch { /* ignore */ }
  }

  if (!existsSync(hooksPath)) {
    writeMarker()
    return { hooksPath, removed: [], backup: null, markerWritten }
  }

  const data = loadHooksJson(hooksPath)
  const backup = backupFile(hooksPath)
  const removed = []

  if (data.hooks && typeof data.hooks === 'object') {
    for (const event of Object.keys(data.hooks)) {
      if (!Array.isArray(data.hooks[event])) continue
      const before = data.hooks[event].length
      data.hooks[event] = data.hooks[event].filter((entry) => !entry?.[MANAGED_KEY])
      if (data.hooks[event].length !== before) {
        removed.push({ event, removedCount: before - data.hooks[event].length })
      }
      if (data.hooks[event].length === 0) delete data.hooks[event]
    }
    if (Object.keys(data.hooks).length === 0) delete data.hooks
  }

  saveHooksJson(hooksPath, data)
  writeMarker()
  return { hooksPath, removed, backup, markerWritten }
}

export function inspectHooks({
  hooksPath = defaultHooksJsonPath(),
  configPath = defaultConfigTomlPath(),
  hookScriptPath = defaultHookScriptPath(),
} = {}) {
  const scriptExists = existsSync(hookScriptPath)
  const featureFlagOk = existsSync(configPath)
    && /^\s*codex_hooks\s*=\s*true/m.test(readFileSync(configPath, 'utf8'))

  if (!existsSync(hooksPath)) {
    return { installed: false, eventsInstalled: [], hooksPath, hookScriptPath, scriptExists, featureFlagOk }
  }
  let data
  try {
    data = loadHooksJson(hooksPath)
  } catch (e) {
    return { installed: false, eventsInstalled: [], hooksPath, hookScriptPath, scriptExists, featureFlagOk, error: e.code }
  }
  const eventsInstalled = []
  for (const event of HOOK_EVENTS) {
    const arr = data?.hooks?.[event]
    if (!Array.isArray(arr)) continue
    if (arr.some((entry) => entry?.[MANAGED_KEY])) eventsInstalled.push(event)
  }
  return {
    installed: eventsInstalled.length === HOOK_EVENTS.length && featureFlagOk,
    eventsInstalled,
    hooksPath,
    hookScriptPath,
    scriptExists,
    featureFlagOk,
  }
}

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

export function bootstrapCodexHooks({
  hooksPath = defaultHooksJsonPath(),
  configPath = defaultConfigTomlPath(),
  scriptPath = defaultHookScriptPath(),
  templatePath = defaultTemplatePath(),
  uninstallMarkerPath = defaultUninstallMarkerPath(),
  respectUninstallMarker = true,
} = {}) {
  if (respectUninstallMarker && existsSync(uninstallMarkerPath)) {
    return { skipped: true, reason: 'uninstall_marker', uninstallMarkerPath }
  }

  let markerCleared = false
  if (!respectUninstallMarker && existsSync(uninstallMarkerPath)) {
    try { unlinkSync(uninstallMarkerPath); markerCleared = true } catch { /* ignore */ }
  }

  const scriptResult = deployHookScript({ scriptPath, templatePath })

  const inspect = inspectHooks({ hooksPath, configPath, hookScriptPath: scriptPath })
  if (inspect.error === 'malformed_hooks_json') {
    return {
      skipped: true,
      reason: 'malformed_hooks_json',
      hooksPath,
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
    hooksPath,
    configPath,
    hookScriptPath: scriptPath,
    uninstallMarkerPath,
    clearUninstallMarker: false,
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
  MANAGED_KEY,
  HOOK_EVENTS,
  parseHookVersion,
  defaultTemplatePath,
  defaultUninstallMarkerPath,
  FEATURE_FLAG_MARKER,
}
