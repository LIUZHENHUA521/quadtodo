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

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function loadPkgVersion() {
  try {
    const pkg = JSON.parse(readFileSync(resolvePath(__dirname, '../package.json'), 'utf8'))
    return pkg.version || '0.0.0'
  } catch { return '0.0.0' }
}

function pidFile(rootDir = DEFAULT_ROOT_DIR) {
  return join(rootDir, 'quadtodo.pid')
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
    lines.push(`quadtodo listening on ${url('127.0.0.1')}  (loopback only)`)
    lines.push('')
    lines.push('⚠️  To access from phone via Tailscale, run:')
    lines.push('     quadtodo config set host 0.0.0.0')
    lines.push('   or start with:')
    lines.push('     quadtodo start --expose')
  } else {
    lines.push(`quadtodo listening on ${url(host === '0.0.0.0' || host === '::' ? 'all-interfaces' : host)}  (port ${port})`)
    lines.push('')
    lines.push('⚠️  SECURITY: quadtodo exposes a shell + AI terminal. Reachable URLs:')
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
        detail: '空（per-session 路由仍可工作；如要 ad-hoc 推送，set via `quadtodo config set openclaw.targetUserId <peer-id>`）',
      })
    }

    // 3. quadtodo skill 装好了吗（OpenClaw 端配置）
    const skillFile = join(homedir(), '.openclaw', 'skills', 'quadtodo-claw', 'SKILL.md')
    checks.push({
      name: 'quadtodo-claw skill installed',
      ok: existsSync(skillFile),
      detail: existsSync(skillFile)
        ? skillFile
        : '缺失：参考 docs/OPENCLAW.md',
    })

    // 4. Claude Code hook 安装状态（主动推送）
    try {
      const { inspectHooks } = await import('./openclaw-hook-installer.js')
      const hk = inspectHooks()
      checks.push({
        name: 'claude-code hook script',
        ok: hk.scriptExists,
        detail: hk.hookScriptPath + (hk.scriptExists ? '' : ' (missing — should be auto-installed)'),
      })
      checks.push({
        name: 'claude-code hooks installed',
        ok: hk.installed,
        detail: hk.installed
          ? `events: ${hk.eventsInstalled.join(', ')}`
          : '缺失：跑 `quadtodo openclaw install-hook` 一次',
      })
    } catch (e) {
      checks.push({
        name: 'claude-code hooks',
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
      detail: tg.supergroupId || '未配置：第一次跑 quadtodo 时让 bot 拿 chat.id（log 里），再 `quadtodo config set telegram.supergroupId <id>`',
    })

    // 6. allowedChatIds（白名单）
    const allowList = Array.isArray(tg.allowedChatIds) ? tg.allowedChatIds : []
    checks.push({
      name: 'telegram.allowedChatIds',
      ok: allowList.length > 0,
      detail: allowList.length > 0
        ? allowList.join(', ')
        : '空 = 拒所有：跑 `quadtodo config set telegram.allowedChatIds.0 <supergroup-id>`',
    })

    // 7. token（从 OpenClaw config 读）
    try {
      const { readBotToken } = await import('./telegram-bot.js')
      const tok = readBotToken(() => cfg)
      checks.push({
        name: 'telegram bot token',
        ok: Boolean(tok),
        detail: tok ? '✓ found in ~/.openclaw/openclaw.json' : '缺失：先在 OpenClaw 注册 bot token（openclaw channels add --channel telegram --token ...）',
      })
    } catch (e) {
      checks.push({ name: 'telegram bot token', ok: false, detail: e.message })
    }

    // 注：hook check 已经在 openclaw 段做过；不重复
  }

  return { ok: checks.every(c => c.ok), checks }
}

// ─── commander ───

const program = new Command()
program
  .name('quadtodo')
  .description('Local four-quadrant todo CLI with embedded Claude Code / Codex terminal')
  .version(loadPkgVersion())

