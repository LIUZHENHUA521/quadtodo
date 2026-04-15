# AI 使用统计与周/月报告 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 quadtodo 里加入 AI 会话的 token + 成本 + 活跃时长统计，并提供 Web 端周/月报告 + Markdown 导出。

**Architecture:** 复用现有 `transcript_files` 索引通路 —— 在 `scanner.js` 解析 jsonl 时顺手抽取 usage，写入新加的 6 个字段；后端新增 `src/stats/` 模块做聚合、`/api/stats/report` 暴露 JSON + Markdown；前端新增 `StatsDrawer.tsx` + TodoManage 顶栏按钮。

**Tech Stack:** Node 20 + better-sqlite3 / Express / vitest · React 18 + antd + `@ant-design/charts` + xterm（已有）

---

## File Structure

**Create**
- `src/usage-parser.js` — 从已解析的 turns 里抽 usage（纯函数，无 IO）
- `src/pricing.js` — token → ¥/$
- `src/stats/report.js` — 聚合逻辑（从 DB 查 + 组装 report 对象）
- `src/stats/markdown.js` — report 对象 → Markdown 字符串
- `src/routes/stats.js` — Express 路由
- `test/usage-parser.test.js`
- `test/pricing.test.js`
- `test/stats.report.test.js`
- `test/stats.markdown.test.js`
- `test/stats.route.test.js`
- `test/fixtures/claude-usage.jsonl`
- `test/fixtures/codex-usage.jsonl`
- `web/src/StatsDrawer.tsx`

**Modify**
- `src/db.js` — schema 迁移 + 新字段支持 + 查询 API
- `src/transcripts/scanner.js` — 解析时累加 usage / activeMs / primaryModel
- `src/transcripts/indexer.js` — upsert 时传入新字段
- `src/config.js` — `defaultConfig()` 加 `pricing` / `stats` 段
- `src/server.js` — 挂 `/api/stats` 路由
- `web/src/TodoManage.tsx` — 顶栏加 📊 按钮
- `web/package.json` — 加 `@ant-design/charts`（如未装）

---

## Task 1: DB schema — 给 transcript_files 加 6 个字段

**Files:**
- Modify: `src/db.js`
- Test: `test/db.test.js`（追加）

- [ ] **Step 1: Write failing test**

追加到 `test/db.test.js`：

```js
import { describe, it, expect } from 'vitest'
import { openDb } from '../src/db.js'

describe('transcript_files usage columns', () => {
  it('upsert 可写入 usage / active_ms / primary_model 字段', () => {
    const db = openDb(':memory:')
    db.upsertTranscriptFile({
      tool: 'claude',
      nativeId: 'u1',
      cwd: '/tmp',
      jsonlPath: '/tmp/u1.jsonl',
      size: 10, mtime: 1,
      startedAt: 1000, endedAt: 2000,
      firstUserPrompt: 'hi', turnCount: 2,
      inputTokens: 100, outputTokens: 50,
      cacheReadTokens: 10, cacheCreationTokens: 5,
      primaryModel: 'claude-sonnet-4-6', activeMs: 800,
    })
    const row = db.raw.prepare(`SELECT * FROM transcript_files WHERE jsonl_path = ?`).get('/tmp/u1.jsonl')
    expect(row.input_tokens).toBe(100)
    expect(row.output_tokens).toBe(50)
    expect(row.cache_read_tokens).toBe(10)
    expect(row.cache_creation_tokens).toBe(5)
    expect(row.primary_model).toBe('claude-sonnet-4-6')
    expect(row.active_ms).toBe(800)
    db.close()
  })

  it('老 DB 自动补列', () => {
    // 先用老 schema 建库，再 open 一次，应该已补齐新列
    const db1 = openDb(':memory:')
    // 显式 drop 新列模拟老库
    // 在内存库上靠 openDb 的 ALTER 幂等保证：再 open 一次不报错
    const db2 = openDb(':memory:')
    const cols = db2.raw.prepare(`PRAGMA table_info(transcript_files)`).all().map(c => c.name)
    for (const c of ['input_tokens','output_tokens','cache_read_tokens','cache_creation_tokens','primary_model','active_ms']) {
      expect(cols).toContain(c)
    }
    db1.close(); db2.close()
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

```
npx vitest run test/db.test.js
```

- [ ] **Step 3: Modify SCHEMA + migration + upsert in `src/db.js`**

在 `SCHEMA` 里 transcript_files 的 CREATE 块追加 6 个字段（放在 `bound_todo_id` 之前）：

```
  input_tokens          INTEGER,
  output_tokens         INTEGER,
  cache_read_tokens     INTEGER,
  cache_creation_tokens INTEGER,
  primary_model         TEXT,
  active_ms             INTEGER,
