# Top 10 任务显示修复 + transcript 绑定兜底 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 `StatsDrawer` "Top 10 任务"只显示 2 条的 bug，并补上 `transcript_files.bound_todo_id` 的 auto-bind 兜底链路。

**Architecture:** 两步修复。Part B 改 `buildReport` 让 `topTodos` 从 `transcript_files ∪ ai_session_log` 合并聚合，排序用 `max(activeMs, wallClockMs)`；Part A 在 `matcher.js` 新增 `autoMatchByLog`，`autoBindUnbound` 加第二阶段，用 `tool + started_at ±60s` 在 `ai_session_log` 里找唯一 todo_id 做兜底绑定。不动表结构，老数据启动时通过 `scanIncremental → autoBindUnbound` 自动回补。

**Tech Stack:** Node.js ESM, better-sqlite3, vitest（单测），React + antd（前端，本轮无代码改动）

**Spec 参考:** `docs/superpowers/specs/2026-04-20-top10-binding-fix-design.md`

---

## 文件结构

**新增：**
- `test/transcripts.matcher.log-fallback.test.js` — matcher 新阶段的单元测试

**修改：**
- `src/db.js` — 新增 `listSessionLogsInWindow(tool, startedAt, windowMs)` 方法
- `src/transcripts/matcher.js` — 新增 `autoMatchByLog(files, db, windowMs)` 函数
- `src/transcripts/index.js` — `applyBindingToTodo` 加 `opts.createNewSession`；`autoBindUnbound` 加第二阶段
- `src/stats/report.js` — `buildReport` 的 `todoAgg` 合并 logs；排序改 `max`；`summary.todoCount` union
- `test/transcripts.test.js` — 加 1 个 "防劫持" case
- `test/stats.report.test.js` — 加 2 个 case（仅日志 / max 排序）

**不改：** `web/src/StatsDrawer.tsx`（token=0 / cost=0 按现有格式 `0` / `$0.00` 展示即可，符合决策 Q1=b）

---

## Task 1: `listSessionLogsInWindow` — db.js 新方法

**Files:**
- Modify: `src/db.js`（在 `insertSessionLog` 附近加新方法并导出）
- Modify: `test/db.test.js`（加 1 个 case）

- [ ] **Step 1: 写失败测试**

在 `test/db.test.js` 末尾追加（若文件不存在同名 describe，则新增一个）：

```js
// 放在 describe('openDb', ...) 内或新开一个 describe
it('listSessionLogsInWindow 返回同 tool 且 started_at 在窗口内的日志', () => {
  const db = openDb(':memory:')
  db.insertSessionLog({ id: 'a', todoId: 't1', tool: 'claude', quadrant: 1, status: 'done', startedAt: 1_000_000, completedAt: 1_001_000 })
  db.insertSessionLog({ id: 'b', todoId: 't2', tool: 'claude', quadrant: 1, status: 'done', startedAt: 1_000_030, completedAt: 1_001_030 })
  db.insertSessionLog({ id: 'c', todoId: 't3', tool: 'codex',  quadrant: 1, status: 'done', startedAt: 1_000_010, completedAt: 1_001_010 })
  db.insertSessionLog({ id: 'd', todoId: 't4', tool: 'claude', quadrant: 1, status: 'done', startedAt: 2_000_000, completedAt: 2_001_000 })

  const out = db.listSessionLogsInWindow('claude', 1_000_020, 60_000)
  // 期望：a 和 b 命中（claude 且在 ±60s 内），c 被 tool 过滤，d 在窗外
  const ids = out.map(r => r.id).sort()
  expect(ids).toEqual(['a', 'b'])
  // 返回字段必须至少包含 id, todo_id, tool, started_at
  expect(out[0]).toHaveProperty('todo_id')
  expect(out[0]).toHaveProperty('started_at')
})
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo && npx vitest run test/db.test.js -t "listSessionLogsInWindow"
```
Expected: FAIL with `db.listSessionLogsInWindow is not a function`

