# 标记完成自动关终端 + 移除 Pipeline 功能

日期：2026-05-13

## 目标

1. 把待办（todo）状态改为 `done` 时，自动 kill 该 todo（及其子 todo）名下仍在运行的 Claude/Codex PTY 进程，并关闭浏览器 mini 终端面板。
2. 移除 Multi-agent Pipeline（coder↔reviewer worktree 流水线）功能：后端路由、orchestrator、worktree helpers、DB 表/默认模板/配置；前端抽屉、API、入口按钮。

合并到一个 PR 是用户决定（拍板 A）。两件事互不耦合，可顺序提交两个 commit 方便回滚。

## Part 1 — 标记完成自动关终端

### 现状

- `PUT /api/todos/:id` 是所有"改 todo"路径的唯一出口（含 UI 复选框 toggle、详情抽屉验收通过按钮、MCP、Telegram、OpenClaw、批量 patch 内部最终也走 `db.updateTodo`）。但批量 patch 走的是 `db.batchPatch`，不经过路由 —— 暂不覆盖，理由：批量改 done 是低频运维操作。
- 每个 todo 在 DB 里挂 `aiSessions[]`，live PTY 会话登记在 `ait.sessions: Map`。`pty.stop(sessionId)` 杀进程；session 上设 `userClosedReason` 可避免 PTY 'done' 事件把刚写的 'done' 覆盖回 'todo'（参考 `openclaw-wizard.js:1056-1071`）。
- 已存在的 `userClosedReason` 拦截判断在 `ai-terminal.js:291`：当前只识别 `'topic_closed'`，需要扩展。

### 设计

#### 后端：`src/routes/todos.js` PUT `/:id`

在 `db.updateTodo` 之后、`res.json` 之前增加副作用：

```text
若 existing.status !== 'done' 且 patch.status === 'done':
    收集 todoIds = [existing.id, ...subtodo.id (parentId === existing.id)]
    遍历每个 todoId 对应的 aiSessions:
        对每个 sessionId, sess = getLiveSession(sessionId)
        if sess && sess.status in {'running', 'pending_confirm', 'idle'}:
            if todoId === existing.id:    # 只在父 todo 上打标
                sess.userClosedReason = 'todo_marked_done'
            try { pty.stop(sessionId) } catch { logged }
```

要点：
- 子 todo 的 session 不打 `userClosedReason`，让 PTY 'done' 事件按正常逻辑把子 todo 回写为 `'todo'`（子 todo 是独立 lifecycle，不被父级带走）。
- `pty.stop` 是幂等的，对已 done/failed 的 session 无副作用。
- 用 try/catch 包住，确保即使某个 session 关闭失败也不影响 HTTP 响应。

#### 后端：`src/routes/ai-terminal.js:291`

把：
```js
if (session.userClosedReason !== 'topic_closed' && !superseded) {
```
改为：
```js
if (!session.userClosedReason && !superseded) {
```
任何已显式设置的 close reason 都跳过 todo 状态覆写，更通用。`topic_closed` / `lark_thread_closed` / `slash_stop` / 新的 `todo_marked_done` 都自动适用。

#### 前端：`web/src/TodoManage.tsx`

两个改动点：

1. `handleToggleDone` (line 663)：在调用 `updateTodo(..., { status: 'done' })` 之前，若 `todo.aiSessions` 里存在 `status === 'running' || 'pending_confirm'` 的 session，弹 Modal.confirm：
   > 任务还有 N 个 AI 会话在运行（Claude/Codex 终端）。标记完成会同时关闭它们，确定吗？

   只在 done 方向加确认；`done → todo` 反向不需要。
2. 详情抽屉"验收通过"按钮 (line 1342)：这条路径前置状态是 `ai_done`，PTY 通常已退，不弹确认（保持验收流的轻量体验）。后端兜底关掉残留 session。

> 等价复用：抽出一个 helper `hasLiveSession(todo)` 放在 `TodoManage.tsx` 顶部或 `utils` 里。

### 验收（Part 1）

| 场景 | 期望 |
|---|---|
| 有 1 个 running Claude 会话的 todo → 点复选框完成 | 弹确认 → 确认 → todo 状态 done、xterm 1~2s 内显示 "=== AI 任务已结束 ===" |
| 同上 → 取消确认 | todo 保持原状态，session 继续跑 |
| 有 1 个 pending_confirm 会话 → 完成 | 弹确认；确认后 PTY 被 kill |
| 已 ai_done 的 todo → 点"验收通过" | 不弹确认；todo 变 done；无报错（PTY 已退） |
| 没有任何 aiSession 的 todo → 完成 | 不弹确认，正常变 done |
| 父 todo 完成、子 todo 有 running 会话 | 父 done；子 todo 的 PTY 被 kill；子 todo 状态回到 'todo'（不被带 done） |
| 反向 done → todo（撤销勾选） | 正常切换，无任何副作用 |
| MCP / 飞书 等外部路径调 `PUT /api/todos/:id { status: 'done' }` | 服务端同样关闭 PTY |

