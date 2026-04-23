# quadtodo MCP Server + Global Search + ⌘K Palette

**Date**: 2026-04-23
**Status**: Approved, implementation starting

## Goal

把 quadtodo 变成一个 Claude Code 可以通过 MCP 链接的本地知识库。外部 Claude Code session 或 quadtodo 内置的 AI 终端都能通过同一套工具读写用户的待办、搜索全局语料、做任务清理/合并/归档。

配套在 quadtodo UI 里加一个 ⌘K 全局搜索命令面板，和 MCP 共用同一个 `/api/search` 端点，逻辑不重复。

## Non-goals

- 不做任何"Claude 之外的 LLM"集成。
- 不做 MCP 鉴权——依赖 quadtodo 整体的访问控制（loopback / Tailscale 私网）。
- 不改动 ai_sessions JSON 列的物理布局（仍挂在 todo 行下）。
- 不做"任务清理 AI 抽屉"的 UI（留给后续做成 slash 命令）。

## High-level architecture

```
┌──────────────────────────────────────────────────────────────┐
│                  quadtodo Express (port 5677)                 │
│                                                               │
│  /api/todos   /api/wiki   /api/transcripts   ...(已有)        │
│                                                               │
│  /api/search ──── createSearchService({ db }) ───────┐        │
│                        │                             │        │
│                        ▼                             │        │
│     SQLite FTS5: todos_fts / comments_fts /          │        │
│                  wiki_fts / ai_sessions_fts          │        │
│                                                      │        │
│  /mcp   (Streamable HTTP via @modelcontextprotocol/sdk)        │
│     └──── 17 tools ────► searchService / db helpers │        │
│                                                      │        │
└──────────────┬───────────────────────┬───────────────┘        │
               │                       │                        │
        Claude Code             quadtodo Web UI                 │
        (任意会话)              ⌘K CmdPalette ──────────────────┘
```

## Decisions

| 项 | 决定 |
|---|---|
| 方向 | **C**：MCP + UI ⌘K 一起做，MCP 作为共享底层 |
| 能力档 | **T4**：包含 `read_transcript`，带 token 预算 |
| 搜索默认语料 | todos / comments / ai_sessions 元信息 / wiki（4 scope） |
| transcripts 搜索 | **不进默认 FTS**，提供独立工具 `search_transcripts`（纯 Node 扫描日志文件） |
| UI 范围 | **β**：MCP + ⌘K 面板。清理 AI 留给后续 slash 命令 |
| 传输 | **HTTP** 挂 `/mcp`，与主进程同 DB、同 Express |
| 安全 | **s1**：破坏性操作默认 `confirm:false` 返回预览，第二次带 `confirm:true` 执行 |
| Token | **无签名 token**，纯靠双次调用契约 |
| Archived | 新增 `archived_at INTEGER NULL` 字段（不是软删，是归档） |
| 审计 | 破坏性操作 NDJSON 写 `~/.quadtodo/mcp-audit.log` |
| ⌘K 快捷键 | ⌘K / Ctrl+K，冲突时备用 ⌘P |
| 日志扫描 | 纯 Node，无 ripgrep 外部依赖 |
| `work_dir` 索引 | 本期不做（YAGNI） |

## Tool catalog (17 tools)

### Read (8)

1. **`search`** — 全局 FTS。参数：`query`, `scopes[]` (default 全开), `includeArchived`, `limit≤100`。返回 `{ total, results[{ scope, todoId, snippet, score, ... }] }`。
2. **`search_transcripts`** — 对会话日志文件做逐行扫描。参数：`query`, `todoId?`, `afterTs?`, `beforeTs?`, `maxMatches≤30`, `maxLinesPerFile≤200`。返回 `{ matches[{ sessionId, todoId, lineNumber, beforeLines, matchLine, afterLines }] }`。
3. **`list_todos`** — 结构化列表。参数：`quadrant?`, `status?`, `tags?`, `dueBefore?`, `dueAfter?`, `archived?`, `page?=1`, `pageSize≤50`。
4. **`get_todo`** — 单条完整：本体 + 子任务 + comments + ai_sessions + wiki 存在性。
5. **`read_wiki`** — 指定 todo 的 wiki markdown。
6. **`read_transcript`** — 指定 sessionId 的对话，`maxTokens` 默认 8000，尾部截断。
7. **`get_stats`** — 未完成按象限分布、今日 due、本周完成数、Top5 热 todo。
8. **`get_recent_sessions`** — 最近 N 个 AI 会话（跨 todo）。

