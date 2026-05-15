#!/usr/bin/env node
import { Command } from 'commander'
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, realpathSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { join, dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  DEFAULT_ROOT_DIR,
  loadConfig,
  saveConfig,
  getConfigValue,
  setConfigValue,
  resolveToolsConfig,
} from './config.js'
import { shouldRunWizard, runFirstRunWizard } from './first-run-wizard.js'
import updateNotifier from 'update-notifier'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Bin names verified via `npm view <pkg> bin`.
// kind:
//   - 'npm'   → installed via `npm install -g <pkg>` (claude / codex)
//   - 'shell' → installed via piping `<script>` to a shell (cursor; upstream installer)
export const TOOL_PACKAGES = {
  claude: { kind: 'npm',   pkg: '@anthropic-ai/claude-code',                   bin: 'claude'        },
  codex:  { kind: 'npm',   pkg: '@openai/codex',                               bin: 'codex'         },
  cursor: { kind: 'shell', script: 'curl https://cursor.com/install -fsSL | bash', bin: 'cursor-agent' },
}

export function planInstallTools(opts) {
  const flags = opts || {}
  const explicit = []
  if (flags.claude) explicit.push('claude')
  if (flags.codex)  explicit.push('codex')
  if (flags.cursor) explicit.push('cursor')
  if (flags.all || explicit.length === 0) return ['claude', 'codex', 'cursor']
  return explicit
}

function loadPkgVersion() {
  try {
    const pkg = JSON.parse(readFileSync(resolvePath(__dirname, '../package.json'), 'utf8'))
    return pkg.version || '0.0.0'
  } catch { return '0.0.0' }
}

function pidFile(rootDir = DEFAULT_ROOT_DIR) {
  return join(rootDir, 'agentquad.pid')
}

export function writePidFile(rootDir, { pid, port, host }) {
  const payload = { pid, port, host, startedAt: new Date().toISOString() }
  writeFileSync(pidFile(rootDir), JSON.stringify(payload))
}

export function readPidFile(rootDir) {
  const pf = pidFile(rootDir)
  if (!existsSync(pf)) return null
  let raw
  try {
    raw = readFileSync(pf, 'utf8').trim()
  } catch {
    return null
  }
  try {
    const obj = JSON.parse(raw)
    if (obj && typeof obj.pid === 'number' && obj.pid > 0) return obj
  } catch { /* legacy plain-number */ }
  const n = Number(raw)
  if (Number.isFinite(n) && n > 0) return { pid: n }
  return null
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

// Tailscale 私网段：100.64.0.0 / 10 (RFC 6598 CGNAT)
function isTailscaleIPv4(addr) {
  if (!addr || typeof addr !== 'string') return false
  const parts = addr.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127
}

// 枚举本机可用于访问的地址：区分 Tailscale / LAN / loopback。
// 返回 { tailscale: [...], lan: [...], loopback: [...] }，每项带 name + address。
export function collectReachableAddresses() {
  const out = { tailscale: [], lan: [], loopback: [] }
  const ifs = networkInterfaces()
  for (const [name, entries] of Object.entries(ifs)) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4') continue
      if (entry.internal) {
        out.loopback.push({ name, address: entry.address })
      } else if (isTailscaleIPv4(entry.address) || /tailscale|utun/i.test(name)) {
        // 兜底：macOS 下 Tailscale 通常是 utunN 接口，配合 100.x 判定更稳
        if (isTailscaleIPv4(entry.address)) {
          out.tailscale.push({ name, address: entry.address })
        } else {
          out.lan.push({ name, address: entry.address })
        }
      } else {
        out.lan.push({ name, address: entry.address })
      }
    }
  }
  return out
}

export function buildStartupBanner({ port, host, addresses = collectReachableAddresses() }) {
  const lines = []
  const url = (addr) => `http://${addr}:${port}`
  const isLoopbackOnly = host === '127.0.0.1' || host === 'localhost'

  if (isLoopbackOnly) {
    lines.push(`AgentQuad listening on ${url('127.0.0.1')}  (loopback only)`)
    lines.push('')
    lines.push('⚠️  To access from phone via Tailscale, run:')
    lines.push('     agentquad config set host 0.0.0.0')
    lines.push('   or start with:')
    lines.push('     agentquad start --expose')
  } else {
    lines.push(`AgentQuad listening on ${url(host === '0.0.0.0' || host === '::' ? 'all-interfaces' : host)}  (port ${port})`)
    lines.push('')
    lines.push('⚠️  SECURITY: AgentQuad exposes a shell + AI terminal. Reachable URLs:')
    if (addresses.tailscale.length) {
      lines.push('   Tailscale (recommended — private mesh VPN):')
      for (const item of addresses.tailscale) {
        lines.push(`     ${url(item.address)}    [${item.name}]`)
      }
      lines.push('   Tip: with MagicDNS you can also use  http://<your-mac-name>:' + port)
    } else {
      lines.push('   ❌ No Tailscale interface detected.')
      lines.push('      Install Tailscale on this Mac + your phone, sign into the same account.')
      lines.push('      Guide: docs/MOBILE.md')
    }
    if (addresses.lan.length) {
      lines.push('   LAN (same-WiFi only — anyone on the same network can reach these):')
      for (const item of addresses.lan) {
        lines.push(`     ${url(item.address)}    [${item.name}]`)
      }
    }
    lines.push('')
    lines.push('   Do NOT put this URL on the public internet without an auth layer.')
  }

  return lines.join('\n')
}

// ─── exported helpers (for tests) ───

/** Fixed list of check names — lets tests assert the structure is complete. */
export function buildDoctorChecks() {
  return [
    'rootDir exists',
    'config.json parseable',
    'better-sqlite3 loadable',
    'node-pty loadable',
    'claude binary',
    'codex binary',
    'cursor binary',
  ]
}

/**
 * Runs every check and returns a structured report.
 * @param {object} opts
 * @param {string} [opts.rootDir]  override root dir (tests use tmpdir)
 */
