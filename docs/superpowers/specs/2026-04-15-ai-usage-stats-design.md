# AI 使用统计与周/月报告 — 设计文档

- 日期：2026-04-15
- 所属项目：`quadtodo`
- 对应 README 条目：§ 5 静默工作时长统计

## 目标

在 quadtodo 现有的 "AI 终端 + 四象限" 体验上，补足会话的**时长 + token 消耗 + 成本**统计，并以**周/月报告**的形式回答两个核心问题：

1. 我过去这段时间花最多时间的任务 Top 10 是哪些？
2. AI 帮我完成了多少小时的工作？

## 背景（当前项目已有能力）

- `ai_session_log` 表已记录每个 PTY 会话的 `started_at / completed_at / duration_ms / tool / quadrant / todo_id / status`，并有 `querySessionStats()` 聚合。
- `transcript_files` 表已索引 `~/.claude/projects/**/*.jsonl` 和 `~/.codex/sessions/**/*.jsonl`，带 `bound_todo_id` 将 transcript 绑定到 todo；内容进入 FTS5 供搜索。
- 当前**没有** token / 成本统计，也没有专门的统计/报告页面。

## 核心决策（brainstorm 已锁定）

1. **数据源**：离线解析 Claude / Codex 本地 jsonl（不做实时 PTY 输出解析）。
2. **聚合粒度**：transcript 级 —— 在 `transcript_files` 表上加汇总字段；不建 per-turn 明细表（YAGNI）。
3. **价格表**：内置默认单价 + `~/.quadtodo/config.json` 可 override。
4. **交付形态**：Web 端一个报告抽屉 + Markdown 导出（本期不做 CLI）。
5. **"AI 工时" 口径**：墙钟时长 + 活跃时长**双口径**并列显示。

## 数据模型

### `transcript_files` 表新增字段（均可空，老记录后台重扫回填）

| 字段 | 类型 | 含义 |
|---|---|---|
| `input_tokens` | INTEGER | 全文件 assistant usage.input_tokens 之和 |
| `output_tokens` | INTEGER | 全文件 assistant usage.output_tokens 之和 |
| `cache_read_tokens` | INTEGER | cache_read_input_tokens 之和 |
| `cache_creation_tokens` | INTEGER | cache_creation_input_tokens 之和 |
| `primary_model` | TEXT | 该会话主导模型（assistant 消息里出现次数最多的 model，名字做归一化） |
| `active_ms` | INTEGER | 活跃时长：相邻 assistant 消息 Δt ≤ 阈值（默认 120s）累加 |

**迁移方式**：沿用项目现有模式 —— `openDb()` 里通过 `PRAGMA table_info(transcript_files)` 检查字段存在性，缺失则 `ALTER TABLE ... ADD COLUMN`。老 jsonl 在服务启动时通过后台异步任务重扫一次，条件：任意新字段为 NULL。

### 配置（`~/.quadtodo/config.json`）

新增 `pricing` 段：

```json
{
  "pricing": {
    "default": { "input": 3.00, "output": 15.00, "cacheRead": 0.30, "cacheWrite": 3.75 },
    "models": {
      "claude-opus-4-*":   { "input": 15.00, "output": 75.00, "cacheRead": 1.50, "cacheWrite": 18.75 },
      "claude-sonnet-4-*": { "input": 3.00,  "output": 15.00, "cacheRead": 0.30, "cacheWrite": 3.75  },
      "claude-haiku-4-*":  { "input": 1.00,  "output": 5.00,  "cacheRead": 0.10, "cacheWrite": 1.25  }
    },
    "cnyRate": 7.2
  },
  "stats": {
    "idleThresholdMs": 120000
  }
}
```

- 单价单位：USD / 百万 token
- 模型匹配走 glob，miss 回落 `default`
- `cnyRate` 用于在报告里同时显示 ¥

## 后端模块设计

### 新增 `src/usage-parser.js`