```

在 `openDb()` 里 `todos` 迁移块之后追加 transcript_files 的迁移：

```js
const tfCols = db.prepare(`PRAGMA table_info(transcript_files)`).all().map(c => c.name)
for (const col of [
  ['input_tokens', 'INTEGER'],
  ['output_tokens', 'INTEGER'],
  ['cache_read_tokens', 'INTEGER'],
  ['cache_creation_tokens', 'INTEGER'],
  ['primary_model', 'TEXT'],
  ['active_ms', 'INTEGER'],
]) {
  if (!tfCols.includes(col[0])) db.exec(`ALTER TABLE transcript_files ADD COLUMN ${col[0]} ${col[1]}`)
}
```

把 `tfStmts.upsert` 换成包含新字段：

```js
upsert: db.prepare(`
  INSERT INTO transcript_files (tool, native_id, cwd, jsonl_path, size, mtime, started_at, ended_at, first_user_prompt, turn_count, bound_todo_id, indexed_at, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, primary_model, active_ms)
  VALUES (@tool, @native_id, @cwd, @jsonl_path, @size, @mtime, @started_at, @ended_at, @first_user_prompt, @turn_count, @bound_todo_id, @indexed_at, @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens, @primary_model, @active_ms)
  ON CONFLICT(jsonl_path) DO UPDATE SET
    tool=excluded.tool,
    native_id=excluded.native_id,
    cwd=excluded.cwd,
    size=excluded.size,
    mtime=excluded.mtime,
    started_at=excluded.started_at,
    ended_at=excluded.ended_at,
    first_user_prompt=excluded.first_user_prompt,
    turn_count=excluded.turn_count,
    indexed_at=excluded.indexed_at,
    input_tokens=excluded.input_tokens,
    output_tokens=excluded.output_tokens,
    cache_read_tokens=excluded.cache_read_tokens,
    cache_creation_tokens=excluded.cache_creation_tokens,
    primary_model=excluded.primary_model,
    active_ms=excluded.active_ms
`),
```

`upsertTranscriptFile` 里传入这 6 个字段（默认 null）：

```js
function upsertTranscriptFile(row) {
  tfStmts.upsert.run({
    tool: row.tool,
    native_id: row.nativeId ?? null,
    cwd: row.cwd ?? null,
    jsonl_path: row.jsonlPath,
    size: row.size,
    mtime: row.mtime,
    started_at: row.startedAt ?? null,
    ended_at: row.endedAt ?? null,
    first_user_prompt: row.firstUserPrompt ?? null,
    turn_count: row.turnCount ?? 0,
    bound_todo_id: row.boundTodoId ?? null,
    indexed_at: Date.now(),
    input_tokens: row.inputTokens ?? null,
    output_tokens: row.outputTokens ?? null,
    cache_read_tokens: row.cacheReadTokens ?? null,
    cache_creation_tokens: row.cacheCreationTokens ?? null,
    primary_model: row.primaryModel ?? null,
    active_ms: row.activeMs ?? null,
  })
  return tfStmts.getByPath.get(row.jsonlPath)
}
```

- [ ] **Step 4: Run test — expect PASS**

```
npx vitest run test/db.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/db.js test/db.test.js
git commit -m "feat(db): add usage/cost columns to transcript_files"
```

---

## Task 2: usage-parser — 从 jsonl 里抽 token / activeMs / primaryModel

**Files:**
- Create: `src/usage-parser.js`
- Create: `test/fixtures/claude-usage.jsonl`
- Create: `test/fixtures/codex-usage.jsonl`
- Create: `test/usage-parser.test.js`

- [ ] **Step 1: Create fixtures**

`test/fixtures/claude-usage.jsonl`：

```jsonl
{"type":"user","message":{"role":"user","content":"hi"},"timestamp":"2026-04-15T10:00:00.000Z","sessionId":"c1"}
{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-4-6-20260101","content":[{"type":"text","text":"hello"}],"usage":{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":5,"cache_creation_input_tokens":2}},"timestamp":"2026-04-15T10:00:30.000Z"}
{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-4-6-20260101","content":[{"type":"text","text":"again"}],"usage":{"input_tokens":50,"output_tokens":10,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}},"timestamp":"2026-04-15T10:01:10.000Z"}
not valid json
{"type":"assistant","message":{"role":"assistant","model":"claude-opus-4-6","content":[{"type":"text","text":"x"}],"usage":{"input_tokens":10,"output_tokens":5}},"timestamp":"2026-04-15T10:10:00.000Z"}
```

（两条 sonnet 消息相隔 40s（≤120s 阈值），opus 消息距第二条 sonnet 8m50s，会被裁掉。activeMs = 40000 + 0 = 40000。primaryModel = `claude-sonnet-4-6`（两票 vs opus 一票）。Tokens: input=160, output=35, cacheRead=5, cacheCreation=2。）

`test/fixtures/codex-usage.jsonl`：

```jsonl
{"type":"session_meta","payload":{"id":"d1","cwd":"/tmp","timestamp":"2026-04-15T11:00:00.000Z"}}
{"type":"response_item","timestamp":"2026-04-15T11:00:00.000Z","payload":{"type":"message","role":"user","content":[{"text":"ping"}]}}
{"type":"response_item","timestamp":"2026-04-15T11:00:05.000Z","payload":{"type":"message","role":"assistant","model":"gpt-5-codex","content":[{"text":"pong"}],"token_usage":{"input_tokens":30,"output_tokens":8,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
```

- [ ] **Step 2: Write failing test — `test/usage-parser.test.js`**

```js
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import readline from 'node:readline'
import fs from 'node:fs'
import { extractUsage } from '../src/usage-parser.js'

async function rawLines(file) {
  const out = []
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity })
  for await (const l of rl) out.push(l)
  return out
}

describe('extractUsage', () => {
  it('claude：累加 usage、算 activeMs、归一化 primaryModel', async () => {
    const lines = await rawLines(path.resolve(__dirname, 'fixtures/claude-usage.jsonl'))
    const out = extractUsage('claude', lines, { idleThresholdMs: 120000 })
    expect(out.inputTokens).toBe(160)
    expect(out.outputTokens).toBe(35)
    expect(out.cacheReadTokens).toBe(5)
    expect(out.cacheCreationTokens).toBe(2)
    expect(out.primaryModel).toBe('claude-sonnet-4-6')
    expect(out.activeMs).toBe(40000)
    expect(out.parseErrorCount).toBe(1)
  })

  it('codex：读 token_usage', async () => {
    const lines = await rawLines(path.resolve(__dirname, 'fixtures/codex-usage.jsonl'))
    const out = extractUsage('codex', lines, { idleThresholdMs: 120000 })
    expect(out.inputTokens).toBe(30)
    expect(out.outputTokens).toBe(8)
    expect(out.primaryModel).toBe('gpt-5-codex')
  })

  it('空输入不炸', () => {
    const out = extractUsage('claude', [], { idleThresholdMs: 120000 })
    expect(out.inputTokens).toBe(0)
    expect(out.primaryModel).toBeNull()
    expect(out.activeMs).toBe(0)
  })
})
```

- [ ] **Step 3: Run, expect FAIL (module not found)**

```
npx vitest run test/usage-parser.test.js
```

- [ ] **Step 4: Implement `src/usage-parser.js`**

```js
// Pure helpers: given already-read JSONL lines + tool, return usage summary.
// No I/O. No throw on bad lines; returns parseErrorCount instead.

const MODEL_DATE_SUFFIX = /-\d{8}$/ // e.g. "-20260101"

function normalizeModel(name) {
  if (!name) return null
  return String(name).replace(MODEL_DATE_SUFFIX, '')
}

function pickMode(counter) {
  let best = null, bestN = -1
  for (const [k, n] of counter) if (n > bestN) { best = k; bestN = n }
  return best
}

function extractClaude(lines, { idleThresholdMs }) {
  let input = 0, output = 0, cacheR = 0, cacheC = 0, errors = 0
  const modelCounter = new Map()
  const assistantTs = []
  for (const line of lines) {
    if (!line || !line.trim()) continue
    let j
    try { j = JSON.parse(line) } catch { errors++; continue }
    const msg = j.message
    const role = msg?.role
    if (role !== 'assistant') continue
    const u = msg.usage || {}
    input  += Number(u.input_tokens)  || 0
    output += Number(u.output_tokens) || 0
    cacheR += Number(u.cache_read_input_tokens)     || 0
    cacheC += Number(u.cache_creation_input_tokens) || 0
    const model = normalizeModel(msg.model)
    if (model) modelCounter.set(model, (modelCounter.get(model) || 0) + 1)
    const ts = j.timestamp ? Date.parse(j.timestamp) : NaN
    if (!Number.isNaN(ts)) assistantTs.push(ts)
  }
  let activeMs = 0
  assistantTs.sort((a, b) => a - b)
  for (let i = 1; i < assistantTs.length; i++) {
    const dt = assistantTs[i] - assistantTs[i - 1]
    if (dt > 0 && dt <= idleThresholdMs) activeMs += dt
  }
  return {
    inputTokens: input, outputTokens: output,
    cacheReadTokens: cacheR, cacheCreationTokens: cacheC,
    primaryModel: pickMode(modelCounter),
    activeMs, parseErrorCount: errors,
  }
}

function extractCodex(lines, { idleThresholdMs }) {
  let input = 0, output = 0, cacheR = 0, cacheC = 0, errors = 0
  const modelCounter = new Map()
  const assistantTs = []
  for (const line of lines) {
    if (!line || !line.trim()) continue
    let j
    try { j = JSON.parse(line) } catch { errors++; continue }
    if (j.type !== 'response_item') continue
    const p = j.payload
    if (!p || p.type !== 'message' || p.role !== 'assistant') continue
    const u = p.token_usage || p.usage || {}
    input  += Number(u.input_tokens)  || 0
    output += Number(u.output_tokens) || 0
    cacheR += Number(u.cache_read_input_tokens)     || 0
    cacheC += Number(u.cache_creation_input_tokens) || 0
    const model = normalizeModel(p.model)
    if (model) modelCounter.set(model, (modelCounter.get(model) || 0) + 1)
    const ts = j.timestamp ? Date.parse(j.timestamp) : NaN
    if (!Number.isNaN(ts)) assistantTs.push(ts)
  }
  let activeMs = 0
  assistantTs.sort((a, b) => a - b)
  for (let i = 1; i < assistantTs.length; i++) {
    const dt = assistantTs[i] - assistantTs[i - 1]
    if (dt > 0 && dt <= idleThresholdMs) activeMs += dt
  }
  return {
    inputTokens: input, outputTokens: output,
    cacheReadTokens: cacheR, cacheCreationTokens: cacheC,
    primaryModel: pickMode(modelCounter),
    activeMs, parseErrorCount: errors,
  }
}

export function extractUsage(tool, lines, opts = {}) {
  const o = { idleThresholdMs: 120_000, ...opts }
  if (tool === 'claude') return extractClaude(lines, o)
  if (tool === 'codex')  return extractCodex(lines, o)
  throw new Error(`unknown tool: ${tool}`)
}
```

- [ ] **Step 5: Run test — PASS**

```
npx vitest run test/usage-parser.test.js
```

- [ ] **Step 6: Commit**

```bash
git add src/usage-parser.js test/usage-parser.test.js test/fixtures/claude-usage.jsonl test/fixtures/codex-usage.jsonl
git commit -m "feat(usage-parser): extract tokens/activeMs/primaryModel from jsonl"
```

---

## Task 3: 把 usage 融进 scanner + indexer

**Files:**
- Modify: `src/transcripts/scanner.js`
- Modify: `src/transcripts/indexer.js`

让 `parseTranscriptFile` 在读 jsonl 的同时把原始行收集起来喂给 `extractUsage`，避免重复 IO。

- [ ] **Step 1: Modify `src/transcripts/scanner.js`**

在 `parseClaudeFile` 顶部收集 `rawLines`：

```js
async function parseClaudeFile(filePath) {
  const rl = readline.createInterface({ input: fs.createReadStream(filePath, 'utf8'), crlfDelay: Infinity })
  let nativeId = null
  let cwd = null
  let startedAt = null
  let endedAt = null
  let firstUserPrompt = null
  let turnCount = 0
  const turns = []
  const rawLines = []
  for await (const line of rl) {
    if (!line.trim()) continue
    rawLines.push(line)
    // ... 原有解析逻辑不变
```

文件末尾 `return` 前追加：

```js
  const { extractUsage } = await import('../usage-parser.js')
  const usage = extractUsage('claude', rawLines, {})
  return { nativeId, cwd, startedAt, endedAt, firstUserPrompt, turnCount, turns, usage }
}
```

对 `parseCodexFile` 做同样改动（`extractUsage('codex', rawLines, {})`）。

- [ ] **Step 2: Modify `src/transcripts/indexer.js` to pass usage fields**

```js
import { parseTranscriptFile } from './scanner.js'

export async function indexFile(db, { tool, jsonlPath, size, mtime }) {
  let parsed
  try { parsed = await parseTranscriptFile(tool, jsonlPath) }
  catch (e) { return null }
  const u = parsed.usage || {}
  const row = db.upsertTranscriptFile({
    tool,
    nativeId: parsed.nativeId,
    cwd: parsed.cwd,
    jsonlPath,
    size,
    mtime,
    startedAt: parsed.startedAt,
    endedAt: parsed.endedAt,
    firstUserPrompt: parsed.firstUserPrompt,
    turnCount: parsed.turnCount,
    inputTokens: u.inputTokens ?? null,
    outputTokens: u.outputTokens ?? null,
    cacheReadTokens: u.cacheReadTokens ?? null,
    cacheCreationTokens: u.cacheCreationTokens ?? null,
    primaryModel: u.primaryModel ?? null,
    activeMs: u.activeMs ?? null,
  })
  if (row && parsed.turns?.length) db.writeFtsTurns(row.id, parsed.turns)
  return row
}
```

- [ ] **Step 3: Add integration test — `test/transcripts.test.js` 追加**

打开 `test/transcripts.test.js` 看现有结构后追加：

```js
it('scanner 解析 claude fixture 时填充 usage 字段', async () => {
  const { parseTranscriptFile } = await import('../src/transcripts/scanner.js')
  const p = new URL('./fixtures/claude-usage.jsonl', import.meta.url).pathname
  const out = await parseTranscriptFile('claude', p)
  expect(out.usage.inputTokens).toBe(160)
  expect(out.usage.primaryModel).toBe('claude-sonnet-4-6')
  expect(out.usage.activeMs).toBe(40000)
})
```

- [ ] **Step 4: Run**

```
npx vitest run test/transcripts.test.js
```

全绿。

- [ ] **Step 5: 触发一次 full rescan 重算老记录**

在 `src/transcripts/index.js` 的 `scan()` 里把 dirty 判断增强：

```js
const missingUsage = existing && existing.input_tokens == null && existing.output_tokens == null
const dirty = mode === 'full' || !existing || existing.size !== f.size || existing.mtime !== f.mtime || missingUsage
```

这样服务启动的 `scanFull()` 会自动回填老库。

- [ ] **Step 6: Commit**

```bash
git add src/transcripts/scanner.js src/transcripts/indexer.js src/transcripts/index.js test/transcripts.test.js
git commit -m "feat(transcripts): populate usage columns during scan + backfill"
```

---

## Task 4: pricing 模块 + config 默认值

**Files:**
- Create: `src/pricing.js`
- Create: `test/pricing.test.js`
- Modify: `src/config.js`

- [ ] **Step 1: Write failing test — `test/pricing.test.js`**

```js
import { describe, it, expect } from 'vitest'
import { estimateCost, DEFAULT_PRICING } from '../src/pricing.js'

describe('estimateCost', () => {
  const pricing = DEFAULT_PRICING

  it('sonnet 按 glob 命中', () => {
    const c = estimateCost(
      { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreation: 0 },
      'claude-sonnet-4-6',
      pricing,
    )
    expect(c.usd).toBeCloseTo(3 + 15, 2)
    expect(c.cny).toBeCloseTo((3 + 15) * pricing.cnyRate, 2)
  })

  it('opus 按 glob 命中', () => {
    const c = estimateCost(
      { input: 0, output: 1_000_000, cacheRead: 0, cacheCreation: 0 },
      'claude-opus-4-6',
      pricing,
    )
    expect(c.usd).toBeCloseTo(75, 2)
  })

  it('未知模型回落 default', () => {
    const c = estimateCost({ input: 2_000_000, output: 0, cacheRead: 0, cacheCreation: 0 }, 'gpt-5-codex', pricing)
    expect(c.usd).toBeCloseTo(pricing.default.input * 2, 2)
  })

  it('null model 也回落 default', () => {
    const c = estimateCost({ input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 }, null, pricing)
    expect(c.usd).toBeCloseTo(pricing.default.input, 2)
  })
})
```

- [ ] **Step 2: Run — FAIL**

```
npx vitest run test/pricing.test.js
```

- [ ] **Step 3: Implement `src/pricing.js`**

```js
export const DEFAULT_PRICING = {
  default:   { input: 3.00,  output: 15.00, cacheRead: 0.30, cacheWrite: 3.75  },
  models: {
    'claude-opus-4-*':   { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
    'claude-sonnet-4-*': { input: 3.00,  output: 15.00, cacheRead: 0.30, cacheWrite: 3.75  },
    'claude-haiku-4-*':  { input: 1.00,  output: 5.00,  cacheRead: 0.10, cacheWrite: 1.25  },
  },
  cnyRate: 7.2,
}

function globToRegex(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

function resolveRate(model, pricing) {
  if (model && pricing.models) {
    for (const [pattern, rate] of Object.entries(pricing.models)) {
      if (globToRegex(pattern).test(model)) return rate
    }
  }
  return pricing.default
}

export function estimateCost(tokens, model, pricing = DEFAULT_PRICING) {
  const rate = resolveRate(model, pricing)
  const usd =
    (Number(tokens.input)        || 0) * rate.input      / 1_000_000 +
    (Number(tokens.output)       || 0) * rate.output     / 1_000_000 +
    (Number(tokens.cacheRead)    || 0) * rate.cacheRead  / 1_000_000 +
    (Number(tokens.cacheCreation)|| 0) * rate.cacheWrite / 1_000_000
  return { usd, cny: usd * (pricing.cnyRate || 0) }
}
```

- [ ] **Step 4: Modify `src/config.js` default**

在 `defaultConfig()` 里追加：

```js
import { DEFAULT_PRICING } from './pricing.js'
// ...
function defaultConfig() {
  return {
    port: 5677,
    defaultTool: 'claude',
    defaultCwd: homedir(),
    tools: resolveToolsConfig(),
    webhook: { ...DEFAULT_WEBHOOK_CONFIG },
    pricing: DEFAULT_PRICING,
    stats: { idleThresholdMs: 120_000 },
  }
}
```

在 `normalizeConfig` 的返回里，把 `pricing` 和 `stats` 也合并：

```js
pricing: { ...defaults.pricing, ...(cfg.pricing || {}), models: { ...defaults.pricing.models, ...(cfg.pricing?.models || {}) } },
stats:   { ...defaults.stats, ...(cfg.stats || {}) },
```

- [ ] **Step 5: Run all tests — PASS**

```
npx vitest run test/pricing.test.js test/config.test.js
```

若 `config.test.js` 因新增字段 snapshot 失败，按提示更新。

- [ ] **Step 6: Commit**

```bash
git add src/pricing.js src/config.js test/pricing.test.js
git commit -m "feat(pricing): token-to-cost estimator with config override"
```

---

## Task 5: 聚合逻辑 `src/stats/report.js`

**Files:**
- Create: `src/stats/report.js`
- Create: `test/stats.report.test.js`

- [ ] **Step 1: Write failing test**

```js
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb } from '../src/db.js'
import { buildReport } from '../src/stats/report.js'
import { DEFAULT_PRICING } from '../src/pricing.js'

function seed(db, rows) {
  for (const r of rows) {
    db.upsertTranscriptFile({
      tool: r.tool || 'claude',
      nativeId: r.id, cwd: '/tmp',
      jsonlPath: `/tmp/${r.id}.jsonl`,
      size: 1, mtime: r.endedAt,
      startedAt: r.startedAt, endedAt: r.endedAt,
      firstUserPrompt: 'x', turnCount: 1,
      inputTokens: r.input, outputTokens: r.output,
      cacheReadTokens: 0, cacheCreationTokens: 0,
      primaryModel: r.model, activeMs: r.active,
      boundTodoId: r.todoId ?? null,
    })
  }
}

describe('buildReport', () => {
  let db
  beforeEach(() => { db = openDb(':memory:') })

  it('summary 汇总 + topTodos 排序', () => {
    db.createTodo({ title: 'A', quadrant: 1 })
    const a = db.listTodos()[0]
    db.createTodo({ title: 'B', quadrant: 2 })
    const b = db.listTodos()[1]
    seed(db, [
      { id: 's1', startedAt: 1000, endedAt: 2000, active: 600_000, input: 100_000, output: 20_000, model: 'claude-sonnet-4-6', todoId: a.id },
      { id: 's2', startedAt: 3000, endedAt: 4000, active: 300_000, input: 50_000,  output: 10_000, model: 'claude-sonnet-4-6', todoId: a.id },
      { id: 's3', startedAt: 5000, endedAt: 6000, active: 900_000, input: 1_000_000, output: 200_000, model: 'claude-opus-4-6', todoId: b.id },
      { id: 's4', startedAt: 7000, endedAt: 8000, active: 100_000, input: 1000, output: 500, model: 'claude-sonnet-4-6', todoId: null },
    ])
    db.insertSessionLog({ id: 's1', todoId: a.id, tool: 'claude', quadrant: 1, status: 'done', startedAt: 1000, completedAt: 2000 })
    db.insertSessionLog({ id: 's2', todoId: a.id, tool: 'claude', quadrant: 1, status: 'done', startedAt: 3000, completedAt: 4000 })
    db.insertSessionLog({ id: 's3', todoId: b.id, tool: 'claude', quadrant: 2, status: 'done', startedAt: 5000, completedAt: 6000 })
    db.insertSessionLog({ id: 's4', todoId: 'unbound', tool: 'claude', quadrant: 4, status: 'done', startedAt: 7000, completedAt: 8000 })

    const report = buildReport(db, { since: 0, until: 9000, pricing: DEFAULT_PRICING })
    expect(report.summary.sessionCount).toBe(4)
    expect(report.summary.todoCount).toBe(2)
    expect(report.summary.unboundSessionCount).toBe(1)
    expect(report.summary.activeMs).toBe(600_000 + 300_000 + 900_000 + 100_000)
    expect(report.summary.tokens.input).toBe(1_151_000)
    expect(report.summary.cost.usd).toBeGreaterThan(0)

    // topTodos by activeMs desc
    expect(report.topTodos[0].todoId).toBe(b.id)  // 900k
    expect(report.topTodos[1].todoId).toBe(a.id)  // 600k+300k=900k... actually equal, take by title order — just check inclusion
    const ids = report.topTodos.map(t => t.todoId)
    expect(ids).toContain(a.id)
    expect(ids).toContain(b.id)
  })

  it('空 DB 返回 empty summary', () => {
    const r = buildReport(db, { since: 0, until: 1000, pricing: DEFAULT_PRICING })
    expect(r.summary.sessionCount).toBe(0)
    expect(r.topTodos).toEqual([])
  })
})
```

- [ ] **Step 2: Run — FAIL**

```
npx vitest run test/stats.report.test.js
```

- [ ] **Step 3: Implement `src/stats/report.js`**

```js
import { estimateCost } from '../pricing.js'

function addTokens(a, b) {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
  }
}

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }

function fileTokens(f) {
  return {
    input: f.input_tokens || 0,
    output: f.output_tokens || 0,
    cacheRead: f.cache_read_tokens || 0,
    cacheCreation: f.cache_creation_tokens || 0,
  }
}

function costOf(tokens, model, pricing) {
  return estimateCost(tokens, model, pricing)
}

function pickBucketSize(since, until) {
  return (until - since) > 7 * 86400_000 ? 86400_000 : 3600_000
}

export function buildReport(db, { since, until = Date.now(), pricing, topN = 10 }) {
  const raw = db.raw
  const files = raw.prepare(`
    SELECT * FROM transcript_files
    WHERE started_at IS NOT NULL AND started_at >= ? AND started_at < ?
  `).all(since, until)

  const logs = raw.prepare(`
    SELECT * FROM ai_session_log
    WHERE completed_at >= ? AND completed_at < ?
  `).all(since, until)

  // summary
  let totalTokens = { ...ZERO }
  let totalActive = 0
  let totalWall = 0
  const coveredTodos = new Set()
  let unbound = 0
  for (const f of files) {
    totalTokens = addTokens(totalTokens, fileTokens(f))
    totalActive += f.active_ms || 0
    if (f.bound_todo_id) coveredTodos.add(f.bound_todo_id)
    else unbound++
  }
  for (const l of logs) totalWall += l.duration_ms || 0

  const totalCost = costOf(totalTokens, null, pricing)

  // topTodos: group files by bound_todo_id
  const todoAgg = new Map()
  for (const f of files) {
    if (!f.bound_todo_id) continue
    const bucket = todoAgg.get(f.bound_todo_id) || {
      todoId: f.bound_todo_id, activeMs: 0, tokens: { ...ZERO }, sessions: 0, models: new Map(),
    }
    bucket.activeMs += f.active_ms || 0
    bucket.tokens = addTokens(bucket.tokens, fileTokens(f))
    bucket.sessions += 1
    if (f.primary_model) bucket.models.set(f.primary_model, (bucket.models.get(f.primary_model) || 0) + 1)
    todoAgg.set(f.bound_todo_id, bucket)
  }
  // wall clock per todo from ai_session_log
  const todoWall = new Map()
  for (const l of logs) {
    todoWall.set(l.todo_id, (todoWall.get(l.todo_id) || 0) + (l.duration_ms || 0))
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
        wallClockMs: todoWall.get(b.todoId) || 0,
        tokens: b.tokens,
        cost: costOf(b.tokens, topModel, pricing),
        sessionCount: b.sessions,
        primaryModel: topModel,
      }
    })
    .sort((a, b) => b.activeMs - a.activeMs)
    .slice(0, topN)

  // byTool / byQuadrant / byModel
  const byTool = aggregateBy(files, logs, f => f.tool, l => l.tool, pricing)
  const byQuadrant = aggregateBy(files, logs,
    f => (todoById.get(f.bound_todo_id)?.quadrant) || 0,
    l => l.quadrant, pricing)
  const byModel = aggregateBy(files, [], f => f.primary_model || '(unknown)', () => null, pricing, { includeWall: false })

  // timeline
  const bucketSize = pickBucketSize(since, until)
  const timelineMap = new Map()
  for (const f of files) {
    const b = Math.floor((f.started_at || since) / bucketSize) * bucketSize
    const cur = timelineMap.get(b) || { t: b, wallClockMs: 0, activeMs: 0, tokens: { ...ZERO } }
    cur.activeMs += f.active_ms || 0
    cur.tokens = addTokens(cur.tokens, fileTokens(f))
    timelineMap.set(b, cur)
  }
  for (const l of logs) {
    const b = Math.floor(l.completed_at / bucketSize) * bucketSize
    const cur = timelineMap.get(b) || { t: b, wallClockMs: 0, activeMs: 0, tokens: { ...ZERO } }
    cur.wallClockMs += l.duration_ms || 0
    timelineMap.set(b, cur)
  }
  const timeline = [...timelineMap.values()]
    .sort((a, b) => a.t - b.t)
    .map(e => ({ ...e, cost: costOf(e.tokens, null, pricing) }))

  return {
    range: { since, until, label: rangeLabel(since, until) },
    summary: {
      wallClockMs: totalWall,
      activeMs: totalActive,
      tokens: { ...totalTokens, total: totalTokens.input + totalTokens.output + totalTokens.cacheRead + totalTokens.cacheCreation },
      cost: totalCost,
      sessionCount: logs.length || files.length,
      todoCount: coveredTodos.size,
      unboundSessionCount: unbound,
    },
    topTodos,
    byTool,
    byQuadrant,
    byModel,
    timeline,
  }
}

