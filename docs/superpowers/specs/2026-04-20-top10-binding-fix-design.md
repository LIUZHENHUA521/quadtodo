# Top 10 任务显示修复 + transcript 绑定链路兜底 — 设计文档

- 日期：2026-04-20
- 所属项目：`quadtodo`
- 关联 spec：`2026-04-15-ai-usage-stats-design.md`

## 背景

AI 使用统计抽屉（`StatsDrawer`）的"Top 10 任务"实测只显示 2 条。诊断结果（数据来自 `~/.quadtodo/data.db`，2026-04-20）：

| 时间窗 | transcript_files | 其中 bound | distinct todo | ai_session_log | logs 中 distinct todo |
|---|---|---|---|---|---|
| 本周 | 85 | 0 | 0 | 24 | 22 |
| 本月 / 近 30 天 | 453 | 2 | 2 | — | — |

本周 22 个 todo 在 `ai_session_log` 里都有记录，但对应的 transcript 一条都没被绑回 todo。根因：

1. **`topTodos` 口径偏窄**：`buildReport` 只按 `transcript_files.bound_todo_id` 聚合，忽略了 `ai_session_log` 里的 todo_id，导致绑定链路一破就只剩空壳。
2. **auto-bind 三道门太严**：`src/transcripts/matcher.js` 要求 `cwd 相同 + startedAt±60s + first_user_prompt[:100] 完全相等` + orphan 来自 `todo.aiSessions`。现实中 orphan 列表常为空或 prompt 不等，几乎全 miss。
3. **两边 ID 体系不通**：`ai_session_log.id`（`ai-<ms>-<rand>`）≠ `transcript_files.native_id`（Claude 的 session UUID），无法直接 JOIN。只能靠 `tool + 时间窗` 对齐。

## 目标

1. 让"Top 10 任务"立刻能显示用户本周真实跑过的全部 todo（即使 transcript 没绑定）。
2. 让新产生的 transcript 在扫描时通过 `ai_session_log` 兜底自动绑定；老数据启动时一次性回补。
3. 两类数据口径一致：UI 表格里同时能读出"AI 活跃时长"和"墙钟时长"，不出现 summary 说 22 个 todo 但表里只 2 条的割裂。

### 定位声明

本方案 Part A 的 "log-fallback auto-bind" 是**绕行方案**。根本问题是 PTY runner 启动时没把 session 写进 `todo.aiSessions`（导致 orphan 列表为空，现有严格 matcher 无用武之地）。真正的修复应该在 PTY runner 的会话生命周期上动刀，本轮不做。当 PTY runner 修好后：orphan-based 第一阶段会率先命中，log-fallback 第二阶段变成冷门兜底，不会产生冲突，也可随时下线。

## 非目标（YAGNI）

- 不引入实时 PTY 输出解析或新 ID 同步协议。
- 不动 PTY runner 的 `aiSessions` 写入逻辑（那是另一条更深的坑，本轮只用兜底）。
- 不给 `ai_session_log` 补 `cwd`/`prompt` 字段，也不建新表。

## 改动范围

### Part B · topTodos 合并 `ai_session_log`（立即生效）

文件：`src/stats/report.js`

现状：`topTodos = [...todoAgg.values()].sort(...).slice(0, topN)`，`todoAgg` 只由 `transcript_files` 构建。

改法：改成两步 upsert。

```js
// 1) 先走 transcript_files（有 tokens/activeMs/cost）
for (const f of files) {
  if (!f.bound_todo_id) continue
  const b = todoAgg.get(f.bound_todo_id) || newBucket()
  b.activeMs += f.active_ms || 0
  b.tokens = addTokens(b.tokens, fileTokens(f))
  b.sessions += 1
  if (f.primary_model) b.models.set(...)
  todoAgg.set(f.bound_todo_id, b)
}

// 2) 再用 ai_session_log 补 wallClockMs 和"仅日志"行
for (const l of logs) {
  if (!l.todo_id) continue
  const b = todoAgg.get(l.todo_id) || newBucket()  // 不存在则新建零值
  b.wallClockMs += l.duration_ms || 0
  b.logSessions += 1
  todoAgg.set(l.todo_id, b)
}
```

`newBucket()` 含：`{ activeMs: 0, wallClockMs: 0, tokens: { ...ZERO }, sessions: 0, logSessions: 0, models: new Map() }`。

**排序键**：`Math.max(activeMs, wallClockMs)` 降序；tiebreak 沿用 `tokens input+output+cacheRead+cacheCreation`。