export async function doctorReport({ rootDir = DEFAULT_ROOT_DIR } = {}) {
  const checks = []

  checks.push({
    name: 'rootDir exists',
    ok: existsSync(rootDir) || (loadConfig({ rootDir }), true),
  })

  {
    const major = Number(process.version.slice(1).split('.')[0])
    checks.push({
      name: 'Node version',
      ok: major >= 20,
      detail: process.version + (major >= 20 ? '' : ' (please upgrade to Node 20+; e.g. `nvm install 20`)'),
    })
  }

  {
    const distIndex = resolvePath(__dirname, '../dist-web/index.html')
    const ok = existsSync(distIndex)
    checks.push({
      name: 'frontend assets',
      ok,
      detail: ok
        ? distIndex
        : `missing ${distIndex} — run \`npm run build\` (from source) or \`npm i -g agentquad\` (reinstall)`,
    })
  }

  let cfg = null
  try {
    cfg = loadConfig({ rootDir })
    checks.push({ name: 'config.json parseable', ok: true })
  } catch (e) {
    checks.push({ name: 'config.json parseable', ok: false, detail: e.message })
  }

  try {
    const { default: Database } = await import('better-sqlite3')
    const test = new Database(':memory:')
    test.prepare('SELECT 1').get()
    test.close()
    checks.push({ name: 'better-sqlite3 loadable', ok: true })
  } catch (e) {
    checks.push({ name: 'better-sqlite3 loadable', ok: false, detail: e.message })
  }

  try {
    await import('node-pty')
    checks.push({ name: 'node-pty loadable', ok: true })
  } catch (e) {
    checks.push({ name: 'node-pty loadable', ok: false, detail: e.message })
  }

  for (const tool of ['claude', 'codex', 'cursor']) {
    const bin = cfg?.tools?.[tool]?.bin || cfg?.tools?.[tool]?.command || tool
    const which = spawnSync('command', ['-v', bin], {
      encoding: 'utf8',
      shell: '/bin/sh',
    })
    const ok = which.status === 0 && which.stdout.trim().length > 0
    checks.push({
      name: `${tool} binary`,
      ok,
      detail: ok ? which.stdout.trim() : `${bin} not found in PATH`,
    })
  }

  // ─── OpenClaw 桥接（仅当启用时检查）─────────────────────
  const oc = cfg?.openclaw || {}
  if (oc.enabled) {
    // 1. openclaw CLI 可用？
    const ocCli = spawnSync('command', ['-v', 'openclaw'], {
      encoding: 'utf8',
      shell: '/bin/sh',
    })
    const ocCliOk = ocCli.status === 0 && ocCli.stdout.trim().length > 0
    checks.push({
      name: 'openclaw CLI',
      ok: ocCliOk,
      detail: ocCliOk ? ocCli.stdout.trim() : 'openclaw not in PATH (install via `npm i -g openclaw`)',
    })

    // 2. targetUserId 配置（fallback）
    // 主路径下，每个 ai-session 启动时由 OpenClaw skill 显式传 routeUserId（per-session）。
    // 这里的 targetUserId 只是 ad-hoc ask_user / 没绑 session 时的兜底。
    // 因此空值仅警告，不算 fail。
    if (oc.targetUserId) {
      checks.push({
        name: 'openclaw.targetUserId (fallback)',
        ok: true,
        detail: oc.targetUserId,
      })
    } else {
      checks.push({
        name: 'openclaw.targetUserId (fallback)',
        ok: true,
        detail: '空（per-session 路由仍可工作；如要 ad-hoc 推送，set via `agentquad config set openclaw.targetUserId <peer-id>`）',
      })
    }

    // 3. AgentQuad skill 装好了吗（OpenClaw 端配置）
    const skillFile = join(homedir(), '.openclaw', 'skills', 'agentquad-claw', 'SKILL.md')
    checks.push({
      name: 'agentquad-claw skill installed',
      ok: existsSync(skillFile),
      detail: existsSync(skillFile)
        ? skillFile
        : '缺失：参考 docs/OPENCLAW.md',
    })
    // 3b. legacy skill 目录还在？软警告（非 failing）
    const legacySkillDir = join(homedir(), '.openclaw', 'skills', 'quadtodo-claw')
    if (existsSync(legacySkillDir)) {
      checks.push({
        name: 'legacy openclaw skill folder',
        ok: true,
        detail: 'legacy ~/.openclaw/skills/quadtodo-claw/ still exists — safe to delete',
      })
    }

    // 4. （历史保留位）claude-code hook 现在挪到 oc.enabled 外面统一检查
  }

  // ─── AI CLI hooks 安装状态（claude / codex / cursor）——所有用户都看 ──
  // 不再绑定 openclaw 启用与否，因为 hook 还服务 Telegram / Lark 推送
  const HOOK_DOCTOR_TOOLS = [
    { name: 'claude-code', mod: './openclaw-hook-installer.js', flag: 'claude' },
    { name: 'codex',       mod: './codex-hook-installer.js',    flag: 'codex'  },
    { name: 'cursor',      mod: './cursor-hook-installer.js',   flag: 'cursor' },
  ]
  for (const { name, mod, flag } of HOOK_DOCTOR_TOOLS) {
    try {
      const m = await import(mod)
      const hk = m.inspectHooks()
      checks.push({
        name: `${name} hook script`,
        ok: hk.scriptExists,
        detail: hk.hookScriptPath + (hk.scriptExists ? '' : ' (missing — should be auto-installed)'),
      })
      checks.push({
        name: `${name} hooks installed`,
        ok: hk.installed,
        detail: hk.installed
          ? `events: ${hk.eventsInstalled.join(', ')}`
          : `缺失：跑 \`agentquad hook bootstrap --${flag}\` 一次`,
      })
    } catch (e) {
      checks.push({
        name: `${name} hooks`,
        ok: false,
        detail: `inspect failed: ${e.message}`,
      })
    }
  }

  // ─── Telegram 直连（仅当启用时检查）────────────────────────
  const tg = cfg?.telegram || {}
  if (tg.enabled) {
    // 5. supergroupId
    checks.push({
      name: 'telegram.supergroupId',
      ok: Boolean(tg.supergroupId),
      detail: tg.supergroupId || '未配置：第一次跑 AgentQuad 时让 bot 拿 chat.id（log 里），再 `agentquad config set telegram.supergroupId <id>`',
    })

    // 6. allowedChatIds（白名单）
    const allowList = Array.isArray(tg.allowedChatIds) ? tg.allowedChatIds : []
    checks.push({
      name: 'telegram.allowedChatIds',
      ok: allowList.length > 0,
      detail: allowList.length > 0
        ? allowList.join(', ')
        : '空 = 拒所有：跑 `agentquad config set telegram.allowedChatIds.0 <supergroup-id>`',
    })

    // 7. token（从 ~/.agentquad/config.json 读）
    try {
      const { readBotToken } = await import('./telegram-bot.js')
      const tok = readBotToken(() => cfg)
      checks.push({
        name: 'telegram bot token',
        ok: Boolean(tok),
        detail: tok ? '✓ token in ~/.agentquad/config.json' : '缺失：在 Web Settings → Telegram 里填 Bot Token，或编辑 ~/.agentquad/config.json 的 telegram.botToken',
      })
    } catch (e) {
      checks.push({ name: 'telegram bot token', ok: false, detail: e.message })
    }

    // 注：hook check 已经在 openclaw 段做过；不重复
  }

  return { ok: checks.every(c => c.ok), checks }
}

async function promptYesNo(question) {
  const readline = await import('node:readline')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (a) => {
      rl.close()
      const text = (a || '').trim().toLowerCase()
      // empty input → default Yes
      resolve(text === '' || text === 'y' || text === 'yes')
    })
  })
}