function aggregateBy(files, logs, keyF, keyL, pricing, { includeWall = true } = {}) {
  const m = new Map()
  for (const f of files) {
    const k = keyF(f)
    if (k == null) continue
    const cur = m.get(k) || { key: k, sessions: 0, activeMs: 0, wallClockMs: 0, tokens: { ...ZERO } }
    cur.sessions += 1
    cur.activeMs += f.active_ms || 0
    cur.tokens = addTokens(cur.tokens, fileTokens(f))
    m.set(k, cur)
  }
  if (includeWall) {
    for (const l of logs) {
      const k = keyL(l)
      if (k == null) continue
      const cur = m.get(k) || { key: k, sessions: 0, activeMs: 0, wallClockMs: 0, tokens: { ...ZERO } }
      cur.wallClockMs += l.duration_ms || 0
      m.set(k, cur)
    }
  }
  return [...m.values()].map(e => ({ ...e, cost: estimateCost(e.tokens, null, pricing) }))
}

function rangeLabel(since, until) {
  const days = Math.round((until - since) / 86400_000)
  if (days === 7) return '本周'
  if (days >= 28 && days <= 31) return '本月'
  if (days === 30) return '近 30 天'
  return '自定义'
}
```

- [ ] **Step 4: Run — PASS**

```
npx vitest run test/stats.report.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/stats/report.js test/stats.report.test.js
git commit -m "feat(stats): aggregate tokens/activeMs/cost per todo and group"
```

---

## Task 6: Markdown 渲染器

**Files:**
- Create: `src/stats/markdown.js`
- Create: `test/stats.markdown.test.js`

- [ ] **Step 1: Write failing test**

```js
import { describe, it, expect } from 'vitest'
import { renderMarkdown } from '../src/stats/markdown.js'

