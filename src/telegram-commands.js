/**
 * 构造给 Telegram 的 slash 菜单 —— Claude Code 命令 + 用户/项目/插件自定义命令。
 *
 * 来源（顺序优先）：
 *   1. src/data/claude-code-commands.json —— 内置静态清单（curated）
 *   2. ~/.claude/commands/<name>.md —— 用户全局自定义命令
 *   3. <projectRoot>/.claude/commands/<name>.md —— 项目级自定义命令
 *   4. ~/.claude/plugins/cache/<plugin>/<version>/commands/<name>.md —— 插件命令
 *
 * 后面的源会覆盖前面同名命令的 description。
 *
 * Telegram 限制（hard-fail 注册整批，否则只丢这条）：
 *   - 命令名：^[a-z][a-z0-9_]{0,31}$（**不允许连字符**）
 *   - description: 1-256 字符
 *   - 最多 100 条
 *
 * 不符合的命令会被静默过滤（warn 一行）。Claude Code 里 `install-github-app`
 * 这种带 `-` 的命令注册不进 Telegram，但用户在 PTY 直接打字仍可用。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STATIC_JSON = join(__dirname, 'data', 'claude-code-commands.json')

const TELEGRAM_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/
const MAX_DESCRIPTION = 256
const MAX_COMMANDS = 100

/** 解析 .md 文件 frontmatter 中的 description（YAML 风格 `description: ...`）。 */
function parseDescription(filePath) {
  try {
    const text = readFileSync(filePath, 'utf8')
    const m = text.match(/^---\s*\n([\s\S]*?)\n---/)
    if (!m) return null
    const fm = m[1]
    // 简单 YAML 解析：找 description: <value>，支持引号
    const dm = fm.match(/^description:\s*["']?(.+?)["']?\s*$/m)
    return dm ? dm[1].trim() : null
  } catch {
    return null
  }
}

/** 扫一个 commands 目录，返回 [{command, description, source}, ...]。 */
function scanCommandDir(dirPath, source) {
  if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) return []
  const out = []
  let entries
  try { entries = readdirSync(dirPath) } catch { return [] }
  for (const name of entries) {
    if (!name.endsWith('.md')) continue
    const cmd = basename(name, extname(name))
    const description = parseDescription(join(dirPath, name)) || `Custom command (${source})`
    out.push({ command: cmd, description, source })
  }
  return out
}

/** 找 ~/.claude/plugins/cache 里所有 plugin 的 commands/ 目录。 */
function findPluginCommandDirs() {
  const root = join(homedir(), '.claude', 'plugins', 'cache')
  if (!existsSync(root)) return []
  const dirs = []
  try {
    // 结构 cache/<owner>/<plugin>/<version>/commands
    for (const owner of readdirSync(root)) {
      const ownerDir = join(root, owner)
      if (!statSync(ownerDir).isDirectory()) continue
      for (const plugin of readdirSync(ownerDir)) {
        const pluginDir = join(ownerDir, plugin)
        if (!statSync(pluginDir).isDirectory()) continue
        for (const ver of readdirSync(pluginDir)) {
          const cmdsDir = join(pluginDir, ver, 'commands')
          if (existsSync(cmdsDir)) dirs.push({ path: cmdsDir, source: `plugin:${plugin}` })
        }
      }
    }
  } catch {}
  return dirs
}

/**
 * 装载静态 JSON 清单。
 * 容错：JSON 损坏 / 缺字段 → 返回空，让上游决定是否报错。
 */
function loadStatic() {
  try {
    const raw = readFileSync(STATIC_JSON, 'utf8')
    const j = JSON.parse(raw)
    if (Array.isArray(j?.commands)) {
      return j.commands.map((c) => ({ ...c, source: 'builtin' }))
    }
  } catch {}
  return []
}

/**
 * 构造最终 Telegram-ready 命令列表。
 * @param {object} opts
 * @param {string} opts.projectRoot - 项目根目录（用于 .claude/commands）
 * @param {object} [opts.logger]
 * @returns {{commands: Array<{command:string,description:string}>, skipped: Array<{command:string,reason:string}>}}
 */
export function buildTelegramCommands({ projectRoot = process.cwd(), logger = console } = {}) {
  const all = []
  all.push(...loadStatic())
  all.push(...scanCommandDir(join(homedir(), '.claude', 'commands'), 'user'))
  all.push(...scanCommandDir(join(projectRoot, '.claude', 'commands'), 'project'))
  for (const { path, source } of findPluginCommandDirs()) {
    all.push(...scanCommandDir(path, source))
  }

  // dedupe by name; later entries (project / plugin) win over builtin
  const map = new Map()
  for (const c of all) {
    if (!c?.command) continue
    map.set(c.command, c)
  }

  const accepted = []
  const skipped = []
  for (const c of map.values()) {
    if (!TELEGRAM_NAME_RE.test(c.command)) {
      skipped.push({ command: c.command, reason: 'invalid_name (telegram requires [a-z0-9_])' })
      continue
    }
    let desc = String(c.description || '').trim()
    if (!desc) {
      skipped.push({ command: c.command, reason: 'empty_description' })
      continue
    }
    if (desc.length > MAX_DESCRIPTION) desc = desc.slice(0, MAX_DESCRIPTION - 1) + '…'
    accepted.push({ command: c.command, description: desc })
  }

  if (accepted.length > MAX_COMMANDS) {
    skipped.push(...accepted.slice(MAX_COMMANDS).map((c) => ({ command: c.command, reason: 'over_100_limit' })))
    accepted.length = MAX_COMMANDS
  }

  if (skipped.length && logger?.warn) {
    logger.warn(`[telegram-commands] skipped ${skipped.length} command(s): ${skipped.slice(0, 6).map((s) => `${s.command}(${s.reason})`).join(', ')}${skipped.length > 6 ? '…' : ''}`)
  }
  return { commands: accepted, skipped }
}