async function bootstrapAgentsIfNeeded({ cfg, version, port, isTTY }) {
  const mode = cfg?.agents?.autoBootstrap || 'prompt'
  if (mode === 'never') return
  if (cfg?.agents?.bootstrapDismissed) return

  const { previewAllAgents, installAllAgents } = await import('./agent-installer-dispatcher.js')
  const p = previewAllAgents({ port, version })
  const needed = Object.entries(p.results)
    .filter(([, v]) => (v.changes || []).length > 0)
    .map(([k]) => k)
  if (needed.length === 0) return

  if (mode === 'silent') {
    const r = installAllAgents({ port, version, only: needed })
    console.log(`[agents] auto bootstrap: ${Object.keys(r.results).join(', ')}`)
    return
  }

  if (!isTTY) {
    console.warn(`[agents] 检测到未配置的 agent 工具: ${needed.join(', ')}（运行 \`agentquad agents install\` 启用）`)
    return
  }

  // prompt mode (interactive TTY)
  const ok = await promptYesNo(`[agents] 检测到 ${needed.join(', ')} 未配置 AgentQuad MCP / skill，现在安装吗？[Y/n] `)
  if (ok) {
    const r = installAllAgents({ port, version, only: needed })
    for (const [t, res] of Object.entries(r.results)) {
      console.log(`  ${t}: ${res.ok ? (res.changes?.join(', ') || 'ok') : `error: ${res.error}`}`)
    }
  } else {
    try {
      setConfigValue('agents.bootstrapDismissed', 'true')
    } catch (e) {
      console.warn(`[agents] 持久化 dismissed 失败: ${e.message}`)
    }
    console.log('[agents] 已记住你的选择；运行 `agentquad agents install` 可手动启用')
  }
}