- 选 `max` 而不是 `sum`：绑定打通场景下 `activeMs` 是 `wallClockMs` 的"去 idle"子集，两者高度相关，相加等于重复计数。
- `max` 保证仅日志行（activeMs=0 但 wallClockMs>0）能按墙钟时长冒泡，但又不让"墙钟重复计一次"把既有真实活跃的行挤下去。
- 现有测试 `test/stats.report.test.js:52` 原依赖 `activeMs` 单键 + tokens tiebreak，`max` 语义下同样靠 tokens tiebreak 命中 `b.id`，**无需改现有断言**。

**sessionCount 语义**：`topTodos[i].sessionCount = Math.max(b.sessions, b.logSessions)`。

- 正常对齐场景（transcript 和 log 一一对应）下 max = 真实会话数，不双计。
- 极端场景（绑定遗失、PTY 失败未落盘、Claude 写 jsonl 失败）下 max 可能低估真实尝试次数。可接受——UI 可以通过 "活跃 / 墙钟" 两列暗示数据完整性，不在这里追求绝对准确。

**summary 口径对齐**：
- `summary.todoCount`：改为 `union(bound_todo_id in files) ∪ (todo_id in logs)`。
- **时间窗口口径**：`files` 用 `started_at ∈ [since, until)`，`logs` 用 `completed_at ∈ [since, until)`。同一会话如果起始在窗前、结束在窗内（或反之），仍按"任一侧落窗即计入"归并到 union——接受这种"宽口径"作为显式约定，比严格对齐更符合用户直觉（谁希望"跨周末的一场 AI 会话被吞掉"）。
- `summary.unboundSessionCount`：维持原意（transcript_files 中 `bound_todo_id == null` 的数量），这是"绑定链路问题规模"的指标，保留对 UI 有诊断价值。

### Part A · ai_session_log 兜底 auto-bind（治本）

文件：`src/transcripts/matcher.js` + `src/db.js` + `src/transcripts/index.js`

#### 1. 新增 db 方法

`src/db.js`：

```js
listSessionLogsInWindow(tool, startedAt, windowMs)
// 返回 ai_session_log 中 tool 相同、|started_at - ?| <= windowMs 的行
// 实现：在 JS 侧计算 lo = startedAt - windowMs, hi = startedAt + windowMs
// SELECT id, todo_id, tool, started_at FROM ai_session_log
//   WHERE tool = ? AND started_at BETWEEN ? AND ?
```

#### 2. matcher.js 新增 log-fallback 阶段

新函数 `autoMatchByLog(unboundFiles, db)`：

```js
export function autoMatchByLog(unboundFiles, db, windowMs = WINDOW_MS) {
  const pairs = []
  for (const f of unboundFiles) {
    if (!f.tool || !f.started_at) continue
    const logs = db.listSessionLogsInWindow(f.tool, f.started_at, windowMs)
    if (logs.length === 0) continue
    // 唯一性：同窗口多条 log 对应不同 todo 则 skip（避免误绑）
    const todoIds = [...new Set(logs.map(l => l.todo_id))]
    if (todoIds.length !== 1) continue
    pairs.push({ fileId: f.id, todoId: todoIds[0], sessionId: null, nativeId: f.native_id })
  }
  return pairs
}
```

- 窗口复用现有 `WINDOW_MS = 60_000`。
- 不要求 `cwd` 匹配（`ai_session_log` 无此字段；如需额外过滤可查 `todo.workDir` 再比对，但先不做，保持第一版简单）。
- 歧义（多 todo_id）一律 skip，与现有 `tieReject` 语义一致。

#### 3. `autoBindUnbound()` 增加第二阶段

`src/transcripts/index.js::autoBindUnbound`：

```js
async function autoBindUnbound() {
  const unbound = db.listUnboundTranscriptFiles()
  if (!unbound.length) return 0

  // 第一阶段：orphan-based（现有严格规则，优先级更高）
  const orphans = collectOrphans(listTodos())
  const pairs1 = orphans.length ? autoMatch(unbound, orphans) : []
  for (const p of pairs1) { /* 现有逻辑：applyBindingToTodo + setTranscriptBound */ }

  // 第二阶段：ai_session_log 兜底
  const stillUnbound = db.listUnboundTranscriptFiles()
  const pairs2 = autoMatchByLog(stillUnbound, db)
  for (const p of pairs2) {
    const file = db.getTranscriptFile(p.fileId)
    if (!file) continue
    applyBindingToTodo(p.todoId, {
      nativeId: p.nativeId,
      tool: file.tool,
      startedAt: file.started_at,
      endedAt: file.ended_at,
    }, null, { createNewSession: true })  // ← 关键：绕过 pending-session 劫持
    db.setTranscriptBound(p.fileId, p.todoId)
  }

  return pairs1.length + pairs2.length
}
```

