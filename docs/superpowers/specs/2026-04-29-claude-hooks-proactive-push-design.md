# Claude Code Hooks 主动推送 + 默认 bypass 权限

**Date**: 2026-04-29
**Status**: Draft → 待用户审批
**Depends on**: 2026-04-29-openclaw-quadtodo-bridge-design.md（OpenClaw 双向桥）

## 1. 背景与目标

### 当前 bug
quadtodo 启动的 PTY 里跑 Claude Code，AI 干完一轮**没主动调 `ask_user`** 时，
微信收不到任何通知，用户得自己反复刷 Web UI 才知道"AI 是不是空闲了"。

### 根因
现有推送链路只有一条：**AI 主动调 `quadtodo.ask_user(...)` MCP 工具**。
AI 不调 = 不推。这条路只覆盖"AI 想让用户拍板"的场景。

### 目标
新增一条**框架级、AI 改不了**的推送链路：用 Claude Code 自己的 **hooks**
（`~/.claude/settings.json` 里 `hooks` 段）在关键事件触发，由独立的 hook 脚本调
quadtodo HTTP API 推送微信。

**分工原则**（用户决策）：
- **`ask_user` MCP 工具** = 交互式问答（AI 主动，结构化选项）
- **Claude Code hooks** = 状态主动推送（框架触发，AI 改不了）

附加需求：start_ai_session 启动 PTY 里的 Claude Code 时，**默认 `permissionMode: 'bypass'`**
（用户从微信驱动，没法响应交互式权限弹窗）。

---

## 2. 架构

```
PTY 里的 Claude Code（继承 quadtodo MCP + env 注入）
    │
    ├── 主动调 ask_user MCP（交互式问答，已实现）
    │       └─→ openclaw-bridge.postText → 微信
    │
    └── 框架级 hook 触发（新增）
            │
            ├── Stop hook        ← 每轮 AI 回答结束
            ├── Notification hook← AI 在等输入
            └── SessionEnd hook  ← session 整个结束
                    │
                    ↓ 调本地脚本（继承 PTY env）
            ~/.quadtodo/claude-hooks/notify.js
                    │
                    ↓ 读 env: QUADTODO_SESSION_ID 等
                    ↓ 不是 quadtodo 启动的 → exit 0
                    ↓ 是 → POST 到本地 quadtodo
            POST http://127.0.0.1:5677/api/openclaw/hook
                    │
                    ↓ 应用节流 / 去重
                    ↓ 查 sessionRoute（targetUserId）
                    ↓ openclaw-bridge.postText → 微信
                    ↓
            "🤖 任务「修复 login」AI 这一轮结束了"
```

### 关键设计点
1. **hook 脚本是中转薄壳** —— 不直接调 openclaw CLI，而是 POST 到 quadtodo HTTP，
   由 quadtodo 集中应用节流/去重/路由
2. **env 注入做隔离** —— 用户手动跑 Claude Code 时（不在 quadtodo PTY 里），
   `QUADTODO_SESSION_ID` 没设，hook 脚本立刻 exit 0，零副作用
3. **Bypass 权限改默认** —— 让 PTY 里的 Claude Code 自动处理所有权限请求，
   配合 hook，用户在微信里能放心远程驱动

---

## 3. 推送事件 & 文案

| Hook | 触发 | 默认 | 推送话术（带 ticket 替身 — 用 todoId 短码） |
|---|---|---|---|
| `Stop` | 一轮 AI 回答结束 | ✅ 开 | `🤖 [#tNN] 任务「X」AI 一轮结束，去 quadtodo 看看 / 回我下一步` |
| `Notification` | Claude Code idle 等输入（权限/暂停） | ✅ 开 | `⚠️ [#tNN] 任务「X」AI 卡住等输入` |
| `SessionEnd` | session 结束 | ✅ 开 | `✅ [#tNN] 任务「X」AI 跑完了` |

> `[#tNN]` 是 `t + todoId 短码后 3 位`（独立于 `ask_user` 的 ticket 命名空间，前缀 `t` 区分）

---

## 4. 节流策略

| 规则 | 触发场景 |
|---|---|
| **ask_user pending 时 Stop 静默** | 已有 `pending_questions` 表里 status=pending 且 sessionId 匹配 → 跳过 Stop hook（避免与 ask_user 重复推） |
| **同 (sessionId × event 类型) 30s cooldown** | Stop 一连串触发时只推第一条；30s 后下一条才能推 |
| **Notification 优先级最高** | 即使在 cooldown 也立即推（`Notification` 通常意味着 AI 真的卡住了） |
| **SessionEnd 不节流** | 最终态必须送达，无视所有 cooldown |
| **整体出站沿用现有 6/min 限流** | 极端场景下跟 ask_user 共享配额，达到上限时丢最旧的非紧急事件 |

