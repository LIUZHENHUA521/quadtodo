# Codex × 飞书/Telegram 主动推送桥接

**Date**: 2026-05-09
**Status**: Draft → 待用户审批
**Depends on**:
- `2026-04-29-claude-hooks-proactive-push-design.md`（Claude 端 hook 推送链路，本设计稿在其上扩展 Codex 路径）
- `2026-05-09-gpt-default-pricing-design.md`（pricing.js 加 GPT 模型族，避免本稿重复定义价格）

## 1. 背景与目标

### 现状

quadtodo 的 PTY 已经支持 spawn / resume Codex（`pty.js` 内 `tool === 'codex'` 分支齐全），
`transcript.js` 也实现了 `parseCodexJsonl`，`usage-parser.js` 有 `extractCodex`。

但 **AI 干完一轮主动推送到飞书 / Telegram** 这条链路只对 Claude 通：
- `openclaw-hook.js` 第 99 行注释明写："仅 Claude（codex 暂不在 footer 范围；Codex 推送目前没走 hook 路径）"
- Codex CLI 没有 `~/.claude/settings.json` 这种 PreToolUse / Stop / Notification hook 协议
- 结果：用 Codex 跑 todo 时，飞书 thread / Telegram topic 收不到任何 turn-end / ask-user 通知

### 目标

让 Codex todo 在飞书 / Telegram 上获得**与 Claude 等价的主动推送体验**：

1. AI 跑完一轮 → IM 收到一条带 footer（token / cost）的 markdown 消息
2. AI 卡在权限确认 prompt → IM 收到 ✅/❌ 卡片，按下后 PTY 收到 `y\n` / `n\n`
3. session 结束 → IM 收到收尾消息 + 完整 transcript .md 附件

### 非目标（明确剔除）

- ❌ OpenClaw 微信渠道 / `quadtodo-claw` skill 改造
- ❌ `openclaw-hook-installer.js` 写 Codex 配置（Codex 没等价 settings.json，不动）
- ❌ cursor-agent 推送链路
- ❌ Codex 加密 reasoning 解密 / 展示

---

## 2. 关键事实（事先验证过）

### 2.1 Codex jsonl 格式（实测 ~/.codex/sessions/2026/04/25/rollout-*.jsonl）

| record | 用途 | 出现频次（典型 session） |
|---|---|---|
| `session_meta` | session id / cwd / git / cli_version | 1 |
| `event_msg/task_started` | AI 开始一轮 | 每轮 1 |
| `event_msg/task_complete` | **AI 一轮完成** | 每轮 1 ← Stop 等价信号 |
| `event_msg/agent_message` | AI 文本（重复信息，与 response_item 配对） | ≈ assistant 数 |
| `event_msg/token_count` | 每个 tool call 后 token 统计 | 多 |
| `event_msg/exec_command_end` | shell tool call 完成 | 多 |
| `event_msg/patch_apply_end` | apply_patch 完成 | 偶尔 |
| `event_msg/turn_aborted` | 用户 ctrl-C 中断 | 偶尔 |
| `event_msg/error` | 错误 | 偶尔 |
| `response_item/message/assistant` | 干净的 assistant turn 文本（已被 `extractCodex` 消费） | 多 |
| `response_item/reasoning` | 推理（加密 by default） | 多 |

**关键结论**：`event_msg/task_complete` 是 Codex 的 turn-end 信号，干净、结构化、可靠 ——
不需要在 stdout 上做 pattern matching 来判断 turn 边界。

### 2.2 缺失的事件类型

实测扫描全部 `event_msg/*` 子类（见 §2.1 表），**没有**出现 `exec_approval_request` /
`patch_approval` / `permission_request` 类事件。Codex 0.125 把权限交互留在 PTY stdin（`Approve? (y/n)` 类 prompt），不写进 jsonl。

→ ask-user 等价信号必须从 PTY stdout 嗅探，jsonl 路径不可用。

### 2.3 复用现成模块

| 模块 | 状态 | 本稿如何用 |
|---|---|---|
| `pty.js` Codex spawn / resume | ✅ 已支持 | 不动 |
| `pty.js findCodexSession` 系列 | ✅ 已支持（fs.watch + regex） | 复用 |
| `transcript.js parseCodexJsonl` | ✅ 已支持 | 复用 |
| `usage-parser.js extractCodex` | ✅ 已支持 | 复用 |
| `openclaw-bridge.js` 出站推送 | ✅ tool-agnostic（lark / telegram / weixin 三 channel） | 复用 |
| `pricing.js` GPT 价表 | ⏳ 由 `2026-05-09-gpt-default-pricing-design.md` 提供 | 等其落地 |

---

## 3. 架构