#### 3a. `applyBindingToTodo` 新增 `createNewSession` 选项（关键修正）

现有 `applyBindingToTodo`（`src/transcripts/index.js:12-47`）在 `sessionIdHint` 为空时，有一个 fallback：

```js
if (targetIdx === -1) targetIdx = filtered.findIndex(s => !s?.nativeSessionId && s?.tool === tool)
```

它会**抓到该 todo 下任意一个同 tool、还没 nativeSessionId 的 pending session**。这在 orphan-based 绑定路径是合理的（那条 pending session 本就是要被填 nativeId 的），但 **log-fallback 的前提是"根本没有 pending session"**——真正的 PTY 会话从未写进 `todo.aiSessions`。如果此时 todo 上恰好有一条**无关的**手动创建的 pending session（用户在 UI 上开了个 AI terminal 但没实际跑），transcript 会被错误地塞进那条 session，导致"牛头不对马嘴"的绑定。

**修改签名**：

```js
function applyBindingToTodo(todoId, info, sessionIdHint, opts = {}) {
  // ...
  let targetIdx = -1
  if (sessionIdHint) targetIdx = filtered.findIndex(s => s?.sessionId === sessionIdHint)
  if (targetIdx === -1 && !opts.createNewSession) {
    targetIdx = filtered.findIndex(s => !s?.nativeSessionId && s?.tool === tool)
  }
  // ...
}
```

`createNewSession: true` 时跳过 pending-session fallback，强制走 "push 新 `imported-${nativeId}` session" 分支。orphan-based 路径不传该选项，行为不变。

#### 3b. 去重依赖（明确声明）

`applyBindingToTodo` 的 dedup 通过 `nativeSessionId + tool` 判等（`src/transcripts/index.js:18`）。`pairs1` 和 `pairs2` 的输入来源不同，但最终写入的 `(nativeId, tool)` 对应唯一的 transcript_file，因此：

- 同一 file 不会被两阶段重复处理：第二阶段用 `db.listUnboundTranscriptFiles()` 二次拉取，已绑的不会再进 `stillUnbound`。
- 同一 `native_id + tool` 也不会在同一 todo 下产生两条 aiSessions：`filtered` 的初始化就过滤掉同 `(nativeId, tool)` 的老记录。

无需额外防御。

#### 4. 老数据回填

`autoBindUnbound()` 已在 `scanFull / scanIncremental` 末尾调用，服务启动时的 `scanIncremental()` 自然会触发回补，不需要额外入口。

### Part C · 前端展示

文件：`web/src/StatsDrawer.tsx`

- `TopTodo` 类型加 `wallClockMs: number`（已有）无需改；字段已在用。
- Top 10 表格列：`token / cost` 值为 `0` 时直接按原格式显示（即 `0` 和 `$0.00 / ¥0.0`），**不加 tag / 不加标注**（按用户决策 Q1=b）。
- 保留现有 "墙钟" 列（`wallClockMs`），它本身就能表达"仅日志"场景。

## 数据模型

**不动表结构**。完全沿用现有 `transcript_files` / `ai_session_log`。

## 测试

### 新增

`test/transcripts.matcher.log-fallback.test.js`：

- case 1：1 个 unbound file + 1 条 log 同 tool、started_at 差 5s → 绑到 log.todo_id
- case 2：1 个 unbound file + 2 条 log 同 tool、同窗口但不同 todo_id → 不绑（歧义）
- case 3：1 个 unbound file + 1 条 log 但 tool 不同 → 不绑
- case 4：1 个 unbound file + 1 条 log 但 started_at 差 120s → 不绑（窗外）
- case 5（防劫持）：todo 上已有一条 `{ sessionId: 'manual-123', tool: 'claude', nativeSessionId: null, prompt: 'something else' }` 的无关 pending session。另有 1 个 unbound file + 1 条匹配的 log → 绑定后，该 pending session 的 `nativeSessionId` **仍为 null**，transcript 被加入一条新的 `imported-<nativeId>` session（而不是挤进那条 manual pending）。

### 修改

`test/stats.report.test.js`：

