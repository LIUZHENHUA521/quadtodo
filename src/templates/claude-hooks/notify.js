#!/usr/bin/env node
// quadtodo-hook-version: 2
/**
 * AgentQuad Claude Code hook —— 把 PTY 内 Claude Code 的状态事件转推到微信。
 *
 * 调用约定：
 *   - argv[2] = 事件名: stop | notification | session-end
 *   - stdin = Claude Code 注入的 hook payload（JSON 文本，可空）
 *   - env: QUADTODO_SESSION_ID  (空 = 非 AgentQuad 启动的 Claude Code，立刻 exit 0)
 *          QUADTODO_TARGET_USER (微信 peer id)
 *          QUADTODO_TODO_ID
 *          QUADTODO_TODO_TITLE
 *
 * 故障策略：失败一律静默。这个脚本绝不能阻塞 Claude Code。
 * - 没注 env → 仍然记日志（"no env"），exit 0
 * - AgentQuad 没起 / 网络失败 → catch 后记日志，exit 0
 * - JSON 解析失败 → 当作空 payload 继续
 *
 * Debug log: 写到 ~/.agentquad/claude-hooks/hook.log，记每次 fire。
 * 这样能 100% 区分"hook 没 fire" vs "fire 了但 AgentQuad 没收到"。
 *
 * 这个文件是模板源；安装器会拷贝到 ~/.agentquad/claude-hooks/notify.js。
 * 顶部 `quadtodo-hook-version` 行用于版本比对，升级 AgentQuad 时会自动覆盖旧脚本（带备份）。
 * 注意：脚本独立运行（不能 import config.js）。LOG_PATH 用 import.meta.url 派生，
 * 跟随脚本所在目录，自动适配 ~/.agentquad / ~/.quadtodo（legacy）。
 */
import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LOG_PATH = join(dirname(fileURLToPath(import.meta.url)), 'hook.log')

function logLine(obj) {
  try {
    appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n', 'utf8')
  } catch { /* ignore — log 失败也不能阻塞 */ }
}

const event = (process.argv[2] || 'unknown').toLowerCase()
const SESSION_ID = process.env.QUADTODO_SESSION_ID
if (!SESSION_ID) {
  logLine({ event, status: 'skipped_no_env', argv: process.argv.slice(2) })
  process.exit(0)
}

const QUADTODO_URL = process.env.QUADTODO_URL || 'http://127.0.0.1:5677'
const ENDPOINT = `${QUADTODO_URL}/api/openclaw/hook`
logLine({ event, status: 'fired', sessionId: SESSION_ID, todoTitle: process.env.QUADTODO_TODO_TITLE })

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  raw += chunk
  // 防止超大 payload 把这个进程占内存
  if (raw.length > 64 * 1024) raw = raw.slice(0, 64 * 1024)
})
process.stdin.on('end', send)
// 没有 stdin 也要发（例如 SessionEnd 可能不带 payload）
setTimeout(() => { if (!sent) send() }, 1500).unref?.()

let sent = false
async function send() {
  if (sent) return
  sent = true

  let hookPayload = null
  if (raw.trim()) {
    try { hookPayload = JSON.parse(raw) } catch { hookPayload = { _raw: raw.slice(0, 240) } }
  }

  const body = JSON.stringify({
    event,
    sessionId: SESSION_ID,
    targetUserId: process.env.QUADTODO_TARGET_USER || null,
    todoId: process.env.QUADTODO_TODO_ID || null,
    todoTitle: process.env.QUADTODO_TODO_TITLE || null,
    hookPayload,
  })

  try {
    // 30s timeout：openclaw CLI shell-out 实测 4-6s，留足余量；
    // Claude Code 默认等 hook 60s，所以 30s 安全。
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 30_000)
    timer.unref?.()
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (res.ok) {
      const data = await res.json().catch(() => null)
      logLine({ event, status: 'sent', sessionId: SESSION_ID, action: data?.action, reason: data?.reason })
    } else {
      const text = await res.text().catch(() => '')
      logLine({ event, status: 'http_error', code: res.status, body: text.slice(0, 200) })
    }
  } catch (e) {
    logLine({ event, status: 'fetch_error', error: e?.message || String(e) })
  }
}
