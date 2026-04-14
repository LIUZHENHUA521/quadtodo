# 历史会话找回 + 关键词搜索设计

- 日期：2026-04-14
- 状态：待实现

## 1. 背景

quadtodo 启动 Claude Code / Codex 时是托管一个 PTY 进程并在输出里抓取 `nativeSessionId`
写入 `todo_ai_sessions`。实际使用中会出现：

- quadtodo 服务被外部 kill / 机器休眠 / 崩溃 → `done` 事件没触发
- 此时 Claude/Codex 自身的 transcript 已经落盘，但 quadtodo 这侧 `nativeSessionId` 没写入
- 结果：todo 看起来"没有会话记录"，实际本地 transcript 还在，无法复用（无法 resume/fork/
  transcript 预览）

本设计引入一个**"孤儿 transcript 找回"**能力：

- 扫描本地 Claude/Codex transcript 目录
- 高置信度条件下自动挂回对应 todo
- 未命中的进入"待认领池"，前端可关键词全文搜索 + 手动绑定

## 2. 目标与非目标

**目标**

- 丢失的会话能通过手动或自动方式恢复到对应 todo 下，**复用**现有的 resume/fork/transcript
  能力（即绑定后等同于 quadtodo 亲自启动的会话，只多一个 `imported` 标记）
- 关键词全文搜索本地所有 Claude + Codex transcript
- 一条原生会话全局唯一挂回，改挂给出明确的移动确认

**非目标**

- 跨机器同步 transcript
- 修改 Claude / Codex 的落盘格式
- 语义 / 向量搜索（先关键词够用；可在 FTS 索引基础上后续扩展）

## 3. 数据源路径

| Tool | 目录 | 单文件格式 |
| --- | --- | --- |
| Claude | `~/.claude/projects/<url-encoded-cwd>/<session-uuid>.jsonl` | 每行一个 JSON，含 `sessionId` / `cwd` / `message` 字段 |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl` | 首行 `{"type":"session_meta","payload":{"id":<uuid>,"timestamp":...,"cwd":...}}`，后续是逐轮消息 |

路径可在 `settings.json` 中通过 `transcriptDirs.claude` / `transcriptDirs.codex` 覆盖，未配置时走
默认值。

## 4. 数据层（better-sqlite3）

### 4.1 新表

```sql
CREATE TABLE transcript_files (
  id            INTEGER PRIMARY KEY,
  tool          TEXT    NOT NULL,           -- 'claude' | 'codex'
  native_id     TEXT,                       -- 从文件路径/内容解析
  cwd           TEXT,
  jsonl_path    TEXT    NOT NULL UNIQUE,
  size          INTEGER NOT NULL,
  mtime         INTEGER NOT NULL,
  started_at    INTEGER,
  ended_at      INTEGER,
  first_user_prompt TEXT,                   -- 前 200 字符，用于匹配
  turn_count    INTEGER DEFAULT 0,
  bound_todo_id TEXT,                       -- 已挂回时回填，便于统计未认领数
  indexed_at    INTEGER NOT NULL
);
CREATE INDEX idx_tf_native ON transcript_files(native_id);
CREATE INDEX idx_tf_bound  ON transcript_files(bound_todo_id);

CREATE VIRTUAL TABLE transcript_fts USING fts5(
  content,
  role UNINDEXED,
  file_id UNINDEXED,
  tokenize = "unicode61 remove_diacritics 2"
);
```

> 中文分词：`unicode61` 对 CJK 粗粒度可用；若命中率差，降级为 `LIKE %q%` 作为兜底路径，
> 但不阻塞一期。

### 4.2 `todo_ai_sessions` 扩展

- 新列 `source TEXT NOT NULL DEFAULT 'native'`（`'native' | 'imported'`）
- `native_session_id` 新增**部分唯一索引**：
  `CREATE UNIQUE INDEX uniq_tas_native ON todo_ai_sessions(native_session_id) WHERE native_session_id IS NOT NULL;`

### 4.3 与现有表的关系

- 一个 `transcript_files` 行对应至多一个 `todo_ai_sessions` 行
- 绑定 = 插入/更新 `todo_ai_sessions(source='imported')` + 回写
  `transcript_files.bound_todo_id`
- 解绑 = 删除 `todo_ai_sessions` 行 + 清空 `bound_todo_id`
- 改挂 = 原绑定解除 + 新绑定（两步走一个事务）

## 5. 后端模块（`src/transcripts/`）

| 文件 | 职责 |
| --- | --- |
| `scanner.js` | 遍历两种工具目录，按 (path, size, mtime) 判定脏文件，解析 meta（nativeId, cwd, startedAt, endedAt, first_user_prompt, turn_count）并 upsert 进 `transcript_files` |
| `indexer.js` | 对脏文件逐 turn 写 `transcript_fts`（删除旧行 + 重建） |
| `matcher.js` | 未绑定 file 尝试自动挂回。规则：`tool` 相同 + `cwd` 严格相等 + `startedAt ∈ [orphanSession.startedAt - 60s, +60s]` + `first_user_prompt.slice(0,100) == orphanSession.prompt.slice(0,100)`。三项全中才自动绑；多对多时按 `abs(Δt)` 升序贪心配对 |
| `searcher.js` | `search({ q, tool?, cwd?, since?, unboundOnly?, limit, offset })`；q 存在时走 FTS5 并返回 snippet，缺省按 startedAt 倒序分页 |
| `index.js` | 对外：`scanFull()` / `scanIncremental()` / `search(...)` / `bind(fileId, todoId, { force })` / `unbind(fileId)` / `getUnboundCount()` |

### 5.1 路由（`src/routes/transcripts.js`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/transcripts/scan` | 增量扫 + 自动挂回；返回 `{ newFiles, dirty, autoBound, unbound }` |
| GET  | `/api/transcripts/search` | query `q,tool,cwd,since,unboundOnly,limit,offset`；返回 `{ total, items }` |
| GET  | `/api/transcripts/:fileId` | 返回文件元信息（不返全文） |
| GET  | `/api/transcripts/:fileId/preview?offset=&limit=` | 分页返回 turns（复用现有 transcript 解析） |
| POST | `/api/transcripts/:fileId/bind` | body `{ todoId, force? }`；已绑到他处且未 force → 409 + `{ currentTodoId }` |
| POST | `/api/transcripts/:fileId/unbind` | 解绑 |
| GET  | `/api/transcripts/stats` | `{ unboundCount }`，供红点徽章用 |

