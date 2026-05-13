# One-Key Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `npm i -g agentquad && agentquad` 这一行就能跑起来：默认 action + 首跑向导 + 端口 +1 重试 + pid 文件 JSON 化 + 发包卫生。

**Architecture:** 在现有 `src/cli.js` 的 `start` 命令上抽 `runStart` 复用，挂到 `program` 默认 action；`src/server.js` 加 `listenWithRetry`；新增 `src/first-run-wizard.js` 模块封装首跑交互；pid 文件升级为 JSON 但读侧向后兼容。

**Tech Stack:** Node 20+ / commander 12 / vitest 2 / readline / better-sqlite3

**Spec:** `docs/superpowers/specs/2026-05-13-one-key-launch-design.md`

**已确认的关键决策**：
- 方案 A + B（默认 action + 首跑向导）
- 端口被占用自动 +1 重试，最多 2 次
- pid 文件升级 JSON，老格式 fallback 读取
- 版本号 bump 0.2.0 → 0.3.0
- 显式 `--port` 时仍然 +1 重试（启动成功优先）
- 旧 `quadtodo-0.1.1.tgz` 清理 + `.gitignore` 加 `*.tgz`

---

## File Structure

**Create:**
- `src/first-run-wizard.js` — 首跑检测 + 交互
- `test/first-run-wizard.test.js` — 向导单测
- `test/listen-with-retry.test.js` — 端口重试单测
- `test/pid-file-format.test.js` — pid JSON 化单测
- `test/cli-default-action.test.js` — 默认 action 单测

**Modify:**
- `src/cli.js` — 抽 `runStart`、加默认 action、接首跑向导、pid 文件读写适配
- `src/server.js` — `listen` 加 EADDRINUSE +1 重试，返回真实 port
- `README.md` — "30 秒上手" 压成两行、命令表加默认行为、start 选项加 `--no-wizard`
- `docs/RELEASE.md` — 追加 "0.3.0 发版前清单"
- `package.json` — version bump 0.2.0 → 0.3.0
- `.gitignore` — 加 `*.tgz`

**Delete:**
- `quadtodo-0.1.1.tgz`（仓库根的旧 tarball）

---

## Task 1: 抽取 runStart，保持 `start` 行为零回归

**Files:**
- Modify: `src/cli.js:340-482`（`program.command('start')` action 体）
- Test: `test/cli.test.js`（追加 `runStart` 导出存在性检查）

- [ ] **Step 1: 写失败测试 —— runStart 已导出**

在 `test/cli.test.js` 顶层 import 块加入：

```js
import { runStart } from '../src/cli.js'
```

并在 `describe('cli helpers', ...)` 里加一个 case：

```js
it('exports runStart as an async function', () => {
  expect(typeof runStart).toBe('function')
  expect(runStart.constructor.name).toBe('AsyncFunction')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/cli.test.js -t "exports runStart"`
Expected: FAIL — `runStart is not exported from ../src/cli.js`

- [ ] **Step 3: 抽 runStart 函数**

在 `src/cli.js` 现有 `program.command('start')` 上方（约第 339 行）插入：

```js
// runStart：start 子命令的核心实现，导出给默认 action / 首跑向导复用
export async function runStart(cmdOpts = {}) {
  const rootDir = DEFAULT_ROOT_DIR
  const cfg = loadConfig({ rootDir })
  const defaultCwd = cmdOpts.cwd || cfg.defaultCwd || process.env.HOME || process.cwd()
  const host = cmdOpts.expose
    ? '0.0.0.0'
    : (cmdOpts.host || cfg.host || '127.0.0.1')

  // ─── 把整段现有 action 体复制到这里 (logs setup + pid 检查 + createServer + listen + banner + hook bootstrap + open + shutdown) ───
  // ↓↓↓ 把 src/cli.js:346-482 行 .action(async (cmdOpts) => { ... }) 内的全部代码原样搬过来 ↓↓↓
  // 注意：cmdOpts.open !== false 这一处保留（commander --no-open 会把 .open 设为 false）
  // 注意：把所有 process.exit(1) 改成 throw new Error(msg) 让调用方决定退出策略——
  //       但 listen 失败这种本来就要退出，保留 process.exit；只有"already running"也保留 process.exit
}
```