// runStart：start 子命令的核心实现，导出给默认 action / 首跑向导复用
export async function runStart(cmdOpts = {}) {
  // dry-run 短路（仅用于测试，让默认 action 测试不真起服务 / 不跑向导）
  if (process.env.AGENTQUAD_DRY_RUN === '1') return

  const rootDir = DEFAULT_ROOT_DIR
  const cfg = loadConfig({ rootDir })
  const defaultCwd = cmdOpts.cwd || cfg.defaultCwd || process.env.HOME || process.cwd()
  const host = cmdOpts.expose
    ? '0.0.0.0'
    : (cmdOpts.host || cfg.host || '127.0.0.1')

  // 首跑向导（命中条件才进；任何异常都不阻塞后续 start）
  try {
    const need = shouldRunWizard({
      rootDir,
      isTTY: !!process.stdin.isTTY && !!process.stdout.isTTY,
      env: process.env,
      flags: { wizard: cmdOpts.wizard !== false },
    })
    if (need) {
      await runFirstRunWizard()
    }
  } catch (e) {
    console.warn(`⚠ first-run wizard skipped: ${e?.message || e}`)
  }

  // ─── stdout/stderr 复制到 ~/.agentquad/logs/agentquad.log ───
  // 保留正常 console 输出 + 同步追加到日志文件，方便诊断
  try {
    const logsDir = join(rootDir, 'logs')
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true })
    const logFile = join(logsDir, 'agentquad.log')
    // 启动时如果 log > 5MB 就截断到尾部 1MB
    try {
      const { statSync } = await import('node:fs')
      const st = statSync(logFile)
      if (st.size > 5 * 1024 * 1024) {
        const buf = readFileSync(logFile)
        const tail = buf.subarray(buf.length - 1024 * 1024)
        writeFileSync(logFile, tail)
      }
    } catch { /* file 不存在或读不了，忽略 */ }
    const { createWriteStream } = await import('node:fs')
    const logStream = createWriteStream(logFile, { flags: 'a' })
    logStream.write(`\n=== agentquad start ${new Date().toISOString()} pid=${process.pid} ===\n`)
    const wrap = (orig) => (...args) => {
      try {
        const line = args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
        logStream.write(`${new Date().toISOString()} ${line}\n`)
      } catch { /* 写 log 失败不阻塞 */ }
      orig.apply(console, args)
    }
    console.log = wrap(console.log)
    console.info = wrap(console.info)
    console.warn = wrap(console.warn)
    console.error = wrap(console.error)
    console.debug = wrap(console.debug)
  } catch (e) {
    console.warn(`[startup] log file setup failed: ${e.message}; continuing without file log`)
  }

  const pf = pidFile(rootDir)
  const existing = readPidFile(rootDir)
  if (existing && isAlive(existing.pid)) {
    const where = existing.port ? `http://${existing.host || '127.0.0.1'}:${existing.port}` : '(unknown port)'
    console.error(`AgentQuad already running (pid ${existing.pid}) at ${where}. Run 'agentquad stop' first.`)
    process.exit(1)
  }
  if (existing) { try { unlinkSync(pf) } catch { /* ignore */ } }

  const port = cmdOpts.port || cfg.port
  const { createServer } = await import('./server.js')
  const srv = createServer({
    dbFile: join(rootDir, 'data.db'),
    logDir: join(rootDir, 'logs'),
    tools: resolveToolsConfig(cfg.tools),
    defaultCwd,
    configRootDir: rootDir,
    webDist: resolvePath(__dirname, '../dist-web'),
    strictWebDist: true,
  })

  let actualPort
  try {
    actualPort = await srv.listen(port, host)
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      console.error(`ports ${port} and ${port + 1} both in use — run 'agentquad config set port <newPort>' or stop whoever holds them`)
    } else if (e.code === 'EADDRNOTAVAIL') {
      console.error(`host ${host} not available on this machine — try --host 0.0.0.0`)
    } else {
      console.error(`listen failed: ${e.message}`)
    }
    process.exit(1)
  }

  writePidFile(rootDir, { pid: process.pid, port: actualPort, host })
  console.log(buildStartupBanner({ port: actualPort, host }))
  console.log(`AI terminal default cwd: ${defaultCwd}`)

  // ─── 自动 bootstrap 3 个 AI CLI 的 hook（claude / codex / cursor）───
  // 设计：每个工具独立 try/catch；缺啥补啥 / 已装则 noop / uninstall marker 被尊重
  // 任何错误一律 warn-skip，绝不让 hook bootstrap 把 agentquad start 挂掉
  const BOOTSTRAP_TOOLS = [
    { tool: 'claude-code', mod: './openclaw-hook-installer.js', fn: 'bootstrapHooks',       malformedReason: 'malformed_settings'  },
    { tool: 'codex',       mod: './codex-hook-installer.js',    fn: 'bootstrapCodexHooks',  malformedReason: 'malformed_hooks_json' },
    { tool: 'cursor',      mod: './cursor-hook-installer.js',   fn: 'bootstrapCursorHooks', malformedReason: 'malformed_hooks_json' },
  ]
  for (const { tool, mod, fn, malformedReason } of BOOTSTRAP_TOOLS) {
    try {
      const m = await import(mod)
      const r = m[fn]()
      if (r.skipped) {
        if (r.reason === 'uninstall_marker') {
          console.log(`ℹ ${tool} hook: 已被你 hook uninstall 拒绝；想恢复跑 'agentquad hook bootstrap --${tool === 'claude-code' ? 'claude' : tool}'`)
        } else if (r.reason === malformedReason) {
          console.warn(`⚠ ${tool} hook: 配置 JSON 损坏，跳过自动安装；修好后跑 'agentquad hook bootstrap --${tool === 'claude-code' ? 'claude' : tool}'`)
        } else {
          console.log(`ℹ ${tool} hook bootstrap skipped: ${r.reason}`)
        }
        continue
      }
      if (r.scriptResult.action === 'installed') {
        console.log(`✓ ${tool} hook script installed (v${r.scriptResult.version}) → ${r.scriptResult.scriptPath}`)
      } else if (r.scriptResult.action === 'upgraded') {
        console.log(`✓ ${tool} hook script upgraded v${r.scriptResult.previousVersion ?? 0} → v${r.scriptResult.version} (backup: ${r.scriptResult.backup})`)
      }
      if (r.alreadyInstalled) {
        // 静默：避免每次 start 都刷屏。doctor 会显示状态
      } else if (r.hookResult) {
        console.log(`✓ ${tool} hooks installed: ${r.hookResult.added.join(', ')}`)
        if (r.hookResult.configResult?.action && r.hookResult.configResult.action !== 'already_present') {
          console.log(`  feature flag ${r.hookResult.configResult.action} → ${r.hookResult.configResult.configPath}`)
        }
      }
    } catch (e) {
      console.warn(`⚠ ${tool} hook bootstrap failed: ${e?.message || e}`)
    }
  }

  // ─── 自动 bootstrap 三家 AI CLI 的 AgentQuad MCP + skill（agents）───
  try {
    const pkg = JSON.parse(readFileSync(resolvePath(__dirname, '../package.json'), 'utf8'))
    await bootstrapAgentsIfNeeded({
      cfg,
      version: pkg.version,
      port: actualPort,
      isTTY: !!process.stdin.isTTY && !!process.stdout.isTTY,
    })
  } catch (e) {
    console.warn(`[agents] bootstrap failed: ${e?.message || e}`)
  }

  // listen 完成后异步发"重启完成 + Resume N 个会话"通知到 telegram。
  // 不 await，发不发都不阻塞 boot；postText 走 telegram HTTPS 直发，不依赖 long-poll
  if (typeof srv.notifyStartupRecovery === 'function') {
    Promise.resolve().then(() => srv.notifyStartupRecovery()).catch(() => {})
  }

  if (cmdOpts.open !== false) {
    try {
      const { default: open } = await import('open')
      // 浏览器自动打开仍走 127.0.0.1（避免 0.0.0.0 在浏览器里非法）
      open(`http://127.0.0.1:${actualPort}`)
    } catch (e) {
      console.warn(`could not auto-open browser: ${e.message}`)
    }
  }

  const shutdown = async (signal) => {
    console.log(`\nreceived ${signal}, shutting down...`)
    try { unlinkSync(pf) } catch { /* ignore */ }
    await srv.close()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

// ─── commander ───

const program = new Command()
program
  .name('agentquad')
  .description('Local four-quadrant todo CLI with embedded Claude Code / Codex terminal')
  .version(loadPkgVersion())

program.command('start')
  .option('-p, --port <port>', 'override port', (v) => Number(v))
  .option('--no-open', 'do not auto-open browser')
  .option('--cwd <path>', 'default cwd for AI terminal sessions')
  .option('--host <host>', 'bind address (e.g. 0.0.0.0 to allow Tailscale/LAN access)')
  .option('--expose', 'shorthand for --host 0.0.0.0 (bind all interfaces)')
  .option('--no-wizard', 'skip first-run wizard even if config.json is absent')
  .action(async (cmdOpts) => { await runStart(cmdOpts) })

// 裸跑 `agentquad`（无子命令）→ 复用 start 逻辑，默认开向导
// 注意：--no-wizard 同时挂在 start 子命令上，两边需保持一致
program
  .option('--no-wizard', 'skip first-run wizard')
  .action(async function (cmdOpts) {
    if (this.args.length) {
      console.error(`Unknown command: ${this.args[0]}`)
      console.error(`Run 'agentquad --help' for available commands.`)
      process.exit(1)
    }
    await runStart(cmdOpts)
  })

program.command('stop')
  .action(async () => {
    const pf = pidFile(DEFAULT_ROOT_DIR)
    const info = readPidFile(DEFAULT_ROOT_DIR)
    if (!info) { console.log('AgentQuad is not running (no pid file)'); return }
    const pid = info.pid
    if (!pid || !isAlive(pid)) {
      console.log('stale pid file, removing')
      try { unlinkSync(pf) } catch { /* ignore */ }
      return
    }
    process.kill(pid, 'SIGTERM')
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      if (!isAlive(pid)) {
        try { unlinkSync(pf) } catch { /* ignore */ }
        console.log('AgentQuad stopped')
        return
      }
      await new Promise(r => setTimeout(r, 100))
    }
    console.log('AgentQuad did not exit in 3s, sending SIGKILL')
    try { process.kill(pid, 'SIGKILL') } catch { /* ignore */ }
    try { unlinkSync(pf) } catch { /* ignore */ }
  })