去重 key 设计：
```
dedup_key = `${sessionId}:${eventType}`
hookCooldownMs = 30_000        // event 内
askUserSilenceWindow = 0       // 检测到 pending 直接静默，不靠时间窗
```

---

## 5. 实现组件清单

| 组件 | 类型 | 修改/新增 |
|---|---|---|
| `~/.quadtodo/claude-hooks/notify.js` | 新文件 | hook 脚本：读 env + stdin payload，POST 到 quadtodo |
| `src/routes/openclaw-hook.js` | 新文件 | `POST /api/openclaw/hook` 处理 |
| `src/openclaw-bridge.js` | 改 | 加 hook event 节流逻辑（独立于 ask_user 限流） |
| `src/mcp/tools/openclaw/index.js` | 改 | `start_ai_session`: 注入 env + 默认 `permissionMode='bypass'` |
| `src/server.js` | 改 | 挂载 `/api/openclaw/hook` 路由 |
| `src/cli.js` | 改 | 加子命令 `quadtodo openclaw install-hook` 写 `~/.claude/settings.json` |
| `src/openclaw-hook-installer.js` | 新文件 | 安装 / 卸载 hook 的工具函数（合并、不覆盖用户其他 hook） |
| `test/openclaw-hook.test.js` | 新测试 | hook 路由 + 节流单测 |
| `test/openclaw-hook-installer.test.js` | 新测试 | settings.json merge 逻辑 |

---

## 6. hook 脚本（`~/.quadtodo/claude-hooks/notify.js`）

```js
#!/usr/bin/env node
// stdin: Claude Code 传入的 hook payload (JSON)
// env:
//   QUADTODO_SESSION_ID   - quadtodo 启动 PTY 时注入；没注就 exit 0
//   QUADTODO_TARGET_USER  - 微信 peer id
//   QUADTODO_TODO_ID
//   QUADTODO_TODO_TITLE
// argv[2]: stop | notification | session-end

const { QUADTODO_SESSION_ID, QUADTODO_TARGET_USER, QUADTODO_TODO_ID, QUADTODO_TODO_TITLE } = process.env
if (!QUADTODO_SESSION_ID) process.exit(0)

let payload = ''
process.stdin.on('data', c => payload += c)
process.stdin.on('end', async () => {
  const event = process.argv[2] || 'unknown'
  const body = JSON.stringify({
    event,
    sessionId: QUADTODO_SESSION_ID,
    targetUserId: QUADTODO_TARGET_USER || null,
    todoId: QUADTODO_TODO_ID || null,
    todoTitle: QUADTODO_TODO_TITLE || null,
    hookPayload: tryParse(payload),
  })
  await fetch('http://127.0.0.1:5677/api/openclaw/hook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }).catch(() => {})  // 失败静默：宁可丢推送也不阻塞 Claude Code
})

function tryParse(s) { try { return JSON.parse(s) } catch { return null } }
```

特点：
- **超薄**：一个文件 < 30 行，无依赖（只用 node 内置 fetch）
- **非阻塞**：fetch 失败 → catch 后正常 exit，**绝不阻塞 Claude Code**
- **零侵入**：`QUADTODO_SESSION_ID` 没注入就直接 exit 0

---

## 7. `quadtodo openclaw install-hook` 命令

读 `~/.claude/settings.json`，**合并**而不是覆盖现有 hooks 段：

```json
{
  "hooks": {
    "Stop": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "node $HOME/.quadtodo/claude-hooks/notify.js stop" }] }
    ],
    "Notification": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "node $HOME/.quadtodo/claude-hooks/notify.js notification" }] }
    ],
    "SessionEnd": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "node $HOME/.quadtodo/claude-hooks/notify.js session-end" }] }
    ]
  }
}
```

合并规则：
- 已有 `Stop` 数组 → append 一个 entry，不删 / 不改其他 entry
- 用一个内嵌标识 `"_quadtodo_managed": true` 标记自己 add 的，方便 uninstall 时只删自己加的
- 配套提供 `quadtodo openclaw uninstall-hook` 反操作

边界：`~/.claude/settings.json` 不存在 → 创建；存在但 JSON 损坏 → 报错让用户修，不擅自覆盖。

---

## 8. `start_ai_session` 修改

```diff
  inputSchema: {
    todoId: ...,
    tool: ...,
-   permissionMode: z.enum(['default', 'acceptEdits', 'bypass']).optional(),
+   permissionMode: z.enum(['default', 'acceptEdits', 'bypass']).optional()
+     .describe('默认 bypass：从微信远程驱动时无法响应交互权限'),
    ...
  }

- permissionMode: args.permissionMode || null,
+ permissionMode: args.permissionMode || 'bypass',
```