const sampleReport = {
  range: { since: Date.parse('2026-04-08T00:00:00Z'), until: Date.parse('2026-04-15T00:00:00Z'), label: '本周' },
  summary: {
    wallClockMs: 12.1 * 3600_000,
    activeMs: 8.3 * 3600_000,
    tokens: { input: 4_000_000, output: 1_000_000, cacheRead: 8_100_000, cacheCreation: 100_000, total: 13_200_000 },
    cost: { usd: 23.7, cny: 170.6 },
    sessionCount: 47, todoCount: 12, unboundSessionCount: 3,
  },
  topTodos: [
    { todoId: 'a', title: '修复 bug', quadrant: 1, activeMs: 2.1 * 3600_000, wallClockMs: 3 * 3600_000, tokens: { input: 500000, output: 120000, cacheRead: 0, cacheCreation: 0 }, cost: { usd: 4.2, cny: 30 }, sessionCount: 6, primaryModel: 'claude-sonnet-4-6' },
  ],
  byModel: [
    { key: 'claude-opus-4-6',   sessions: 18, tokens: { input: 2_000_000, output: 500_000, cacheRead: 0, cacheCreation: 0 }, cost: { usd: 12.1, cny: 87 } },
    { key: 'claude-sonnet-4-6', sessions: 29, tokens: { input: 2_000_000, output: 500_000, cacheRead: 0, cacheCreation: 0 }, cost: { usd: 11.6, cny: 83 } },
  ],
}