新增 1 个测试 `test/todos-route.test.js`（或追加现有的）：mock pty + sessions，验证状态切换触发 stop 调用。

## Part 2 — 移除 Pipeline 功能

### 后端删除清单

- 删整文件：
  - `src/routes/pipelines.js`
  - `src/orchestrator.js`
  - `src/worktree.js`
- `src/server.js`：
  - 移除 `import { createPipelinesRouter } from "./routes/pipelines.js";`
  - 移除 `import { createOrchestrator } from "./orchestrator.js";`
  - 移除 `const orchestrator = createOrchestrator(...)` 块
  - 移除 `app.use("/api/pipelines", ...)` 挂载
- `src/db.js`：
  - 删两个 DDL：`CREATE TABLE pipeline_templates (...)` (line 124) 和 `CREATE TABLE pipeline_runs (...)` (line 136) + 对应索引
  - 在 schema 初始化后加一次性迁移：`db.exec("DROP TABLE IF EXISTS pipeline_runs; DROP TABLE IF EXISTS pipeline_templates;")`
  - 删 `pipelineRuns` prepared statements (line 1519-1525 附近) 及 db 上暴露的 `listPipelineTemplates / listPipelineRunsForTodo / startPipelineRun / stopPipelineRun / updatePipelineRun / insertPipelineRun / getPipelineTemplate` 等方法
  - 删合并 todo 时迁移 `pipeline_runs.todo_id` 的逻辑（line 580、622）
  - 删 `DEFAULT_TEMPLATES` 里跟 pipeline 相关的内置模板与往 `pipeline_templates` 表 seed 的逻辑（line 1591/1603/1627-1628 涉及的 CODER_SYS/REVIEWER_SYS 常量及其填充函数）。`prompt_templates` 表与其默认模板保留（与 pipeline 无关）。
- `src/config.js`：
  - 删 `pipeline:` 默认段（line 339）
  - 删 `pipeline: { ...defaults.pipeline, ...(cfg.pipeline || {}) }` 合并行（line 434）

### 前端删除清单

- 删整文件：`web/src/pipeline/PipelineRunDrawer.tsx`，并删掉 `web/src/pipeline/` 目录里其他 pipeline 子文件（若有）。
- `web/src/api.ts`：
  - 删 `Multi-agent Pipelines` 整段（line 823-907+）：所有 `Pipeline*` interface + `listPipelineTemplates` / `listPipelineRunsForTodo` / `getPipelineRun` / `startPipelineRun` / `stopPipelineRun` 等函数
- `web/src/TodoManage.tsx`：
  - 删 import（line 57-58 的 Pipeline imports）
  - 删 pipeline state（line 222-229）
  - 删 templates fetch useEffect（line 230）
  - 删 `handleStartPipeline` callback（line 233-264）
  - 删 `useDrawerStack('pipeline', ...)`（line 354）
  - 删详情抽屉里 "Pipeline" Button（line 1351-1358）
  - 删 `<PipelineRunDrawer ... />` 渲染（line 1669-1685）

### DB 迁移策略

- 新增一句迁移：`DROP TABLE IF EXISTS pipeline_runs;` 写在现有 schema bootstrap 里，确保升级用户启动后表自动消失。无回滚（用户拍板可以删）。
- `pipeline_templates` 表整张表 DROP（一次性迁移）。Pipeline 与 `prompt_templates` 不共享表，无需精细 DELETE。

### 用户告知

- README 加一行 "Multi-agent Pipeline 功能已移除；若磁盘上有 `.quadtodo-worktrees/` 残留目录可手动 `rm -rf` 清理"。
- 不输出迁移工具，因为没有用户数据需要保留。

### 验收（Part 2）

- `agentquad start` 启动无 import 报错；服务端日志无 pipeline 相关字样
- `GET /api/pipelines/...` 任意路径返回 404（Express 默认）
- 前端 build 通过，TodoManage 详情抽屉无 Pipeline 按钮
- DB 升级后 `pipeline_runs` 表不存在；如果之前有 worktree 残留，README 已说明
- `npm test` 全绿
- grep `pipeline\|Pipeline\|worktree\|Worktree` 在删除范围外应仅命中：a) 历史 docs/specs（保留作为历史记录）b) 测试 fixture 里 todo 标题字符串"Deployment pipeline setup"（非实际功能引用）

## 共用风险与回滚

- **回滚**：两件事建议拆 2 个 commit。Part 2 一旦 DROP TABLE 后旧 pipeline_runs 数据丢失，无法回滚。用户已确认接受。
- **测试覆盖**：原 pipeline 没有专门测试文件，删除不会引起测试红。若有 `import` 残留会被 vitest scan 出来。
- **node-pty 残留进程**：现有 PTY kill 路径未变更，Part 1 复用 `pty.stop`，无新风险。

## 不在范围内

- 批量 patch API 的状态变化不触发 close（低频，后续按需添加）
- 把"标记 done"前置弹窗做成可关闭的偏好（YAGNI）
- 任何 UI 视觉刷新

