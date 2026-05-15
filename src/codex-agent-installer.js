/**
 * Codex agent installer：
 *   - 写 ~/.codex/config.toml 的 [mcp_servers.agentquad] 表（marker 注释包起来）
 *   - 装 ~/.codex/skills/agentquad-child/SKILL.md
 *
 * marker 实现：TOML 文件支持注释，用 `# <<< agentquad managed start ... # >>> end` 注释行
 * 包裹一段以 newline 分隔的 toml block；卸载时按注释边界精确删。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const SKILL_NAME = 'agentquad-child'
const MARKER_START = '# <<< agentquad managed start — do not edit by hand >>>'
const MARKER_END = '# <<< agentquad managed end >>>'

function defaultConfigTomlPath() {
  return join(homedir(), '.codex', 'config.toml')
}

function defaultSkillsDir() {
  return join(homedir(), '.codex', 'skills')
}

function defaultSkillTemplatePath() {
  return fileURLToPath(new URL('./templates/agent-skills/agentquad-child.skill.md', import.meta.url))
}

function buildBlock({ port, version }) {
  return [
    MARKER_START,
    `# agentquad-version: ${version}`,
    `# agentquad-port: ${port}`,
    `# agentquad-generated-at: ${new Date().toISOString()}`,
    '[mcp_servers.agentquad]',
    `url = "http://127.0.0.1:${port}/mcp"`,
    'transport = "http"',
    MARKER_END,
    '',
  ].join('\n')
}

function stripExistingBlock(raw) {
  const startIdx = raw.indexOf(MARKER_START)
  if (startIdx === -1) return { raw, found: false }
  const endIdx = raw.indexOf(MARKER_END, startIdx)
  if (endIdx === -1) return { raw, found: false }
  const afterEnd = raw.indexOf('\n', endIdx)
  const head = raw.slice(0, startIdx).replace(/\n*$/, '\n')
  const tail = afterEnd === -1 ? '' : raw.slice(afterEnd + 1)
  return { raw: head + tail, found: true }
}

function parseExistingBlock(raw) {
  const startIdx = raw.indexOf(MARKER_START)
  if (startIdx === -1) return null
  const endIdx = raw.indexOf(MARKER_END, startIdx)
  if (endIdx === -1) return null
  const block = raw.slice(startIdx, endIdx + MARKER_END.length)
  const versionM = block.match(/# agentquad-version:\s*(\S+)/)
  const portM = block.match(/# agentquad-port:\s*(\d+)/)
  const urlM = block.match(/url\s*=\s*"http:\/\/[^"]*:(\d+)\//)
  return {
    version: versionM ? versionM[1] : null,
    port: portM ? Number(portM[1]) : null,
    urlPort: urlM ? Number(urlM[1]) : null,
  }
}

export function installAgent({
  configTomlPath = defaultConfigTomlPath(),
  skillsDir = defaultSkillsDir(),
  skillTemplatePath = defaultSkillTemplatePath(),
  port,
  version,
} = {}) {
  if (!port) throw new Error('port_required')
  if (!version) throw new Error('version_required')

  const changes = []
  const cur = existsSync(configTomlPath) ? readFileSync(configTomlPath, 'utf8') : ''
  const existing = parseExistingBlock(cur)
  const sameAll = existing && existing.version === version && existing.port === port

  let next
  if (sameAll) {
    // idempotent — 不动文件，保留原 generatedAt
    next = cur
  } else {
    const { raw: stripped } = stripExistingBlock(cur)
    const block = buildBlock({ port, version })
    const sep = stripped && !stripped.endsWith('\n') ? '\n' : ''
    next = stripped + sep + block
    changes.push('mcp_registered')
  }

  if (next !== cur) {
    mkdirSync(dirname(configTomlPath), { recursive: true })
    writeFileSync(configTomlPath, next, 'utf8')
  }

  // skill
  const skillDir = join(skillsDir, SKILL_NAME)
  const skillFile = join(skillDir, 'SKILL.md')
  if (!existsSync(skillFile) || readFileSync(skillFile, 'utf8') !== readFileSync(skillTemplatePath, 'utf8')) {
    mkdirSync(skillDir, { recursive: true })
    copyFileSync(skillTemplatePath, skillFile)
    changes.push('skill_installed')
  }

  return { ok: true, changes, configPath: configTomlPath, skillPath: skillFile }
}

export function uninstallAgent({
  configTomlPath = defaultConfigTomlPath(),
  skillsDir = defaultSkillsDir(),
} = {}) {
  const removed = []
  if (existsSync(configTomlPath)) {
    const cur = readFileSync(configTomlPath, 'utf8')
    const { raw, found } = stripExistingBlock(cur)
    if (found) {
      writeFileSync(configTomlPath, raw, 'utf8')
      removed.push('mcp_block')
    }
  }
  const skillDir = join(skillsDir, SKILL_NAME)
  if (existsSync(skillDir)) {
    rmSync(skillDir, { recursive: true, force: true })
    removed.push('skill')
  }
  return { ok: true, removed }
}

export function inspectAgent({
  configTomlPath = defaultConfigTomlPath(),
  skillsDir = defaultSkillsDir(),
  expectedPort = null,
} = {}) {
  const out = {
    target: 'codex',
    mcpRegistered: false,
    skillPresent: false,
    drift: false,
    configPath: configTomlPath,
    expectedPort,
    actualPort: null,
    version: null,
  }
  if (existsSync(configTomlPath)) {
    const cur = readFileSync(configTomlPath, 'utf8')
    const parsed = parseExistingBlock(cur)
    if (parsed) {
      out.mcpRegistered = true
      out.actualPort = parsed.port
      out.version = parsed.version
    }
  }
  if (existsSync(join(skillsDir, SKILL_NAME, 'SKILL.md'))) out.skillPresent = true
  if (out.mcpRegistered && expectedPort && out.actualPort !== expectedPort) out.drift = true
  return out
}