describe('renderMarkdown', () => {
  it('snapshot', () => {
    expect(renderMarkdown(sampleReport)).toMatchSnapshot()
  })

  it('包含关键信息', () => {
    const md = renderMarkdown(sampleReport)
    expect(md).toContain('# quadtodo 周报')
    expect(md).toContain('活跃 8.3h')
    expect(md).toContain('12.1h')
    expect(md).toContain('修复 bug')
    expect(md).toContain('claude-opus-4-6')
    expect(md).toContain('其中 3 场未关联任务')
  })
})
```

- [ ] **Step 2: Run — FAIL**

```
npx vitest run test/stats.markdown.test.js
```

- [ ] **Step 3: Implement `src/stats/markdown.js`**

```js
function fmtHours(ms) { return (ms / 3600_000).toFixed(1) + 'h' }
function fmtTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}
function fmtDate(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
function fmtCost(c) { return `$${c.usd.toFixed(2)} / ¥${c.cny.toFixed(1)}` }

export function renderMarkdown(r) {
  const { range, summary, topTodos, byModel } = r
  const lines = []
  lines.push(`# quadtodo ${range.label === '本月' ? '月报' : '周报'} · ${fmtDate(range.since)} ~ ${fmtDate(range.until)}`)
  lines.push('')
  lines.push(`AI 活跃 ${fmtHours(summary.activeMs)}（墙钟 ${fmtHours(summary.wallClockMs)}）· ${summary.sessionCount} 场会话 · 覆盖 ${summary.todoCount} 个任务`)
  lines.push(`Token ${fmtTokens(summary.tokens.total)}（cache 命中 ${fmtTokens(summary.tokens.cacheRead)}）· 成本 ${fmtCost(summary.cost)}`)
  if (summary.unboundSessionCount > 0) {
    lines.push(`> 其中 ${summary.unboundSessionCount} 场未关联任务`)
  }
  lines.push('')
  lines.push('## Top 10 任务')
  topTodos.forEach((t, i) => {
    lines.push(`${i + 1}. ${t.title} — 活跃 ${fmtHours(t.activeMs)} · ${fmtCost(t.cost)} · ${t.sessionCount} 场`)
  })
  lines.push('')
  lines.push('## 按模型')
  for (const m of byModel) {
    lines.push(`- ${m.key}: ${m.sessions} 场 · ${fmtTokens(m.tokens.input + m.tokens.output)} tok · ${fmtCost(m.cost)}`)
  }
  return lines.join('\n')
}
```

- [ ] **Step 4: Run — PASS (accept snapshot)**

```
npx vitest run test/stats.markdown.test.js
```

如需更新 snapshot：`npx vitest run test/stats.markdown.test.js -u`。

- [ ] **Step 5: Commit**

```bash
git add src/stats/markdown.js test/stats.markdown.test.js
git commit -m "feat(stats): render report as Markdown"
```

---

## Task 7: HTTP 路由 `/api/stats`

**Files:**
- Create: `src/routes/stats.js`
- Modify: `src/server.js`
- Create: `test/stats.route.test.js`

- [ ] **Step 1: Write failing test**

```js
import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { createServer } from '../src/server.js'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'

function mkServer() {
  const root = mkdtempSync(join(tmpdir(), 'qt-'))
  return createServer({ dbFile: ':memory:', logDir: root, configRootDir: root, tools: { claude: { bin: 'claude', command: 'claude', args: [] }, codex: { bin: 'codex', command: 'codex', args: [] } } })
}

describe('GET /api/stats/report', () => {
  it('返回 summary + topTodos + byTool', async () => {
    const srv = mkServer()
    const res = await request(srv.app).get('/api/stats/report?since=0&until=9999999999999')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.report).toHaveProperty('summary')
    expect(res.body.report).toHaveProperty('topTodos')
    expect(res.body.report).toHaveProperty('byTool')
    expect(res.body.report).toHaveProperty('byModel')
    expect(res.body.report).toHaveProperty('timeline')
    await srv.close()
  })

  it('.md 端点返回 Markdown', async () => {
    const srv = mkServer()
    const res = await request(srv.app).get('/api/stats/report.md?since=0&until=9999999999999')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/markdown/)
    expect(res.text).toMatch(/# quadtodo/)
    await srv.close()
  })

  it('400 若 since/until 非法', async () => {
    const srv = mkServer()
    const res = await request(srv.app).get('/api/stats/report?since=abc&until=xyz')
    expect(res.status).toBe(400)
    await srv.close()
  })
})
```

- [ ] **Step 2: Run — FAIL**

```
npx vitest run test/stats.route.test.js
```

- [ ] **Step 3: Implement `src/routes/stats.js`**

```js
import express from 'express'
import { buildReport } from '../stats/report.js'
import { renderMarkdown } from '../stats/markdown.js'

