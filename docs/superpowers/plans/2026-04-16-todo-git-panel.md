# Todo Git 面板(阶段 1)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在每个 todo 卡片上增加 git 状态行与内嵌 git diff 面板,纯只读。

**Architecture:** 后端一个读取库(`src/git/gitStatus.js`)封装所有 `spawn('git')` 调用与错误分类,上层路由(`src/routes/git.js`)提供 REST 端点并维护进程内缓存,AI 会话 done 时通过 `onSessionDone` 回调触发缓存失效。前端 zustand store 统一管理每个 workDir 的 git 状态,两个组件 `TodoGitBadge` 和 `TodoGitDiffPanel` 订阅 store,`TodoGitDiffPanel` 使用 diff2html 渲染 `git diff HEAD` 原文。

**Tech Stack:** Node.js + Express(后端),vitest + supertest(测试),React 18 + zustand + AntD(前端),diff2html(新依赖,渲染统一 diff)。

---

## 文件结构

**新建**:

| 文件 | 职责 |
|------|------|
| `src/git/gitStatus.js` | `readGitStatus(workDir)` / `readGitDiff(workDir)` — 所有 `spawn('git')` 调用 + 错误分类,不抛异常 |
| `src/routes/git.js` | 工厂 `createGitRouter()`,返回 `{ router, invalidate }`;三个 REST 端点 + 进程内缓存 |
| `test/git-status.test.js` | `readGitStatus` / `readGitDiff` 单测(真实 `git init` tmpdir) |
| `test/git.route.test.js` | 路由 + 缓存 + 去重 supertest |
| `web/src/store/gitStatusStore.ts` | zustand `gitStatusStore` |
| `web/src/todo/TodoGitBadge.tsx` | 卡片一行紧凑展示(分支 / dirty / ↑↓) |
| `web/src/todo/TodoGitDiffPanel.tsx` | 内嵌折叠面板(状态头 + diff2html 渲染区) |

**修改**:

| 文件 | 修改 |
|------|------|
| `src/routes/ai-terminal.js` | `createAiTerminal` 构造参数加 `onSessionDone?` 回调,在 `pty.on('done')` 里调用 |
| `src/server.js` | 创建 git router,通过 `onSessionDone` 注入 `invalidate` |
| `test/ai-terminal.route.test.js` | 加 case:session done 触发 `onSessionDone` 且带 `cwd` |
| `web/src/TodoManage.tsx` | `fetchMany` on mount + 插入 Badge + Diff 按钮 + Panel;SessionViewer `onDone` 里追加 `refresh` |
| `web/package.json` | 加 `diff2html` 依赖 |

---

## Task 1:安装 diff2html 依赖

**Files:**
- Modify: `web/package.json`

- [ ] **Step 1:安装 diff2html**

```bash
cd web && npm install diff2html
```

Expected: `package.json` 新增 `"diff2html": "^3.x.x"`;`package-lock.json` 更新。

- [ ] **Step 2:验证 vite 能解析**

```bash
cd web && npx tsc --noEmit
```

Expected: EXIT=0,无 type 错误。

- [ ] **Step 3:Commit**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo
git add web/package.json web/package-lock.json
git commit -m "chore(web): add diff2html dependency for git diff rendering"
```

---

## Task 2:`gitStatus.js` 骨架 + "not_found" / "not_a_repo" 测试

**Files:**
- Create: `src/git/gitStatus.js`
- Create: `test/git-status.test.js`

- [ ] **Step 1:写失败测试 — 不存在的目录返回 not_found**

Create `test/git-status.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { readGitStatus, readGitDiff } from '../src/git/gitStatus.js'

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'quadtodo-git-'))
  execSync('git init -q', { cwd: dir })
  execSync('git config user.email "t@e.com"', { cwd: dir })
  execSync('git config user.name "t"', { cwd: dir })
  execSync('git config commit.gpgsign false', { cwd: dir })
  return dir
}

describe('readGitStatus', () => {
  let dirs = []
  afterEach(() => {
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
    dirs = []
  })

  it('returns not_found for non-existent dir', async () => {
    const r = await readGitStatus('/nonexistent/path/xyz123abc')
    expect(r.state).toBe('not_found')
  })

  it('returns not_a_repo for non-git dir', async () => {
    const d = mkdtempSync(join(tmpdir(), 'quadtodo-nogit-'))
    dirs.push(d)
    const r = await readGitStatus(d)
    expect(r.state).toBe('not_a_repo')
  })
})
```

- [ ] **Step 2:运行测试确认失败**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo
npx vitest run test/git-status.test.js
```

Expected: FAIL(模块 `src/git/gitStatus.js` 不存在)。

- [ ] **Step 3:实现骨架**

Create `src/git/gitStatus.js`:

```js
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'

const DEFAULT_TIMEOUT_MS = 5000

function runGit(args, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, env, maxBytes } = {}) {
  return new Promise((resolve) => {
    let proc
    try {
      proc = spawn('git', args, { cwd, env: env || process.env })
    } catch (e) {
      resolve({ error: 'spawn_failed', code: e?.code || '', stderr: e?.message || '' })
      return
    }
    let stdout = Buffer.alloc(0)
    let stderr = ''
    let truncated = false
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { proc.kill('SIGTERM') } catch {}
      resolve({ error: 'timeout' })
    }, timeoutMs)
    proc.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ error: err?.code === 'ENOENT' ? 'git_missing' : 'spawn_failed', code: err?.code || '', stderr: err?.message || '' })
    })
    proc.stdout?.on('data', (chunk) => {
      if (maxBytes && stdout.length + chunk.length > maxBytes) {
        const remaining = Math.max(0, maxBytes - stdout.length)
        if (remaining > 0) stdout = Buffer.concat([stdout, chunk.slice(0, remaining)])
        truncated = true
        try { proc.kill('SIGTERM') } catch {}
      } else {
        stdout = Buffer.concat([stdout, chunk])
      }
    })
    proc.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
    proc.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout: stdout.toString('utf8'), stderr, truncated })
    })
  })
}

function checkDir(workDir) {
  if (!workDir || !existsSync(workDir)) return { state: 'not_found' }
  try {
    if (!statSync(workDir).isDirectory()) return { state: 'not_found' }
  } catch {
    return { state: 'not_found' }
  }
  return null
}

export async function readGitStatus(workDir, opts = {}) {
  const pre = checkDir(workDir)
  if (pre) return pre
  const isRepo = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: workDir, ...opts })
  if (isRepo.error === 'git_missing') return { state: 'git_missing' }
  if (isRepo.error === 'timeout') return { state: 'timeout' }
  if (isRepo.error) return { state: 'error', message: (isRepo.stderr || '').slice(0, 500) }
  if (isRepo.code !== 0 || (isRepo.stdout || '').trim() !== 'true') return { state: 'not_a_repo' }
  return { state: 'ok', branch: '', dirty: 0, ahead: 0, behind: 0, hasUpstream: false }
}

export async function readGitDiff(workDir, opts = {}) {
  const pre = checkDir(workDir)
  if (pre) return pre
  return { state: 'ok', diff: '', untracked: [], truncated: false }
}
```