然后把 `program.command('start').action(...)` 替换为：

```js
program.command('start')
  .option('-p, --port <port>', 'override port', (v) => Number(v))
  .option('--no-open', 'do not auto-open browser')
  .option('--cwd <path>', 'default cwd for AI terminal sessions')
  .option('--host <host>', 'bind address (e.g. 0.0.0.0 to allow Tailscale/LAN access)')
  .option('--expose', 'shorthand for --host 0.0.0.0 (bind all interfaces)')
  .option('--no-wizard', 'skip first-run wizard even if config.json is absent')
  .action(async (cmdOpts) => { await runStart(cmdOpts) })
```

- [ ] **Step 4: 跑全套测试确认零回归**

Run: `npx vitest run test/cli.test.js`
Expected: PASS（包括新加的 runStart 导出测试 + 原有 cli 测试）

Run: `npx vitest run`
Expected: PASS — 整套测试不破。

- [ ] **Step 5: 手测 `agentquad start` 行为不变**

Run:
```bash
node src/cli.js start --no-open
# 几秒后另一个终端：
curl -s http://127.0.0.1:5677/api/status
# 关掉：
node src/cli.js stop
```
Expected: banner 输出 + status 接口返回 JSON + stop 成功清理 pid。

- [ ] **Step 6: Commit**

```bash
git add src/cli.js test/cli.test.js
git commit -m "refactor(cli): 抽取 runStart 函数供默认 action 复用"
git push origin main
```

---

## Task 2: server.js 加 listenWithRetry，端口 +1 重试一次

**Files:**
- Modify: `src/server.js:1682-1691`（现有 `listen` 函数）
- Test: `test/listen-with-retry.test.js`

- [ ] **Step 1: 写失败测试**

新建 `test/listen-with-retry.test.js`：

```js
import { describe, it, expect, afterEach } from 'vitest'
import { createServer } from 'node:http'
import { listenWithRetry } from '../src/server.js'

describe('listenWithRetry', () => {
  const servers = []
  afterEach(async () => {
    for (const s of servers) await new Promise((r) => s.close(r))
    servers.length = 0
  })

  it('listens on requested port when free', async () => {
    const s = createServer()
    servers.push(s)
    const port = await listenWithRetry(s, 0, '127.0.0.1')
    expect(port).toBeGreaterThan(0)
    expect(s.address().port).toBe(port)
  })

  it('retries port+1 once when EADDRINUSE', async () => {
    const blocker = createServer().listen(0, '127.0.0.1')
    await new Promise((r) => blocker.once('listening', r))
    servers.push(blocker)
    const taken = blocker.address().port

    const s = createServer()
    servers.push(s)
    const port = await listenWithRetry(s, taken, '127.0.0.1')
    expect(port).toBe(taken + 1)
  })

  it('throws when both port and port+1 are taken', async () => {
    const b1 = createServer().listen(0, '127.0.0.1')
    await new Promise((r) => b1.once('listening', r))
    servers.push(b1)
    const taken = b1.address().port

    const b2 = createServer().listen(taken + 1, '127.0.0.1')
    await new Promise((r) => b2.once('listening', r))
    servers.push(b2)

    const s = createServer()
    servers.push(s)
    await expect(listenWithRetry(s, taken, '127.0.0.1')).rejects.toThrow(/EADDRINUSE/)
  })

  it('propagates non-EADDRINUSE errors immediately', async () => {
    const s = createServer()
    servers.push(s)
    await expect(listenWithRetry(s, 65536, '127.0.0.1')).rejects.toThrow()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/listen-with-retry.test.js`
Expected: FAIL — `listenWithRetry is not exported from ../src/server.js`

- [ ] **Step 3: 实现 listenWithRetry**

在 `src/server.js` 文件顶部（其他 helper 旁）新增并 export：

```js
export async function listenWithRetry(server, port, host, { maxAttempts = 2 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    const tryPort = port + i
    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => {
          server.off('listening', onListening)
          reject(err)
        }
        const onListening = () => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(tryPort, host)
      })
      return tryPort
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || i === maxAttempts - 1) throw err
      console.warn(`port ${tryPort} in use, retrying ${tryPort + 1}...`)
    }
  }
}
```