program.command('status')
  .action(async () => {
    const info = readPidFile(DEFAULT_ROOT_DIR)
    if (!info) { console.log('not running'); return }
    const pid = info.pid
    if (!isAlive(pid)) {
      console.log(`stale pid file (${pid}), not running`)
      return
    }
    const port = info.port ?? loadConfig().port
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/status`)
      const body = await r.json()
      console.log(`running pid=${pid} port=${port} version=${body.version} activeSessions=${body.activeSessions}`)
    } catch {
      console.log(`running pid=${pid} port=${port} (could not reach /api/status)`)
    }
  })

program.command('doctor')
  .action(async () => {
    const report = await doctorReport()
    for (const c of report.checks) {
      const icon = c.ok ? '✓' : '✗'
      const tail = c.detail ? ` — ${c.detail}` : ''
      console.log(`${icon} ${c.name}${tail}`)
    }

    const missing = report.checks
      .filter(c => !c.ok && /^(claude|codex|cursor) binary$/.test(c.name))
      .map(c => c.name.split(' ')[0])

    if (missing.length > 0) {
      const flags = missing.map(t => `--${t}`).join(' ')
      console.log(`\nMissing AI CLI(s): ${missing.join(', ')}`)
      console.log(`Suggested fix: agentquad install-tools ${flags}`)
      if (process.stdin.isTTY) {
        const ans = await prompt(`Run it now? [Enter = yes / q = skip] `)
        if (ans.trim().toLowerCase() !== 'q') {
          const r = spawnSync(process.execPath, [
            fileURLToPath(import.meta.url),
            'install-tools',
            ...missing.map(t => `--${t}`),
            '-y',
          ], { stdio: 'inherit' })
          process.exit(r.status ?? 1)
        }
      }
    }

    process.exit(report.ok ? 0 : 1)
  })

program.command('install-tools')
  .description('Install missing AI CLIs (claude / codex / cursor)')
  .option('--claude', 'install only @anthropic-ai/claude-code (npm)')
  .option('--codex',  'install only @openai/codex (npm)')
  .option('--cursor', 'install only cursor-agent (upstream shell installer)')
  .option('--all',    'install all (default if no flag given)')
  .option('-y, --yes', 'skip the y/N confirmation')
  .action(async (opts) => {
    const tools = planInstallTools(opts)
    const items = tools.map((t) => ({ tool: t, ...TOOL_PACKAGES[t] }))

    console.log('About to install:')
    for (const it of items) {
      if (it.kind === 'shell') console.log(`  - ${it.bin}  via: ${it.script}`)
      else console.log(`  - ${it.pkg}  (binary: ${it.bin})  via npm install -g`)
    }

    if (!opts.yes && process.stdin.isTTY) {
      const ok = await prompt('Continue? [y/N] ')
      if (!/^y(es)?$/i.test(ok.trim())) {
        console.log('Aborted.')
        process.exit(0)
      }
    }

    let allOk = true
    for (const it of items) {
      if (it.kind === 'shell') {
        console.log(`\n>> ${it.script}`)
        const r = spawnSync('/bin/sh', ['-lc', it.script], { stdio: 'inherit' })
        if (r.status !== 0) {
          console.error(`\n✗ shell installer for ${it.bin} exited ${r.status}`)
          console.error(`  Manual fix: re-run "${it.script}" in your shell, then check PATH.`)
          allOk = false
          break
        }
      } else {
        console.log(`\n>> npm install -g ${it.pkg}`)
        const r = spawnSync('npm', ['install', '-g', it.pkg], { stdio: 'inherit' })
        if (r.status !== 0) {
          console.error(`\n✗ npm install -g ${it.pkg} exited ${r.status}`)
          printInstallFailureFix(it)
          allOk = false
          break
        }
      }
      const w = spawnSync('command', ['-v', it.bin], { encoding: 'utf8', shell: '/bin/sh' })
      if (w.status !== 0 || !w.stdout.trim()) {
        console.error(`\n✗ installer reported success but \`${it.bin}\` is not in PATH.`)
        if (it.kind === 'shell') {
          console.error(`  You may need to restart your shell, or run the installer manually:  ${it.script}`)
        } else {
          printInstallFailureFix(it)
        }
        allOk = false
        break
      }
      console.log(`✓ ${it.bin} → ${w.stdout.trim()}`)
    }

    process.exit(allOk ? 0 : 1)
  })

// ─── agentquad mcp install / status ─────────────────────────────

export function defaultClaudeSettingsPath() {
  return join(homedir(), '.claude', 'settings.json')
}

export function buildMcpServerEntry({ host, port } = {}) {
  const h = host && host !== '0.0.0.0' ? host : '127.0.0.1'
  return {
    type: 'http',
    url: `http://${h}:${port}/mcp`,
  }
}

/**
 * Merge `agentquad` 进 settings.json 的 mcpServers 段，不破坏现有条目。
 * - 如果 settings.json 不存在：创建一个只含 mcpServers 的新文件
 * - 如果存在且有效 JSON：merge
 * - 如果存在但不是 JSON：报错（让用户自己先修好）
 * - 如果存在 legacy `quadtodo` entry 且其 url/command 指向 OUR 包 bin → 删除
 *
 * 返回 { path, action: 'created'|'updated'|'unchanged', entry, legacyRemoved }
 */