- [ ] **Step 4:运行测试确认通过**

```bash
npx vitest run test/git-status.test.js
```

Expected: 2 PASS。

- [ ] **Step 5:Commit**

```bash
git add src/git/gitStatus.js test/git-status.test.js
git commit -m "feat(git): gitStatus skeleton with dir/repo checks"
```

---

## Task 3:`gitStatus` — branch + dirty + upstream 字段

**Files:**
- Modify: `src/git/gitStatus.js`
- Modify: `test/git-status.test.js`

- [ ] **Step 1:写失败测试 — 分支名/dirty/upstream**

Append to `test/git-status.test.js`(在最后 `describe` 块内):

```js
  it('fresh repo: branch present, dirty=0, no upstream', async () => {
    const d = makeRepo(); dirs.push(d)
    execSync('git commit --allow-empty -m "init"', { cwd: d })
    const r = await readGitStatus(d)
    expect(r.state).toBe('ok')
    expect(r.branch).toMatch(/^(main|master)$/)
    expect(r.dirty).toBe(0)
    expect(r.hasUpstream).toBe(false)
    expect(r.ahead).toBe(0)
    expect(r.behind).toBe(0)
  })

  it('dirty files counted (modified + untracked)', async () => {
    const d = makeRepo(); dirs.push(d)
    writeFileSync(join(d, 'a.txt'), 'x')
    execSync('git add a.txt && git commit -m "a"', { cwd: d })
    writeFileSync(join(d, 'a.txt'), 'xx')       // modified
    writeFileSync(join(d, 'b.txt'), 'new')       // untracked
    const r = await readGitStatus(d)
    expect(r.state).toBe('ok')
    expect(r.dirty).toBe(2)
  })

  it('upstream set: ahead/behind computed', async () => {
    const remote = mkdtempSync(join(tmpdir(), 'quadtodo-remote-'))
    dirs.push(remote)
    execSync('git init -q --bare', { cwd: remote })
    const d = makeRepo(); dirs.push(d)
    writeFileSync(join(d, 'a.txt'), 'x')
    execSync('git add a.txt && git commit -m "a"', { cwd: d })
    execSync(`git remote add origin ${remote}`, { cwd: d })
    execSync('git push -u origin HEAD', { cwd: d })
    writeFileSync(join(d, 'b.txt'), 'y')
    execSync('git add b.txt && git commit -m "b"', { cwd: d })
    writeFileSync(join(d, 'c.txt'), 'z')
    execSync('git add c.txt && git commit -m "c"', { cwd: d })
    const r = await readGitStatus(d)
    expect(r.state).toBe('ok')
    expect(r.hasUpstream).toBe(true)
    expect(r.ahead).toBe(2)
    expect(r.behind).toBe(0)
  })

  it('detached HEAD: branch field is HEAD, headShort present', async () => {
    const d = makeRepo(); dirs.push(d)
    writeFileSync(join(d, 'a.txt'), 'x')
    execSync('git add a.txt && git commit -m "a"', { cwd: d })
    const sha = execSync('git rev-parse HEAD', { cwd: d }).toString().trim()
    execSync(`git checkout ${sha}`, { cwd: d })
    const r = await readGitStatus(d)
    expect(r.state).toBe('ok')
    expect(r.branch).toBe('HEAD')
    expect(r.headShort).toMatch(/^[0-9a-f]{7}$/)
  })
```

- [ ] **Step 2:运行测试确认失败**

```bash
npx vitest run test/git-status.test.js
```

Expected: 新 4 个 case 失败(branch 空串、dirty 始终 0 等)。

- [ ] **Step 3:补实现**

Replace `readGitStatus` in `src/git/gitStatus.js` with the full version:

```js
export async function readGitStatus(workDir, opts = {}) {
  const pre = checkDir(workDir)
  if (pre) return pre

  const isRepo = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: workDir, ...opts })
  if (isRepo.error === 'git_missing') return { state: 'git_missing' }
  if (isRepo.error === 'timeout') return { state: 'timeout' }
  if (isRepo.error) return { state: 'error', message: (isRepo.stderr || '').slice(0, 500) }
  if (isRepo.code !== 0 || (isRepo.stdout || '').trim() !== 'true') return { state: 'not_a_repo' }

  const branchRes = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workDir, ...opts })
  if (branchRes.error === 'timeout') return { state: 'timeout' }
  if (branchRes.error) return { state: 'error', message: (branchRes.stderr || '').slice(0, 500) }
  const branch = (branchRes.stdout || '').trim() || 'HEAD'

  let headShort
  if (branch === 'HEAD') {
    const shaRes = await runGit(['rev-parse', '--short=7', 'HEAD'], { cwd: workDir, ...opts })
    if (shaRes.code === 0) headShort = (shaRes.stdout || '').trim()
  }

  const statusRes = await runGit(['status', '--porcelain'], { cwd: workDir, ...opts })
  if (statusRes.error === 'timeout') return { state: 'timeout' }
  if (statusRes.error) return { state: 'error', message: (statusRes.stderr || '').slice(0, 500) }
  const dirty = (statusRes.stdout || '').split('\n').filter((l) => l.trim().length > 0).length

  let hasUpstream = false
  let ahead = 0
  let behind = 0
  const revListRes = await runGit(
    ['rev-list', '--count', '--left-right', '@{upstream}...HEAD'],
    { cwd: workDir, ...opts }
  )
  if (revListRes.error === 'timeout') return { state: 'timeout' }
  if (!revListRes.error && revListRes.code === 0) {
    const parts = (revListRes.stdout || '').trim().split(/\s+/)
    if (parts.length === 2) {
      hasUpstream = true
      behind = Number(parts[0]) || 0
      ahead = Number(parts[1]) || 0
    }
  }

  const out = { state: 'ok', branch, dirty, ahead, behind, hasUpstream }
  if (headShort) out.headShort = headShort
  return out
}
```