### 5.2 启动钩子

`server.js` listen 后异步 `scanFull()`，不阻塞启动；日志打印 `[transcripts] full scan done
files=X bound=Y unbound=Z cost=Nms`。

## 6. 前端

### 6.1 全局入口（A）

- 工具栏 🔍 按钮（`DashboardOutlined` 旁），徽章显示未挂回数（`/transcripts/stats`
  轮询 30s）
- 点击打开 `TranscriptSearchDrawer`（右侧抽屉，宽 560）
  - 顶部 banner：`X 条未挂回 · [重新扫描]`（按钮触发 `/scan`）
  - 搜索框（关键词） + 筛选（tool / cwd 选择器 / 时间段 / 仅显示未挂回）
  - 列表项：
    - tool icon + P 标签（若已挂则显示目标 todo 颜色） + 首条 prompt 摘要
    - 命中 snippet 行（FTS5 snippet，<mark>高亮</mark>）
    - 元信息：startedAt、turn_count、已挂到 `<todo.title>` 或 `未挂回`
    - 操作：`预览` / `绑定到 todo…`（已挂则显示 `改挂…` / `解绑`）
  - 绑定弹窗：搜索 todo 标题的选择器；确认 → POST bind；409 则弹"该会话当前挂在
    《todo X》，是否移动？"，确认则带 `force=true` 重试

### 6.2 todo 详情内嵌（B）

- `TodoDetail` 增加 `历史会话` Tab
- 默认查询 = `{ cwd: todo.workDir, q: todo.title }`
- 结果行的绑定按钮直接 POST `bind({ todoId: todo.id })`

### 6.3 其它 UI 细节

- `todo_ai_sessions.source === 'imported'` 的行：在 `SessionViewer` / 卡片标签处显示一个灰色
  `已导入` Tag
- transcript 预览复用现有 `TranscriptView`（按 nativeId 读 jsonl）

## 7. 流程

```text
启动
  └─ scanFull (async)
       ├─ 遍历两种目录 → diff(path,size,mtime) → 脏文件集
       ├─ scanner 解析 meta → upsert transcript_files
       ├─ indexer 重建脏文件 FTS
       └─ matcher 尝试自动挂回 → 事务更新 todo_ai_sessions + bound_todo_id

用户点 🔍
  └─ scanIncremental (同上)
        └─ search(q,...) → 渲染
              └─ 用户点绑定 → bind({todoId, force?})
                                ├─ 200 → 刷新列表
                                └─ 409 → 确认框 → force=true 重试
```

## 8. 错误与边界

- **jsonl 损坏 / 半截**：按行解析，单行 JSON.parse 失败 → warn + 跳过；文件仍入索引
- **一个 jsonl 含多 nativeId**（理论不应出现）：取首个，warn 一行
- **Codex 用户自定义目录**：settings 里 `transcriptDirs.codex` 覆盖，缺省值 `~/.codex/sessions`
- **FTS5 不可用**（极老 sqlite）：启动时探测，失败时 searcher 自动降级为 `LIKE %q%`，性能差但功能不瘫
- **matcher 多对多**：
  - 一个 todo 多条孤儿 session × 多条候选 file → 按 `abs(Δt)` 升序贪心配对
  - 同一个 file 命中多个 todo → 取 `abs(Δt)` 最小；平局则不自动绑（避免错绑）
- **文件被删除**：下次 scan 发现 jsonl_path 不存在 → 删 `transcript_files` 行 + 对应
  FTS 行；若该 file 已绑定 todo，保留 `todo_ai_sessions` 行但 `native_session_id` 保持不变
  （允许用户手动删除）

## 9. 测试

**单元（vitest）**

- `scanner` 解析两个 fixture（Claude 一份、Codex 一份），校验 nativeId/cwd/startedAt/
  first_user_prompt/turn_count
- `indexer` 写入后 FTS 查询命中 + snippet
- `matcher` 三项命中 → auto-bind；任一缺失 → 不绑；多对多贪心配对

**路由**

- `/scan` 返回结构 + 幂等（两次 scan 不重复索引）
- `/search` q/tool/cwd/unboundOnly 组合
- `/bind` 正常 / 409 / force 移动 / 解绑

**不做**

- 前端组件单测（体量小，复核即可）
- 真机 e2e

## 10. 拆分

一期（本次实现）：

1. DB schema 迁移（加 `source` 列 + 唯一索引）+ 新表
2. `scanner` / `indexer` / `matcher` / `searcher`
3. 路由 + 启动钩子
4. 前端：🔍 全局入口 + `TranscriptSearchDrawer` + 绑定弹窗 + todo 详情 Tab
5. 已导入 Tag

后续（非本期）：

- 语义搜索 / embedding
- transcript 级别的 diff / 合并
- 自动清理过大 FTS（> 某阈值时 rebuild）