export function installMcpIntoClaudeSettings({
  settingsPath = defaultClaudeSettingsPath(),
  host,
  port,
  name = 'agentquad',
} = {}) {
  const entry = buildMcpServerEntry({ host, port })
  let settings = {}
  let existed = false
  if (existsSync(settingsPath)) {
    existed = true
    const raw = readFileSync(settingsPath, 'utf8')
    try {
      settings = JSON.parse(raw)
    } catch (e) {
      const err = new Error(`settings.json exists but is not valid JSON: ${e.message}`)
      err.code = 'invalid_settings'
      throw err
    }
  } else {
    const dir = dirname(settingsPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
  if (!settings.mcpServers || typeof settings.mcpServers !== 'object') {
    settings.mcpServers = {}
  }
  // legacy 清理：如果有 quadtodo entry 且看起来是 OUR 包（http URL 指向 /mcp，或
  // command 字段含 /quadtodo/ | /agentquad/），删掉它。
  let legacyRemoved = false
  const legacy = settings.mcpServers.quadtodo
  if (legacy && name !== 'quadtodo') {
    const isOurs =
      (typeof legacy.url === 'string' && /\/mcp\/?$/.test(legacy.url)) ||
      (typeof legacy.command === 'string' && /\/agentquad\/|\/quadtodo\//.test(legacy.command))
    if (isOurs) {
      delete settings.mcpServers.quadtodo
      legacyRemoved = true
    }
  }
  const existing = settings.mcpServers[name]
  const same = existing && existing.type === entry.type && existing.url === entry.url
  if (same && !legacyRemoved) {
    return { path: settingsPath, action: 'unchanged', entry, legacyRemoved }
  }
  settings.mcpServers[name] = entry
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
  return { path: settingsPath, action: existed ? 'updated' : 'created', entry, legacyRemoved }
}

const mcpCmd = program.command('mcp').description('Claude Code MCP: install / status')

mcpCmd.command('install')
  .option('--settings <path>', 'path to claude settings.json', defaultClaudeSettingsPath())
  .option('--host <host>', 'override host in the URL (useful when this Mac is accessed remotely)')
  .action((opts) => {
    const cfg = loadConfig()
    try {
      const out = installMcpIntoClaudeSettings({
        settingsPath: opts.settings,
        host: opts.host || cfg.host,
        port: cfg.port,
      })
      const icon = out.action === 'unchanged' ? '=' : out.action === 'created' ? '+' : '~'
      console.log(`${icon} ${out.action} ${out.path}`)
      if (out.legacyRemoved) {
        console.log('   removed legacy mcpServers["quadtodo"] entry')
      }
      console.log(`   mcpServers.agentquad.url = ${out.entry.url}`)
      if (out.action === 'unchanged') {
        console.log('   (already configured)')
      } else {
        console.log('   Claude Code 里输入 /mcp 可验证连接。')
      }
    } catch (e) {
      console.error(`install failed: ${e.message}`)
      process.exit(1)
    }
  })

mcpCmd.command('status')
  .action(async () => {
    const cfg = loadConfig()
    const port = cfg.port
    const url = `http://127.0.0.1:${port}/mcp/health`
    try {
      const r = await fetch(url)
      const body = await r.json()
      console.log(`✓ ${url}`)
      console.log(`  ${JSON.stringify(body)}`)
    } catch (e) {
      console.error(`✗ ${url} unreachable: ${e.message}`)
      console.error(`  AgentQuad 是不是没跑？试 'agentquad start' 或 'npm start'`)
      process.exit(1)
    }
  })

// ─── hook 操作共享 action（被顶层 `hook` 命令组和老的 `openclaw` 子命令复用）─────
async function actInstallHook() {
  const { installHooks } = await import('./openclaw-hook-installer.js')
  try {
    const out = installHooks()
    console.log(`✓ installed ${out.added.join(', ')} hooks`)
    console.log(`  settings: ${out.settingsPath}`)
    if (out.backup) console.log(`  backup:   ${out.backup}`)
    if (out.markerCleared) console.log(`  uninstall marker cleared`)
    console.log('')
    console.log('完成。新的 PTY 会话启动后会自动通过 hook 推送状态到微信。')
    console.log('注意：现存的 PTY 会话（重启前已经在跑的）env 已固定，不受影响；')
    console.log('     新 agentquad.start_ai_session 启动的 PTY 才会带 hook env。')
  } catch (e) {
    console.error(`install-hook failed: ${e.message}`)
    if (e.code === 'malformed_settings') {
      console.error(`  你的 ~/.claude/settings.json JSON 不合法，先修复再试。`)
    }
    if (e.code === 'hook_script_missing') {
      console.error(`  hook 脚本缺失。跑 'agentquad hook bootstrap' 一键部署 + 安装。`)
    }
    process.exit(1)
  }
}

async function actBootstrapHook() {
  const { bootstrapHooks } = await import('./openclaw-hook-installer.js')
  try {
    const r = bootstrapHooks({ respectUninstallMarker: false })
    if (r.skipped) {
      if (r.reason === 'malformed_settings') {
        console.error(`✗ bootstrap skipped: ${r.settingsPath} JSON 不合法，请先修复`)
        process.exit(1)
      }
      console.log(`= bootstrap skipped: ${r.reason}`)
      return
    }
    const sr = r.scriptResult
    if (sr.action === 'installed') {
      console.log(`✓ hook script installed (v${sr.version}) → ${sr.scriptPath}`)
    } else if (sr.action === 'upgraded') {
      console.log(`✓ hook script upgraded v${sr.previousVersion ?? 0} → v${sr.version}`)
      if (sr.backup) console.log(`  backup: ${sr.backup}`)
    } else {
      console.log(`= hook script up-to-date (v${sr.version}) → ${sr.scriptPath}`)
    }
    if (r.alreadyInstalled) {
      console.log(`= hooks already installed in ~/.claude/settings.json`)
    } else if (r.hookResult) {
      console.log(`✓ hooks installed: ${r.hookResult.added.join(', ')}`)
      if (r.hookResult.backup) console.log(`  settings backup: ${r.hookResult.backup}`)
    }
    if (r.markerCleared) console.log(`  uninstall marker cleared`)
  } catch (e) {
    console.error(`bootstrap failed: ${e.message}`)
    process.exit(1)
  }
}

async function actUninstallHook(opts) {
  const { uninstallHooks } = await import('./openclaw-hook-installer.js')
  try {
    const out = uninstallHooks({ writeUninstallMarker: opts.marker !== false })
    if (out.removed.length === 0) {
      console.log('= no AgentQuad hooks installed; nothing to remove')
    } else {
      console.log(`✓ removed AgentQuad hooks from ${out.settingsPath}`)
      for (const r of out.removed) console.log(`   ${r.event}: -${r.removedCount}`)
      if (out.backup) console.log(`  backup: ${out.backup}`)
    }
    if (out.markerWritten) {
      console.log(`  marker written → 下次 'agentquad start' 不会自动装回；想恢复跑 'agentquad hook bootstrap'`)
    }
  } catch (e) {
    console.error(`uninstall-hook failed: ${e.message}`)
    process.exit(1)
  }
}

async function actHookStatus() {
  const { inspectHooks } = await import('./openclaw-hook-installer.js')
  const r = inspectHooks()
  const icon = r.installed ? '✓' : '✗'
  console.log(`${icon} hooks installed: ${r.installed}`)
  console.log(`  events: ${r.eventsInstalled.length ? r.eventsInstalled.join(', ') : '(none)'}`)
  console.log(`  settings: ${r.settingsPath}`)
  console.log(`  hook script: ${r.hookScriptPath} (${r.scriptExists ? 'exists' : 'MISSING'})`)
  if (r.error) console.log(`  ⚠️  ${r.error}`)
}

// ─── 多工具 hook 操作（claude / codex / cursor）─────────────────────
export function planHookTools(opts) {
  const flags = opts || {}
  const explicit = []
  if (flags.claude) explicit.push('claude')
  if (flags.codex)  explicit.push('codex')
  if (flags.cursor) explicit.push('cursor')
  if (flags.all || explicit.length === 0) return ['claude', 'codex', 'cursor']
  return explicit
}

const HOOK_INSTALLERS = {
  claude: { mod: () => import('./openclaw-hook-installer.js'), bootstrap: 'bootstrapHooks' },
  codex:  { mod: () => import('./codex-hook-installer.js'),    bootstrap: 'bootstrapCodexHooks' },
  cursor: { mod: () => import('./cursor-hook-installer.js'),   bootstrap: 'bootstrapCursorHooks' },
}

async function actInstallHookMulti(opts) {
  let allOk = true
  for (const tool of planHookTools(opts)) {
    try {
      const m = await HOOK_INSTALLERS[tool].mod()
      const out = m.installHooks()
      const path = out.settingsPath || out.hooksPath
      console.log(`✓ [${tool}] installed ${out.added.join(', ')} → ${path}`)
      if (out.backup) console.log(`   backup: ${out.backup}`)
      if (out.configResult?.action && out.configResult.action !== 'already_present') {
        console.log(`   feature flag ${out.configResult.action} → ${out.configResult.configPath}`)
      }
      if (out.markerCleared) console.log(`   uninstall marker cleared`)
    } catch (e) {
      console.error(`✗ [${tool}] ${e.message}`)
      if (e.code === 'hook_script_missing') {
        console.error(`   跑 'agentquad hook bootstrap --${tool}' 一键部署 + 安装`)
      }
      allOk = false
    }
  }
  if (!allOk) process.exit(1)
}

async function actUninstallHookMulti(opts) {
  let allOk = true
  for (const tool of planHookTools(opts)) {
    try {
      const m = await HOOK_INSTALLERS[tool].mod()
      const out = m.uninstallHooks({ writeUninstallMarker: opts.marker !== false })
      const path = out.settingsPath || out.hooksPath
      if (out.removed.length === 0) {
        console.log(`= [${tool}] no AgentQuad hooks; nothing to remove`)
      } else {
        const total = out.removed.reduce((s, r) => s + r.removedCount, 0)
        console.log(`✓ [${tool}] removed ${total} entries → ${path}`)
        for (const r of out.removed) console.log(`     ${r.event}: -${r.removedCount}`)
        if (out.backup) console.log(`   backup: ${out.backup}`)
      }
      if (out.markerWritten) console.log(`   marker written`)
    } catch (e) {
      console.error(`✗ [${tool}] ${e.message}`)
      allOk = false
    }
  }
  if (!allOk) process.exit(1)
}

async function actHookStatusMulti(opts) {
  for (const tool of planHookTools(opts)) {
    try {
      const m = await HOOK_INSTALLERS[tool].mod()
      const r = m.inspectHooks()
      const icon = r.installed ? '✓' : '✗'
      const path = r.settingsPath || r.hooksPath
      console.log(`${icon} [${tool}] installed: ${r.installed}`)
      console.log(`   events: ${r.eventsInstalled.length ? r.eventsInstalled.join(', ') : '(none)'}`)
      console.log(`   config: ${path}`)
      console.log(`   script: ${r.hookScriptPath} (${r.scriptExists ? 'exists' : 'MISSING'})`)
      if (r.featureFlagOk === false) console.log(`   ⚠️  codex_hooks feature flag not set in ~/.codex/config.toml`)
      if (r.error) console.log(`   ⚠️  ${r.error}`)
    } catch (e) {
      console.error(`✗ [${tool}] ${e.message}`)
    }
  }
}

async function actBootstrapHookMulti(opts) {
  let allOk = true
  for (const tool of planHookTools(opts)) {
    const cfg = HOOK_INSTALLERS[tool]
    try {
      const m = await cfg.mod()
      const r = m[cfg.bootstrap]({ respectUninstallMarker: false })
      if (r.skipped) {
        const reasonTxt = r.reason === 'malformed_settings' || r.reason === 'malformed_hooks_json'
          ? `${r.reason} — 请先修复 JSON 再试`
          : r.reason
        console.log(`= [${tool}] skipped: ${reasonTxt}`)
        if (r.reason === 'malformed_settings' || r.reason === 'malformed_hooks_json') allOk = false
        continue
      }
      const sr = r.scriptResult
      const verb = sr.action === 'unchanged' ? '=' : '✓'
      console.log(`${verb} [${tool}] script ${sr.action} (v${sr.version})`)
      if (sr.backup) console.log(`   script backup: ${sr.backup}`)
      if (r.alreadyInstalled) {
        console.log(`   hooks already installed`)
      } else if (r.hookResult) {
        console.log(`   hooks installed: ${r.hookResult.added.join(', ')}`)
        if (r.hookResult.backup) console.log(`   config backup: ${r.hookResult.backup}`)
        if (r.hookResult.configResult?.action && r.hookResult.configResult.action !== 'already_present') {
          console.log(`   feature flag ${r.hookResult.configResult.action} → ${r.hookResult.configResult.configPath}`)
        }
      }
      if (r.markerCleared) console.log(`   uninstall marker cleared`)
    } catch (e) {
      console.error(`✗ [${tool}] ${e.message}`)
      allOk = false
    }
  }
  if (!allOk) process.exit(1)
}

function addToolFlags(cmd) {
  return cmd
    .option('--claude', 'apply to Claude Code hooks (~/.claude/settings.json)')
    .option('--codex', 'apply to OpenAI Codex hooks (~/.codex/hooks.json + config.toml)')
    .option('--cursor', 'apply to Cursor Agent hooks (~/.cursor/hooks.json)')
    .option('--all', 'apply to all tools (default if no flag given)')
}

// ─── 顶层 hook 子命令组（首选入口；发现性比埋在 openclaw 下好）──────
const hookCmd = program.command('hook').description('管理 AgentQuad 在 Claude Code / Codex / Cursor 里安装的 hook（装/删/查/恢复）')

addToolFlags(hookCmd.command('install'))
  .description('合并写入 hook 配置；默认 --all（claude + codex + cursor）')
  .action(actInstallHookMulti)

addToolFlags(hookCmd.command('uninstall'))
  .description('移除 AgentQuad 加的 hook entry，保留你其他 hook；默认写 .uninstalled marker，下次 start 不再装回')
  .option('--no-marker', '不写 .uninstalled marker（下次 agentquad start 会自动装回）')
  .action(actUninstallHookMulti)

addToolFlags(hookCmd.command('status'))
  .description('查看每个工具的 hook 安装状态')
  .action(actHookStatusMulti)

addToolFlags(hookCmd.command('bootstrap'))
  .description('一键部署 hook script + 安装 hooks（强制忽略 .uninstalled marker，用于"删过又想恢复"场景）')
  .action(actBootstrapHookMulti)

// ─── agents 子命令组：装/卸 AgentQuad MCP + skill 到 Claude Code / Codex / Cursor ───
const agentsCmd = program.command('agents').description('为 Claude Code / Codex / Cursor 装 AgentQuad MCP + skill（嵌套子 agent 能力）')

const VALID_AGENT_TARGETS = ['claude', 'codex', 'cursor']

function addAgentTargetFlag(cmd) {
  return cmd.option('--target <name>', '指定 claude / codex / cursor，多次传入累加', (v, acc = []) => {
    if (!VALID_AGENT_TARGETS.includes(v)) throw new Error(`unknown agents target: ${v}`)
    acc.push(v)
    return acc
  }, undefined)
}

function readAgentsCtx() {
  const pkg = JSON.parse(readFileSync(resolvePath(__dirname, '../package.json'), 'utf8'))
  const cfg = loadConfig()
  return { port: cfg.port || 5677, version: pkg.version }
}

addAgentTargetFlag(agentsCmd.command('install'))
  .description('合并写入 MCP 配置 + skill 文件；默认装三家')
  .option('--dry-run', '只 preview 不写盘')
  .action(async (opts) => {
    const { installAllAgents, previewAllAgents } = await import('./agent-installer-dispatcher.js')
    const { port, version } = readAgentsCtx()
    const only = opts.target || null
    if (opts.dryRun) {
      const p = previewAllAgents({ port, version, only })
      console.log('dry-run preview:')
      for (const [t, r] of Object.entries(p.results)) {
        const text = r.changes && r.changes.length ? r.changes.join(', ') : 'no changes'
        console.log(`  ${t}: ${text}`)
      }
      if (p.summary?.failed?.length) {
        for (const t of p.summary.failed) console.error(`  ${t}: error — ${p.results[t]?.error || 'unknown'}`)
      }
      return
    }
    const r = installAllAgents({ port, version, only })
    for (const [t, res] of Object.entries(r.results)) {
      if (res.ok) console.log(`✓ ${t}:`, res.changes?.length ? res.changes.join(', ') : 'already up to date')
      else console.error(`✗ ${t}:`, res.error)
    }
    if (r.summary?.failed?.length) process.exitCode = 1
  })

addAgentTargetFlag(agentsCmd.command('uninstall'))
  .description('删除 marker 段 + skill 文件；用户其他 mcpServers / skill 不动')
  .action(async (opts) => {
    const { uninstallAllAgents } = await import('./agent-installer-dispatcher.js')
    const only = opts.target || null
    const r = uninstallAllAgents({ only })
    for (const [t, res] of Object.entries(r.results)) {
      if (res.ok) console.log(`✓ ${t}: removed`, (res.removed || []).join(', ') || 'nothing')
      else console.error(`✗ ${t}:`, res.error)
    }
    if (r.summary?.failed?.length) process.exitCode = 1
  })

agentsCmd.command('status')
  .description('查看三家 agent 工具的 AgentQuad MCP / skill 安装状态 + drift')
  .action(async () => {
    const { inspectAllAgents } = await import('./agent-installer-dispatcher.js')
    const { port } = readAgentsCtx()
    const r = inspectAllAgents({ expectedPort: port })
    for (const [t, ins] of Object.entries(r.results)) {
      if (ins.error) {
        console.log(`  ${t.padEnd(8)} ✗ error — ${ins.error}`)
        continue
      }
      const mcp = ins.mcpRegistered ? '✓ MCP' : '✗ MCP'
      const sk = ins.skillPresent ? '✓ skill' : '✗ skill'
      const drift = ins.drift ? `  ⚠ drift (actual:${ins.actualPort} expected:${ins.expectedPort})` : ''
      console.log(`  ${t.padEnd(8)} ${mcp}   ${sk}   ${ins.configPath}${drift}`)
    }
  })

// ─── openclaw 子命令组：保留旧路径以向后兼容；hook 操作建议改用 `agentquad hook *` ───
const openclawCmd = program.command('openclaw').description('OpenClaw bridge: install/uninstall Claude Code hooks for proactive WeChat push')

openclawCmd.command('install-hook')
  .description('alias of `agentquad hook install`')
  .action(actInstallHook)

openclawCmd.command('bootstrap')
  .description('alias of `agentquad hook bootstrap`')
  .action(actBootstrapHook)

openclawCmd.command('uninstall-hook')
  .description('alias of `agentquad hook uninstall`')
  .option('--no-marker', '不写 .uninstalled marker（下次 agentquad start 会自动装回）')
  .action(actUninstallHook)

openclawCmd.command('hook-status')
  .description('alias of `agentquad hook status`')
  .action(actHookStatus)

openclawCmd.command('inbound')
  .description('OpenClaw skill 单入口：转发一条用户消息到 AgentQuad wizard，stdout 是给用户的回复')
  .requiredOption('--from <peer>', '微信对端 user_id（OpenClaw 给的 from_user_id）')
  .requiredOption('--text <text>', '用户原文')
  .option('--port <port>', 'AgentQuad 端口', (v) => Number(v))
  .action(async (opts) => {
    const cfg = loadConfig()
    const port = opts.port || cfg.port || 5677
    const url = `http://127.0.0.1:${port}/api/openclaw/inbound`
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: opts.from, text: opts.text }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) {
        console.error(`✗ ${res.status} ${data.error || 'unknown'}`)
        process.exit(1)
      }
      // 把 reply 直接打到 stdout — OpenClaw skill 会把它转发回微信用户
      process.stdout.write(String(data.reply || ''))
      // exit 0
    } catch (e) {
      console.error(`✗ inbound failed: ${e.message}`)
      console.error(`  AgentQuad 是不是没跑？试 'agentquad status'`)
      process.exit(1)
    }
  })