- [ ] **Step 4:运行测试确认全部通过**

```bash
npx vitest run test/git-status.test.js
```

Expected: 6 PASS。

- [ ] **Step 5:Commit**

```bash
git add src/git/gitStatus.js test/git-status.test.js
git commit -m "feat(git): readGitStatus returns branch/dirty/ahead/behind/hasUpstream"
```

---

## Task 4:`readGitDiff` — 实现与截断

**Files:**
- Modify: `src/git/gitStatus.js`
- Modify: `test/git-status.test.js`

- [ ] **Step 1:写失败测试**

Append to `test/git-status.test.js`:

```js
  it('diff: modified + untracked files', async () => {
    const d = makeRepo(); dirs.push(d)
    writeFileSync(join(d, 'a.txt'), 'hello\n')
    execSync('git add a.txt && git commit -m "a"', { cwd: d })
    writeFileSync(join(d, 'a.txt'), 'hello\nworld\n')
    writeFileSync(join(d, 'new.txt'), 'brand new\n')
    const r = await readGitDiff(d)
    expect(r.state).toBe('ok')
    expect(r.diff).toContain('a.txt')
    expect(r.diff).toContain('+world')
    expect(r.untracked).toContain('new.txt')
    expect(r.truncated).toBe(false)
  })

  it('diff: truncates when exceeding maxBytes', async () => {
    const d = makeRepo(); dirs.push(d)
    writeFileSync(join(d, 'big.txt'), '')
    execSync('git add big.txt && git commit -m "empty"', { cwd: d })
    const big = 'line\n'.repeat(5000)
    writeFileSync(join(d, 'big.txt'), big)
    const r = await readGitDiff(d, { maxBytes: 1024 })
    expect(r.state).toBe('ok')
    expect(r.truncated).toBe(true)
    expect(r.diff.length).toBeLessThanOrEqual(1024 + 256)
  })

  it('diff: not_a_repo for plain dir', async () => {
    const d = mkdtempSync(join(tmpdir(), 'quadtodo-nogit-diff-'))
    dirs.push(d)
    const r = await readGitDiff(d)
    expect(r.state).toBe('not_a_repo')
  })
```

- [ ] **Step 2:运行测试确认失败**

```bash
npx vitest run test/git-status.test.js
```

Expected: 3 新 case 失败(`diff` 空串,`truncated` 始终 false)。

- [ ] **Step 3:补实现**

Replace `readGitDiff` in `src/git/gitStatus.js`:

```js
export async function readGitDiff(workDir, opts = {}) {
  const pre = checkDir(workDir)
  if (pre) return pre
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : 200 * 1024

  const isRepo = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: workDir })
  if (isRepo.error === 'git_missing') return { state: 'git_missing' }
  if (isRepo.error === 'timeout') return { state: 'timeout' }
  if (isRepo.error) return { state: 'error', message: (isRepo.stderr || '').slice(0, 500) }
  if (isRepo.code !== 0 || (isRepo.stdout || '').trim() !== 'true') return { state: 'not_a_repo' }

  const diffRes = await runGit(['diff', 'HEAD'], { cwd: workDir, maxBytes })
  if (diffRes.error === 'timeout') return { state: 'timeout' }
  if (diffRes.error) return { state: 'error', message: (diffRes.stderr || '').slice(0, 500) }

  const untrackedRes = await runGit(['ls-files', '--others', '--exclude-standard'], { cwd: workDir })
  const untracked = untrackedRes.code === 0
    ? (untrackedRes.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean)
    : []

  return {
    state: 'ok',
    diff: diffRes.stdout || '',
    untracked,
    truncated: !!diffRes.truncated,
  }
}
```

- [ ] **Step 4:运行测试确认通过**

```bash
npx vitest run test/git-status.test.js
```

Expected: 全部 9 PASS。

- [ ] **Step 5:Commit**

```bash
git add src/git/gitStatus.js test/git-status.test.js
git commit -m "feat(git): readGitDiff with untracked list and byte-limit truncation"
```

---

## Task 5:Git router + 缓存 + 参数校验

**Files:**
- Create: `src/routes/git.js`
- Create: `test/git.route.test.js`

- [ ] **Step 1:写失败测试**