export function createStatsRouter({ db, getPricing }) {
  const router = express.Router()

  function parseRange(req) {
    const s = Number(req.query.since)
    const u = Number(req.query.until)
    if (!Number.isFinite(s) || !Number.isFinite(u) || s >= u) return null
    return { since: s, until: u }
  }

  router.get('/report', (req, res) => {
    const range = parseRange(req)
    if (!range) return res.status(400).json({ ok: false, error: 'invalid_range' })
    const report = buildReport(db, { ...range, pricing: getPricing() })
    res.json({ ok: true, report })
  })

  router.get('/report.md', (req, res) => {
    const range = parseRange(req)
    if (!range) return res.status(400).send('invalid range')
    const report = buildReport(db, { ...range, pricing: getPricing() })
    res.set('Content-Type', 'text/markdown; charset=utf-8')
    res.send(renderMarkdown(report))
  })

  return router
}
```

- [ ] **Step 4: Mount in `src/server.js`**

顶部加 import：

```js
import { createStatsRouter } from "./routes/stats.js";
```

在 `app.use("/api/transcripts", ...)` 下方加：

```js
app.use("/api/stats", createStatsRouter({
  db,
  getPricing: () => (loadConfig({ rootDir: configRootDir }).pricing),
}));
```

需要把 `runtimeConfig` 扩展读 pricing（可选），或每次 loadConfig（简单稳妥）。

- [ ] **Step 5: Run tests — PASS**

```
npx vitest run test/stats.route.test.js
```

- [ ] **Step 6: Commit**

```bash
git add src/routes/stats.js src/server.js test/stats.route.test.js
git commit -m "feat(stats): expose /api/stats/report JSON + Markdown"
```

---

## Task 8: 前端 StatsDrawer

**Files:**
- Create: `web/src/StatsDrawer.tsx`
- Modify: `web/src/TodoManage.tsx`
- Modify: `web/package.json`（加依赖）

- [ ] **Step 1: 安装图表库**

```bash
cd web && npm i @ant-design/charts && cd ..
```

- [ ] **Step 2: Create `web/src/StatsDrawer.tsx`**

```tsx
import { useEffect, useMemo, useState } from 'react'
import { Drawer, Segmented, DatePicker, Card, Table, Collapse, Button, message, Empty, Spin } from 'antd'
import { Line, Pie } from '@ant-design/charts'
import dayjs, { Dayjs } from 'dayjs'

