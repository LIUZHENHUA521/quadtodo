# OpenClaw × quadtodo 微信双向桥接（"open-claw"）

**Date**: 2026-04-29
**Status**: Draft → 待用户审批
**Author**: Claude (assisted)

## 1. 背景与目标

quadtodo 是本地的四象限 todo CLI，每条 todo 内嵌一个 Claude Code / Codex PTY 会话。
OpenClaw 是用户已经在用的本地 AI 个人助理（gateway @ 127.0.0.1:18789），
通过腾讯官方 `@tencent-weixin/openclaw-weixin` 插件接入了**个人微信**。

目标：在不离开微信对话窗口的前提下，把 quadtodo 用起来。

**核心用户故事**：

1. 我在微信跟 OpenClaw 说"帮我做：修复 X bug"
2. OpenClaw 在微信里**多轮向导**问我：工作目录 / 象限 / 模板
3. quadtodo 自动创建 todo，启动 Claude Code PTY，注入模板首句
4. AI 在本地干活；遇到方案分歧时调 `quadtodo.ask_user(question, options[])`
5. quadtodo 把"问题 + 选项 + 短 ticket"格式化推到我微信
6. 我在微信回 "1" 或 "a3f 1"
7. quadtodo 路由回复 → resolve `ask_user` → AI 拿到 chosen 继续干

---

## 2. 既有基础（不需要重做）

| 能力 | 现有位置 |
|---|---|
| Todo CRUD + 4 象限 + workDir 字段 | `src/db.js`、`db.createTodo`、`db.updateTodo` |
| **模板系统**（含 builtin 模板） | `src/db.js`、`db.listTemplates`、`src/routes/templates.js` |
| MCP server（Streamable HTTP，17 工具，stateless） | `src/mcp/server.js`、`src/mcp/tools/{read,write,destructive}/` |
| PTY 会话池（`tool: claude`/`codex`，prompt 注入，session resume） | `src/pty.js`、`PtyManager` |
| `quadtodo mcp install` 把 quadtodo 写进 `~/.claude/settings.json` | 已实现 |
| 启动会话的 HTTP 路由（含 prompt 注入） | `src/routes/ai-terminal.js` |
| Pending-confirm 模式探测 + webhook 推送（飞书/企微） | `src/notifier.js` |

**关键洞察**：因为用户已跑过 `quadtodo mcp install`，PTY 里启动的嵌套 Claude Code
**自动继承** quadtodo MCP server，可以直接调 `quadtodo.ask_user`，不用做嵌套
MCP 配置注入。

---

## 3. 架构

```
┌─ 微信对话 ─────────────────────────────────────────┐
│  你说: "帮我做：修复 login bug"                    │
│  你回: "1"  或  "a3f 1"                            │
│  你看: "[#a3f] 任务 X 卡到决策点 1./2./3."         │
└─────────────┬──────────────────────────────────────┘
              ↑↓ 长轮询 (HTTPS) — 既有
┌─ OpenClaw gateway (127.0.0.1:18789) ───────────────┐
│  + openclaw-weixin 插件（既有）                    │
│  + 新 skill: quadtodo-claw（新增）                 │
│      让模型 → 调 quadtodo MCP                      │
└─────────────┬──────────────────────────────────────┘
              ↑↓ MCP HTTP /mcp（既有 + 8 个新 tool）
┌─ quadtodo (127.0.0.1:5677) ────────────────────────┐
│  既有 17 个工具                                    │
│  + start_ai_session    ← 新                        │
│  + ask_user            ← 新（PTY 内 AI 调，阻塞）   │
│  + submit_user_reply   ← 新（用户回复入口）         │
│  + list_pending        ← 新                        │
│  + cancel_pending      ← 新                        │
│  + list_workdir_options← 新（向导用）               │
│  + list_templates      ← 新（向导用）               │
│  + list_quadrants      ← 新（向导用）               │
│                                                    │
│  + src/openclaw-bridge.js（新：发消息）            │
│  + src/pending-questions.js（新：ticket+Promise 池）│
│  + DB 表 pending_questions（新）                   │
└─────────────┬──────────────────────────────────────┘
              ↓ spawn PTY（既有）
┌─ Claude Code（嵌套 PTY 子进程）────────────────────┐
│  ~/.claude/settings.json 已注册 quadtodo MCP       │
│  AI 自主调 quadtodo.ask_user(...)                  │
└────────────────────────────────────────────────────┘
```

---

## 4. 关键时序：AI 卡到决策点