```
PTY 里的 Codex（继承 quadtodo MCP + env 注入）
    │
    ├── (a) jsonl tail 路径（turn-end / session-end / error）
    │       │
    │       ↓ codex-event-emitter.js fs.watch
    │       ↓ 解析增量行 → 识别 event_msg/task_complete | turn_aborted | error
    │       ↓ 拼 quadtodo 内部统一事件契约
    │       │     { sessionId, evt: 'stop'|'session-end'|'error', sourceTool: 'codex', ... }
    │       ↓
    │       └─→ POST 到 quadtodo HTTP
    │              POST http://127.0.0.1:5677/api/openclaw/hook
    │              （沿用 Claude 那条路由，让 openclaw-hook 内部按 sourceTool 分支）
    │
    └── (b) PTY stdout 嗅探路径（ask-user / 权限确认）
            │
            ↓ codex-prompt-detector.js 监听 PTY data 事件
            ↓ 正则匹配 Approve? (y/n) | Continue? [y/N] | Allow this command? 等
            ↓ debounce + de-dup（避免一行多次匹配）
            ↓
            └─→ 直接 push 到 ask_user pending + bridge
                   （走与 Claude Notification hook 相同的下游分发，但事件起点不同）

下游（已有）：
    openclaw-hook.js
        │
        ├── 节流（沿用 §4 规则，按 sessionId × evt × sourceTool）
        ├── 内容拼装：调 transcript.js loadTranscript({ tool: 'codex', ... })
        ├── usage-footer：调 extractCodex（pricing 由 gpt-default-pricing 设计稿覆盖）
        └── openclaw-bridge.postText / postCard
                ├── lark-bot.replyInThread
                └── telegram-bot.sendMessage / sendDocument
```

### 3.1 路径选择理由

**为什么 turn-end 走 jsonl tail 而不是 hook**：
Codex 没有 hook 协议，但 jsonl 写入是协议级行为（不可被 AI 改），等价于 hook 的"框架级触发、AI 改不了"原则。`event_msg/task_complete` 在每轮结束时由 Codex CLI 写入，比 stdout 嗅探更可靠。

**为什么 ask-user 走 stdout 嗅探**：
权限 prompt 在 stdin/stdout 上交互，jsonl 不写。Codex 升级若加了 `exec_approval_request` 事件，可在 emitter 里加 jsonl 分支，stdout 嗅探作为兜底保留即可。

**为什么继续走 `POST /api/openclaw/hook` 而不另开端点**：
节流、去重、内容拼装、附件生成、bridge 出站等下游链路全是 Claude/Codex 通用的，开新路由会复制 80% 代码。仅在路由 handler 入口按 `sourceTool` 分支即可。

---

## 4. 事件契约（codex-event-emitter → /api/openclaw/hook）

POST 请求体（沿用 Claude hook 现有字段，加一个 `source` 区分）：

```json
{
  "source": "codex",
  "event": "Stop" | "SessionEnd" | "Error",
  "session_id": "<codex native uuid>",
  "transcript_path": "/Users/.../rollout-...jsonl",
  "cwd": "/Users/.../quadtodo",
  "quadtodo_session_id": "<quadtodo internal>",
  "quadtodo_todo_id": "<todoId>",
  "raw_event_payload": { /* event_msg.payload, 给 handler 取 error message 等 */ }
}
```

**`quadtodo_session_id` / `quadtodo_todo_id` 注入方式**：
PTY 启动 Codex 时把 quadtodo 自己的 sessionId / todoId 写入 `~/.quadtodo/codex-sessions/<nativeId>.json`（codex-event-emitter 启动后从 jsonl 头部 `session_meta` 拿 nativeId，再去这个目录查 quadtodo 元数据）。

理由：Codex CLI 不接受任意 env 透传到 jsonl（不像 Claude hook 直接读 env），用文件做 sidecar 比改 Codex 干净。

---

## 5. 推送事件 & 文案