PTY 启动时注入 env（修改 `pty.start` 接受额外 env 参数，或在 spawnSession 内拼装）：

```js
env: {
  ...process.env,
  QUADTODO_SESSION_ID: sessionId,
  QUADTODO_TARGET_USER: targetUserId || '',
  QUADTODO_TODO_ID: todoId,
  QUADTODO_TODO_TITLE: todo.title,
}
```

---

## 9. 错误处理

| 现象 | 处理 |
|---|---|
| hook 脚本 fetch 失败（quadtodo 没跑） | catch 静默 → Claude Code 继续，丢推送 |
| `~/.claude/settings.json` 损坏 | install-hook 报错并打印当前内容，不擅自覆盖 |
| hook payload 太大 | 截断到 240 字符 + 加 `[truncated]` 标记 |
| Claude Code 同时触发多个 hook（很常见，比如 Stop + Notification） | quadtodo 端按 dedup_key 串行处理 |
| AI 一轮里调了 ask_user 又触发 Stop | "ask_user pending 时 Stop 静默" 规则兜底 |
| 用户手动跑 `claude` 在 quadtodo 之外 | env 没注入 → hook 脚本 exit 0，无副作用 |

---

## 10. 验收标准

**P0**：
1. `quadtodo openclaw install-hook` 跑完 `~/.claude/settings.json` 里有 3 个 quadtodo 注释的 hook 配置；既有 hook 不被破坏
2. 通过 quadtodo 启动的 PTY，每轮 AI 结束 → 微信收到 `🤖 [#tNN] ... 一轮结束` 推送
3. AI 调了 `ask_user`（pending 状态下）的同一轮 Stop → **没有**重复推送
4. 用户手动 `claude` 在外面跑 → **没有**任何 quadtodo 推送
5. SessionEnd 推送一定送达（不被节流吞）
6. PTY 里 Claude Code 默认不再问权限（`permissionMode='bypass'`）

**P1**：
7. `quadtodo openclaw uninstall-hook` 干净清除自己加的 entry
8. `quadtodo doctor` 检查 hook 是否安装 + 文件是否存在

**P2**：
9. PreToolUse 高风险工具警报（ Bash/Edit/Write 前推消息让用户远程批/拒）
10. 自定义话术模板（用户能改默认推送格式）

---

## 11. 风险

| 风险 | 缓解 |
|---|---|
| Stop hook 太频繁导致微信刷屏 | 30s cooldown + ask_user pending 静默 + 6/min 整体限流 |
| `~/.claude/settings.json` 合并破坏用户原有配置 | 备份原文件到 `.bak` + 用 `_quadtodo_managed` 标记自己加的 + uninstall 反操作 |
| bypass 权限默认化让 AI 跑危险操作 | 用户已明确同意此风险（远程驱动场景必需）；可在 SKILL.md 里建议"敏感任务不要走 quadtodo"作为补丁 |
| hook 脚本依赖 quadtodo 进程在线 | fetch 失败静默；如果 quadtodo 挂了用户从其他渠道（Web UI / openclaw 本地）也能感知 |
| Notification hook 的具体 trigger 行为不确定（Claude Code 文档不全） | 实施时 spike 验证；如果不可靠，降级为 fallback（Stop 兜底） |

---

## 12. 实施分阶段

| Stage | 范围 | 验证 |
|---|---|---|
| **1. hook 脚本 + 路由** | `notify.js` + `POST /api/openclaw/hook` + 节流逻辑 + 单测 | curl 模拟 hook 调用，看推送（mock openclaw-bridge）|
| **2. env 注入 + bypass 默认** | `start_ai_session` 改 + pty.js 接受 env 参数 + 单测 | 启动一个 PTY，验证 env 在子进程可见 |
| **3. install-hook CLI** | `~/.claude/settings.json` 合并器 + cli.js 子命令 + 单测 | 在临时目录测合并/卸载 |
| **4. 端到端** | 跑通"启动 → AI 干一轮 → 微信收 Stop 推送" | 真实在微信看到推送 |
| **5. doctor 集成** | doctor 加 hook 安装状态检查 | doctor 输出 ok |

---

## 13. 与现有 ask_user 的边界

| 行为 | 谁负责 |
|---|---|
| AI 想让用户拍板（带选项） | `ask_user` MCP 工具 |
| AI 一轮回答结束（无显式拍板需求）| Stop hook |
| AI 卡在权限弹窗 / Claude Code 系统级 idle | Notification hook |
| Session 结束 / 任务完成 | SessionEnd hook |
| AI 调了 ask_user 但同时 Stop 也触发 | **ask_user 优先**，Stop 静默 |
| AI 没调 ask_user 但聊天中混入 "请告诉我..." | Stop hook 兜底（推一条"AI 一轮结束"，文案不带具体问题） |