```
AI（PTY 里）              quadtodo                 OpenClaw         微信
  │                         │                        │              │
  │ ask_user(q, [a,b,c])    │                        │              │
  ├───────────────────────► │                        │              │
  │                         │ ① 生成 ticket=a3f      │              │
  │                         │ ② INSERT pending       │              │
  │                         │ ③ POST /sendMessage    │              │
  │                         ├──────────────────────► │              │
  │                         │                        ├────────────► │
  │                         │                        │  "[#a3f]…"   │
  │     ⏳ 阻塞 (≤10min)    │                        │              │
  │                         │                        │  你回 "1"    │
  │                         │                        │ ◄────────────┤
  │                         │   submit_user_reply    │              │
  │                         │ ◄──────────────────────┤              │
  │                         │ ④ 解析 ticket+模糊匹配  │              │
  │                         │ ⑤ resolve promise      │              │
  │ ◄───────────────────────┤                        │              │
  │ {chosen:"a", ticket:…}  │                        │              │
  │ AI 继续                 │                        │              │
```

**ticket 解析（步骤 ④）**：

1. 文本前缀正则 `/^#?([a-z2-7]{3})\b/` 命中 → 显式 route 到那条
2. 没匹配到 → route 到**最近一条** pending（`ORDER BY created_at DESC LIMIT 1`）
3. 选项匹配优先级：
   - 纯数字 1/2/3 → options[index-1]
   - 选项原文 startswith / contains（大小写不敏感）→ 对应 option
   - 都不匹配 → free-text，整段原文回填给 AI（让 AI 自己理解）

---

## 5. 创建任务的多轮向导

OpenClaw skill 处理多轮对话，quadtodo 仅提供查询工具。

```
你: "帮我做：修复 login bug"
🤖（OpenClaw）调 list_workdir_options + list_quadrants + list_templates
🤖: "📁 选个工作目录：
     1. ~/Desktop/code/crazyCombo/quadtodo (默认)
     2. ~/Desktop/code/crazyCombo/client
     3. ~/Desktop/code/crazyCombo/server
     4. 自定义路径（请输入）"
你: "1"
🤖: "🎯 选象限：
     1. 重要紧急
     2. 重要不紧急 ✓ 默认
     3. 紧急不重要
     4. 不重要不紧急"
你: "2"
🤖: "📋 选模板：
     1. Bug 修复
     2. 重构
     3. 写测试
     4. 自由模式"
你: "1"
🤖 调 create_todo + start_ai_session
🤖: "✅ todo #42 已建 + Claude Code 已启动（注入 Bug 修复模板）"
```

**用户也可以一句话直说**："帮我做：修复 X，目录 quadtodo，象限 1，bug 修复模板"
→ skill 直接 create，跳过向导。

**workdir 推导逻辑**（`list_workdir_options`）：
- 取 quadtodo 现有 todo 中出现频次最高的前 5 个 `workDir`（去重 + 频次降序）
- 不足 5 个时，补 `defaultCwd` + 当前 git repo 根目录
- 始终包含一个 "自定义路径" 占位选项（前端用，让用户输入）

**模板默认值**：
- 复用 `db.listTemplates()`，返回 `[{id, name, description, content}]`
- 内置模板：Bug 修复 / 重构 / 写测试 / 代码评审 / 脑爆模式 / 自由模式
- 模板 `content` 作为 `start_ai_session` 的 prompt 首句

---

## 6. 新增 MCP 工具（8 个）

| 工具 | 输入 | 输出 | 调用方 |
|---|---|---|---|
| `start_ai_session` | `{todoId, tool?='claude', cwd?, templateId?, prompt?}` | `{sessionId}` | OpenClaw skill |
| `ask_user` | `{question, options[], todoId?, sessionId?, timeoutMs?}` | `{ticket, chosen, chosenIndex, status: 'answered'\|'timeout'\|'cancelled', answerText, elapsedMs}` | **PTY 内 AI**（阻塞） |
| `submit_user_reply` | `{text}` | `{ticket, status, chosen?}` | OpenClaw skill |
| `list_pending_questions` | `{}` | `[{ticket, todoId, sessionId, question, options, createdAt, ageSeconds}]` | OpenClaw skill / 调试 |
| `cancel_pending_question` | `{ticket, reason?}` | `{ok}` | OpenClaw skill / 用户主动 |
| `list_workdir_options` | `{}` | `[{path, source: 'recent'\|'default'\|'cwd', count?}]` | OpenClaw skill |
| `list_quadrants` | `{}` | `[{id:1, label:'重要紧急', isDefault:false}, ...]` | OpenClaw skill |
| `list_templates` | `{}` | `[{id, name, description, isBuiltin}]` | OpenClaw skill |

