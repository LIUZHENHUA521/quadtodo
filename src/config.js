import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execSync } from 'node:child_process'

export const DEFAULT_ROOT_DIR = join(homedir(), '.quadtodo')

function detectBinary(name) {
  try {
    const result = execSync(`command -v ${name}`, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' })
    return result.trim() || name
  } catch {
    return name
  }
}

function defaultConfig() {
  return {
    port: 5677,
    defaultTool: 'claude',
    defaultCwd: homedir(),
    tools: {
      claude: { bin: detectBinary('claude'), args: [] },
      codex: { bin: detectBinary('codex'), args: [] },
    },
  }
}

function ensureRoot(rootDir) {
  if (!existsSync(rootDir)) mkdirSync(rootDir, { recursive: true })
  const logsDir = join(rootDir, 'logs')
  if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true })
}

export function loadConfig({ rootDir = DEFAULT_ROOT_DIR } = {}) {
  ensureRoot(rootDir)
  const file = join(rootDir, 'config.json')
  if (!existsSync(file)) {
    const cfg = defaultConfig()
    writeFileSync(file, JSON.stringify(cfg, null, 2))
    return cfg
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    const backup = file + '.corrupt'
    renameSync(file, backup)
    const cfg = defaultConfig()
    writeFileSync(file, JSON.stringify(cfg, null, 2))
    return cfg
  }
}

export function saveConfig(cfg, { rootDir = DEFAULT_ROOT_DIR } = {}) {
  ensureRoot(rootDir)
  writeFileSync(join(rootDir, 'config.json'), JSON.stringify(cfg, null, 2))
}

export function getConfigValue(path, { rootDir = DEFAULT_ROOT_DIR } = {}) {
  const cfg = loadConfig({ rootDir })
  return path.split('.').reduce((obj, key) => (obj == null ? undefined : obj[key]), cfg)
}

export function setConfigValue(path, value, { rootDir = DEFAULT_ROOT_DIR } = {}) {
  const cfg = loadConfig({ rootDir })
  const keys = path.split('.')
  let obj = cfg
  for (let i = 0; i < keys.length - 1; i++) {
    if (obj[keys[i]] == null || typeof obj[keys[i]] !== 'object') obj[keys[i]] = {}
    obj = obj[keys[i]]
  }
  // 尝试把字符串转成合适类型（数字、布尔）
  let v = value
  if (typeof value === 'string') {
    if (value === 'true') v = true
    else if (value === 'false') v = false
    else if (/^-?\d+(\.\d+)?$/.test(value)) v = Number(value)
  }
  obj[keys[keys.length - 1]] = v
  saveConfig(cfg, { rootDir })
  return v
}