### Safe write (5)

9. **`create_todo`** — 新建。
10. **`update_todo`** — patch 字段：title/description/quadrant/dueAt/tags/subtodos。
11. **`add_comment`** — 加评论。
12. **`complete_todo`** — 标 status=done（可 undo）。
13. **`unarchive_todo`** — 清空 archived_at。

### Destructive (4) — preview → confirm

默认 `confirm:false` 只返回预览 JSON 不执行。

14. **`delete_todo`** — 硬删，级联删子任务/评论/ai_sessions。
15. **`archive_todo`** — 设置 archived_at，从默认列表隐藏。
16. **`merge_todos`** — 将 sourceIds 合并进 targetId：搬评论/会话/子任务，然后删源。参数 `titleStrategy: "keep_target"|"concat"|"manual"` + `manualTitle?`。
17. **`bulk_update`** — 批量 patch 匹配 todos。预览列出最多 20 条。

所有破坏性工具的预览响应：

```jsonc
{
  "preview": true,
  "summary": "将硬删 id=42（标题 Y），级联删除 3 条子任务 / 2 条评论 / 5 个 AI 会话",
  "impact": { "todosDeleted": [42], "subtodosDeleted": 3, "commentsDeleted": 2, "sessionsDeleted": 5 },
  "confirmWith": { "confirm": true, "confirmNote": "<optional audit note>" }
}
```

## Database changes

### Schema

```sql
-- 1. todos 新增字段
ALTER TABLE todos ADD COLUMN archived_at INTEGER NULL;
CREATE INDEX IF NOT EXISTS idx_todos_archived_at ON todos(archived_at);

-- 2. FTS5 虚拟表
CREATE VIRTUAL TABLE todos_fts USING fts5(
  title, description, tags,
  content='todos', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE comments_fts USING fts5(
  body, content='comments', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE wiki_fts USING fts5(
  todo_title, wiki_body,
  tokenize='unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE ai_sessions_fts USING fts5(
  label, command, native_session_id,
  tokenize='unicode61 remove_diacritics 2'
);

-- 3. 触发器（todos_fts / comments_fts）
CREATE TRIGGER todos_ai AFTER INSERT ON todos BEGIN
  INSERT INTO todos_fts(rowid, title, description, tags)
    VALUES (new.id, new.title, new.description, COALESCE(new.tags,''));
END;
CREATE TRIGGER todos_ad AFTER DELETE ON todos BEGIN
  INSERT INTO todos_fts(todos_fts, rowid, title, description, tags)
    VALUES ('delete', old.id, old.title, old.description, COALESCE(old.tags,''));
END;
CREATE TRIGGER todos_au AFTER UPDATE ON todos BEGIN
  INSERT INTO todos_fts(todos_fts, rowid, title, description, tags)
    VALUES ('delete', old.id, old.title, old.description, COALESCE(old.tags,''));
  INSERT INTO todos_fts(rowid, title, description, tags)
    VALUES (new.id, new.title, new.description, COALESCE(new.tags,''));
END;
-- comments_fts 同理
```

### 同步策略

- **todos_fts / comments_fts**：AFTER INSERT/UPDATE/DELETE 触发器，业务代码零感知。
- **wiki_fts**：wiki run 结束 + 服务启动时**全量重建**。更新频率低，重建成本几十毫秒。
- **ai_sessions_fts**：在 `db.js` 的 `updateTodo` 和 `routes/ai-terminal.js` 的会话写入路径里**显式同步**。因为 ai_sessions 是 JSON 列不是独立表，触发器实现会很脆弱。