**`ask_user` 阻塞实现**（核心难点）：

- HTTP 长连接最多保持 `timeoutMs`（默认 600s = 10 分钟）
- 服务端用 `pendingQuestions.waitForAnswer(ticket, timeoutMs)` 拿到 Promise，await 之
- 若 MCP 客户端 timeout 短于 10 分钟（待验证），降级方案：在 ack 后立刻返回
  `{ticket, status: 'pending'}`，由 AI 之后调 `wait_user_reply(ticket)` 轮询
- **第一版先用直接阻塞**，spike 验证 Claude Code MCP client timeout，必要时降级

---

## 7. DB schema

```sql
CREATE TABLE pending_questions (
  ticket          TEXT PRIMARY KEY,    -- 3 字符 base32 (RFC4648, a-z2-7)
  session_id      TEXT NOT NULL,       -- PTY 会话 ID（如有）
  todo_id         INTEGER,             -- 关联 todo（可空）
  question        TEXT NOT NULL,
  options_json    TEXT NOT NULL,       -- JSON ["opt1", "opt2", ...]
  status          TEXT NOT NULL,       -- pending|answered|timeout|cancelled
  answer_text     TEXT,                -- 用户原文回复
  chosen_index    INTEGER,             -- 解析后选中的 0-based 索引（free text 时为 NULL）
  created_at      INTEGER NOT NULL,    -- ms epoch
  answered_at     INTEGER,
  timeout_ms      INTEGER NOT NULL
);
CREATE INDEX idx_pq_status ON pending_questions(status, created_at DESC);
CREATE INDEX idx_pq_session ON pending_questions(session_id);
```

迁移：在 `src/db.js` 的 schema bootstrap 段加 `CREATE TABLE IF NOT EXISTS`。

---

## 8. 新增 quadtodo 模块

| 文件 | 职责 | 行数估 |
|---|---|---|
| `src/openclaw-bridge.js` | 封装 OpenClaw gateway HTTP；`postWeixinText(targetUserId, text)`、读 token、retry、限流 | ~120 |
| `src/pending-questions.js` | ticket 生成 + DB 持久化 + Promise 池（ticket → resolve fn）+ 模糊匹配解析 | ~180 |
| `src/mcp/tools/openclaw/index.js` | 注册 8 个新 MCP 工具 | ~250 |
| `src/db.js`（改） | 加 pending_questions 表 + DAO 方法 | +60 |
| `src/server.js`（改） | 启动时初始化 openclaw-bridge + pending-questions，注入到 MCP 工具 | +20 |
| `src/cli.js`（改） | `quadtodo doctor` 加 openclaw gateway ping | +30 |
| `~/.openclaw/workspace/skills/quadtodo-claw/SKILL.md` | OpenClaw 端 skill | ~80 |
| `test/openclaw-bridge.test.js` | 模拟 gateway HTTP 单测 | ~80 |
| `test/pending-questions.test.js` | ticket 生成/解析/超时单测 | ~120 |

---

## 9. 配置

`~/.quadtodo/config.json` 新增段：

```json
{
  "openclaw": {
    "enabled": false,
    "gatewayUrl": "http://127.0.0.1:18789",
    "gatewayTokenEnv": "OPENCLAW_GATEWAY_TOKEN",
    "channel": "openclaw-weixin",
    "targetUserId": "",
    "askUser": {
      "defaultTimeoutMs": 600000,
      "maxConcurrent": 8,
      "rateLimitPerMin": 6
    }
  }
}
```

**安全约束**：
- `gatewayTokenEnv` 指定环境变量名，token 不直接落配置文件
- 启动时若 `enabled === true` 但 token env 缺失 → 警告，禁用 openclaw 出站
- `targetUserId` 必填，否则 `ask_user` 直接返回 `{status: 'misconfigured'}`

---

## 10. OpenClaw skill

`~/.openclaw/workspace/skills/quadtodo-claw/SKILL.md` frontmatter：

```yaml
---
name: quadtodo-claw
description: 当用户说要做某个开发任务（"帮我做"/"帮我修"/"实现 X"/"写一个 X"）、
  或者用户回复一个数字/选项内容/带 [#xxx] 前缀的文本时使用。
  连接本地 quadtodo（127.0.0.1:5677/mcp）的 MCP 服务。
mcpServers:
  quadtodo:
    type: streamable-http
    url: http://127.0.0.1:5677/mcp
---
```