纯函数模块，职责单一：扫一个 jsonl 文件并返回 usage 汇总。

```
parseTranscriptUsage(jsonlPath, tool) → {
  inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
  primaryModel,            // mode of assistant messages' model field (normalized)
  activeMs,                // Σ Δt where Δt ≤ idleThresholdMs
  firstTurnAt, lastTurnAt,
  parseErrorCount          // 坏行计数，不抛错
}
```

- **Claude jsonl**：`{ type: 'assistant', message: { model, usage: {...} }, timestamp }` 直接取。
- **Codex jsonl**：兼容 `payload.info.total_token_usage` / 每条 message 的 `token_usage`；取不到记 0。
- **不抛错**：坏行跳过并计数，通过返回值上报。
- **模型归一化**：去掉日期后缀（`claude-opus-4-6-20260101` → `claude-opus-4-6`）。

### 新增 `src/pricing.js`

```
estimateCost(tokens, model, pricingConfig) → { usd, cny }
```

- `tokens = { input, output, cacheRead, cacheCreation }`
- glob 匹配用 `minimatch`（已在 deps 里，或加入）
- miss 回落 `pricing.default`
- cny = usd × `pricing.cnyRate`

### 修改 `src/transcript.js`

indexer 在 upsert transcript 时调用 `parseTranscriptUsage`，把 6 个新字段一起写入 `transcript_files`。启动时的 reindex：新增"字段缺失判断"条件，缺任一新字段即重扫。

### 新增 `src/routes/stats.js`

不复用 `querySessionStats()`（只懂时长），新实现一套。

**接口**：

`GET /api/stats/report?since=<ts>&until=<ts>`

响应：

```
{
  range: { since, until, label },                 // label = "本周" / "本月" / "自定义"
  summary: {
    wallClockMs, activeMs,
    tokens: { input, output, cacheRead, cacheCreation, total },
    cost: { usd, cny },
    sessionCount, todoCount,
    unboundSessionCount                           // 未绑定 todo 的会话数
  },
  topTodos: [                                     // Top 10 按 activeMs 降序
    { todoId, title, quadrant, wallClockMs, activeMs, tokens, cost, sessionCount }
  ],
  byTool:     [ { tool, sessions, wallClockMs, activeMs, tokens, cost } ],
  byQuadrant: [ { quadrant, sessions, wallClockMs, activeMs, tokens, cost } ],
  byModel:    [ { model, sessions, tokens, cost } ],
  timeline:   [ { t, wallClockMs, activeMs, tokens, cost } ]    // 日桶或小时桶
}
```

桶大小：范围 > 7 天用日桶，否则小时桶（与现有 `querySessionStats` 保持一致）。

`GET /api/stats/report.md?since=&until=`

直接返回渲染好的 Markdown 字符串（Content-Type: `text/markdown; charset=utf-8`），前端"导出"按钮 fetch 它。

**路由挂载**：在 `src/server.js` 里挂 `/api/stats`。

## 前端设计

### 入口

`web/src/TodoManage.tsx` 顶栏现有"设置"按钮旁加一个"📊 统计"按钮，点击打开 `<StatsDrawer>`（宽度 720，复用 SettingsDrawer 的抽屉形态）。

### `web/src/StatsDrawer.tsx`（新）

#### 顶部控件条

- 日期范围 Segmented：`本周 / 本月 / 近 30 天 / 自定义`（自定义打开 antd RangePicker）
- 右侧两个按钮：`📋 复制 Markdown` · `💾 下载 .md`

#### 四张总览卡片

1. **AI 活跃时长**：`8.3h` （副文案 "墙钟 12.1h"）
2. **Token 消耗**：`12.4M` （副文案 "其中缓存命中 8.1M"）
3. **估算成本**：`$23.7 / ¥170.6` （副文案 "按当前价目表"）
4. **会话数 / 覆盖任务**：`47 场 / 12 个 todo`

#### 两个图表并排