program.command('start')
  .option('-p, --port <port>', 'override port', (v) => Number(v))
  .option('--no-open', 'do not auto-open browser')
  .option('--cwd <path>', 'default cwd for AI terminal sessions')
  .option('--host <host>', 'bind address (e.g. 0.0.0.0 to allow Tailscale/LAN access)')
  .option('--expose', 'shorthand for --host 0.0.0.0 (bind all interfaces)')
  .action(async (cmdOpts) => {
    const rootDir = DEFAULT_ROOT_DIR
    const cfg = loadConfig({ rootDir })
    const defaultCwd = cmdOpts.cwd || cfg.defaultCwd || process.env.HOME || process.cwd()
    const host = cmdOpts.expose
      ? '0.0.0.0'
      : (cmdOpts.host || cfg.host || '127.0.0.1')

    // ─── stdout/stderr 复制到 ~/.quadtodo/logs/quadtodo.log ───
    // 保留正常 console 输出 + 同步追加到日志文件，方便诊断
    try {
      const logsDir = join(rootDir, 'logs')
      if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true })
      const logFile = join(logsDir, 'quadtodo.log')
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
      logStream.write(`\n=== quadtodo start ${new Date().toISOString()} pid=${process.pid} ===\n`)
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
    if (existsSync(pf)) {
      const oldPid = Number(readFileSync(pf, 'utf8'))
      if (oldPid && isAlive(oldPid)) {
        console.error(`quadtodo already running (pid ${oldPid}). Run 'quadtodo stop' first.`)
        process.exit(1)
      }
      try { unlinkSync(pf) } catch { /* ignore */ }
    }

    const port = cmdOpts.port || cfg.port
    const { createServer } = await import('./server.js')
    const srv = createServer({
      dbFile: join(rootDir, 'data.db'),
      logDir: join(rootDir, 'logs'),
      tools: resolveToolsConfig(cfg.tools),
      defaultCwd,
      configRootDir: rootDir,
      webDist: resolvePath(__dirname, '../dist-web'),
    })

    try {
      await srv.listen(port, host)
    } catch (e) {
      if (e.code === 'EADDRINUSE') {
        console.error(`port ${port} in use — run 'quadtodo config set port <newPort>' or stop whoever holds it`)
      } else if (e.code === 'EADDRNOTAVAIL') {
        console.error(`host ${host} not available on this machine — try --host 0.0.0.0`)
      } else {
        console.error(`listen failed: ${e.message}`)
      }
      process.exit(1)
    }

    writeFileSync(pf, String(process.pid))
    console.log(buildStartupBanner({ port, host }))
    console.log(`AI terminal default cwd: ${defaultCwd}`)

    // ─── 自动 bootstrap Claude Code hook（部署 notify.js + 合入 settings.json）───
    // 设计：缺啥补啥 / 已装则 noop / 用户跑过 uninstall-hook 留下的 marker 会被尊重
    // 任何错误一律 warn-skip，绝不让 hook bootstrap 把 quadtodo start 挂掉
    try {
      const { bootstrapHooks } = await import('./openclaw-hook-installer.js')
      const r = bootstrapHooks()
      if (r.skipped) {
        if (r.reason === 'uninstall_marker') {
          console.log(`ℹ claude-code hook: 已被你 uninstall-hook 拒绝；想恢复跑 'quadtodo openclaw bootstrap'`)
        } else if (r.reason === 'malformed_settings') {
          console.warn(`⚠ claude-code hook: ~/.claude/settings.json JSON 损坏，跳过自动安装；修好后跑 'quadtodo openclaw bootstrap'`)
        } else {
          console.log(`ℹ claude-code hook bootstrap skipped: ${r.reason}`)
        }
      } else {
        if (r.scriptResult.action === 'installed') {
          console.log(`✓ claude-code hook script installed (v${r.scriptResult.version}) → ${r.scriptResult.scriptPath}`)
        } else if (r.scriptResult.action === 'upgraded') {
          console.log(`✓ claude-code hook script upgraded v${r.scriptResult.previousVersion ?? 0} → v${r.scriptResult.version} (backup: ${r.scriptResult.backup})`)
        }
        if (r.alreadyInstalled) {
          // 静默：避免每次 start 都刷屏。doctor 会显示状态
        } else if (r.hookResult) {
          console.log(`✓ claude-code hooks installed: ${r.hookResult.added.join(', ')}`)
        }
      }
    } catch (e) {
      console.warn(`⚠ claude-code hook bootstrap failed: ${e?.message || e}`)
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
        open(`http://127.0.0.1:${port}`)
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
  })

program.command('stop')
  .action(async () => {
    const pf = pidFile()
    if (!existsSync(pf)) { console.log('quadtodo is not running (no pid file)'); return }
    const pid = Number(readFileSync(pf, 'utf8'))
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
        console.log('quadtodo stopped')
        return
      }
      await new Promise(r => setTimeout(r, 100))
    }
    console.log('quadtodo did not exit in 3s, sending SIGKILL')
    try { process.kill(pid, 'SIGKILL') } catch { /* ignore */ }
    try { unlinkSync(pf) } catch { /* ignore */ }
  })

program.command('status')
  .action(async () => {
    const pf = pidFile()
    if (!existsSync(pf)) { console.log('not running'); return }
    const pid = Number(readFileSync(pf, 'utf8'))
    if (!isAlive(pid)) {
      console.log(`stale pid file (${pid}), not running`)
      return
    }
    const cfg = loadConfig()
    const port = cfg.port
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
    process.exit(report.ok ? 0 : 1)
  })

// ─── quadtodo mcp install / status ─────────────────────────────

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
 * Merge `quadtodo` 进 settings.json 的 mcpServers 段，不破坏现有条目。
 * - 如果 settings.json 不存在：创建一个只含 mcpServers 的新文件
 * - 如果存在且有效 JSON：merge
 * - 如果存在但不是 JSON：报错（让用户自己先修好）
 *
 * 返回 { path, action: 'created'|'updated'|'unchanged', entry }
 */