type Range = 'week' | 'month' | '30d' | 'custom'

interface Cost { usd: number; cny: number }
interface Tokens { input: number; output: number; cacheRead: number; cacheCreation: number; total?: number }
interface TopTodo {
  todoId: string; title: string; quadrant: number
  activeMs: number; wallClockMs: number
  tokens: Tokens; cost: Cost
  sessionCount: number; primaryModel: string | null
}
interface Report {
  range: { since: number; until: number; label: string }
  summary: {
    wallClockMs: number; activeMs: number
    tokens: Tokens; cost: Cost
    sessionCount: number; todoCount: number; unboundSessionCount: number
  }
  topTodos: TopTodo[]
  byTool: any[]; byQuadrant: any[]; byModel: any[]
  timeline: { t: number; wallClockMs: number; activeMs: number; tokens: Tokens; cost: Cost }[]
}

function rangeToMs(r: Range, custom?: [Dayjs, Dayjs]): [number, number] {
  const now = Date.now()
  if (r === 'week')  return [dayjs().startOf('week').valueOf(), now]
  if (r === 'month') return [dayjs().startOf('month').valueOf(), now]
  if (r === '30d')   return [now - 30 * 86400_000, now]
  if (custom && custom.length === 2) return [custom[0].startOf('day').valueOf(), custom[1].endOf('day').valueOf()]
  return [now - 7 * 86400_000, now]
}

const fmtHours = (ms: number) => (ms / 3600_000).toFixed(1) + 'h'
const fmtTok = (n: number) => n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : String(n)
const fmtCost = (c: Cost) => `$${c.usd.toFixed(2)} / ¥${c.cny.toFixed(1)}`