| 事件 | 触发 | 默认 | 文案（继承 Claude 的 [#tNN] 规则） |
|---|---|---|---|
| Codex `task_complete` | jsonl 出现 `event_msg/task_complete` | ✅ 开 | `🤖 [#tNN] 任务「X」AI 一轮结束，去 quadtodo 看看 / 回我下一步` |
| Codex prompt 嗅探命中 | PTY stdout 匹配权限 prompt 正则 | ✅ 开 | `⚠️ [#tNN] 任务「X」AI 卡住等输入：<prompt 文本>` |
| Codex `turn_aborted` | jsonl 出现 `event_msg/turn_aborted` | ✅ 开 | `🛑 [#tNN] 任务「X」AI 这一轮被中断` |
| Codex `error` | jsonl 出现 `event_msg/error` | ✅ 开 | `❌ [#tNN] 任务「X」Codex 报错：<message>` |
| Codex SessionEnd | PTY 进程退出 + emitter 关 fs.watch | ✅ 开 | `✅ [#tNN] 任务「X」AI 跑完了` + 完整 transcript .md |

ask-user 卡片（飞书 interactive card / Telegram inline keyboard）：
- 飞书：复用 `lark-card.buildPermissionCard`，按钮 callback 走 `lark-bot.handleCardAction`
- Telegram：复用 `ask-user-buttons.js`，callback_data 标记 `codex:<sessionId>:y` / `:n`
- 回写：handler 拿到回调 → 找到 sessionId 对应的 PTY → `pty.write('y\n' | 'n\n')`

---

## 6. ask-user prompt 嗅探规则

### 6.1 基础正则集

每条都是命中即触发；按 union 处理；命中后 debounce 1.5s 防重复。

```js
const CODEX_APPROVAL_PATTERNS = [
  // 英文 yes/no 形式
  /^\s*(approve|allow|continue|proceed)\??\s*\(\s*y\/n\s*\)/im,
  /\?\s*\[\s*y\/N\s*\]/i,
  /\?\s*\[\s*Y\/n\s*\]/i,
  // 中文（如果 Codex 国际化版有）
  /(允许|批准|授权).*\?\s*[（(]\s*[yYnN][\/／][nNyY]\s*[)）]/,
  // shell exec 阻塞确认
  /run this command\?\s*\[/i,
  /apply patch\?\s*\[/i,
]
```

### 6.2 误检兜底

**问题**：AI 输出的 markdown 里也可能含 "approve? (y/n)"（比如它在解释别的命令）。

**对策**：嗅探只看**最近 N 行 stdout 流末尾**（不是滚动的整段输出），且要求该行**之后 1.5s 内没有更多 stdout**（PTY 在等 stdin → 真的卡住了）。

```js
class CodexPromptDetector {
  constructor(pty, onMatch) {
    this.recentChunks = []        // ring buffer 最近 4KB
    this.lastChunkAt = 0
    this.debounceTimer = null
    pty.on('data', (chunk) => this.onData(chunk))
  }
  onData(chunk) {
    this.recentChunks.push({ ts: Date.now(), text: stripAnsi(chunk) })
    while (this.recentChunks.length > 32) this.recentChunks.shift()
    this.lastChunkAt = Date.now()
    clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => this.maybeMatch(), 1500)
  }
  maybeMatch() {
    const tail = this.recentChunks.slice(-4).map(c => c.text).join('')
    for (const re of CODEX_APPROVAL_PATTERNS) {
      const m = tail.match(re)
      if (m) {
        this.onMatch({ promptText: tail.slice(-200), matchedPattern: re.source })
        return
      }
    }
  }
}
```

测试矩阵覆盖：5 条 fixture（Codex 0.125 / 各 prompt 形态），加 2 条"AI 在解释命令"的反例（不应触发）。

---

## 7. 实现组件清单

| 组件 | 类型 | 改动 |
|---|---|---|
| `src/codex-event-emitter.js` | 新文件 | jsonl tail（fs.watch + 增量解析）→ POST `/api/openclaw/hook` |
| `src/codex-prompt-detector.js` | 新文件 | PTY stdout 嗅探 → POST `/api/openclaw/hook`（event=Notification, source=codex） |
| `src/pty.js` | 改 | Codex spawn 后启动 emitter + detector；exit 时停掉它们；写 sidecar `~/.quadtodo/codex-sessions/<nativeId>.json` 注入 quadtodo session/todoId |
| `src/openclaw-hook.js` | 改 | 入口按 `body.source` 分支：`'claude'` 走现路径（含 transcript_path 校验、Claude jsonl 解析），`'codex'` 改用 `loadTranscript({ tool: 'codex', nativeSessionId, ... })`；usage footer 改用 `extractCodex` |
| `src/usage-footer.js` | 改 | `extractSessionUsageFromLines` 增加 `tool` 参数，按 tool 调 `extractClaude` / `extractCodex` |
| `src/openclaw-bridge.js` | 不动 | 已 tool-agnostic |
| `src/lark-card.js` / `src/ask-user-buttons.js` | 改（小） | 卡片 callback 加 `source=codex` 字段，回写时分发到 PTY write 而非 hook 阻塞机制 |
| `src/server.js` | 不动 | `/api/openclaw/hook` 路由复用 |
| `~/.quadtodo/codex-sessions/<nativeId>.json` | 新 sidecar 路径 | quadtodo session/todoId 与 codex nativeId 的映射 |
| `test/codex-event-emitter.test.js` | 新测试 | jsonl 增量解析 + event 派发（fixture: task_complete / turn_aborted / error） |
| `test/codex-prompt-detector.test.js` | 新测试 | 5 条命中 + 2 条反例 + debounce 行为 |
| `test/openclaw-hook.codex.test.js` | 新测试 | source=codex 路径，footer 用 extractCodex，附件生成 |
| `test/usage-footer.test.js` | 改 | 加 codex 用例（assertion: 调用 extractCodex 而非 extractClaude） |
| `test/lark-card.codex.test.js` | 新测试 | callback 路由到 PTY write，不走 Claude hook 机制 |

---

## 8. 节流 & 去重（沿用 Claude hook 规则）

复用 `openclaw-hook.js` 现有节流，**仅扩展 dedup key 加 source 维度**：

```
dedup_key = `${sessionId}:${eventType}:${source}`
```

理由：同一 sessionId 不会同时是 Claude 和 Codex（PTY 一对一），但 dedup key 加 source 让 telemetry / 日志更清晰，且未来若引入"hybrid pipeline（Claude → Codex 接力）"时无需改 key 结构。

其它规则不变：
- ask_user pending 时 Stop 静默
- Notification 优先级最高，无视 cooldown
- SessionEnd 不节流
- 整体出站沿用 6/min 限流

---

## 9. 错误处理

| 故障点 | 兜底 |
|---|---|
| Codex jsonl 还没 flush 就触发 task_complete | 沿用 Claude 那侧的 `readLatestAssistantTurnFresh` 思路：retry × 3，每次 200ms，仍读不到则用最近一条 assistant message |
| sidecar 文件读不到（崩溃后重启 PTY） | emitter 启动时若 sidecar 缺失 → POST 时 `quadtodo_todo_id` 为空 → handler 走老链路按 nativeId 反查 DB（`aiTerminal.sessions.get(nativeId)`） |
| stdout 嗅探正则误判 | 命中后 debounce 1.5s 内若有新 stdout 行 → 取消推送（说明 AI 还在打字、不是真卡住） |
| Codex 升级改了 jsonl schema | emitter 用 `j?.payload?.type` 安全访问，未知 type 静默丢弃；vitest 跑 fixture 守住已知 schema |
| Codex 没写 task_complete 就 crash | PTY exit 事件兜底触发 SessionEnd 推送，附件用最后能拿到的 jsonl 内容 |

---

## 10. 验收标准

### Codex 主流程（手测 + e2e）

- [ ] Web 选 codex 创建 todo → PTY 启动 Codex 0.125+ → `~/.codex/sessions/.../rollout-*.jsonl` 出现
- [ ] sidecar `~/.quadtodo/codex-sessions/<nativeId>.json` 生成，含 quadtodo session/todoId
- [ ] Codex 跑完一轮（jsonl 出现 `event_msg/task_complete`） → 飞书 thread 收到一条 markdown，footer 显示 `turn / session token / cost`（pricing 命中 `gpt-5*`）
- [ ] Telegram topic 收到等价 V2 文本，footer 一致
- [ ] Codex 输出 `Approve? (y/n)` → 飞书 interactive card / Telegram inline keyboard 1.5s 内推到
- [ ] 飞书按 ✅ → 对应 PTY 收到 `y\n`（用 `pty.write` mock 验证）
- [ ] Telegram 按 ❌ → 对应 PTY 收到 `n\n`
- [ ] Ctrl-C 中断（jsonl `event_msg/turn_aborted`）→ IM 收到 🛑 文案
- [ ] PTY exit → IM 收到 ✅ 收尾 + 完整 transcript .md 附件

### Claude 零回归

- [ ] 现有 vitest 全绿（`test/openclaw-hook.test.js` 等）
- [ ] 手测：Claude todo 跑一轮，飞书 / Telegram 推送格式与改动前一致

### 节流 / 错误兜底

- [ ] ask_user pending 时 Codex Stop 被静默
- [ ] Codex prompt 嗅探：5 个 fixture 命中，2 个反例不命中
- [ ] sidecar 缺失时 handler 回退到 nativeId 反查 DB

---

## 11. 实施顺序（建议给 writing-plans 阶段）

1. **Phase A — 基础设施**：sidecar 写 / 读 + emitter 框架（不接 IM，先打 console.log）
2. **Phase B — turn-end 链路**：emitter 解析 task_complete → POST → handler 按 source=codex 取 codex transcript → bridge 推送（Claude 路径只读不改）
3. **Phase C — usage-footer**：`extractSessionUsageFromLines` 加 tool 参数；codex todo footer 显示
4. **Phase D — ask-user 嗅探**：detector + 卡片 + PTY 回写（飞书先，Telegram 跟上）
5. **Phase E — 错误事件 / SessionEnd / 附件**：error / turn_aborted / SessionEnd 三件套
6. **Phase F — 测试 + Claude 回归**：vitest 全绿 + 手测两侧 IM

每个 Phase 单独 PR，前一个不接死后一个，便于独立 revert。