### 启动一致性自检

```js
// 在 createServer 启动时
if (db.prepare('SELECT COUNT(*) AS n FROM todos_fts').get().n
    !== db.prepare('SELECT COUNT(*) AS n FROM todos').get().n) {
  console.warn('[search] todos_fts out of sync, rebuilding')
  db.exec("DELETE FROM todos_fts; INSERT INTO todos_fts(rowid, title, description, tags) SELECT id, title, description, COALESCE(tags,'') FROM todos;")
}
// 同样检查 comments_fts / ai_sessions_fts
```

### `merge_todos` 事务化算法

```js
db.transaction(() => {
  const target = db.getTodo(targetId)
  for (const srcId of sourceIds) {
    const src = db.getTodo(srcId)
    // 1. 子任务：修改 parent_id 为 target
    db.prepare('UPDATE todos SET parent_id = ? WHERE parent_id = ?').run(targetId, srcId)
    // 2. 评论：修改 todo_id
    db.prepare('UPDATE comments SET todo_id = ? WHERE todo_id = ?').run(targetId, srcId)
    // 3. ai_sessions：JSON 合并
    const merged = mergeAiSessions(target.aiSessions, src.aiSessions)
    db.prepare('UPDATE todos SET ai_sessions = ? WHERE id = ?').run(JSON.stringify(merged), targetId)
    // 4. wiki：如有则追加
    // 5. 删除源 todo
    db.prepare('DELETE FROM todos WHERE id = ?').run(srcId)
  }
  // 6. 按 titleStrategy 更新 target 标题
  applyTitleStrategy(target, srcTodos, strategy, manualTitle)
})()
```

## Directory layout

```
src/
  search/
    index.js        # createSearchService({ db })
    fts.js          # initFtsTables / ensureConsistent / syncAiSessionsFts
    transcripts.js  # createTranscriptScanner({ logDir, indexDb })
  mcp/
    server.js       # createMcpRouter({ searchService, db, audit })
    audit.js        # appendAudit(entry) → ~/.quadtodo/mcp-audit.log
    tools/
      search.js
      list-todos.js
      get-todo.js
      read-wiki.js
      read-transcript.js
      get-stats.js
      get-recent-sessions.js
      search-transcripts.js
      create-todo.js
      update-todo.js
      add-comment.js
      complete-todo.js
      unarchive-todo.js
      delete-todo.js        # destructive
      archive-todo.js       # destructive
      merge-todos.js        # destructive
      bulk-update.js        # destructive
      index.js              # 导出 { allTools, registerAll }
  db.js
    # 新增：
    #   migrateArchivedAt()
    #   archiveTodo(id) / unarchiveTodo(id)
    #   mergeTodos({ targetId, sourceIds, titleStrategy, manualTitle })
    #   bulkUpdateTodos({ filter, patch })
    # 保持：
    #   listTodos / createTodo / updateTodo / deleteTodo 等不变
  routes/
    search.js       # 新增：/api/search → searchService
    todos.js        # 小扩充：list_todos 支持 archived 参数
  cli.js
    # 新增子命令：
    #   quadtodo mcp install    # 把 mcpServers 片段 merge 进 ~/.claude/settings.json
    #   quadtodo mcp status     # health check + 列工具

web/src/
  CmdPalette.tsx    # ⌘K 面板
  api.ts            # 新增 searchAll({ query, scopes, limit })
  TodoManage.tsx    # 顶栏加入 ⌘K 提示 + 手机 🔍 按钮
  main.tsx          # 全局监听 ⌘K 快捷键
```

## Claude Code 用户接入

```jsonc
// ~/.claude/settings.json
{
  "mcpServers": {
    "quadtodo": {
      "type": "http",
      "url": "http://127.0.0.1:5677/mcp"
    }
  }
}
```

便利命令：

```bash
quadtodo mcp install    # 交互式配置
quadtodo mcp status     # 健康检查 + 列工具
```

## UI changes