- [ ] **Step 3: 实现**

编辑 `src/db.js`。在 `aiLogStmts` 对象（目前有 `insert` 和 `listSince`）中追加一个 prepare，在导出对象里暴露方法。

在 `aiLogStmts` 初始化块（约 L464-L470）：

```js
const aiLogStmts = {
  insert: db.prepare(`
    INSERT OR REPLACE INTO ai_session_log
      (id, todo_id, tool, quadrant, status, exit_code, started_at, completed_at, duration_ms)
    VALUES
      (@id, @todo_id, @tool, @quadrant, @status, @exit_code, @started_at, @completed_at, @duration_ms)
  `),
  listSince: db.prepare(`SELECT * FROM ai_session_log WHERE completed_at >= ? AND completed_at < ? ORDER BY completed_at DESC`),
  listInWindow: db.prepare(`
    SELECT id, todo_id, tool, started_at, completed_at, duration_ms
    FROM ai_session_log
    WHERE tool = ? AND started_at BETWEEN ? AND ?
  `),
}
```

然后在 openDb 返回的对象里（约 L962 附近），加入导出：

```js
insertSessionLog,
querySessionStats,
listSessionLogsInWindow: (tool, startedAt, windowMs) => {
  const lo = startedAt - windowMs
  const hi = startedAt + windowMs
  return aiLogStmts.listInWindow.all(tool, lo, hi)
},
```

- [ ] **Step 4: 跑测试验证通过**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo && npx vitest run test/db.test.js -t "listSessionLogsInWindow"
```
Expected: PASS

- [ ] **Step 5: 跑全量 db 测试确保无回归**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo && npx vitest run test/db.test.js
```
Expected: 所有原有测试 + 新 case 全绿

- [ ] **Step 6: 提交**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo && git add src/db.js test/db.test.js && git commit -m "feat(db): add listSessionLogsInWindow for transcript log-fallback auto-bind"
```

---

## Task 2: `autoMatchByLog` — matcher.js 新函数

**Files:**
- Create: `test/transcripts.matcher.log-fallback.test.js`
- Modify: `src/transcripts/matcher.js`（导出新函数）

- [ ] **Step 1: 写失败测试**

创建 `test/transcripts.matcher.log-fallback.test.js`：

```js
import { describe, it, expect } from 'vitest'
import { autoMatchByLog, WINDOW_MS } from '../src/transcripts/matcher.js'

// 用内存 mock 当作 db：只需要实现 listSessionLogsInWindow
function makeDb(logs) {
  return {
    listSessionLogsInWindow(tool, startedAt, windowMs) {
      return logs.filter(l =>
        l.tool === tool &&
        l.started_at >= startedAt - windowMs &&
        l.started_at <= startedAt + windowMs
      )
    }
  }
}