修改原有 `listen` 函数（约 1682 行）：

```js
function listen(port, host = "127.0.0.1") {
  return listenWithRetry(httpServer, port, host, { maxAttempts: 2 })
}
```

调用方 `listen()` 现在返回真实端口（Number），原本 resolve 的是 `address()`。检查 `src/cli.js` 内 `await srv.listen(port, host)` 的使用 —— 把返回值赋给 `actualPort` 并往下传给 banner / open。

具体改 `runStart` 内：

```js
let actualPort
try {
  actualPort = await srv.listen(port, host)
} catch (e) {
  // 现有错误处理保留
}
// 后面所有 banner / open 用 actualPort 替换 port：
writeFileSync(pf, ...)            // 见 Task 3 改 JSON
console.log(buildStartupBanner({ port: actualPort, host }))
// open(`http://127.0.0.1:${actualPort}`)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/listen-with-retry.test.js`
Expected: PASS（4 个 case 全绿）

Run: `npx vitest run test/cli.test.js test/ai-terminal.route.test.js`
Expected: PASS — 没把现有用 `listen` 的地方搞坏。

- [ ] **Step 5: 手测端口重试**

```bash
# 终端 A
nc -l 127.0.0.1 5677    # 占住 5677
# 终端 B
node src/cli.js start --no-open
```
Expected: 终端 B banner 显示 `port 5678`，warn 中提到 `port 5677 in use, retrying 5678`。
清理：`node src/cli.js stop`，终端 A `Ctrl-C`。

- [ ] **Step 6: Commit**

```bash
git add src/server.js src/cli.js test/listen-with-retry.test.js
git commit -m "feat(server): listen EADDRINUSE 时自动 +1 重试一次"
git push origin main
```

---

## Task 3: pid 文件 JSON 化（写新格式 + 读兼容老）

**Files:**
- Modify: `src/cli.js`（`runStart` 内 `writeFileSync(pf, ...)`，`stop` / `status` 内 pid 读取处）
- Test: `test/pid-file-format.test.js`

- [ ] **Step 1: 写失败测试**

新建 `test/pid-file-format.test.js`：

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writePidFile, readPidFile } from '../src/cli.js'