Create `test/git.route.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { createGitRouter } from '../src/routes/git.js'

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'quadtodo-gitroute-'))
  execSync('git init -q', { cwd: dir })
  execSync('git config user.email "t@e.com"', { cwd: dir })
  execSync('git config user.name "t"', { cwd: dir })
  execSync('git config commit.gpgsign false', { cwd: dir })
  writeFileSync(join(dir, 'a.txt'), 'x')
  execSync('git add a.txt && git commit -m "a"', { cwd: dir })
  return dir
}

function makeApp() {
  const app = express()
  app.use(express.json())
  const { router, invalidate } = createGitRouter()
  app.use('/api/git', router)
  return { app, invalidate }
}

describe('routes/git', () => {
  let dirs = []
  afterEach(() => {
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
    dirs = []
  })

  it('GET /status rejects missing workDir', async () => {
    const { app } = makeApp()
    const r = await request(app).get('/api/git/status')
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('bad_request')
  })

  it('GET /status rejects relative workDir', async () => {
    const { app } = makeApp()
    const r = await request(app).get('/api/git/status').query({ workDir: './foo' })
    expect(r.status).toBe(400)
  })

  it('GET /status returns ok state for real repo', async () => {
    const d = makeRepo(); dirs.push(d)
    const { app } = makeApp()
    const r = await request(app).get('/api/git/status').query({ workDir: d })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(r.body.status.state).toBe('ok')
    expect(typeof r.body.timestamp).toBe('number')
  })

  it('GET /status is cached (second call does not re-spawn)', async () => {
    const d = makeRepo(); dirs.push(d)
    const { app } = makeApp()
    const r1 = await request(app).get('/api/git/status').query({ workDir: d })
    const ts1 = r1.body.timestamp
    await new Promise(resolve => setTimeout(resolve, 20))
    const r2 = await request(app).get('/api/git/status').query({ workDir: d })
    expect(r2.body.timestamp).toBe(ts1)
  })

  it('POST /refresh bypasses cache', async () => {
    const d = makeRepo(); dirs.push(d)
    const { app } = makeApp()
    const r1 = await request(app).get('/api/git/status').query({ workDir: d })
    const ts1 = r1.body.timestamp
    await new Promise(resolve => setTimeout(resolve, 20))
    const r2 = await request(app).post('/api/git/refresh').send({ workDir: d })
    expect(r2.body.timestamp).toBeGreaterThan(ts1)
  })

  it('invalidate() drops cache for that workDir', async () => {
    const d = makeRepo(); dirs.push(d)
    const { app, invalidate } = makeApp()
    const r1 = await request(app).get('/api/git/status').query({ workDir: d })
    const ts1 = r1.body.timestamp
    invalidate(d)
    await new Promise(resolve => setTimeout(resolve, 20))
    const r2 = await request(app).get('/api/git/status').query({ workDir: d })
    expect(r2.body.timestamp).toBeGreaterThan(ts1)
  })

  it('GET /diff returns diff for modified repo', async () => {
    const d = makeRepo(); dirs.push(d)
    writeFileSync(join(d, 'a.txt'), 'xyz')
    const { app } = makeApp()
    const r = await request(app).get('/api/git/diff').query({ workDir: d })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(r.body.diff.state).toBe('ok')
    expect(r.body.diff.diff).toContain('a.txt')
  })
})
```

- [ ] **Step 2:运行测试确认失败**

```bash
npx vitest run test/git.route.test.js
```

Expected: FAIL — `src/routes/git.js` 不存在。

- [ ] **Step 3:实现**

Create `src/routes/git.js`:

```js
import { Router } from 'express'
import { resolve, isAbsolute } from 'node:path'
import { readGitStatus, readGitDiff } from '../git/gitStatus.js'

export function createGitRouter() {
  const cache = new Map()

  function invalidate(workDir) {
    if (!workDir) return
    cache.delete(resolve(workDir))
  }

  function validateAbsolute(workDir) {
    if (!workDir || typeof workDir !== 'string') return null
    if (!isAbsolute(workDir)) return null
    return resolve(workDir)
  }

  async function computeStatus(key) {
    const status = await readGitStatus(key)
    const entry = { status, timestamp: Date.now(), inflight: null }
    cache.set(key, entry)
    return entry
  }

  async function getOrComputeStatus(key) {
    const existing = cache.get(key)
    if (existing) {
      if (existing.inflight) {
        const status = await existing.inflight
        return cache.get(key) || { status, timestamp: Date.now(), inflight: null }
      }
      return existing
    }
    const placeholder = { status: null, timestamp: 0, inflight: null }
    placeholder.inflight = readGitStatus(key)
    cache.set(key, placeholder)
    const status = await placeholder.inflight
    const entry = { status, timestamp: Date.now(), inflight: null }
    cache.set(key, entry)
    return entry
  }

  const router = Router()

  router.get('/status', async (req, res) => {
    const key = validateAbsolute(req.query.workDir)
    if (!key) return res.status(400).json({ ok: false, error: 'bad_request' })
    try {
      const entry = await getOrComputeStatus(key)
      res.json({ ok: true, status: entry.status, timestamp: entry.timestamp })
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message || 'internal_error' })
    }
  })

  router.post('/refresh', async (req, res) => {
    const key = validateAbsolute(req.body?.workDir)
    if (!key) return res.status(400).json({ ok: false, error: 'bad_request' })
    try {
      const entry = await computeStatus(key)
      res.json({ ok: true, status: entry.status, timestamp: entry.timestamp })
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message || 'internal_error' })
    }
  })

  router.get('/diff', async (req, res) => {
    const key = validateAbsolute(req.query.workDir)
    if (!key) return res.status(400).json({ ok: false, error: 'bad_request' })
    try {
      const diff = await readGitDiff(key)
      res.json({ ok: true, diff })
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message || 'internal_error' })
    }
  })

  return { router, invalidate }
}
```

- [ ] **Step 4:运行测试确认全部通过**

```bash
npx vitest run test/git.route.test.js
```

Expected: 7 PASS。

- [ ] **Step 5:Commit**

```bash
git add src/routes/git.js test/git.route.test.js
git commit -m "feat(git): /api/git router with in-memory cache and invalidate"
```

---

## Task 6:AI 会话 done 触发 invalidate

**Files:**
- Modify: `src/routes/ai-terminal.js`
- Modify: `test/ai-terminal.route.test.js`

- [ ] **Step 1:写失败测试**

Open `test/ai-terminal.route.test.js` 并在 `describe('routes/ai-terminal', ...)` 的 `makeApp` 内加 `onSessionDone` 参数,再追加测试(添加到现有 describe 块尾):

修改 `makeApp`(line ~37-53):

```js
function makeApp(opts = {}) {
  const db = openDb(':memory:')
  const pty = new FakePty()
  const logDir = mkdtempSync(join(tmpdir(), 'quadtodo-log-'))
  const ait = createAiTerminal({
    db,
    pty,
    logDir,
    defaultCwd: opts.defaultCwd,
    getWebhookConfig: opts.getWebhookConfig,
    notifier: opts.notifier,
    onSessionDone: opts.onSessionDone,
  })
  const app = express()
  app.use(express.json())
  app.use('/api/ai-terminal', ait.router)
  return { app, db, pty, ait, logDir }
}
```

在 describe 块中追加测试(`it('...')` 链最后):