describe('autoMatchByLog', () => {
  it('case 1: 单条命中 → 产出 pair', () => {
    const files = [{ id: 10, tool: 'claude', native_id: 'nat-1', started_at: 100_000 }]
    const db = makeDb([
      { id: 'ai-1', todo_id: 'todo-A', tool: 'claude', started_at: 100_005 },
    ])
    const pairs = autoMatchByLog(files, db)
    expect(pairs).toEqual([{ fileId: 10, todoId: 'todo-A', sessionId: null, nativeId: 'nat-1' }])
  })

  it('case 2: 同窗口多 todo_id → 歧义 skip', () => {
    const files = [{ id: 10, tool: 'claude', native_id: 'nat-1', started_at: 100_000 }]
    const db = makeDb([
      { id: 'ai-1', todo_id: 'todo-A', tool: 'claude', started_at: 100_005 },
      { id: 'ai-2', todo_id: 'todo-B', tool: 'claude', started_at: 100_020 },
    ])
    expect(autoMatchByLog(files, db)).toEqual([])
  })

  it('case 3: 同窗口多条但都是同 todo_id → 绑定', () => {
    const files = [{ id: 10, tool: 'claude', native_id: 'nat-1', started_at: 100_000 }]
    const db = makeDb([
      { id: 'ai-1', todo_id: 'todo-A', tool: 'claude', started_at: 100_005 },
      { id: 'ai-2', todo_id: 'todo-A', tool: 'claude', started_at: 100_020 },
    ])
    const pairs = autoMatchByLog(files, db)
    expect(pairs).toHaveLength(1)
    expect(pairs[0].todoId).toBe('todo-A')
  })

  it('case 4: tool 不同 → 不绑', () => {
    const files = [{ id: 10, tool: 'claude', native_id: 'nat-1', started_at: 100_000 }]
    const db = makeDb([
      { id: 'ai-1', todo_id: 'todo-A', tool: 'codex', started_at: 100_005 },
    ])
    expect(autoMatchByLog(files, db)).toEqual([])
  })

  it('case 5: started_at 差超过 WINDOW_MS → 不绑', () => {
    const files = [{ id: 10, tool: 'claude', native_id: 'nat-1', started_at: 100_000 }]
    const db = makeDb([
      { id: 'ai-1', todo_id: 'todo-A', tool: 'claude', started_at: 100_000 + WINDOW_MS + 1 },
    ])
    expect(autoMatchByLog(files, db)).toEqual([])
  })

  it('case 6: 缺 started_at 或 tool → 跳过', () => {
    const files = [
      { id: 11, tool: 'claude', native_id: 'nat-2' },      // 缺 started_at
      { id: 12, native_id: 'nat-3', started_at: 100_000 }, // 缺 tool
    ]
    const db = makeDb([
      { id: 'ai-x', todo_id: 'todo-X', tool: 'claude', started_at: 100_000 },
    ])
    expect(autoMatchByLog(files, db)).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo && npx vitest run test/transcripts.matcher.log-fallback.test.js
```
Expected: FAIL（`autoMatchByLog is not a function`）

- [ ] **Step 3: 实现**

在 `src/transcripts/matcher.js` 末尾追加：

```js
/**
 * Fallback auto-bind via ai_session_log:
 *   tool 相同 + |started_at 差| ≤ windowMs + 命中 log 对应唯一 todo_id → 绑到 log.todo_id
 * 歧义（多 todo_id）或不命中一律 skip，宁缺毋滥。
 */
export function autoMatchByLog(unboundFiles, db, windowMs = WINDOW_MS) {
  const pairs = []
  for (const f of unboundFiles) {
    if (!f.tool || !f.started_at) continue
    const logs = db.listSessionLogsInWindow(f.tool, f.started_at, windowMs)
    if (logs.length === 0) continue
    const todoIds = [...new Set(logs.map(l => l.todo_id))]
    if (todoIds.length !== 1) continue
    pairs.push({ fileId: f.id, todoId: todoIds[0], sessionId: null, nativeId: f.native_id })
  }
  return pairs
}
```

- [ ] **Step 4: 跑测试验证全部通过**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo && npx vitest run test/transcripts.matcher.log-fallback.test.js
```
Expected: 所有 6 个 case PASS

- [ ] **Step 5: 跑原有 matcher 相关测试确保无回归**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo && npx vitest run test/transcripts.test.js
```
Expected: 全绿（本次不改 `autoMatch` / `collectOrphans`）

- [ ] **Step 6: 提交**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo && git add src/transcripts/matcher.js test/transcripts.matcher.log-fallback.test.js && git commit -m "feat(matcher): add autoMatchByLog for ai_session_log based fallback binding"
```

---

## Task 3: `applyBindingToTodo` 加 `createNewSession` 选项（防劫持）

**Files:**
- Modify: `src/transcripts/index.js:12-47`
- Modify: `test/transcripts.test.js`（加 "防劫持" case）

**背景：** 现有 `applyBindingToTodo` 在 `sessionIdHint` 为空时有个 fallback：`filtered.findIndex(s => !s?.nativeSessionId && s?.tool === tool)`，会抓到该 todo 下**任意一个**同 tool 但还没 nativeSessionId 的 pending session。log-fallback 场景下这种 pending session 可能跟本次 transcript 完全无关，必须绕过。

- [ ] **Step 1: 写失败测试**

在 `test/transcripts.test.js` 的某个 `describe('createTranscriptsService', ...)`（约 L110+ 有现成的 setup）内或文件末尾另开 describe 添加：

```js
// 放到已有 createTranscriptsService 的 describe 下
it('applyBindingToTodo with createNewSession=true 不会劫持无关 pending session', () => {
  const db = openDb(':memory:')
  const todo = db.createTodo({ title: 'test', quadrant: 1 })
  // 手动放一条无关 pending session（sessionId 'manual-1', tool 'claude', 无 nativeSessionId）
  db.updateTodo(todo.id, {
    aiSessions: [{
      sessionId: 'manual-1',
      tool: 'claude',
      status: 'pending_confirm',
      startedAt: 900_000,
      prompt: 'unrelated prompt',
    }],
  })

  const service = createTranscriptsService({
    db,
    listTodos: () => db.listTodos(),
    updateTodo: (id, patch) => db.updateTodo(id, patch),
    dirs: { claude: '/tmp/nope-claude', codex: '/tmp/nope-codex' },
  })

  // 手动喂一条 unbound file（避免依赖 disk 扫描）
  db.upsertTranscriptFile({
    tool: 'claude', nativeId: 'native-xyz', cwd: '/any',
    jsonlPath: '/tmp/native-xyz.jsonl', size: 1, mtime: 1_000_000,
    startedAt: 1_000_000, endedAt: 1_001_000, firstUserPrompt: 'foo',
    turnCount: 1, boundTodoId: null,
  })
  db.insertSessionLog({
    id: 'ai-1', todoId: todo.id, tool: 'claude', quadrant: 1,
    status: 'done', startedAt: 1_000_005, completedAt: 1_001_000,
  })

  // 这一步会触发两阶段 auto-bind
  return service.scanIncremental().then(() => {
    const updated = db.listTodos().find(t => t.id === todo.id)
    // 原 manual-1 session 仍然是 pending_confirm，没被写 nativeSessionId
    const manual = updated.aiSessions.find(s => s.sessionId === 'manual-1')
    expect(manual).toBeTruthy()
    expect(manual.nativeSessionId).toBeFalsy()
    // 新增一条 imported-* session 持有 nativeSessionId
    const imported = updated.aiSessions.find(s => s.sessionId?.startsWith('imported-'))
    expect(imported).toBeTruthy()
    expect(imported.nativeSessionId).toBe('native-xyz')
  })
})
```

> 说明：如果 `test/transcripts.test.js` 现有 `createTranscriptsService` 的 describe 还没有引入 `openDb` 等工具，就在本 case 内 import；保持与文件风格一致。

- [ ] **Step 2: 跑测试验证失败**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo && npx vitest run test/transcripts.test.js -t "createNewSession"
```
Expected: FAIL（现阶段 log-fallback 还没接入 `autoBindUnbound`，所以 `imported` session 根本没出现；或者接入后老 fallback 会改写 manual-1 的 nativeSessionId）

- [ ] **Step 3: 改 `applyBindingToTodo` 签名和实现**

修改 `src/transcripts/index.js`，在函数签名和函数体中加入 `opts`：

```js
function applyBindingToTodo(todoId, { nativeId, tool, startedAt, endedAt }, sessionIdHint, opts = {}) {
  const todo = listTodos().find(t => t.id === todoId)
  if (!todo) return null
  const sessions = Array.isArray(todo.aiSessions) ? [...todo.aiSessions] : []

  // Remove any existing session on this todo that already holds this native id (dedup)
  const filtered = sessions.filter(s => !(s?.nativeSessionId === nativeId && s?.tool === tool))

  let targetIdx = -1
  if (sessionIdHint) targetIdx = filtered.findIndex(s => s?.sessionId === sessionIdHint)
  // createNewSession=true 时跳过 "抓任一 pending session" 的 fallback，强制走 push 新 imported-* 分支
  if (targetIdx === -1 && !opts.createNewSession) {
    targetIdx = filtered.findIndex(s => !s?.nativeSessionId && s?.tool === tool)
  }

  const baseTs = startedAt || Date.now()
  const newSession = targetIdx >= 0 ? { ...filtered[targetIdx] } : {
    sessionId: `imported-${nativeId}`,
    tool,
    status: 'done',
    startedAt: baseTs,
    prompt: '',
    label: '',
  }
  newSession.nativeSessionId = nativeId
  newSession.tool = tool
  newSession.source = 'imported'
  if (!newSession.startedAt) newSession.startedAt = baseTs
  if (!newSession.completedAt) newSession.completedAt = endedAt || baseTs
  if (!newSession.status || newSession.status === 'running' || newSession.status === 'pending_confirm') {
    newSession.status = 'done'
  }

  if (targetIdx >= 0) filtered[targetIdx] = newSession
  else filtered.push(newSession)

  updateTodo(todoId, { aiSessions: filtered })
  return newSession.sessionId
}
```

**不要改其他地方的调用点**（`bind()` 和 `autoBindUnbound` 第一阶段的 applyBindingToTodo 调用都不传 `opts`，行为不变）。

- [ ] **Step 4: 跑全量 transcripts 测试确保已有行为没断**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo && npx vitest run test/transcripts.test.js
```
Expected: 原有测试全绿；**新的 "防劫持" case 仍失败**，因为 Task 4 才把第二阶段接入 autoBindUnbound。这是预期的，我们会在 Task 4 跑完后一起绿。

- [ ] **Step 5: 暂不提交**

等 Task 4 完成后一起提交两个文件（Task 4 的 commit 会把两个文件一并带上）。

---

## Task 4: `autoBindUnbound` 第二阶段接入 log-fallback

**Files:**
- Modify: `src/transcripts/index.js`（`autoBindUnbound` 函数体，约 L100-L118）

- [ ] **Step 1: 实现**

把现有 `autoBindUnbound` 替换成下面版本（原有第一阶段逻辑保留，追加第二阶段）：

```js
async function autoBindUnbound() {
  const unbound = db.listUnboundTranscriptFiles()
  if (!unbound.length) return 0

  // 第一阶段：orphan-based（严格：cwd + startedAt + prompt[:100]）
  const orphans = collectOrphans(listTodos())
  let pairs1 = []
  if (orphans.length) {
    pairs1 = autoMatch(unbound, orphans)
    for (const p of pairs1) {
      const file = db.getTranscriptFile(p.fileId)
      if (!file) continue
      applyBindingToTodo(p.todoId, {
        nativeId: p.nativeId,
        tool: file.tool,
        startedAt: file.started_at,
        endedAt: file.ended_at,
      }, p.sessionId)
      db.setTranscriptBound(p.fileId, p.todoId)
    }
  }

  // 第二阶段：ai_session_log 兜底（tool + started_at ±60s + 唯一 todo_id）
  const stillUnbound = db.listUnboundTranscriptFiles()
  const pairs2 = stillUnbound.length ? autoMatchByLog(stillUnbound, db) : []
  for (const p of pairs2) {
    const file = db.getTranscriptFile(p.fileId)
    if (!file) continue
    applyBindingToTodo(p.todoId, {
      nativeId: p.nativeId,
      tool: file.tool,
      startedAt: file.started_at,
      endedAt: file.ended_at,
    }, null, { createNewSession: true })
    db.setTranscriptBound(p.fileId, p.todoId)
  }

  return pairs1.length + pairs2.length
}
```

**同时在文件顶部 import 里加入 `autoMatchByLog`**（原已从 `./matcher.js` 导入 `collectOrphans, autoMatch`）：

```js
import { collectOrphans, autoMatch, autoMatchByLog } from './matcher.js'
```

- [ ] **Step 2: 跑 Task 3 的"防劫持"测试验证绿**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo && npx vitest run test/transcripts.test.js -t "createNewSession"
```
Expected: PASS

- [ ] **Step 3: 跑全量 transcripts 测试确保无回归**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo && npx vitest run test/transcripts.test.js
```
Expected: 全绿

- [ ] **Step 4: 跑全量 test 再兜一次**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo && npx vitest run
```
Expected: 全绿（`stats.report.test.js` 也应通过——我们还没改它）

- [ ] **Step 5: 提交 Task 3 + Task 4**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo && git add src/transcripts/index.js test/transcripts.test.js && git commit -m "feat(transcripts): wire log-fallback into autoBindUnbound, protect against pending-session hijack"
```

---

## Task 5: `buildReport` 合并 `ai_session_log` 到 `topTodos`

**Files:**
- Modify: `src/stats/report.js`（`buildReport` 函数）
- Modify: `test/stats.report.test.js`（加 2 个新 case）

- [ ] **Step 1: 写失败测试**

在 `test/stats.report.test.js` 的 `describe('buildReport', ...)` 块里追加：

```js
it('仅有 ai_session_log 的 todo 也进 topTodos（tokens=0, wallClockMs>0）', () => {
  // 有一个 todo 只有 log，没有 transcript
  db.createTodo({ title: 'LogOnly', quadrant: 3 })
  const t = db.listTodos()[0]
  db.insertSessionLog({
    id: 'log-only-1', todoId: t.id, tool: 'claude', quadrant: 3,
    status: 'done', startedAt: 2_000, completedAt: 5_000,
  })
  // duration_ms 得手工传（insertSessionLog 可能自行计算或要求显式传，按现有签名填入）
  // 若 insertSessionLog 不自动算 duration_ms，改用：
  //   db.insertSessionLog({ ..., durationMs: 3_000 })

  const report = buildReport(db, { since: 0, until: 10_000, pricing: DEFAULT_PRICING })

  expect(report.topTodos).toHaveLength(1)
  const row = report.topTodos[0]
  expect(row.todoId).toBe(t.id)
  expect(row.activeMs).toBe(0)
  expect(row.wallClockMs).toBe(3_000)
  expect(row.tokens.input).toBe(0)
  expect(row.tokens.output).toBe(0)
  expect(row.cost.usd).toBe(0)
  expect(row.sessionCount).toBe(1)
  expect(report.summary.todoCount).toBe(1)
})

it('max(activeMs, wallClockMs) 排序：仅日志的行能超过活跃很低的 transcript 行', () => {
  // todo A：只有 transcript，activeMs=500k
  db.createTodo({ title: 'A', quadrant: 1 })
  const a = db.listTodos()[0]
  db.upsertTranscriptFile({
    tool: 'claude', nativeId: 's-a', cwd: '/tmp',
    jsonlPath: '/tmp/s-a.jsonl', size: 1, mtime: 2_000,
    startedAt: 1_000, endedAt: 2_000, firstUserPrompt: 'x', turnCount: 1,
    inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0,
    primaryModel: 'claude-sonnet-4-6', activeMs: 500_000,
    boundTodoId: a.id,
  })
  // todo B：只有 log，wallClockMs=800k
  db.createTodo({ title: 'B', quadrant: 2 })
  const b = db.listTodos()[1]
  db.insertSessionLog({
    id: 'log-b', todoId: b.id, tool: 'claude', quadrant: 2,
    status: 'done', startedAt: 3_000, completedAt: 803_000,
  })

  const report = buildReport(db, { since: 0, until: 1_000_000, pricing: DEFAULT_PRICING })
  // B 的 max = 800k > A 的 max = 500k，B 排第一
  expect(report.topTodos[0].todoId).toBe(b.id)
  expect(report.topTodos[1].todoId).toBe(a.id)
})
```

> 注：如果 `insertSessionLog` 不根据 started/completed 自动算 `duration_ms`，在测试里显式传 `durationMs`。先跑下面的 Step 2，看失败信息里是否有 "durationMs not defined"。检查 `src/db.js` 的 `insertSessionLog` 实现，按现有签名传参。

- [ ] **Step 2: 跑测试验证失败**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo && npx vitest run test/stats.report.test.js
```
Expected:
- 新增两个 case FAIL（"只有 log 的 todo 没出现在 topTodos" 或 "topTodos[0] 是 a 而不是 b"）
- **既有断言应仍绿**（`expect(report.topTodos[0].todoId).toBe(b.id)` 在现状排序下仍 by activeMs + tokens tiebreak 通过）

- [ ] **Step 3: 修改 `buildReport` 合并 logs 并改排序键**

编辑 `src/stats/report.js`，把 "topTodos" 那段（约 L59-L103）替换为：

```js
// topTodos: group files by bound_todo_id AND merge logs by todo_id
function newBucket(todoId) {
  return {
    todoId, activeMs: 0, wallClockMs: 0, tokens: { ...ZERO },
    sessions: 0, logSessions: 0, models: new Map(),
  }
}
const todoAgg = new Map()
for (const f of files) {
  if (!f.bound_todo_id) continue
  const bucket = todoAgg.get(f.bound_todo_id) || newBucket(f.bound_todo_id)
  bucket.activeMs += f.active_ms || 0
  bucket.tokens = addTokens(bucket.tokens, fileTokens(f))
  bucket.sessions += 1
  if (f.primary_model) bucket.models.set(f.primary_model, (bucket.models.get(f.primary_model) || 0) + 1)
  todoAgg.set(f.bound_todo_id, bucket)
}
for (const l of logs) {
  if (!l.todo_id) continue
  const bucket = todoAgg.get(l.todo_id) || newBucket(l.todo_id)
  bucket.wallClockMs += l.duration_ms || 0
  bucket.logSessions += 1
  todoAgg.set(l.todo_id, bucket)
}

const todos = db.listTodos()
const todoById = new Map(todos.map(t => [t.id, t]))

const topTodos = [...todoAgg.values()]
  .map(b => {
    const t = todoById.get(b.todoId)
    const topModel = [...b.models.entries()].sort((a, c) => c[1] - a[1])[0]?.[0] || null
    return {
      todoId: b.todoId,
      title: t?.title || '(已删除)',
      quadrant: t?.quadrant || 0,
      activeMs: b.activeMs,
      wallClockMs: b.wallClockMs,
      tokens: b.tokens,
      cost: costOf(b.tokens, topModel, pricing),
      sessionCount: Math.max(b.sessions, b.logSessions),
      primaryModel: topModel,
    }
  })
  .sort((a, b) => {
    const aMax = Math.max(a.activeMs, a.wallClockMs)
    const bMax = Math.max(b.activeMs, b.wallClockMs)
    if (bMax !== aMax) return bMax - aMax
    const aTok = a.tokens.input + a.tokens.output + a.tokens.cacheRead + a.tokens.cacheCreation
    const bTok = b.tokens.input + b.tokens.output + b.tokens.cacheRead + b.tokens.cacheCreation
    return bTok - aTok
  })
  .slice(0, topN)
```

同时**删除**原来单独的 `todoWall` 聚合（下面这段，约 L72-L76）——wallClockMs 已并入 `todoAgg`：

```js
// ↓↓↓ 删掉这段 ↓↓↓
const todoWall = new Map()
for (const l of logs) {
  todoWall.set(l.todo_id, (todoWall.get(l.todo_id) || 0) + (l.duration_ms || 0))
}
```

以及原 map 中的 `wallClockMs: todoWall.get(b.todoId) || 0` 行也随之移除（新版本里直接用 `b.wallClockMs`）。

**修改 `summary.todoCount`**：把构造 summary 时的 `todoCount` 从 `coveredTodos.size` 改为 union。在原 `for (const f of files)` 循环之后（构造 `coveredTodos` 的位置）追加 logs 的 todo_id：

```js
for (const l of logs) {
  if (l.todo_id) coveredTodos.add(l.todo_id)
}
```

这样 `summary.todoCount = coveredTodos.size` 自动变成 union。

- [ ] **Step 4: 跑测试验证全部通过**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo && npx vitest run test/stats.report.test.js
```
Expected: 3 个原 case + 2 个新 case 全绿。若新 case 因 `insertSessionLog` 签名报错，修 Step 1 测试里的参数名（加 `durationMs: 3_000` 等）再跑。

- [ ] **Step 5: 跑全量 test**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo && npx vitest run
```
Expected: 全绿。注意 `test/stats.markdown.test.js` 是 snapshot 测试——如果排序变化影响了 Top 10 的 Markdown 渲染顺序，需要用 `npx vitest run --update` 更新 snapshot，然后人工 diff 一眼确认结果合理。

- [ ] **Step 6: 提交**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo && git add src/stats/report.js test/stats.report.test.js && git commit -m "fix(stats): merge ai_session_log into topTodos, sort by max(active,wall)"
```

如果 Step 5 更新了 snapshot：

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo && git add test/__snapshots__ && git commit -m "test(stats): update markdown snapshot after topTodos merge"
```

---

## Task 6: 手动冒烟测试

**Files:** 无代码改动

- [ ] **Step 1: 重启服务**

```bash
# 若有 daemon：
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo && cat .quadtodo/quadtodo.pid 2>/dev/null | xargs -r kill
# 然后按项目既有方式启动（通常是 `npm start` 或 `node src/cli.js start` — 以 package.json scripts 为准）
```

- [ ] **Step 2: 观察启动日志**

启动后找一行类似 `scanIncremental ... autoBound=X unbound=Y` 的日志。预期：
- `autoBound` 本次应该 ≫ 0（老数据回补）
- `unbound` 应显著下降（诊断时 453 → 预期 < 50）

若日志格式与上不同，查 `src/transcripts/index.js` 的 `return { newFiles, indexed, autoBound, unbound }` 在哪里被打印，照着找即可。

- [ ] **Step 3: 在浏览器里打开 StatsDrawer**

打开 web 界面，进入 TodoManage 页，点顶部 "📊 统计"。切到 "本周"。

预期：
- Top 10 表格**行数 ≥ 10**（本周 ai_session_log 中 22 个 todo，至少前 10 应该都能显示）
- 总览卡片 "会话 / 任务" 的第二个数字（todoCount）应 ≥ 10
- "未关联" 数字明显下降

切到 "本月"：
- Top 10 依然 ≥ 10，包含活跃最高的几个 todo
- 仅日志的 todo 行 token/cost 都是 `0` / `$0.00 / ¥0.0`（按决策 Q1=b）

- [ ] **Step 4: 抽查绑定合理性**

```bash
sqlite3 -readonly ~/.quadtodo/data.db "
  SELECT tf.id, tf.native_id, tf.started_at, tf.bound_todo_id, t.title
  FROM transcript_files tf
  LEFT JOIN todos t ON t.id = tf.bound_todo_id
  WHERE tf.bound_todo_id IS NOT NULL
  ORDER BY tf.indexed_at DESC LIMIT 10;
"
```

人工看 10 条：`started_at` 时间点和对应 todo 的标题看是否合理（即那时候用户应该在做这件事）。如果明显乱绑，记下 transcript id 和被绑到的 todo，留到后续 debug。

- [ ] **Step 5: 冒烟通过后 push（可选）**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo && git log --oneline -n 6
# 确认提交历史干净后
# git push origin <branch>   # 用户自行决定是否 push
```

---

## 自检清单

实施完成后对齐：

- [ ] 本周时间窗 Top 10 表格行数 ≥ 10（之前是 2）
- [ ] `summary.todoCount` ≥ topTodos 行数
- [ ] `summary.unboundSessionCount` 明显下降
- [ ] `npm test` 全绿，新增 / 修改共 3 个测试文件的所有 case 通过
- [ ] 人工抽查 10 条新绑定合理
- [ ] 无任何无关功能回归（`git status` 干净，`git log` 提交历史清晰）