describe('pid file JSON format', () => {
  let dir
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aq-pid-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('writes JSON with pid/port/host/startedAt', () => {
    writePidFile(dir, { pid: 12345, port: 5678, host: '127.0.0.1' })
    const raw = readFileSync(join(dir, 'agentquad.pid'), 'utf8')
    const obj = JSON.parse(raw)
    expect(obj.pid).toBe(12345)
    expect(obj.port).toBe(5678)
    expect(obj.host).toBe('127.0.0.1')
    expect(typeof obj.startedAt).toBe('string')
  })

  it('reads JSON format', () => {
    writeFileSync(join(dir, 'agentquad.pid'), JSON.stringify({ pid: 999, port: 6000, host: 'x' }))
    const got = readPidFile(dir)
    expect(got).toEqual({ pid: 999, port: 6000, host: 'x' })
  })

  it('reads legacy plain-number format and returns { pid }', () => {
    writeFileSync(join(dir, 'agentquad.pid'), '4242')
    const got = readPidFile(dir)
    expect(got.pid).toBe(4242)
    expect(got.port).toBeUndefined()
  })

  it('returns null when pid file missing', () => {
    expect(readPidFile(dir)).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/pid-file-format.test.js`
Expected: FAIL — `writePidFile / readPidFile is not exported from ../src/cli.js`

- [ ] **Step 3: 在 cli.js 加 writePidFile / readPidFile**

在 `src/cli.js` 现有 `pidFile()` 函数下方加入：

```js
export function writePidFile(rootDir, { pid, port, host }) {
  const payload = { pid, port, host, startedAt: new Date().toISOString() }
  writeFileSync(pidFile(rootDir), JSON.stringify(payload))
}

export function readPidFile(rootDir) {
  const pf = pidFile(rootDir)
  if (!existsSync(pf)) return null
  const raw = readFileSync(pf, 'utf8').trim()
  try {
    const obj = JSON.parse(raw)
    if (obj && typeof obj.pid === 'number') return obj
  } catch { /* legacy plain-number */ }
  const n = Number(raw)
  if (Number.isFinite(n) && n > 0) return { pid: n }
  return null
}
```

把 `runStart` 内 `writeFileSync(pf, String(process.pid))` 替换为：

```js
writePidFile(rootDir, { pid: process.pid, port: actualPort, host })
```

把 `runStart` 内"already running" 检查（`Number(readFileSync(pf, 'utf8'))`）替换为：

```js
const existing = readPidFile(rootDir)
if (existing && isAlive(existing.pid)) {
  const where = existing.port ? `http://${existing.host || '127.0.0.1'}:${existing.port}` : '(unknown port)'
  console.error(`AgentQuad already running (pid ${existing.pid}) at ${where}. Run 'agentquad stop' first.`)
  process.exit(1)
}
if (existing) { try { unlinkSync(pf) } catch { /* ignore */ } }
```

同样改 `stop` / `status`：

`stop`（约 484-507）：
```js
const info = readPidFile(DEFAULT_ROOT_DIR)
if (!info) { console.log('AgentQuad is not running (no pid file)'); return }
const pid = info.pid
// ... 后面照旧
```

`status`（约 509-527）：
```js
const info = readPidFile(DEFAULT_ROOT_DIR)
if (!info) { console.log('not running'); return }
const pid = info.pid
if (!isAlive(pid)) { console.log(`stale pid file (${pid}), not running`); return }
const port = info.port ?? loadConfig().port  // 优先用 pid 文件里的真实 port
// ... 后面照旧
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/pid-file-format.test.js test/cli.test.js`
Expected: PASS（新单测 4 个全过 + 原 cli 测试不破）

- [ ] **Step 5: 手测**

```bash
node src/cli.js start --no-open
cat ~/.agentquad/agentquad.pid           # JSON
node src/cli.js status                   # 显示 pid + 真实 port
node src/cli.js stop
```
Expected: pid 文件是 JSON；status 输出含真实 port；stop 成功。

模拟 legacy 格式：
```bash
node src/cli.js start --no-open
node src/cli.js stop
echo -n "99999" > ~/.agentquad/agentquad.pid   # 写 legacy 格式
node src/cli.js status                          # 应识别为 stale 而非崩溃
rm ~/.agentquad/agentquad.pid
```
Expected: status 输出 `stale pid file (99999), not running`。

- [ ] **Step 6: Commit**

```bash
git add src/cli.js test/pid-file-format.test.js
git commit -m "feat(cli): pid 文件升级 JSON 格式（含 port/host），保留老格式读兼容"
git push origin main
```

---

## Task 4: 首跑向导模块（first-run-wizard.js）

**Files:**
- Create: `src/first-run-wizard.js`
- Test: `test/first-run-wizard.test.js`

- [ ] **Step 1: 写失败测试**

新建 `test/first-run-wizard.test.js`：

```js
import { describe, it, expect, vi } from 'vitest'
import { shouldRunWizard, runFirstRunWizard } from '../src/first-run-wizard.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('shouldRunWizard', () => {
  let dir
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aq-wiz-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('returns false when config.json exists (not first run)', () => {
    writeFileSync(join(dir, 'config.json'), '{}')
    expect(shouldRunWizard({ rootDir: dir, isTTY: true, env: {}, flags: {} })).toBe(false)
  })

  it('returns false when stdin is not TTY', () => {
    expect(shouldRunWizard({ rootDir: dir, isTTY: false, env: {}, flags: {} })).toBe(false)
  })

  it('returns false when AGENTQUAD_SKIP_WIZARD=1', () => {
    expect(shouldRunWizard({ rootDir: dir, isTTY: true, env: { AGENTQUAD_SKIP_WIZARD: '1' }, flags: {} })).toBe(false)
  })

  it('returns false when --no-wizard flag set', () => {
    expect(shouldRunWizard({ rootDir: dir, isTTY: true, env: {}, flags: { wizard: false } })).toBe(false)
  })

  it('returns true when first-run + TTY + no skip', () => {
    expect(shouldRunWizard({ rootDir: dir, isTTY: true, env: {}, flags: {} })).toBe(true)
  })
})

describe('runFirstRunWizard', () => {
  it('skips tool install when both already present', async () => {
    const checks = { claude: vi.fn(() => true), codex: vi.fn(() => true) }
    const installTools = vi.fn()
    const ask = vi.fn()
    const r = await runFirstRunWizard({ checks, installTools, ask, log: () => {} })
    expect(installTools).not.toHaveBeenCalled()
    expect(r.installedTools).toEqual([])
    expect(['claude', 'codex']).toContain(r.defaultTool)
  })

  it('prompts to install when claude missing, user says Y → installs', async () => {
    const checks = { claude: vi.fn(() => false), codex: vi.fn(() => true) }
    const installTools = vi.fn(async () => 0)
    const ask = vi.fn()
      .mockResolvedValueOnce('y')      // install?
      .mockResolvedValueOnce('')        // default tool (Enter = claude)
    const r = await runFirstRunWizard({ checks, installTools, ask, log: () => {} })
    expect(installTools).toHaveBeenCalledOnce()
    expect(r.installedTools).toContain('claude')
  })

  it('continues startup even when user declines install', async () => {
    const checks = { claude: vi.fn(() => false), codex: vi.fn(() => false) }
    const installTools = vi.fn()
    const ask = vi.fn().mockResolvedValueOnce('n').mockResolvedValueOnce('')
    const r = await runFirstRunWizard({ checks, installTools, ask, log: () => {} })
    expect(installTools).not.toHaveBeenCalled()
    expect(r.skippedInstall).toBe(true)
  })
})

// 顶部补 beforeEach/afterEach import
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/first-run-wizard.test.js`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现 first-run-wizard.js**

新建 `src/first-run-wizard.js`：

```js
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import readline from 'node:readline'

export function shouldRunWizard({ rootDir, isTTY, env, flags }) {
  if (env.AGENTQUAD_SKIP_WIZARD === '1' || env.AGENTQUAD_SKIP_WIZARD === 'true') return false
  if (flags?.wizard === false) return false
  if (!isTTY) return false
  if (existsSync(join(rootDir, 'config.json'))) return false
  if (existsSync(join(rootDir, 'data.db'))) return false
  return true
}

export function defaultAsk(stdin = process.stdin, stdout = process.stdout) {
  return (question) => new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, output: stdout })
    rl.question(question, (ans) => { rl.close(); resolve(ans) })
  })
}