```js
  it('onSessionDone is called with cwd when pty emits done', async () => {
    const seen = []
    const onSessionDone = (session) => seen.push({ cwd: session?.cwd, todoId: session?.todoId })
    const localCtx = (() => {
      const db = openDb(':memory:')
      const pty = new FakePty()
      const logDir = mkdtempSync(join(tmpdir(), 'quadtodo-log-'))
      const ait = createAiTerminal({ db, pty, logDir, onSessionDone })
      const app = express()
      app.use(express.json())
      app.use('/api/ai-terminal', ait.router)
      return { app, db, pty }
    })()
    const todo = localCtx.db.createTodo({ title: 'T', quadrant: 1, workDir: '/tmp/somewhere' })
    await request(localCtx.app)
      .post('/api/ai-terminal/exec')
      .send({ todoId: todo.id, prompt: 'hi', tool: 'claude', cwd: '/tmp/somewhere' })
    const sid = localCtx.pty.started[0].sessionId
    localCtx.pty.emit('done', { sessionId: sid, exitCode: 0, fullLog: '', nativeId: 'n-1', stopped: false })
    expect(seen).toHaveLength(1)
    expect(seen[0].cwd).toBe('/tmp/somewhere')
    expect(seen[0].todoId).toBe(todo.id)
  })
```

- [ ] **Step 2:运行测试确认失败**

```bash
npx vitest run test/ai-terminal.route.test.js
```

Expected: 新 case FAIL(`onSessionDone` 参数未接入)。

注意:如果当前 `resolveSessionCwd` 会把不存在的 `/tmp/somewhere` 替换掉导致 cwd 变化,把断言改为先 resolve 后的实际值;或者在测试里用 `mkdtempSync` 造一个真实目录(推荐)。修改测试:

```js
    const realDir = mkdtempSync(join(tmpdir(), 'quadtodo-cwd-'))
    const todo = localCtx.db.createTodo({ title: 'T', quadrant: 1, workDir: realDir })
    await request(localCtx.app)
      .post('/api/ai-terminal/exec')
      .send({ todoId: todo.id, prompt: 'hi', tool: 'claude', cwd: realDir })
    const sid = localCtx.pty.started[0].sessionId
    localCtx.pty.emit('done', { sessionId: sid, exitCode: 0, fullLog: '', nativeId: 'n-1', stopped: false })
    expect(seen[0].cwd).toBe(realDir)
```

- [ ] **Step 3:在 ai-terminal.js 接入回调**

Modify `src/routes/ai-terminal.js` line 11(`createAiTerminal` 签名)加 `onSessionDone` 参数:

```js
export function createAiTerminal({ db, pty, logDir, defaultCwd, getDefaultCwd, getWebhookConfig, notifier: injectedNotifier, onSessionDone }) {
```

在 `pty.on('done', ...)` 回调函数体的末尾(`broadcastToSession(session, { type: 'done', ... })` 之后,在 `try { db.insertSessionLog ... }` 之前),加调用:

```js
    broadcastToSession(session, { type: 'done', exitCode, status: aiStatus })

    if (typeof onSessionDone === 'function') {
      try {
        onSessionDone(session)
      } catch (e) {
        console.warn('[ai-terminal] onSessionDone threw:', e?.message)
      }
    }
```

- [ ] **Step 4:运行测试确认通过**

```bash
npx vitest run test/ai-terminal.route.test.js
```

Expected: 全部 PASS(包括原有 case 和新 case)。

- [ ] **Step 5:Commit**

```bash
git add src/routes/ai-terminal.js test/ai-terminal.route.test.js
git commit -m "feat(ai-terminal): onSessionDone hook for post-run side effects"
```

---

## Task 7:`server.js` 挂载 git 路由并连线 invalidate

**Files:**
- Modify: `src/server.js`

- [ ] **Step 1:改 server.js**

在 `src/server.js` 文件顶部 import 区(line ~20 附近)加:

```js
import { createGitRouter } from "./routes/git.js";
```

在 `createServer` 函数内,`createAiTerminal` 调用之前创建 git router;然后把 `invalidate` 通过 `onSessionDone` 传给 `createAiTerminal`:

找到(line ~146):

```js
const ait = createAiTerminal({
    db,
    pty,
    logDir,
    getDefaultCwd: () => runtimeConfig.defaultCwd,
    getWebhookConfig: () => runtimeConfig.webhook,
});
```

改为:

```js
const gitRouter = createGitRouter();
const ait = createAiTerminal({
    db,
    pty,
    logDir,
    getDefaultCwd: () => runtimeConfig.defaultCwd,
    getWebhookConfig: () => runtimeConfig.webhook,
    onSessionDone: (session) => {
        if (session?.cwd) gitRouter.invalidate(session.cwd);
    },
});
```

在 `app.use("/api/ai-terminal", ait.router)` 那行(line ~385)之前或之后加:

```js
app.use("/api/git", gitRouter.router);
```

- [ ] **Step 2:跑全量后端测试**

```bash
npx vitest run
```

Expected: 全部 PASS,无回归。

- [ ] **Step 3:手动启动服务自检**

```bash
node src/cli.js start &
SERVER_PID=$!
sleep 2
curl -s "http://127.0.0.1:3001/api/git/status?workDir=$(pwd)" | head -c 400
echo ""
kill $SERVER_PID
```

(端口号以实际输出为准;目的是确认 `/api/git/status` 能返回 JSON 且 `status.state === 'ok'`)

Expected: 返回 `{"ok":true,"status":{"state":"ok","branch":"main",...},"timestamp":...}`。

- [ ] **Step 4:Commit**

```bash
git add src/server.js
git commit -m "feat(server): mount /api/git and invalidate cache on AI session done"
```

---

## Task 8:前端 zustand store

**Files:**
- Create: `web/src/store/gitStatusStore.ts`

- [ ] **Step 1:实现 store**

Create `web/src/store/gitStatusStore.ts`:

```ts
import { create } from 'zustand'

export type GitEntry =
  | { state: 'loading' }
  | {
      state: 'ok'
      branch: string
      dirty: number
      ahead: number
      behind: number
      hasUpstream: boolean
      headShort?: string
      timestamp: number
    }
  | {
      state: 'not_found' | 'not_a_repo' | 'git_missing' | 'timeout' | 'error'
      timestamp: number
      message?: string
    }

interface State {
  byWorkDir: Record<string, GitEntry>
}

interface Actions {
  fetch: (workDir: string) => Promise<void>
  refresh: (workDir: string) => Promise<void>
  fetchMany: (workDirs: string[]) => Promise<void>
}

async function requestStatus(path: string, init?: RequestInit): Promise<GitEntry> {
  try {
    const res = await fetch(path, init)
    if (!res.ok) {
      return { state: 'error', timestamp: Date.now(), message: `HTTP ${res.status}` }
    }
    const body = await res.json()
    if (!body?.ok) return { state: 'error', timestamp: Date.now(), message: body?.error || 'bad response' }
    const s = body.status
    if (s?.state === 'ok') {
      return {
        state: 'ok',
        branch: s.branch,
        dirty: s.dirty,
        ahead: s.ahead,
        behind: s.behind,
        hasUpstream: s.hasUpstream,
        headShort: s.headShort,
        timestamp: body.timestamp,
      }
    }
    return { state: s?.state || 'error', timestamp: body.timestamp || Date.now(), message: s?.message }
  } catch (e: any) {
    return { state: 'error', timestamp: Date.now(), message: e?.message || 'fetch failed' }
  }
}

export const useGitStatusStore = create<State & Actions>((set, get) => ({
  byWorkDir: {},

  fetch: async (workDir) => {
    if (!workDir) return
    if (get().byWorkDir[workDir]) return
    set((s) => ({ byWorkDir: { ...s.byWorkDir, [workDir]: { state: 'loading' } } }))
    const entry = await requestStatus(`/api/git/status?workDir=${encodeURIComponent(workDir)}`)
    set((s) => ({ byWorkDir: { ...s.byWorkDir, [workDir]: entry } }))
  },

  refresh: async (workDir) => {
    if (!workDir) return
    set((s) => ({ byWorkDir: { ...s.byWorkDir, [workDir]: { state: 'loading' } } }))
    const entry = await requestStatus('/api/git/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir }),
    })
    set((s) => ({ byWorkDir: { ...s.byWorkDir, [workDir]: entry } }))
  },

  fetchMany: async (workDirs) => {
    const unique = Array.from(new Set(workDirs.filter(Boolean)))
    await Promise.all(unique.map((wd) => get().fetch(wd)))
  },
}))
```

- [ ] **Step 2:确认 typecheck**

```bash
cd web && npx tsc --noEmit
```

Expected: EXIT=0。

- [ ] **Step 3:Commit**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo
git add web/src/store/gitStatusStore.ts
git commit -m "feat(web): gitStatusStore zustand for per-workDir git state"
```

---

## Task 9:`TodoGitBadge` 组件

**Files:**
- Create: `web/src/todo/TodoGitBadge.tsx`

- [ ] **Step 1:实现**

Create `web/src/todo/TodoGitBadge.tsx`:

```tsx
import { useEffect } from 'react'
import { Tooltip, Button } from 'antd'
import { BranchesOutlined, ReloadOutlined, WarningOutlined } from '@ant-design/icons'
import { useGitStatusStore, type GitEntry } from '../store/gitStatusStore'

interface Props {
  workDir: string | null | undefined
  onOpenDiff?: () => void
}

export default function TodoGitBadge({ workDir, onOpenDiff }: Props) {
  const entry = useGitStatusStore((s) => (workDir ? s.byWorkDir[workDir] : undefined))
  const fetchStatus = useGitStatusStore((s) => s.fetch)
  const refresh = useGitStatusStore((s) => s.refresh)

  useEffect(() => {
    if (workDir) fetchStatus(workDir)
  }, [workDir, fetchStatus])

  if (!workDir) return null
  if (!entry || entry.state === 'loading') {
    return <span className="todo-git-badge" style={{ color: '#999', fontSize: 12 }}>⎇ ...</span>
  }
  if (entry.state === 'not_a_repo') return null

  const handleRefresh = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (workDir) refresh(workDir)
  }

  const refreshBtn = (
    <Button
      type="text"
      size="small"
      icon={<ReloadOutlined style={{ fontSize: 11 }} />}
      onClick={handleRefresh}
      style={{ padding: '0 4px', height: 18 }}
      title="刷新"
    />
  )

  const clickable: React.CSSProperties = onOpenDiff
    ? { cursor: 'pointer' }
    : {}
  const handleOpen = (e: React.MouseEvent) => {
    e.stopPropagation()
    onOpenDiff?.()
  }

  if (entry.state === 'not_found') {
    return (
      <span className="todo-git-badge" style={{ color: '#cf1322', fontSize: 12 }}>
        <WarningOutlined /> 目录不存在 {refreshBtn}
      </span>
    )
  }
  if (entry.state === 'git_missing' || entry.state === 'timeout' || entry.state === 'error') {
    const label = entry.state === 'git_missing' ? 'git 未安装'
      : entry.state === 'timeout' ? '超时' : '状态获取失败'
    return (
      <Tooltip title={entry.message || label}>
        <span className="todo-git-badge" style={{ color: '#8c8c8c', fontSize: 12 }}>? {label} {refreshBtn}</span>
      </Tooltip>
    )
  }

  const ok = entry as Extract<GitEntry, { state: 'ok' }>
  const detached = ok.branch === 'HEAD' && ok.headShort
  return (
    <span
      className="todo-git-badge"
      style={{ color: '#555', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6, ...clickable }}
      onClick={handleOpen}
    >
      <span><BranchesOutlined /> {detached ? `HEAD (${ok.headShort})` : ok.branch}</span>
      {ok.dirty > 0 && <span style={{ color: '#fa8c16' }}>● {ok.dirty}</span>}
      {ok.hasUpstream && ok.ahead > 0 && <span style={{ color: '#52c41a' }}>↑{ok.ahead}</span>}
      {ok.hasUpstream && ok.behind > 0 && <span style={{ color: '#1890ff' }}>↓{ok.behind}</span>}
      {refreshBtn}
    </span>
  )
}
```

- [ ] **Step 2:typecheck**

```bash
cd web && npx tsc --noEmit
```

Expected: EXIT=0。

- [ ] **Step 3:Commit**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo
git add web/src/todo/TodoGitBadge.tsx
git commit -m "feat(web): TodoGitBadge shows branch/dirty/ahead-behind on card"
```

---

## Task 10:`TodoGitDiffPanel` 组件

**Files:**
- Create: `web/src/todo/TodoGitDiffPanel.tsx`

- [ ] **Step 1:实现**

Create `web/src/todo/TodoGitDiffPanel.tsx`:

```tsx
import { useEffect, useState, useMemo } from 'react'
import { Button, Tooltip, Space, Alert } from 'antd'
import { ReloadOutlined, CloseOutlined, UpOutlined, DownOutlined } from '@ant-design/icons'
import * as Diff2Html from 'diff2html'
import 'diff2html/bundles/css/diff2html.min.css'
import { useGitStatusStore, type GitEntry } from '../store/gitStatusStore'

interface DiffResponse {
  state: 'ok' | 'not_found' | 'not_a_repo' | 'git_missing' | 'timeout' | 'error'
  diff?: string
  untracked?: string[]
  truncated?: boolean
  message?: string
}

interface Props {
  workDir: string | null | undefined
  visible: boolean
  onClose: () => void
}

export default function TodoGitDiffPanel({ workDir, visible, onClose }: Props) {
  const entry = useGitStatusStore((s) => (workDir ? s.byWorkDir[workDir] : undefined))
  const refresh = useGitStatusStore((s) => s.refresh)
  const [collapsed, setCollapsed] = useState(false)
  const [diffData, setDiffData] = useState<DiffResponse | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)

  async function loadDiff() {
    if (!workDir) return
    setDiffLoading(true)
    try {
      const res = await fetch(`/api/git/diff?workDir=${encodeURIComponent(workDir)}`)
      const body = await res.json()
      if (body?.ok) setDiffData(body.diff)
      else setDiffData({ state: 'error', message: body?.error || 'bad response' })
    } catch (e: any) {
      setDiffData({ state: 'error', message: e?.message || 'fetch failed' })
    } finally {
      setDiffLoading(false)
    }
  }

  useEffect(() => {
    if (!visible || !workDir) return
    if (entry?.state === 'ok' && entry.dirty === 0) {
      loadDiff()
      return
    }
    loadDiff()
  }, [visible, workDir, entry?.state])

  const html = useMemo(() => {
    if (!diffData || diffData.state !== 'ok' || !diffData.diff) return ''
    try {
      return Diff2Html.html(diffData.diff, { drawFileList: true, outputFormat: 'line-by-line' })
    } catch {
      return ''
    }
  }, [diffData])

  if (!visible || !workDir) return null

  const ok = entry && entry.state === 'ok' ? (entry as Extract<GitEntry, { state: 'ok' }>) : null
  const statusLine = ok
    ? `${ok.branch}${ok.dirty > 0 ? ` · ●${ok.dirty}` : ''}${ok.hasUpstream && ok.ahead > 0 ? ` · ↑${ok.ahead}` : ''}${ok.hasUpstream && ok.behind > 0 ? ` · ↓${ok.behind}` : ''}`
    : ''

  const handleRefresh = () => {
    if (workDir) refresh(workDir)
    loadDiff()
  }

  return (
    <div
      className="todo-git-panel todo-terminal-panel"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="todo-terminal-collapse-bar">
        <span className="collapse-title">
          {collapsed ? <DownOutlined style={{ fontSize: 10 }} /> : <UpOutlined style={{ fontSize: 10 }} />}
          <span>Git Diff{statusLine ? ` · ${statusLine}` : ''}</span>
        </span>
        <Space size={4}>
          <Tooltip title="刷新">
            <Button size="small" type="text" icon={<ReloadOutlined />} loading={diffLoading} onClick={handleRefresh} />
          </Tooltip>
          <Tooltip title={collapsed ? '展开' : '折叠'}>
            <Button size="small" type="text" icon={collapsed ? <DownOutlined /> : <UpOutlined />} onClick={() => setCollapsed((c) => !c)} />
          </Tooltip>
          <Tooltip title="关闭">
            <Button size="small" type="text" icon={<CloseOutlined />} onClick={onClose} />
          </Tooltip>
        </Space>
      </div>
      {!collapsed && (
        <div className="todo-git-panel-body" style={{ padding: 8, maxHeight: '60vh', overflow: 'auto' }}>
          {diffLoading && <div style={{ color: '#999', padding: 8 }}>加载中...</div>}
          {!diffLoading && diffData?.state === 'not_a_repo' && <div style={{ color: '#999', padding: 8 }}>此目录不是 git 仓库</div>}
          {!diffLoading && diffData?.state === 'not_found' && <div style={{ color: '#cf1322', padding: 8 }}>目录不存在</div>}
          {!diffLoading && diffData?.state === 'git_missing' && <div style={{ color: '#8c8c8c', padding: 8 }}>git 未安装</div>}
          {!diffLoading && diffData?.state === 'timeout' && <div style={{ color: '#8c8c8c', padding: 8 }}>超时,请点刷新</div>}
          {!diffLoading && diffData?.state === 'error' && <Alert type="error" message={diffData.message || '读取 diff 失败'} showIcon />}
          {!diffLoading && diffData?.state === 'ok' && (
            <>
              {diffData.truncated && (
                <Alert type="warning" message="diff 已截断(超过 200KB)" style={{ marginBottom: 8 }} showIcon />
              )}
              {diffData.untracked && diffData.untracked.length > 0 && (
                <div style={{ fontSize: 12, color: '#8c8c8c', marginBottom: 8 }}>
                  Untracked ({diffData.untracked.length}): {diffData.untracked.join(', ')}
                </div>
              )}
              {(!diffData.diff || diffData.diff.length === 0) && (!diffData.untracked || diffData.untracked.length === 0) && (
                <div style={{ color: '#999', padding: 8 }}>工作区干净</div>
              )}
              {html && <div dangerouslySetInnerHTML={{ __html: html }} />}
            </>
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2:typecheck**

```bash
cd web && npx tsc --noEmit
```

Expected: EXIT=0。

- [ ] **Step 3:Commit**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo
git add web/src/todo/TodoGitDiffPanel.tsx
git commit -m "feat(web): TodoGitDiffPanel renders git diff HEAD via diff2html"
```

---

## Task 11:在 `TodoManage.tsx` 集成 Badge + 按钮 + Panel

**Files:**
- Modify: `web/src/TodoManage.tsx`

- [ ] **Step 1:加 imports**

在 `web/src/TodoManage.tsx` 现有 imports 区(line 30 附近)加:

```tsx
import TodoGitBadge from './todo/TodoGitBadge'
import TodoGitDiffPanel from './todo/TodoGitDiffPanel'
import { useGitStatusStore } from './store/gitStatusStore'
```

以及 AntD icons 里如果没有 `BranchesOutlined` 则加:

```tsx
import { BranchesOutlined } from '@ant-design/icons'
```

- [ ] **Step 2:组件挂载时批量拉 git 状态**

找到 `TodoManage` 组件函数内(或它的 `export default function`),拿到 todos 列表后,加一个 effect(建议放在列表状态变化副作用之后):

```tsx
const fetchManyGit = useGitStatusStore((s) => s.fetchMany)
useEffect(() => {
  const workDirs = (todos || [])
    .map((t: any) => t.workDir)
    .filter((v: unknown): v is string => typeof v === 'string' && v.length > 0)
  if (workDirs.length > 0) fetchManyGit(workDirs)
}, [todos, fetchManyGit])
```

(如果 `todos` 变量名/作用域与此不同,按本地情况调整;关键是在 todos 刷新后触发一次 fetchMany。)

- [ ] **Step 3:加 Git Diff 按钮 + Panel 的状态**

在 `TodoManage` 组件顶层 state 区加:

```tsx
const [gitDiffOpenByTodoId, setGitDiffOpenByTodoId] = useState<Record<string, boolean>>({})
```

在每个 todo 卡片的工具栏(大约 line 260 `AI 终端` 按钮那一行附近)旁边,加一个按钮(只在 `todo.workDir` 非空时渲染):

```tsx
{todo.workDir && (
  <Button
    size="small"
    icon={<BranchesOutlined />}
    onClick={(e) => {
      e.stopPropagation()
      setGitDiffOpenByTodoId((m) => ({ ...m, [todo.id]: !m[todo.id] }))
    }}
    className="todo-primary-action"
  >
    Git Diff
  </Button>
)}
```

- [ ] **Step 4:卡片上插 Badge**

在 todo 卡片 hasHistory 区块旁边(line ~276 附近),加 Badge:

```tsx
{todo.workDir && (
  <div style={{ marginTop: 4, paddingLeft: 4 }} onClick={(e) => e.stopPropagation()}>
    <TodoGitBadge
      workDir={todo.workDir}
      onOpenDiff={() => setGitDiffOpenByTodoId((m) => ({ ...m, [todo.id]: true }))}
    />
  </div>
)}
```

- [ ] **Step 5:在 AI 终端面板之后挂 Git Diff 面板**

在当前 `todo-terminal-panel` 条件渲染块(line ~423 附近)之后,加:

```tsx
{todo.workDir && gitDiffOpenByTodoId[todo.id] && (
  <TodoGitDiffPanel
    workDir={todo.workDir}
    visible={true}
    onClose={() => setGitDiffOpenByTodoId((m) => ({ ...m, [todo.id]: false }))}
  />
)}
```

- [ ] **Step 6:AI 会话 done 时刷新 git**

找到 `<SessionViewer ... onDone={() => onRefresh()} ... />`(line ~490 附近)并改为:

```tsx
const refreshGit = useGitStatusStore((s) => s.refresh)
// ...render...
onDone={() => {
  onRefresh()
  if (todo.workDir) refreshGit(todo.workDir)
}}
```

注意:`refreshGit` hook 如果 `TodoManage` 中渲染的是 todo 卡片组件(例如 `TodoCard`)而非内联,则应在对应组件内声明 hook。按实际文件位置调整。

- [ ] **Step 7:typecheck**

```bash
cd web && npx tsc --noEmit
```

Expected: EXIT=0。如有错误按报错提示修(常见:`useState` 未 import、`todos` 作用域)。

- [ ] **Step 8:Commit**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo
git add web/src/TodoManage.tsx
git commit -m "feat(web): integrate Git badge, Diff button and panel in todo cards"
```

---

## Task 12:手动验证

**Files:** 无新改动,纯验证。

- [ ] **Step 1:跑全量测试**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo
npx vitest run
```

Expected: 全部 PASS。

- [ ] **Step 2:构建前端**

```bash
cd web && npm run build
```

Expected: EXIT=0。

- [ ] **Step 3:启动 dev 服务并手工点一遍**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo
node src/cli.js start
```

用浏览器打开应用,验证:

- [ ] 带 `workDir` 的 todo 卡片展示 Badge(分支/dirty/ahead-behind)
- [ ] Badge 上的刷新按钮点后有 loading → 刷新后显示新数据
- [ ] 点 Badge(主体区)展开 Git Diff 面板
- [ ] 点工具栏的"Git Diff"按钮也能展开面板
- [ ] 面板内 diff2html 正确渲染修改(改几个文件测试)
- [ ] 未改动时显示"工作区干净"
- [ ] 造一个大改动(写 > 200KB 文件)看到截断黄条
- [ ] 非 git 目录(手动在 `/tmp` 下 `mkdir` 一个目录作为 workDir)的 todo:Badge 不显示、"Git Diff"按钮不显示
- [ ] 不存在的 workDir 路径(手动编辑 todo):Badge 显示红色"⚠ 目录不存在"
- [ ] AI 会话跑完改了文件后,Badge 上的 dirty 数字自动刷新
- [ ] 刷新整个页面,Badge 重新拉取(非缓存)

- [ ] **Step 4:Push(可选,按用户约定)**

等用户显式要求再 push。

---

## 自检清单

完成上面所有任务后,spec 里的需求覆盖:

- § 1 决策摘要:Task 1-12 全部覆盖
- § 2 数据流:fetchMany on mount (Task 11) + invalidate on session done (Task 6-7) + refresh button (Task 9, 10)
- § 3.1 GitStatus/GitDiff 联合类型 + 错误分类:Task 2-4
- § 3.2 REST 端点 + 缓存 + 去重:Task 5
- § 3.3 AI 会话 done 回调:Task 6-7
- § 4.1 zustand store:Task 8
- § 4.2 TodoGitBadge:Task 9
- § 4.3 TodoGitDiffPanel + diff2html:Task 10
- § 4.4 TodoManage 集成:Task 11
- § 5 错误处理表:全部在 Task 2-4 + Task 9-10
- § 6 测试:Task 2-6 的 TDD 步骤
- § 7 文件清单:Task 1-11 覆盖全部新建和修改
