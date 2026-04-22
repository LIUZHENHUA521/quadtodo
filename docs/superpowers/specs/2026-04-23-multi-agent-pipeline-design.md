# Multi-agent Pipeline — 设计文档

- 日期：2026-04-23
- 所属项目：`quadtodo`
- 目标：为一个 todo 启动多个有角色的 Claude / Codex session 协同工作，通过 orchestrator 自动按路由规则把控制权交接（Lv2 水平）

## 决策记录

| # | 项 | 取值 |
|---|---|---|
| 1 | Handoff 格式 | XML 标签 `<handoff to="..." verdict="approved|rejected" />`（可选 `feedback` / `summary` 属性） |
| 2 | Worktree 根 | `<repo>/.quadtodo-worktrees/` — 自动写入 `.gitignore` |
| 3 | baseSha | pipeline 启动时 `git rev-parse HEAD` |
| 4 | Pipeline 通过后的合并 | 弹 UI：merge / squash / 保留 worktree / 丢弃 |
| 5 | iteration 上限触发 | 停机 + 提示 "再加 1 轮 / 接受当前 / 放弃"三选一 |
| 6 | Coder 被打回 | **复用原 session** 注入 feedback，round+1，上下文连续 |
| 7 | Artifact 内容 | agent 自写 summary + orchestrator 自动附 `git diff baseSha..HEAD` |
| 8 | Agent 没写 handoff 标签就 done | 当 `event: 'done'`，走默认 edge；没配就停机等人 |
| 9 | 默认模板 | **仅 coder ↔ reviewer 循环**，tester 下一版再加 |

## 数据模型

### `pipeline_templates` (新表)

```sql
CREATE TABLE pipeline_templates (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  roles_json      TEXT NOT NULL,     -- [{ key, name, systemPrompt, tool, writeAccess, worktree }]
  edges_json      TEXT NOT NULL,     -- [{ from, event, verdict?, to }]
  max_iterations  INTEGER NOT NULL DEFAULT 3,
  is_builtin      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
```

### `pipeline_runs` (新表)

```sql
CREATE TABLE pipeline_runs (
  id              TEXT PRIMARY KEY,
  todo_id         TEXT NOT NULL,
  template_id     TEXT NOT NULL,
  status          TEXT NOT NULL,     -- running | done | stopped | failed
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  iteration_count INTEGER NOT NULL DEFAULT 0,
  base_branch     TEXT,
  base_sha        TEXT,
  agents_json     TEXT NOT NULL DEFAULT '[]',    -- [{ role, round, sessionId, worktreePath, branch, status, startedAt, completedAt, artifactSha }]
  messages_json   TEXT NOT NULL DEFAULT '[]'     -- [{ at, from, to, kind, verdict?, reason?, artifactRef? }]
);
CREATE INDEX idx_pipeline_runs_todo ON pipeline_runs(todo_id);
CREATE INDEX idx_pipeline_runs_status ON pipeline_runs(status);
```

### Config 新增

`~/.quadtodo/config.json`:
```json
{
  "pipelineMaxAgents": 3
}
```

### 默认模板 seed

启动时若 `pipeline_templates` 为空，写入：
```json
{
  "id": "builtin-coder-reviewer-loop",
  "name": "Coder ↔ Reviewer 循环",
  "description": "代码员实现 → 审阅员审阅，驳回则打回代码员（复用会话），通过则结束",
  "roles": [
    { "key": "coder", "name": "代码员", "tool": "claude", "writeAccess": true, "worktree": "own",
      "systemPrompt": "…" },
    { "key": "reviewer", "name": "审阅员", "tool": "claude", "writeAccess": false, "worktree": "attach_to_writer",
      "systemPrompt": "…" }
  ],
  "edges": [
    { "from": "coder", "event": "done", "to": "reviewer" },
    { "from": "reviewer", "event": "handoff", "verdict": "approved", "to": "__done__" },
    { "from": "reviewer", "event": "handoff", "verdict": "rejected", "to": "coder" }
  ],
  "maxIterations": 3,
  "isBuiltin": true
}
```

## Handoff 标签规范

Coder：
- 默认不需要写 handoff —— done 自动触发 reviewer
- 若想提前提交审阅：`<handoff to="reviewer" summary="…" />`

Reviewer：
- 必须以 handoff 结尾，二选一：
  - `<handoff to="__done__" verdict="approved" rationale="…" />`
  - `<handoff to="coder" verdict="rejected" feedback="具体改动建议" />`

Orchestrator 扫描该 agent 最后一条 assistant turn 的全文（从 JSONL 取），找最后一个 `<handoff …/>`。

## Orchestrator 核心算法

```
on session_done(sessionId):
  agent = findAgent(sessionId)
  handoff = parseHandoff(lastAssistantTurn(agent.sessionId))
  rule = matchRule(template.edges, agent.role, handoff)

  if rule.to == '__done__':
    finalize(run)   // 弹合并 UI
    return

  if rule.to == agent.role:
    // 同角色循环（比如 reviewer → reviewer 不允许，但 coder → coder 不会出现，因为边从 reviewer 出）
    pass

  if is_loopback_to(rule.to, run):     // rule.to 之前已经跑过
    run.iteration_count++
    if run.iteration_count > template.maxIterations:
      pause(run, reason='iteration_limit')
      return

  nextRole = template.roles[rule.to]
  if nextRole == 'coder' and has_previous_coder(run):
    // #6 决策：复用 coder session
    resumeCoderWithFeedback(previous_coder.sessionId, handoff.feedback + artifact)
  else:
    spawnNewAgent(nextRole, run, context_from_previous)
```

## Worktree 管理

- 根目录：`<repo>/.quadtodo-worktrees/<run-id>/`
- Writer 角色：分支名 `quadtodo/<run-id>/<role>-<round>`，base `base_sha`
- Reader 角色（`worktree: 'attach_to_writer'`）：直接 cwd 到 writer 最新 worktree，只读约定（system prompt 里声明）
- Pipeline 结束：
  - 成功 → 弹 UI：squash merge / 直接 merge / 保留 / 丢弃
  - 失败/放弃 → 保留 worktree（方便调试），右栏有「清理」按钮
- `.gitignore` 自动加 `.quadtodo-worktrees/`

## 分阶段实施

| Phase | 文件 | 说明 |
|---|---|---|
| A | `src/db.js`, `src/routes/pipelines.js`（新）, `src/server.js` | DB 表 + 默认模板 seed + CRUD 路由 + 配置项 |
| B | `src/worktree.js`（新） | worktree 创建/读/清理，`.gitignore` 补丁 |
| C | `src/orchestrator.js`（新） | 状态机 + handoff 解析 + 事件订阅 PTY done + spawn / resume agent |
| D | `web/src/pipeline/PipelineRunView.tsx`（新）, 扩 `SessionViewer` 为 N-pane, todo 菜单加「启动 Pipeline」 | UI 入口与运行态展示 |
| E | `web/src/pipeline/Timeline.tsx` | 消息流时间轴 |
| F | 合并 UI、iteration 限制弹窗、worktree 清理面板、文档 | Polish |

## 非目标 / 延后

- tester 角色（下版本）
- Meta-orchestrator（Lv3，独立 AI 做指挥官）
- 并行 agent 分支（多个 coder 并发）
- 跨 todo 的 pipeline 依赖
