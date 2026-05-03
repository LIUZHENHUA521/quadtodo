#!/usr/bin/env node
/**
 * 把 Claude Code 的 slash 命令注册到 Telegram supergroup 的 per-chat 菜单。
 *
 * 用法：
 *   npm run telegram:setup-menu     # 注册（用 src/data/claude-code-commands.json + 自定义 commands/）
 *   npm run telegram:clear-menu     # 清空
 *
 * 读取：
 *   - bot token：~/.openclaw/openclaw.json → channels.telegram.botToken（fallback ~/.quadtodo/config.json → telegram.botToken）
 *   - supergroup id：~/.quadtodo/config.json → telegram.defaultSupergroupId（fallback allowedChatIds[0]）
 *
 * Per-chat scope：只影响这个 supergroup（含其下所有 topic），不动 bot 在私聊 / 别群的菜单。
 */
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { buildTelegramCommands } from '../src/telegram-commands.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')

const CLEAR = process.argv.includes('--clear')

function readConfig() {
  const path = join(homedir(), '.quadtodo', 'config.json')
  if (!existsSync(path)) return {}
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return {} }
}

function readBotToken(cfg) {
  if (cfg?.telegram?.botToken) return cfg.telegram.botToken
  const ocPath = join(homedir(), '.openclaw', 'openclaw.json')
  if (existsSync(ocPath)) {
    try {
      const oc = JSON.parse(readFileSync(ocPath, 'utf8'))
      return oc?.channels?.telegram?.botToken || null
    } catch {}
  }
  return null
}

async function tgCall(token, method, params) {
  const url = `https://api.telegram.org/bot${token}/${method}`
  // 走系统 HTTPS_PROXY（与 quadtodo 一致）
  let fetchFn = fetch
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
  if (proxy) {
    try {
      const { ProxyAgent, fetch: undiciFetch } = await import('undici')
      const dispatcher = new ProxyAgent(proxy)
      fetchFn = (u, opts = {}) => undiciFetch(u, { ...opts, dispatcher })
    } catch {}
  }
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok || !data?.ok) {
    throw new Error(`telegram ${method} failed: ${data?.description || res.status}`)
  }
  return data.result
}

async function main() {
  const cfg = readConfig()
  const token = readBotToken(cfg)
  if (!token) {
    console.error('❌ no bot token found in ~/.quadtodo/config.json or ~/.openclaw/openclaw.json')
    process.exit(1)
  }
  const chatId = cfg?.telegram?.defaultSupergroupId
    || (Array.isArray(cfg?.telegram?.allowedChatIds) ? cfg.telegram.allowedChatIds[0] : null)
  if (!chatId) {
    console.error('❌ no telegram.defaultSupergroupId / allowedChatIds[0] in ~/.quadtodo/config.json')
    process.exit(1)
  }
  const scope = { type: 'chat', chat_id: Number(chatId) || chatId }

  if (CLEAR) {
    await tgCall(token, 'deleteMyCommands', { scope })
    console.log(`✅ cleared per-chat slash menu for supergroup ${chatId}`)
    return
  }

  const { commands, skipped } = buildTelegramCommands({ projectRoot: PROJECT_ROOT, logger: console })
  if (commands.length === 0) {
    console.error('❌ no commands generated; check src/data/claude-code-commands.json')
    process.exit(1)
  }
  await tgCall(token, 'setMyCommands', { commands, scope })
  console.log(`✅ registered ${commands.length} slash command(s) for supergroup ${chatId}`)
  console.log('   ' + commands.map((c) => '/' + c.command).join(' '))
  if (skipped.length) {
    console.log(`ℹ️  skipped ${skipped.length}: ${skipped.map((s) => s.command).join(', ')}`)
    console.log('   (Telegram only allows [a-z0-9_] — hyphenated commands like install-github-app cannot be registered)')
  }
}

main().catch((e) => {
  console.error('❌', e.message)
  process.exit(1)
})