- 左：**时长趋势折线**，X 轴日期桶，两条线（墙钟 / 活跃）
- 右：**按象限环形图** activeMs 占比

图表库：优先复用项目已有 ECharts；若无则引 `@ant-design/charts`（已有 antd 依赖）。

#### Top 10 任务表（antd Table）

列：排名 / 任务标题 / 象限 / 活跃时长 / 墙钟 / Token / 成本 / 会话数

- 标题可点击 → 打开该 todo 详情抽屉（复用已有逻辑）
- 行可展开 → 显示该 todo 下每次 transcript 的 model / 起止时间 / token / cost

#### 按模型分组（折叠面板，默认收起）

列出每个模型的 sessions / tokens / cost，便于看"Opus 烧了多少"。

#### 空状态

当前范围无数据时提示："该时段没有绑定到 todo 的 AI 会话，先去跑几个 AI 任务吧～"

### Markdown 导出格式（后端生成）

```
# quadtodo 周报 · 2026-04-08 ~ 2026-04-15

AI 活跃 8.3h（墙钟 12.1h）· 47 场会话 · 覆盖 12 个任务
Token 12.4M（cache 命中 8.1M）· 成本 $23.7 / ¥170.6

## Top 10 任务
1. 修复 transcript 绑定 bug — 活跃 2.1h · $4.2 · 6 场
2. ...

## 按模型
- claude-opus-4-6: 18 场 · 4.2M tok · $12.1
- claude-sonnet-4-6: 29 场 · 8.2M tok · $11.6
```

## 测试

沿用 vitest，项目已有 `test/`：

- `usage-parser.test.js`：喂三份 fixture jsonl（Claude 正常 / Codex 正常 / 损坏行混入），断言 tokens、activeMs、primaryModel、parseErrorCount。
- `pricing.test.js`：glob 匹配命中、miss 回落 default、¥ 换算正确。
- `stats.route.test.js`：种 10 条 `transcript_files` + `ai_session_log`，断 `/api/stats/report` 的 summary、topTodos 排序、timeline 桶大小切换。
- `stats.markdown.test.js`：snapshot 测 Markdown 导出格式。

## 边界 & 取舍

1. **未绑定 todo 的 transcript**：不进 `topTodos`，但仍计入 summary；在报告里单独一行 "其中 X 场未关联任务"，避免数字对不上。
2. **活跃时长阈值**：默认 120s，放到 `config.stats.idleThresholdMs`，用户可调。
3. **老数据回填**：启动时异步跑一次"缺新字段的 transcript 全量重扫"，不阻塞服务；输出进度日志。
4. **性能**：单次 jsonl 解析只读一遍、不存内容（内容已在 FTS）。典型 1MB jsonl 解析 < 50ms。
5. **Codex 兼容**：部分 Codex 版本可能拿不到 usage，记 0 并在报告里标注"Codex 会话 token 未计入"。
6. **模型名归一化**：`primary_model` 去掉日期后缀后再做 glob 匹配。
7. **时区**：日期范围按本地时区切桶，存储仍是 ms epoch。

## 不做（YAGNI）

- 实时 token 流监控（hook PTY 输出解析） —— 离线索引已够
- per-turn 明细表 —— 本期选了 transcript 级聚合
- CLI 命令（`quadtodo report weekly`） —— 将来需要 cron 自动发周报时再加
- 成本预警 / 超额通知

## 落地范围总览

| 变更 | 位置 |
|---|---|
| 新文件 | `src/usage-parser.js`、`src/pricing.js`、`src/routes/stats.js`、`web/src/StatsDrawer.tsx` |
| 改动 | `src/db.js`（迁移 + 新字段支持）、`src/transcript.js`（扫描时算 usage）、`src/server.js`（挂路由）、`web/src/TodoManage.tsx`（入口按钮） |
| DB 变更 | `transcript_files` 加 6 个字段 |
| 测试 | 4 个新 test 文件 |
