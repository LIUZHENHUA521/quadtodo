/**
 * Cursor agent installer：
 *   - 写 ~/.cursor/mcp.json 的 mcpServers.agentquad（带 _agentquadManaged 旁路 marker）
 *   - 装 ~/.cursor/rules/agentquad.mdc
 *
 * Cursor 不是 AgentQuad spawn 的，没有运行时注入（C），只走 B + rule。
 */
import { existsSync, mkdirSync, readFileSync, copyFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { buildMarker, isAgentquadManaged, writeJsonAtomic } from './agent-installer-shared.js'

const RULE_FILE = 'agentquad.mdc'

function defaultMcpJsonPath() {
  return join(homedir(), '.cursor', 'mcp.json')
}

function defaultRulesDir() {
  return join(homedir(), '.cursor', 'rules')
}

function defaultMdcTemplatePath() {
  return fileURLToPath(new URL('./templates/agent-skills/agentquad-child.cursor.mdc', import.meta.url))
}

function readMcpJson(path) {
  if (!existsSync(path)) return {}
  const raw = readFileSync(path, 'utf8')
  if (!raw.trim()) return {}
  try { return JSON.parse(raw) } catch (e) { throw new Error(`malformed_cursor_mcp_json: ${e.message}`) }
}

export function installAgent({
  mcpJsonPath = defaultMcpJsonPath(),
  rulesDir = defaultRulesDir(),
  mdcTemplatePath = defaultMdcTemplatePath(),
  port,
  version,
} = {}) {
  if (!port) throw new Error('port_required')
  if (!version) throw new Error('version_required')

  const changes = []
  const cur = readMcpJson(mcpJsonPath)
  cur.mcpServers = cur.mcpServers || {}

  const desired = { url: `http://127.0.0.1:${port}/mcp`, transport: 'http' }
  const prev = cur.mcpServers.agentquad
  const prevMarker = cur._agentquadManaged
  const samePort = prev && prev.url === desired.url
  const sameVersion = prevMarker && prevMarker.version === version

  cur.mcpServers.agentquad = desired
  if (samePort && sameVersion && isAgentquadManaged(cur)) {
    cur._agentquadManaged = prevMarker
  } else {
    cur._agentquadManaged = buildMarker({ version, port })
    changes.push('mcp_registered')
  }
  writeJsonAtomic(mcpJsonPath, cur)

  const ruleFile = join(rulesDir, RULE_FILE)
  if (!existsSync(ruleFile) || readFileSync(ruleFile, 'utf8') !== readFileSync(mdcTemplatePath, 'utf8')) {
    mkdirSync(rulesDir, { recursive: true })
    copyFileSync(mdcTemplatePath, ruleFile)
    changes.push('rule_installed')
  }

  return { ok: true, changes, configPath: mcpJsonPath, rulePath: ruleFile }
}

export function uninstallAgent({
  mcpJsonPath = defaultMcpJsonPath(),
  rulesDir = defaultRulesDir(),
} = {}) {
  const removed = []
  if (existsSync(mcpJsonPath)) {
    const cur = readMcpJson(mcpJsonPath)
    if (cur.mcpServers?.agentquad) {
      delete cur.mcpServers.agentquad
      removed.push('mcp_entry')
    }
    if (cur._agentquadManaged) {
      delete cur._agentquadManaged
      removed.push('marker')
    }
    if (removed.length > 0) writeJsonAtomic(mcpJsonPath, cur)
  }
  const ruleFile = join(rulesDir, RULE_FILE)
  if (existsSync(ruleFile)) {
    unlinkSync(ruleFile)
    removed.push('rule')
  }
  return { ok: true, removed }
}

export function inspectAgent({
  mcpJsonPath = defaultMcpJsonPath(),
  rulesDir = defaultRulesDir(),
  expectedPort = null,
} = {}) {
  const out = {
    target: 'cursor',
    mcpRegistered: false,
    skillPresent: false,  // rulePresent 对外仍叫 skillPresent，便于 dispatcher 统一展示
    drift: false,
    configPath: mcpJsonPath,
    expectedPort,
    actualPort: null,
    version: null,
  }
  if (existsSync(mcpJsonPath)) {
    try {
      const cur = readMcpJson(mcpJsonPath)
      if (cur.mcpServers?.agentquad?.url) {
        out.mcpRegistered = true
        const m = cur.mcpServers.agentquad.url.match(/:(\d+)\//)
        if (m) out.actualPort = Number(m[1])
        out.version = cur._agentquadManaged?.version || null
      }
    } catch { /* malformed */ }
  }
  if (existsSync(join(rulesDir, RULE_FILE))) out.skillPresent = true
  if (out.mcpRegistered && expectedPort && out.actualPort !== expectedPort) out.drift = true
  return out
}
