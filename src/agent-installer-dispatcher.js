/**
 * 三家 agent installer 统一分发：
 *   - install / uninstall / inspect / preview
 *   - 单个 target 失败不阻断其它
 *   - overrides 注入测试用路径
 */
import * as claudeInst from './claude-agent-installer.js'
import * as codexInst from './codex-agent-installer.js'
import * as cursorInst from './cursor-agent-installer.js'

const TARGETS = ['claude', 'codex', 'cursor']

function targetMod(name) {
  if (name === 'claude') return claudeInst
  if (name === 'codex') return codexInst
  if (name === 'cursor') return cursorInst
  throw new Error('unknown_target:' + name)
}

function pickTargets(only) {
  if (!only) return TARGETS
  return TARGETS.filter(t => only.includes(t))
}

export function installAllAgents({ port, version, only = null, overrides = {} } = {}) {
  const results = {}
  const failed = []
  for (const t of pickTargets(only)) {
    const args = { port, version, ...(overrides[t] || {}) }
    try {
      results[t] = targetMod(t).installAgent(args)
    } catch (e) {
      results[t] = { ok: false, error: e?.message || String(e) }
      failed.push(t)
    }
  }
  return { results, summary: { failed } }
}

export function uninstallAllAgents({ only = null, overrides = {} } = {}) {
  const results = {}
  const failed = []
  for (const t of pickTargets(only)) {
    try {
      results[t] = targetMod(t).uninstallAgent(overrides[t] || {})
    } catch (e) {
      results[t] = { ok: false, error: e?.message || String(e) }
      failed.push(t)
    }
  }
  return { results, summary: { failed } }
}

export function inspectAllAgents({ expectedPort = null, overrides = {} } = {}) {
  const results = {}
  for (const t of TARGETS) {
    results[t] = targetMod(t).inspectAgent({ expectedPort, ...(overrides[t] || {}) })
  }
  return { results }
}

export function previewAllAgents({ port, version, only = null, overrides = {} } = {}) {
  // 干跑：先 inspect 看现状，再算出"如果 install 会做什么"
  const results = {}
  for (const t of pickTargets(only)) {
    const ins = targetMod(t).inspectAgent({ expectedPort: port, ...(overrides[t] || {}) })
    const changes = []
    if (!ins.mcpRegistered) changes.push('mcp_registered')
    else if (ins.drift) changes.push('mcp_port_update')
    else if (ins.version !== version) changes.push('mcp_version_update')
    if (!ins.skillPresent) changes.push(t === 'cursor' ? 'rule_installed' : 'skill_installed')
    results[t] = { changes }
  }
  return { results }
}