skill body 包含 4 类触发模式：
1. **新任务** → 触发多轮向导
2. **答复决策** → 调 `submit_user_reply`
3. **状态查询** → 调 `list_pending_questions` + 摘要
4. **取消** → 调 `cancel_pending_question`

---

## 11. 风险 & 缓解

| 风险 | 严重度 | 缓解 |
|---|---|---|
| MCP `ask_user` 长阻塞超 Claude Code MCP client 默认 timeout | 🟡 中 | Stage 1 spike：跑 30s 阻塞 + 600s 阻塞实测；不过关时降级为 polling |
| 微信账号风控（高频出站） | 🟡 中 | 内置每分钟 ≤6 条限流；推送做 fingerprint 去重（继承 `notifier.js`） |
| OpenClaw skill 模型识别精度 | 🟢 低 | SKILL body 写明显式前缀 `/做 X` `/答 1` 兜底 |
| 嵌套 Codex 不读 `~/.claude/settings.json` | 🟡 中 | 第一版只支持 Claude Code；Codex 列入 P2 |
| gateway token 泄漏 | 🟡 中 | 强制走 env，doctor 检查 token 来源 |
| ticket 撞车（base32^3=32768） | 🟢 低 | 生成时检查未结案的 ticket，碰撞重试 |
| 模型滥用 ask_user（每个小决策都问） | 🟡 中 | SKILL body + 任务模板里写明"只在重大方案分歧时用 ask_user" |

---

## 12. 验收标准

**P0（必须过）**：
1. 在微信对 OpenClaw 账号说"帮我做：X"，OpenClaw 启动多轮向导（目录/象限/模板）
2. 向导走完后 5-10s 内收到"✅ todo #N 已建 + Claude Code 已启动"
3. quadtodo Web UI 能看到该 todo + 该 PTY 会话
4. AI 在 PTY 里调 `ask_user` 后，微信 5s 内收到 `[#xxx] 任务"X"…\n1.\n2.\n3.`
5. 在微信回 "1" → AI 收到 `chosen` 并继续跑（端到端 ≤ 5s）
6. 同时 2 个 pending：回 "1" → 路由到最新；回 "a3f 1" → 路由到 a3f
7. 超时（默认 10 分钟）AI 收到 `{status: 'timeout'}`

**P1（最好有）**：
8. quadtodo Web UI 能看到 pending_questions 列表 + 在 UI 里也能答复（备用通道）
9. `quadtodo doctor` 检查 OpenClaw gateway 可达 + token env 配置
10. 出站消息每分钟 ≤ 6 条（防风控）
11. 显式前缀 `/做 X` 和 `/答 1` 兜底
12. 一句话创建（"帮我做：X，目录 Y，象限 1，模板 bug 修复"）跳过向导

**P2（以后）**：
13. Codex 支持
14. ask_user 支持图片附件（截图给用户看）
15. 进度推送（任务完成时主动推一条 + git diff stat）

---

## 13. 实施分阶段

| Stage | 范围 | 验证 |
|---|---|---|
| **1. 基础设施** | DB 迁移 + `pending-questions.js` + `openclaw-bridge.js` + 配置段 + 单测 | vitest 单测全过 |
| **2. MCP 工具** | 8 个新 MCP 工具 + 注册 | curl `/mcp` 跑通工具列表 + 模拟调用 |
| **3. OpenClaw skill** | 写 skill MD + 装到 `~/.openclaw/workspace/skills/` | OpenClaw doctor 加载成功 |
| **4. 端到端** | 微信发任务 → AI ask_user → 微信回 → 继续 | 手动测试 P0 全流程 |
| **5. 健壮性** | 超时 / 取消 / 限流 / doctor / 一句话创建 | P1 自检 |

---

## 14. 待用户确认（不阻塞 Stage 1）

- **入站默认行为**：所有微信消息默认进 quadtodo skill（让模型判断）vs 必须带 `/做` 等前缀。**默认假设**：让模型判断，skill body 写明触发关键词。
- **新 todo cwd 缺省**：用户没说目录时，问还是用默认？**默认假设**：必走多轮向导第一步问目录。
- **AI 工具默认**：复用 `defaultTool: 'claude'`。**默认假设**：是的。
- **多用户**：第一版只支持发回原始 sender，多用户 P2。**默认假设**：是的。

如果上面任何一个跟用户预期不符，在 Stage 4 端到端阶段调整即可。