export function installMcpIntoClaudeSettings({
  settingsPath = defaultClaudeSettingsPath(),
  host,
  port,
  name = 'quadtodo',
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
  const existing = settings.mcpServers[name]
  const same = existing && existing.type === entry.type && existing.url === entry.url
  if (same) {
    return { path: settingsPath, action: 'unchanged', entry }
  }
  settings.mcpServers[name] = entry
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
  return { path: settingsPath, action: existed ? 'updated' : 'created', entry }
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
      console.log(`   mcpServers.quadtodo.url = ${out.entry.url}`)
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
      console.error(`  quadtodo 是不是没跑？试 'quadtodo start' 或 'npm start'`)
      process.exit(1)
    }
  })

// ─── openclaw 子命令组：hook 安装 / 卸载 / 状态 ─────────────────
const openclawCmd = program.command('openclaw').description('OpenClaw bridge: install/uninstall Claude Code hooks for proactive WeChat push')

openclawCmd.command('install-hook')
  .description('把 quadtodo 的 3 个 hook（Stop/Notification/SessionEnd）合并写入 ~/.claude/settings.json')
  .action(async () => {
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
      console.log('     新 quadtodo.start_ai_session 启动的 PTY 才会带 hook env。')
    } catch (e) {
      console.error(`install-hook failed: ${e.message}`)
      if (e.code === 'malformed_settings') {
        console.error(`  你的 ~/.claude/settings.json JSON 不合法，先修复再试。`)
      }
      if (e.code === 'hook_script_missing') {
        console.error(`  hook 脚本缺失。跑 'quadtodo openclaw bootstrap' 一键部署 + 安装。`)
      }
      process.exit(1)
    }
  })

openclawCmd.command('bootstrap')
  .description('一键部署 hook script + 安装 hooks（启动期 auto-install 同款逻辑，会清掉 uninstall marker）')
  .action(async () => {
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
  })

openclawCmd.command('uninstall-hook')
  .description('从 ~/.claude/settings.json 移除 quadtodo 加的 hook entry，保留你其他 hook（默认会写 .uninstalled marker，下次 start 不再自动装回）')
  .option('--no-marker', '不写 .uninstalled marker（下次 quadtodo start 会自动装回）')
  .action(async (opts) => {
    const { uninstallHooks } = await import('./openclaw-hook-installer.js')
    try {
      const out = uninstallHooks({ writeUninstallMarker: opts.marker !== false })
      if (out.removed.length === 0) {
        console.log('= no quadtodo hooks installed; nothing to remove')
      } else {
        console.log(`✓ removed quadtodo hooks from ${out.settingsPath}`)
        for (const r of out.removed) console.log(`   ${r.event}: -${r.removedCount}`)
        if (out.backup) console.log(`  backup: ${out.backup}`)
      }
      if (out.markerWritten) {
        console.log(`  marker written → 下次 'quadtodo start' 不会自动装回；想恢复跑 'quadtodo openclaw bootstrap'`)
      }
    } catch (e) {
      console.error(`uninstall-hook failed: ${e.message}`)
      process.exit(1)
    }
  })

openclawCmd.command('hook-status')
  .description('查看 quadtodo hook 是否安装到 ~/.claude/settings.json')
  .action(async () => {
    const { inspectHooks } = await import('./openclaw-hook-installer.js')
    const r = inspectHooks()
    const icon = r.installed ? '✓' : '✗'
    console.log(`${icon} hooks installed: ${r.installed}`)
    console.log(`  events: ${r.eventsInstalled.length ? r.eventsInstalled.join(', ') : '(none)'}`)
    console.log(`  settings: ${r.settingsPath}`)
    console.log(`  hook script: ${r.hookScriptPath} (${r.scriptExists ? 'exists' : 'MISSING'})`)
    if (r.error) console.log(`  ⚠️  ${r.error}`)
  })

openclawCmd.command('inbound')
  .description('OpenClaw skill 单入口：转发一条用户消息到 quadtodo wizard，stdout 是给用户的回复')
  .requiredOption('--from <peer>', '微信对端 user_id（OpenClaw 给的 from_user_id）')
  .requiredOption('--text <text>', '用户原文')
  .option('--port <port>', 'quadtodo 端口', (v) => Number(v))
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
      console.error(`  quadtodo 是不是没跑？试 'quadtodo status'`)
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

const cfgCmd = program.command('config').description('read/write ~/.quadtodo/config.json')
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
    // fallback：argv[1] 是 cli.js 或 bin 名 'quadtodo'
    if (process.argv[1].endsWith('cli.js')) return true
    if (/\/quadtodo$/.test(process.argv[1])) return true
    return false
  }
})()
if (isMain) {
  program.parseAsync(process.argv)
}
