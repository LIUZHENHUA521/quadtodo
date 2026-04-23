#!/usr/bin/env node
import { Command } from 'commander'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
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

  for (const tool of ['claude', 'codex']) {
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

// 仅当被作为可执行脚本运行时才 parse（import 进来做测试时跳过）
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1] && process.argv[1].endsWith('cli.js'))
if (isMain) {
  program.parseAsync(process.argv)
}