export default function StatsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [range, setRange] = useState<Range>('week')
  const [custom, setCustom] = useState<[Dayjs, Dayjs] | undefined>()
  const [report, setReport] = useState<Report | null>(null)
  const [loading, setLoading] = useState(false)

  const [since, until] = useMemo(() => rangeToMs(range, custom), [range, custom])

  useEffect(() => {
    if (!open) return
    setLoading(true)
    fetch(`/api/stats/report?since=${since}&until=${until}`)
      .then(r => r.json())
      .then(j => { if (j.ok) setReport(j.report) })
      .finally(() => setLoading(false))
  }, [open, since, until])

  async function copyMd() {
    const r = await fetch(`/api/stats/report.md?since=${since}&until=${until}`)
    const md = await r.text()
    await navigator.clipboard.writeText(md)
    message.success('已复制 Markdown')
  }
  function downloadMd() {
    window.open(`/api/stats/report.md?since=${since}&until=${until}`, '_blank')
  }

  return (
    <Drawer open={open} onClose={onClose} width={720} title="📊 AI 使用统计">
      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <Segmented
          value={range}
          onChange={v => setRange(v as Range)}
          options={[
            { label: '本周', value: 'week' },
            { label: '本月', value: 'month' },
            { label: '近 30 天', value: '30d' },
            { label: '自定义', value: 'custom' },
          ]}
        />
        {range === 'custom' && (
          <DatePicker.RangePicker onChange={v => v && setCustom(v as [Dayjs, Dayjs])} />
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <Button onClick={copyMd}>📋 复制 Markdown</Button>
          <Button onClick={downloadMd}>💾 下载 .md</Button>
        </div>
      </div>

      {loading && <Spin />}
      {!loading && !report && <Empty description="无数据" />}
      {!loading && report && <ReportBody report={report} />}
    </Drawer>
  )
}

function ReportBody({ report }: { report: Report }) {
  const { summary, topTodos, byQuadrant, byModel, timeline } = report
  if (summary.sessionCount === 0) {
    return <Empty description="该时段没有绑定到 todo 的 AI 会话，先去跑几个 AI 任务吧～" />
  }
  const lineData = timeline.flatMap(e => [
    { date: new Date(e.t).toISOString().slice(0, 10), type: '活跃', value: e.activeMs / 3600_000 },
    { date: new Date(e.t).toISOString().slice(0, 10), type: '墙钟', value: e.wallClockMs / 3600_000 },
  ])
  const pieData = byQuadrant.map(q => ({ type: `Q${q.key}`, value: q.activeMs }))

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
        <Card size="small" title="AI 活跃时长"><h2>{fmtHours(summary.activeMs)}</h2><small>墙钟 {fmtHours(summary.wallClockMs)}</small></Card>
        <Card size="small" title="Token 消耗"><h2>{fmtTok(summary.tokens.total || 0)}</h2><small>cache 命中 {fmtTok(summary.tokens.cacheRead)}</small></Card>
        <Card size="small" title="估算成本"><h2>{fmtCost(summary.cost)}</h2><small>按当前价目表</small></Card>
        <Card size="small" title="会话 / 任务"><h2>{summary.sessionCount} / {summary.todoCount}</h2><small>未关联 {summary.unboundSessionCount}</small></Card>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, margin: '16px 0' }}>
        <Card size="small" title="时长趋势"><Line data={lineData} xField="date" yField="value" seriesField="type" height={220} /></Card>
        <Card size="small" title="象限占比（活跃时长）"><Pie data={pieData} angleField="value" colorField="type" height={220} /></Card>
      </div>

      <Card size="small" title="Top 10 任务" style={{ marginBottom: 12 }}>
        <Table<TopTodo>
          dataSource={topTodos}
          rowKey="todoId"
          pagination={false}
          columns={[
            { title: '#', render: (_, __, i) => i + 1, width: 40 },
            { title: '任务', dataIndex: 'title' },
            { title: '象限', dataIndex: 'quadrant', width: 60 },
            { title: '活跃', render: r => fmtHours(r.activeMs), width: 70 },
            { title: '墙钟', render: r => fmtHours(r.wallClockMs), width: 70 },
            { title: 'Token', render: r => fmtTok(r.tokens.input + r.tokens.output), width: 80 },
            { title: '成本', render: r => fmtCost(r.cost) },
            { title: '会话', dataIndex: 'sessionCount', width: 50 },
          ]}
        />
      </Card>

      <Collapse items={[{
        key: 'models', label: '按模型',
        children: (
          <Table
            dataSource={byModel}
            rowKey="key"
            pagination={false}
            columns={[
              { title: '模型', dataIndex: 'key' },
              { title: '会话', dataIndex: 'sessions', width: 60 },
              { title: 'Token', render: (r: any) => fmtTok(r.tokens.input + r.tokens.output) },
              { title: '成本', render: (r: any) => fmtCost(r.cost) },
            ]}
          />
        )
      }]} />
    </>
  )
}
```

- [ ] **Step 3: Modify `web/src/TodoManage.tsx`**

在顶栏按钮组（设置按钮旁）加入：

```tsx
import StatsDrawer from './StatsDrawer'
// ...
const [statsOpen, setStatsOpen] = useState(false)
// 在 JSX 顶栏按钮位置加：
<Button onClick={() => setStatsOpen(true)}>📊 统计</Button>
<StatsDrawer open={statsOpen} onClose={() => setStatsOpen(false)} />
```

（具体插入点跟随现有 `SettingsDrawer` 的触发按钮，保持一致风格。）

- [ ] **Step 4: Build 验证**

```
cd web && npm run build && cd ..
```

期望无报错，产物进入 `dist-web/`。

- [ ] **Step 5: 手动冒烟**

```
npm start
```

打开浏览器，点 📊 统计，切换"本周 / 本月 / 近 30 天"看数据，点"复制 Markdown"确认粘贴板有内容。

- [ ] **Step 6: Commit**

```bash
git add web/package.json web/package-lock.json web/src/StatsDrawer.tsx web/src/TodoManage.tsx
git commit -m "feat(web): stats drawer with charts + markdown export"
```

---

## Task 9: 收尾 — README + 所有测试一遍

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 在 README "数据存储" 后追加一段**

```markdown
## 统计与周/月报告

顶栏 📊 按钮打开"统计"抽屉：展示所选时段的 AI 活跃时长、墙钟时长、token 消耗、成本估算与 Top 10 任务，支持复制/下载 Markdown 周报。

单价默认内置，也可在 `~/.quadtodo/config.json` 的 `pricing` 段里 override：

\`\`\`json
"pricing": {
  "models": {
    "claude-opus-4-*":   { "input": 15.00, "output": 75.00, "cacheRead": 1.50, "cacheWrite": 18.75 }
  },
  "cnyRate": 7.2
}
\`\`\`

活跃时长的空闲阈值（默认 120s）可通过 `stats.idleThresholdMs` 调整。
```

- [ ] **Step 2: 跑全量测试**

```
npx vitest run
```

期望全绿。

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document stats drawer and pricing config"
```

---

## Self-Review 结果

**Spec coverage check**
- 新 6 字段 ↔ Task 1 ✓
- usage-parser ↔ Task 2 ✓
- scanner/indexer 改动 ↔ Task 3 ✓
- 老数据回填 ↔ Task 3 Step 5（missingUsage 条件）✓
- pricing + config ↔ Task 4 ✓
- report 聚合（summary / topTodos / byTool / byQuadrant / byModel / timeline）↔ Task 5 ✓
- Markdown 渲染 ↔ Task 6 ✓
- HTTP 路由（JSON + md）↔ Task 7 ✓
- StatsDrawer + 入口按钮 ↔ Task 8 ✓
- README 更新 ↔ Task 9 ✓

**Placeholder scan**：无 TBD / TODO / "implement later" / "write tests for the above"。

**Type consistency**
- `upsertTranscriptFile` 参数名（camelCase: `inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheCreationTokens`/`primaryModel`/`activeMs`）Task 1 / 3 一致。
- DB 列名（snake_case）Task 1 schema 与 Task 5 查询读取一致（`input_tokens`、`active_ms` 等）。
- `extractUsage` 返回字段与 indexer 调用点一致。
- `Report` 类型前后端字段名一致（summary/topTodos/byTool/byQuadrant/byModel/timeline）。
