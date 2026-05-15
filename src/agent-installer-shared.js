/**
 * 三家 agent installer 共享工具：
 *   - marker 元数据（_agentquadManaged 旁路键）
 *   - atomic JSON 写入（O_EXCL + rename）
 *   - 运行时 MCP 配置文件读写（spec C 方案）
 *
 * Marker 约定：JSON 文件里和 mcpServers.agentquad 同级放：
 *   { _agentquadManaged: { version, port, generatedAt } }
 * 不引入独立 lockfile，跟现有 hook installer 风格保持一致。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, fstatSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

export function buildMarker({ version, port }) {
  return {
    version: String(version || ''),
    port: Number(port) || 0,
    generatedAt: new Date().toISOString(),
  }
}

export function isAgentquadManaged(entry) {
  if (!entry || typeof entry !== 'object') return false
  const m = entry._agentquadManaged
  return !!(m && typeof m === 'object' && typeof m.version === 'string')
}

/**
 * Atomic JSON 写入。
 * 通过 `<target>.tmp.<rand>` 中转 + rename，保证不出现部分写入。
 */
export function writeJsonAtomic(targetPath, value) {
  mkdirSync(dirname(targetPath), { recursive: true })
  const tmp = `${targetPath}.tmp.${randomBytes(4).toString('hex')}`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8' })
  renameSync(tmp, targetPath)
}

/**
 * 运行时 MCP 配置文件（C 方案）。
 *   - tool=claude → JSON 格式（claude --mcp-config 接受 JSON）
 *   - tool=codex  → TOML 格式
 * 路径：<runtimeDir>/mcp-<sessionId>.{json|toml}
 */
export function writeRuntimeMcpConfig({ runtimeDir, sessionId, port, tool }) {
  mkdirSync(runtimeDir, { recursive: true })
  const url = `http://127.0.0.1:${port}/mcp`
  if (tool === 'codex') {
    const path = join(runtimeDir, `mcp-${sessionId}.toml`)
    const toml = `# agentquad runtime mcp config — auto generated, do not edit\n` +
      `[mcp_servers.agentquad]\n` +
      `url = "${url}"\n` +
      `transport = "http"\n`
    writeFileSync(path, toml, 'utf8')
    return { path, format: 'toml' }
  }
  // default: claude json format
  const path = join(runtimeDir, `mcp-${sessionId}.json`)
  writeJsonAtomic(path, {
    mcpServers: {
      agentquad: {
        url,
        transport: 'http',
      },
    },
  })
  return { path, format: 'json' }
}

export function cleanupRuntimeMcpConfig({ runtimeDir, sessionId }) {
  for (const ext of ['json', 'toml']) {
    const p = join(runtimeDir, `mcp-${sessionId}.${ext}`)
    try { if (existsSync(p)) unlinkSync(p) } catch { /* swallow */ }
  }
}

/**
 * 给 doctor / dispatcher 用：扫 runtimeDir，列出过去 maxAgeMs 没刷新的孤儿。
 */
export function listStaleRuntimeConfigs({ runtimeDir, maxAgeMs = 24 * 3600 * 1000 } = {}) {
  if (!existsSync(runtimeDir)) return []
  const now = Date.now()
  return readdirSync(runtimeDir)
    .filter(n => /^mcp-.*\.(json|toml)$/.test(n))
    .map(n => ({ name: n, path: join(runtimeDir, n), age: now - statSync(join(runtimeDir, n)).mtimeMs }))
    .filter(x => x.age > maxAgeMs)
}