export function defaultChecks() {
  const has = (bin) => spawnSync('command', ['-v', bin], { encoding: 'utf8', shell: '/bin/sh' }).status === 0
  return { claude: () => has('claude'), codex: () => has('codex') }
}

export async function defaultInstallTools(tools) {
  const r = spawnSync(process.execPath, [
    new URL('./cli.js', import.meta.url).pathname,
    'install-tools',
    ...tools.map((t) => `--${t}`),
    '-y',
  ], { stdio: 'inherit' })
  return r.status ?? 1
}

export async function runFirstRunWizard({
  checks = defaultChecks(),
  installTools = defaultInstallTools,
  ask = defaultAsk(),
  log = console.log,
} = {}) {
  log('\n👋 第一次启动 AgentQuad。\n')

  const claudeOK = checks.claude()
  const codexOK = checks.codex()
  const missing = []
  if (!claudeOK) missing.push('claude')
  if (!codexOK) missing.push('codex')

  let installedTools = []
  let skippedInstall = false

  if (missing.length > 0) {
    log(`[1/2] 检测到未安装：${missing.join(', ')}（AI 终端必需）`)
    const ans = (await ask(`      运行 'agentquad install-tools --all' 自动安装？(Y/n) `)).trim().toLowerCase()
    if (ans === '' || ans === 'y' || ans === 'yes') {
      const code = await installTools(missing)
      if (code === 0) installedTools = [...missing]
      else log('\n⚠ 工具安装失败，AI 终端将不可用。修复后跑 agentquad install-tools --all\n')
    } else {
      skippedInstall = true
    }
  }

  const available = []
  if (claudeOK || installedTools.includes('claude')) available.push('claude')
  if (codexOK || installedTools.includes('codex')) available.push('codex')

  let defaultTool = 'claude'
  if (available.length > 0) {
    const optsStr = available.join(' / ')
    const ans = (await ask(`[2/2] 选择默认 AI 工具 (${optsStr}) [默认: ${available[0]}]: `)).trim().toLowerCase()
    defaultTool = available.includes(ans) ? ans : available[0]
  }

  return { skipped: false, installedTools, defaultTool, skippedInstall }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/first-run-wizard.test.js`
Expected: PASS（8 个 case 全绿）

- [ ] **Step 5: Commit**

```bash
git add src/first-run-wizard.js test/first-run-wizard.test.js
git commit -m "feat(cli): 新增 first-run-wizard 模块（检测首跑 + 引导装工具 + 选默认工具）"
git push origin main
```

---

## Task 5: runStart 接首跑向导 + 默认 action 挂载

**Files:**
- Modify: `src/cli.js`（runStart 内开头、program 顶层）
- Test: `test/cli-default-action.test.js`

- [ ] **Step 1: 写失败测试**

新建 `test/cli-default-action.test.js`：

```js
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url))