openclawCmd.command('inbound-state')
  .description('查看 wizard 当前进行中的 peer 列表（调试用）')
  .action(async () => {
    const cfg = loadConfig()
    const port = cfg.port || 5677
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/openclaw/inbound/state`)
      const data = await res.json()
      console.log(JSON.stringify(data, null, 2))
    } catch (e) {
      console.error(`✗ ${e.message}`)
      process.exit(1)
    }
  })

const cfgCmd = program.command('config').description('read/write ~/.agentquad/config.json')
cfgCmd.command('get <key>').action((key) => {
  const v = getConfigValue(key)
  if (v === undefined) process.exit(1)
  console.log(typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v))
})
cfgCmd.command('set <key> <value>').action((key, value) => {
  const coerced = setConfigValue(key, value)
  console.log(`set ${key} = ${coerced}`)
})
cfgCmd.command('list').action(() => {
  console.log(JSON.stringify(loadConfig(), null, 2))
})

// 仅当被作为可执行脚本运行时才 parse（import 进来做测试时跳过）。
// 用 realpath 比对，避免 npm link symlink 下 process.argv[1] !== import.meta.url 把判断打飞。
const isMain = (() => {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    // fallback：argv[1] 是 cli.js 或 bin 名 'agentquad' / 'quadtodo'（legacy alias）
    if (process.argv[1].endsWith('cli.js')) return true
    if (/\/(agentquad|quadtodo)$/.test(process.argv[1])) return true
    return false
  }
})()
if (isMain) {
  // 后台异步检查 npm 上有没有新版本，下次启动时给用户一行提示
  // - 非 TTY / CI / NO_UPDATE_NOTIFIER=1 时 update-notifier 自动静默
  // - 检查结果缓存在 ~/.config/configstore/，间隔 24h，不阻塞 CLI 启动
  try {
    const pkg = JSON.parse(readFileSync(resolvePath(__dirname, '../package.json'), 'utf8'))
    updateNotifier({ pkg, updateCheckInterval: 1000 * 60 * 60 * 24 }).notify({ defer: false })
  } catch { /* 离线 / configstore 不可写：静默忽略 */ }
  program.parseAsync(process.argv)
}

function printInstallFailureFix(it) {
  console.error(`
Common fixes:
  - Permissions: try \`sudo npm install -g ${it.pkg}\`,
    or move npm prefix into your home dir:
      \`npm config set prefix ~/.npm-global\`
      and add \`~/.npm-global/bin\` to your PATH.
  - If you use nvm: \`nvm use 20\` first, then retry.
  - Network/registry: check \`npm config get registry\`.
`)
}

function prompt(question) {
  return new Promise((resolve) => {
    process.stdout.write(question)
    let buf = ''
    process.stdin.setEncoding('utf8')
    const onData = (chunk) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl >= 0) {
        process.stdin.removeListener('data', onData)
        resolve(buf.slice(0, nl))
      }
    }
    process.stdin.on('data', onData)
  })
}