- **既有断言不需要改**：排序从 `activeMs` 改成 `max(activeMs, wallClockMs)` 后，seed 中 `a.id` 与 `b.id` 的 `max` 仍然相等（900_000），tiebreak 依然靠 tokens 命中 `b.id`，`expect(report.topTodos[0].todoId).toBe(b.id)` 依然通过。本次调整前先本地跑一遍现有测试确认无回归。
- 新增 case 1：seed 1 个 todo 只有 ai_session_log 没有对应 transcript_files → 断言 `topTodos` 包含它，`activeMs=0`, `wallClockMs = log.duration_ms`, `tokens` 全 0, `cost.usd=0`
- 新增 case 2：seed 2 个 todo，一个 activeMs=500k 无 log，另一个 activeMs=0 wallClockMs=800k → 断言排序后第二个排在第一（max 语义）

### 手测

1. 启动服务（会自动跑 `scanIncremental` → `autoBindUnbound`）。
2. 开统计抽屉"本周"：
   - 期望 Top 10 行数 ≥ 10（本周有 22 个 todo）
   - `summary.todoCount` ≥ Top 10 行数
   - 本月 450+ unbound transcript 中大部分应被回补（通过 `db.countUnboundTranscripts()` 前后对比 or 日志 "autoBound=X"）。
3. 抽查一条新绑定：`SELECT * FROM transcript_files WHERE bound_todo_id IS NOT NULL ORDER BY indexed_at DESC LIMIT 5` 看是否都是合理的 todo。

## 边界 & 取舍

1. **时间窗 60s 是否够用**：实测 quadtodo PTY 到 Claude CLI 落盘差 ~6s。60s 留足余量。若未来出现冷启动慢 or 大 jsonl 写入延迟，可调到 `config.stats.bindWindowMs`（本期不做）。
2. **歧义 skip 的代价**：两条同窗口 log 会导致两个 transcript 都不绑。可接受——宁可不绑也不误绑。这种情况下用户仍能在 topTodos 里通过 log 路径看到这两个 todo。
3. **`sessionCount` 重复计数**：取 max 而非 sum，避免"1 次跑产生 1 条 log + 1 条 transcript"被算成 2 场会话。绑定打通后两边本就是同一会话。
4. **未来 PTY runner 修好之后的兼容**：若将来 PTY runner 改成启动时就往 `todo.aiSessions` 写 orphan session，第一阶段 orphan-based 匹配自然优先命中，log-fallback 只是兜底，不会冲突。
5. **`primary_model` 仅来自 transcript**：ai_session_log 没模型字段，仅日志行的 `primaryModel` 为 `null`，UI 不显示。可接受。
6. **老数据回填是否会绑错**：第二阶段严格要求"窗口内 log 对应的 todo_id 唯一"，加上 tool 相同，实测误绑概率很低。若出错，用户可通过现有 `unbind` 接口解绑。

## 落地变更总览

| 类型 | 文件 | 说明 |
|---|---|---|
| 新函数 | `src/db.js` | `listSessionLogsInWindow(tool, startedAt, windowMs)` |
| 新函数 | `src/transcripts/matcher.js` | `autoMatchByLog(files, db, windowMs)` |
| 改动 | `src/transcripts/index.js` | `autoBindUnbound()` 增加第二阶段 log-fallback |
| 改动 | `src/stats/report.js` | `topTodos` 合并 `ai_session_log`；`summary.todoCount` union |
| 改动 | `web/src/StatsDrawer.tsx` | 无结构性改动，Top 10 表不加 tag（按决策 Q1=b） |
| 新测试 | `test/transcripts.matcher.log-fallback.test.js` | 4 个 case |
| 改测试 | `test/stats.report.test.js` | +2 个 case |
| DB 变更 | 无 | — |

## 验收标准

1. **修复后实测**：开统计抽屉"本周"，Top 10 行数 = 本周实际跑过 AI 的 todo 数（诊断数据为 22，应有 10 条）。
2. **summary 一致**：`summary.todoCount` ≥ `topTodos.length`，`unboundSessionCount` 明显下降（本月 450+ → 预期 < 50）。
3. **测试通过**：`npm test`（vitest）全绿，新增 6 个 case 全部通过。
4. **无误绑**：随机抽 10 条新绑定，人工核对 `transcript_files.started_at` 与对应 todo 在那时间点的活动吻合。
5. **回退路径**：如果某条 transcript 绑错，现有 `POST /api/transcripts/:id/unbind` 仍可用。