### ⌘K 命令面板

- 全局快捷键 ⌘K / Ctrl+K。
- Modal 形态，顶部单行 Input + scope chips + 结果列表。
- 键盘：`↑↓` / `Enter` 选中跳转 / `Esc` 关闭。
- Debounce 150ms。
- 手机：顶栏 🔍 按钮打开全屏版，复用同组件。

### 预期

跳转逻辑：
- scope=todos → 打开 todo 详情 drawer
- scope=comments → 打开 todo 详情 drawer，滚动到评论区
- scope=wiki → 打开 WikiDrawer 定位到对应 todo
- scope=ai_sessions → 打开 todo 详情，展开对应 session 终端

## Safety / audit

### preview → confirm 模型

```jsonc
// 第一次（无 confirm）
{ "name": "delete_todo", "arguments": { "id": 42 } }
// → { "preview": true, "summary": "...", "impact": {...}, "confirmWith": {...} }

// 第二次（带 confirm）
{ "name": "delete_todo", "arguments": { "id": 42, "confirm": true, "confirmNote": "User approved via chat" } }
// → { "ok": true, "deletedTodoId": 42 }
```

### 审计日志

每次破坏性工具**真执行**时追加一行 NDJSON 到 `~/.quadtodo/mcp-audit.log`：

```jsonc
{"ts":"2026-04-23T10:15:00Z","tool":"merge_todos","ok":true,
 "args":{"targetId":42,"sourceIds":[7,9],"titleStrategy":"keep_target"},
 "result":{"movedComments":3,"movedSessions":2,"deletedTodos":[7,9]},
 "confirmNote":"..."}
```

日志文件无大小上限（用户可以手动清理）；失败执行也记一行 `"ok":false, "error":"..."`。

## Testing

| Layer | Coverage |
|---|---|
| DB migration | archived_at 向下兼容；FTS 表初始化；wiki/ai_sessions FTS 全量重建正确 |
| FTS triggers | todo 增删改后 FTS 命中同步；中英文分词 |
| searchService | 多 scope 归一化排序；includeArchived=false 过滤；分页；空 query 报错 |
| merge_todos | 事务化（失败回滚）；子任务/评论/ai_sessions 全部迁移；titleStrategy 三档 |
| MCP tools | 每个 tool schema 解析；破坏性 tool `confirm:false` 返回预览不改 DB；`confirm:true` 真执行且写 audit |
| MCP HTTP | supertest 通过 JSON-RPC 端到端 |
| ⌘K 面板 | 键盘导航 / debounce / scope 切换 / 手机全屏 |

MCP 测试用 `@modelcontextprotocol/sdk` 客户端 + in-memory transport，避免真起 HTTP。

## Milestones

1. **M1 DB 基础**：archived_at 字段 + 迁移 + `archiveTodo` / `unarchiveTodo` / `mergeTodos` / `bulkUpdate` DB 函数 + 测试
2. **M2 FTS 基础**：4 张虚拟表 + 触发器 + 启动自检 + `createSearchService` + `/api/search` 端点 + 测试
3. **M3 MCP 路由 + 读工具**：`/mcp` Streamable HTTP 路由 + 8 个读工具 + MCP 客户端集成测试
4. **M4 MCP 写工具**：5 个 safe write 工具 + 测试
5. **M5 MCP 破坏性工具**：4 个 destructive 工具 + preview/confirm + audit log + 测试
6. **M6 CLI 子命令**：`quadtodo mcp install/status`
7. **M7 ⌘K 面板**：桌面 + 手机全屏
8. **M8 search_transcripts + read_transcript**：日志扫描 + token 预算裁剪
9. **M9 文档**：README 加章节 + 新建 `docs/MCP.md`

## Out of scope (future)

- slash 命令 `/quadtodo-cleanup`（在 Claude Code 里一键打开带清理 prompt 的 session）
- MCP 鉴权（目前靠 loopback/Tailscale）
- transcripts 进主 FTS
- `work_dir` 全文索引
- `restore_todo`（软删撤销）
