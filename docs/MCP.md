# quadtodo MCP 服务

quadtodo 内置了一个 [MCP](https://modelcontextprotocol.io) Streamable HTTP 服务端，挂在本机 `/mcp` 路径上。**任何支持 MCP 的客户端（Claude Code、Claude Desktop、Inspector 等）都可以连上，把 quadtodo 当做一个"待办知识库"来读写**。

## 它能做什么

通过 17 个工具，Claude 可以：

- 全局搜索你的 todo / 评论 / wiki 记忆 / AI 会话元信息；
- 列出、创建、更新、归档、删除、合并 todos；
- 读取某条 todo 的完整详情（本体 + 子任务 + 评论 + wiki 文件 + AI 会话列表）；
- 扫描 AI 对话历史，找"当时 Claude 说的那句话"；
- 一次性批量改一组 todo 的状态/象限/归档；
- 查当前待办统计、最近的 AI 会话记录。

**典型玩法**：在任意 Claude Code session 里跟它说："帮我清理 quadtodo 里重复的待办" → Claude 会调 `search` / `list_todos` 找出候选 → 把合并建议贴给你 → 你点头 → 它调 `merge_todos(confirm:true)` 真执行，自动在 `~/.quadtodo/mcp-audit.log` 留痕。

## 启用

### 1. 确保 quadtodo 正在跑

```bash
npm start    # 或 quadtodo start
```

如果你要从别的设备（手机、别的电脑）通过 Tailscale 访问，需要先：

```bash
quadtodo config set host 0.0.0.0
npm run stop && npm start
```

### 2. 把 MCP 配置写进 Claude Code

一键：

```bash
quadtodo mcp install
```

会把下面这段 merge 进 `~/.claude/settings.json`：

```jsonc
{
  "mcpServers": {
    "quadtodo": {
      "type": "http",
      "url": "http://127.0.0.1:5677/mcp"
    }
  }
}
```

如果你在别的设备上用 Claude Code 远程连 Mac 上的 quadtodo，把 URL 里的 `127.0.0.1` 换成 Mac 的 Tailscale 名字或 IP（`quadtodo mcp install --host <mac-name>`）。

### 3. 验证

```bash
quadtodo mcp status
```

健康的话输出：

```
✓ http://127.0.0.1:5677/mcp/health
  {"ok":true,"server":"quadtodo",...}
```

在 Claude Code 里输入 `/mcp`，应该看到 `quadtodo` 已连接 + 列出 17 个工具。

## 17 个工具一览

### 📖 Read（8 个）

| 工具 | 用途 |
|---|---|
| `search` | FTS5 全局搜索：todos / comments / wiki / ai_sessions。BM25 排序，支持 scope 过滤和 includeArchived |
| `search_transcripts` | 在 `~/.quadtodo/logs/*.log` 里做逐行扫描。支持 todoId / 时间范围过滤。默认上限 30 条命中 |
| `list_todos` | 结构化列表：quadrant / status / archived / parentId 筛选 |
| `get_todo` | 单条完整详情（本体 + 子任务 id + 评论 + AI 会话 + hasWiki） |
| `read_wiki` | 读取指定 todo 的 wiki markdown |
| `read_transcript` | 读某个 sessionId 的会话日志，maxChars 截断 |
| `get_stats` | 当前快照：象限分布、今日 due、本周完成、归档数 |
| `get_recent_sessions` | 跨 todo 的最近 AI 会话列表 |

### ✏️ Safe Write（5 个）

可逆或低风险，不需要 confirm。

| 工具 | 用途 |
|---|---|
| `create_todo` | 新建（title + quadrant 必填） |
| `update_todo` | patch title / description / quadrant / dueDate / workDir / parentId |
| `add_comment` | 加评论 |
| `complete_todo` | 标完成（status=done，可 reopen） |
| `unarchive_todo` | 取消归档 |

### ⚠️ Destructive（4 个）— 必须 preview → confirm

默认 `confirm:false`，返回预览 JSON + `howToConfirm` 指导；第二次带 `confirm:true` 才真执行，并写 `~/.quadtodo/mcp-audit.log`。

| 工具 | 用途 |
|---|---|
| `delete_todo` | 硬删，级联 |
| `archive_todo` | 归档（可用 `unarchive_todo` 撤销） |
| `merge_todos` | 合并 sourceIds 进 targetId，迁移子任务/评论/会话后删源 |
| `bulk_update` | 批量 patch 一组 todo 的 quadrant / status / archived / dueDate |

## Preview → Confirm 示例

以 `delete_todo` 为例：

```jsonc
// Claude 第一次调用（没带 confirm）
{ "name": "delete_todo", "arguments": { "id": "abc-123" } }

// 返回：
{
  "preview": true,
  "tool": "delete_todo",
  "summary": "将硬删 todo id=abc-123（标题「重构登录模块」），级联删除 3 个子任务 / 2 条评论 / 5 条 AI 会话日志。此操作不可逆。",
  "impact": { "todoId": "abc-123", "title": "...", "subtodos": 3, "comments": 2, ... },
  "howToConfirm": "调用一次同样的 delete_todo，但把 \"confirm\" 设为 true...",
  "confirmedArgs": { "id": "abc-123", "confirm": true, "confirmNote": "<optional note>" }
}

// Claude 把上面的 summary 贴给用户 → 用户同意 → Claude 第二次调用：
{ "name": "delete_todo", "arguments": { "id": "abc-123", "confirm": true, "confirmNote": "用户确认是重复 todo" } }

// 返回：
{ "ok": true, "deleted": { ... } }
```

同时 `~/.quadtodo/mcp-audit.log` 追加一行 NDJSON：

```json
{"ts":"2026-04-23T15:03:22.000Z","tool":"delete_todo","ok":true,"args":{"id":"abc-123"},"result":{...},"confirmNote":"用户确认是重复 todo"}
```

## 全局搜索 UI

⌘K（Mac）/ Ctrl+K（Windows）在 quadtodo 网页端任意页面打开命令面板。和 MCP 共用同一个 `/api/search` 端点，所以搜索行为完全一致。

- scope chips 切换语料范围
- ↑↓ 选择，Enter 跳到对应 todo 的详情抽屉
- Esc 或 ⌘K 再按关闭
- 手机上顶栏 🔍 按钮打开全屏版

## 安全

- quadtodo 服务本身**不做鉴权**，依赖网络层保护：
  - 默认 host=`127.0.0.1`，只有本机可访问；
  - 切 `0.0.0.0` 时只推荐走 Tailscale 私网（见 [docs/MOBILE.md](MOBILE.md)）；
  - **绝对不要**把 `/mcp` 直接开到公网。
- 破坏性工具的 preview/confirm 模式是为了让 Claude 在执行前必须跟你用自然语言解释一遍，防止误删。
- 审计日志 `~/.quadtodo/mcp-audit.log` 记录所有破坏性操作，失败也记。可以 `tail -f` 观察。

## 故障排查

| 症状 | 排查步骤 |
|---|---|
| Claude Code 里 `/mcp` 看不到 quadtodo | 1. `quadtodo mcp status` 确认服务健康；2. 检查 `~/.claude/settings.json` 里确实有 quadtodo 条目；3. 重启 Claude Code |
| `status` 说 unreachable | quadtodo 没跑或 port 不对。`npm start` 或改 `host`/`port` |
| 搜索结果为空但我知道有匹配 | 看 quadtodo 启动日志有没有 `[search] fts ready`。如果上次异常退出过，加一行 `quadtodo config set rebuild_fts true` 强制重建（触发下次启动时全量 rebuild） |
| `merge_todos` 报 `source_not_found` | 检查 sourceIds 是否正确。id 是 UUID 格式，区分大小写 |

## 开发笔记

如果你要给 quadtodo 加新 MCP 工具：

- 读类工具：`src/mcp/tools/read/index.js`
- 写类工具：`src/mcp/tools/write/index.js`
- 破坏性工具：`src/mcp/tools/destructive/index.js`（记得 preview + audit）
- 对应测试：`test/mcp.*.test.js`（用 InMemoryTransport，快）

工具描述（`description` 字段）会被 LLM 读，要写得像给开发者看的 docstring——**说清输入/输出/副作用/典型用法**。