describe('default action', () => {
  it('bare `agentquad` does NOT print commander help when no args', () => {
    // 跑 cli.js 不带任何参数 + 立即 --help 不会触发；用 dry-run 环境变量让 runStart 早退
    const r = spawnSync(process.execPath, [CLI], {
      encoding: 'utf8',
      env: { ...process.env, AGENTQUAD_DRY_RUN: '1', AGENTQUAD_SKIP_WIZARD: '1' },
      timeout: 5000,
    })
    expect(r.stdout || r.stderr).not.toMatch(/Usage: agentquad \[options\] \[command\]/)
  })

  it('`agentquad --help` still prints help', () => {
    const r = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8', timeout: 5000 })
    expect(r.stdout).toMatch(/Usage: agentquad/)
    expect(r.stdout).toMatch(/start/)
    expect(r.stdout).toMatch(/install-tools/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/cli-default-action.test.js`
Expected: FAIL — 默认调用会打印 help。

- [ ] **Step 3: 接入首跑向导 + 加默认 action**

在 `src/cli.js` 顶部 import 加：

```js
import { shouldRunWizard, runFirstRunWizard } from './first-run-wizard.js'
```

在 `runStart` 函数体最开头（在 logs setup 之前）加：

```js
// 首跑向导（命中条件才进；任何异常都不阻塞后续 start）
try {
  const need = shouldRunWizard({
    rootDir,
    isTTY: !!process.stdin.isTTY && !!process.stdout.isTTY,
    env: process.env,
    flags: { wizard: cmdOpts.wizard !== false },
  })
  if (need) {
    const r = await runFirstRunWizard()
    if (r.defaultTool) {
      // 写默认工具到 config（loadConfig 已经在 runStart 顶部读完了，这里直接 set）
      setConfigValue('defaultTool', r.defaultTool, { rootDir })
    }
  }
} catch (e) {
  console.warn(`⚠ first-run wizard skipped: ${e?.message || e}`)
}

// dry-run 短路（仅用于测试，让默认 action 测试不真起服务）
if (process.env.AGENTQUAD_DRY_RUN === '1') return
```

在 `program.command('start')...` 之后、`program.command('stop')` 之前，加默认 action：

```js
// 裸跑 `agentquad`（无子命令）→ 复用 start 逻辑，默认开向导
program
  .option('--no-wizard', 'skip first-run wizard')
  .action(async (cmdOpts) => {
    await runStart({ ...cmdOpts })
  })
```

注意：commander 12 的默认 action 在子命令未匹配时触发；`--help` / `-V` 不会触发 default action（commander 内置短路）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/cli-default-action.test.js`
Expected: PASS（2 个 case 全绿）

- [ ] **Step 5: 手测**

```bash
# 干净环境模拟首跑
mv ~/.agentquad ~/.agentquad.bak 2>/dev/null
AGENTQUAD_SKIP_WIZARD=1 node src/cli.js --no-open    # 应该直接起服务，不问向导
node src/cli.js stop
# 恢复
rm -rf ~/.agentquad && mv ~/.agentquad.bak ~/.agentquad 2>/dev/null
```
Expected: 不弹向导（SKIP），banner 正常输出，stop 成功。

`agentquad --help` 仍有完整子命令列表。

- [ ] **Step 6: Commit**

```bash
git add src/cli.js test/cli-default-action.test.js
git commit -m "feat(cli): 默认 action + 首跑向导接入 runStart"
git push origin main
```

---

## Task 6: README + RELEASE.md 文档更新

**Files:**
- Modify: `README.md`
- Modify: `docs/RELEASE.md`

- [ ] **Step 1: 改 README 30 秒上手**

编辑 `README.md`，把 `## 30 秒上手` 段落（约第 9-19 行）替换为：

```markdown
## 30 秒上手

\`\`\`bash
npm install -g agentquad
agentquad                          # 第一次会引导装 claude / codex 并选默认工具
\`\`\`

> 浏览器自动打开 http://127.0.0.1:5677
> 跳过首跑向导：`AGENTQUAD_SKIP_WIZARD=1 agentquad` 或 `agentquad --no-wizard`
> 端口 5677 被占用时会自动尝试 5678。

> **平台**：仅支持 macOS / Linux；Windows 暂不支持，规划中。
```

- [ ] **Step 2: 命令表加默认行为说明**

在 README 的命令表里（约第 123 行附近），在 `agentquad start ...` 那一行**之前**插一行：

```markdown
| `agentquad`（无参数）| 等价于 `agentquad start`，首次启动会引导装 AI 工具 |
```

`agentquad start` 那一行 options 末尾追加 `[--no-wizard]`，描述加："--no-wizard 跳过首跑向导"。

- [ ] **Step 3: RELEASE.md 追加 0.3.0 发版清单**

在 `docs/RELEASE.md` 末尾追加：

```markdown
---

## 0.3.0 发版前清单（一键启动版）

- [ ] 仓库根目录无 `*.tgz`（删旧的 `quadtodo-*.tgz` / `agentquad-*.tgz`）
- [ ] `.gitignore` 已含 `*.tgz`
- [ ] `package.json` version = `0.3.0`
- [ ] `npm pack --dry-run` 列表确认：
  - 含 `src/cli.js` / `src/server.js` / `src/first-run-wizard.js`
  - 含 `dist-web/index.html`
  - **不**含 `node_modules/` / `web/node_modules/` / `tmp/` / `*.test.js` / `mira-proxy/`
  - tarball 体积 < 10 MB
- [ ] 干净目录 `npm i -g ./agentquad-0.3.0.tgz` 无 native 编译错
- [ ] `agentquad --version` = `0.3.0`
- [ ] **裸跑测试**：`mv ~/.agentquad ~/.agentquad.bak && agentquad`
  - 弹出首跑向导
  - 同意安装 claude/codex 后服务起来
  - 浏览器自动打开看板
- [ ] **二次跑**：`agentquad`，不再问向导，直接起服务
- [ ] **端口重试**：`nc -l 127.0.0.1 5677 &` 占住 → `agentquad` 应自动用 5678
- [ ] **pid 文件 JSON**：`cat ~/.agentquad/agentquad.pid` 是 JSON，包含 `pid` / `port` / `host` / `startedAt`
- [ ] `agentquad stop` 正确停服 + 清理 pid 文件
- [ ] **break 说明已写入 README 故障排除**：0.3.0 起 pid 文件改 JSON，用户应使用 `agentquad stop` 而非手动 `kill $(cat pid)`
- [ ] `quadtodo` alias 行为与 `agentquad` 一致（同一份 cli.js 验证）
- [ ] `npm publish --dry-run` 列表最终确认
- [ ] `npm publish`
- [ ] `npm view agentquad version` = `0.3.0`
```

- [ ] **Step 4: README 故障排除补 pid 文件 break note**

在 `README.md` 的"故障排除"段（约第 239 行起）末尾追加一条：

```markdown
- **0.3.0 升级提示**：从 0.2.x 升上来后，pid 文件格式从纯数字改为 JSON。旧脚本里如果有 `kill $(cat ~/.agentquad/agentquad.pid)` 会失败 —— 请改用 `agentquad stop`。
```

- [ ] **Step 5: Commit**

```bash
git add README.md docs/RELEASE.md
git commit -m "docs: 30 秒上手压成两行，RELEASE 加 0.3.0 一键启动验证清单"
git push origin main
```

---

## Task 7: 发包卫生 —— 清旧 tgz + .gitignore + version bump + npm pack 验收

**Files:**
- Delete: `quadtodo-0.1.1.tgz`
- Modify: `.gitignore`
- Modify: `package.json`

- [ ] **Step 1: 删旧 tarball + 更新 .gitignore**

```bash
rm -f quadtodo-0.1.1.tgz
```

编辑 `.gitignore`，在已有规则末尾加：

```
# 本地构建产物
*.tgz
```

- [ ] **Step 2: package.json bump version**

打开 `package.json`，把 `"version": "0.2.0"` 改为 `"version": "0.3.0"`。

- [ ] **Step 3: 跑全套测试做最后回归**

Run: `npx vitest run`
Expected: PASS — 全套测试包含本计划新增的 4 个测试文件全部绿。

- [ ] **Step 4: npm pack dry-run 验收**

```bash
npm pack --dry-run 2>&1 | tee /tmp/agentquad-pack.txt
```
Expected: 输出列表里：
- 含 `src/cli.js`、`src/server.js`、`src/first-run-wizard.js`
- 含 `dist-web/index.html`（如果 dist-web 没 build 过：先 `npm run build:all`）
- **不**含 `node_modules/`、`web/node_modules/`、`tmp/`、`test/`、`mira-proxy/`
- 总大小 < 10 MB

如缺 `dist-web`，先 build：
```bash
npm run build:all
npm pack --dry-run
```

- [ ] **Step 5: 真实 pack + 在临时目录安装验证**

```bash
npm pack
ls agentquad-0.3.0.tgz   # 确认生成
mkdir -p /tmp/aq-smoke && cd /tmp/aq-smoke
npm i -g $OLDPWD/agentquad-0.3.0.tgz   # 或 sudo / 调 nvm
which agentquad
agentquad --version       # 0.3.0
agentquad --help          # 子命令列表完整
cd $OLDPWD
rm -f agentquad-0.3.0.tgz   # 别提交 tarball
```
Expected: 全部通过，最后无 tarball 残留。

- [ ] **Step 6: Commit**

```bash
git add .gitignore package.json
git commit -m "chore(release): bump 0.3.0、清旧 tgz、ignore *.tgz"
git push origin main
```

---

## 全量验收

按 `docs/RELEASE.md` 末尾的 "0.3.0 发版前清单" 全部跑过即可。

`npm publish` 是最后一步，主人手动确认后再做。

---

## Self-Review

✅ **Spec coverage**：spec 3.1（默认 action / runStart 抽取）→ Task 1+5；3.2（首跑向导）→ Task 4+5；3.3（端口 +1 + pid JSON）→ Task 2+3；3.4（package.json bump）→ Task 7；3.5（README）→ Task 6；3.6（RELEASE.md）→ Task 6；3.7（旧 tgz 清理 + .gitignore）→ Task 7。无遗漏。

✅ **Placeholder scan**：所有"复制现有代码"处都标了精确行号区间（cli.js:346-482）；所有命令、文件路径、JSON 字段都给出实际值；无 TBD/TODO。

✅ **Type consistency**：`writePidFile(rootDir, { pid, port, host })` 与 `readPidFile(rootDir)` 在 Task 3、5 一致；`runStart(cmdOpts)` 在 Task 1、5 签名一致；`shouldRunWizard({ rootDir, isTTY, env, flags })` 在 Task 4 测试与实现一致；`listenWithRetry(server, port, host, opts)` 在 Task 2 测试与实现一致；`runFirstRunWizard` 返回 `{ skipped, installedTools, defaultTool, skippedInstall }` 在测试与调用方一致。
