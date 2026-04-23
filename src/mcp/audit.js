import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 简单的 NDJSON 审计日志：每次破坏性 MCP 工具真执行后追加一行。
 *
 * rootDir 通常是 ~/.quadtodo；文件名固定为 mcp-audit.log。
 * 调用失败（磁盘只读等）不影响主流程——静默降级。
 */
export function createAuditLog({ rootDir, filename = 'mcp-audit.log' } = {}) {
  if (!rootDir) throw new Error('rootDir_required')
  const path = join(rootDir, filename)

  function ensureDir() {
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  function append(entry) {
    try {
      ensureDir()
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        ...entry,
      }) + '\n'
      appendFileSync(path, line, 'utf8')
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e?.message }
    }
  }

  return { append, path }
}
