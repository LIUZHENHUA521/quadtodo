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

### 2.3.0 最低 Codex CLI 版本（reviewer iter-2 #5）

- **最低支持**：Codex CLI **0.125**（实测样本来源版本，含 `event_msg/task_complete` / `event_msg/token_count` 结构）
- **检测方式**：emitter 启动时从 jsonl 头部 `session_meta.payload.cli_version` 读出版本
- **降级策略**：低于 0.125 时本稿能力不可用——emitter 标记 sessionId 为 "unsupported_cli" 模式，仅靠 PTY exit 推 SessionEnd（无 turn-end / footer / 附件、no detector 推送）。CLI doctor 命令报 warning，建议升级

### 2.3 复用现成模块（已校对）

| 模块 | 状态 | 本稿如何用 |
|---|---|---|
| `pty.js` Codex spawn / resume | ✅ 已支持 | 不动 |
| `pty.js` Codex session 探测 | ⚠️ 探测函数（`defaultCodexWatcherFactory` / `detectCodexSessionFromFs`）已实现但**未导出**；只有 `findClaudeSession` (line 238) 暴露 | 需新增 export `findCodexSession(nativeId)` 给 hook handler 用 |
| `transcript.js parseCodexJsonl` | ✅ 已支持 | 复用 |
| `usage-parser.js extractCodex` | ⚠️ 现有实现读 `response_item.message.assistant.token_usage`，但**实测 Codex 0.125 不写这个字段**；token 信息在 `event_msg/token_count.payload.info.total_token_usage` / `last_token_usage` | 需扩展 `extractCodex` 改扫 `event_msg/token_count` 记录；本稿 §7 把 `usage-parser.js` 列为必改 |
| `openclaw-bridge.js` 出站推送 | ✅ tool-agnostic（lark / telegram / weixin 三 channel） | 复用，不动 |
| `routes/openclaw-hook.js` 路由 | ⚠️ 现有 body 解构只取 `{event, sessionId, targetUserId, todoId, todoTitle, hookPayload}`，**不会转发新增的 `source` 字段** | 需扩展 router body 解构 + 透传 source 到 handler |
| `openclaw-hook.js handle()` | ⚠️ 当前签名硬接 Claude（`pty.findClaudeSession` / `readLatestAssistantTurnFresh` / `extractTurnUsage` 读 `raw.message.usage`） | 需在入口按 `source` 分支：claude 走原路径，codex 走新路径 |
| `lark-card.js buildPermissionCard` | ⚠️ header 文案 hard-code `'⚠️ Claude Code 等待授权'` (line 37) | 需把 header 文案参数化（call-site 已传，但要补 codex 调用方传 `'⚠️ Codex 等待授权'`） |
| `pricing.js` GPT 价表 | ⏳ 由 `2026-05-09-gpt-default-pricing-design.md` 提供 | 等其落地（见 §11 实施顺序） |

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
| Codex prompt 嗅探命中 | PTY stdout 匹配权限 prompt 正则（仅在非 danger-full-access 模式触发，见 §5.1） | ✅ 开 | `⚠️ [#tNN] 任务「X」AI 卡住等输入：<prompt 文本>` |
| Codex `turn_aborted` | jsonl 出现 `event_msg/turn_aborted`，**且** 同时出现的 `response_item/message` (role=user, 内含 `<turn_aborted>`) 已在 100ms 窗口内被去重 | ✅ 开 | `🛑 [#tNN] 任务「X」AI 这一轮被中断` |
| Codex `error` | jsonl 出现 `event_msg/error` | ✅ 开 | `❌ [#tNN] 任务「X」Codex 报错：<message>` |
| Codex SessionEnd | PTY 进程退出 + emitter 关 fs.watch | ✅ 开 | `✅ [#tNN] 任务「X」AI 跑完了` + 完整 transcript .md |

### 5.0 两条事件链路的反查方向（reviewer iter-2 #2 澄清）

两条链路看到的 sessionId 入口不同，反查方向也不同——本稿明确分开：

| 路径 | 起点见到的 ID | 是否需要反查 sidecar |
|---|---|---|
| (a) jsonl-tail 路径（emitter） | Codex `session_meta.payload.id`（nativeId） | **需要**：nativeId → quadtodo sessionId / todoId（先内存表，再 sidecar 文件，再 `aiTerminal.sessions.values()` 线性兜底） |
| (b) PTY stdout 嗅探路径（detector） | quadtodo sessionId（detector 是 PTY 的 listener，PTY 自己持有 quadtodo sessionId） | **不需要**：detector POST 时直接写 quadtodo sessionId，跟 Claude 那侧 ask_user 走的路一样 |

由此推论：
- detector POST body 直接给 `sessionId: <quadtodo sessionId>` + `nativeId: <可选>`，不依赖 sidecar
- 卡片 callback 走 `openclaw.findSessionByShortId(quadtodo sessionId.slice(-4))`，与 Claude 现有 wizard `openclaw-wizard.js:1776` 一致；不引入新的 nativeId 反查路径
- sidecar 反查只服务于 emitter (jsonl-tail) 这一条线

### 5.1 ask-user 卡片回写（修正版 —— 经实测核对）

**核心限制（实测）**：Codex 0.125 在 `--ask-for-approval=never`（即 `danger-full-access`，**默认模式**）下完全不会出权限 prompt——session_meta 头部即写明 "Approval policy is currently never"。
本稿的 ask-user 嗅探**仅在用户主动启用 `untrusted` / `on-failure` / `on-request` 模式时生效**。
在默认模式下，detector 启动但永不命中，不影响其他链路。

**键位（修正版）**：Codex TUI 在严格模式下用方向键 + Enter 选 yes/no，**不**接受 `y\n` / `n\n` 字面字符。统一沿用 Claude 现有 `openclaw-wizard.js:1787,1802` 的键位约定：
- 同意 → `pty.write('\r')`（Enter）
- 拒绝 → `pty.write('\x1b')`（Esc）

如果 Codex 后续把 yes 默认从首选项改成第二项（即按 Enter 等于"否"），lark/telegram callback 需根据 detector 抓到的 prompt 文本决定先发 `↓` 再发 `\r`。本稿先按"yes 是默认选中"实现，detector 测试同时覆盖光标位置探测。

**callback 路由**：
- 飞书：复用 `lark-card.buildPermissionCard`，**header 改用参数化**（避免硬写 "Claude Code 等待授权"），call-site 传 `'⚠️ Codex 等待授权'`；按钮 callback 走 `lark-bot.handleCardAction`
- Telegram：复用 `ask-user-buttons.js`，callback_data 标记 `codex:<sessionId>:y` / `:n`
- 回写：handler 拿到回调 → 经 nativeId↔quadtodo sessionId 反查（见 §9 sidecar 风险）→ `pty.write('\r' | '\x1b')`

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

**问题 1（旧）**：AI 输出的 markdown 里含 "approve? (y/n)"（比如解释别的命令）。

**对策 1**：嗅探只看**最近 N 行 stdout 流末尾**（不是滚动的整段输出），且要求该行**之后 1.5s 内没有更多 stdout**（PTY 在等 stdin → 真的卡住了）。

**问题 2（reviewer 新增）**：上面的 debounce 只能挡"AI 还在打字"，挡不住"AI 把 `(y/n)` 作为最终 assistant 内容输出后 PTY 进入 idle 等下一轮用户提问"——这条会被误判成权限请求。

**对策 2**：detector 触发候选命中后，先去 jsonl 里找最近一条 `response_item/message/assistant`，把它的 `content` 字符串与候选 tail 做后缀对比；若候选 tail **完全包含在最新 assistant content 里** → 取消推送（这是 AI 自己写的 prompt-like 文本，不是 Codex CLI 的实际权限请求）。
实现上 detector 持有 emitter 的引用，命中后调 `emitter.getLatestAssistantContent()` 即可（无需重读 jsonl）。

**问题 3（reviewer 新增）**：多个 todo 同日并行启动时，所有 PTY 都看到 `~/.codex/sessions/<yyyy>/<mm>/<dd>/`，emitter 必须按 nativeId 过滤，不能按 dir mtime。

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

## 7. 实现组件清单（已按 reviewer 反馈补全）

| 组件 | 类型 | 改动 |
|---|---|---|
| `src/codex-event-emitter.js` | 新文件 | jsonl tail（fs.watch + 增量解析）→ POST `/api/openclaw/hook` 含 `nativeId`；持有 native↔quadtodo 反查；暴露 `getLatestAssistantContent()` 给 detector 做误检兜底；emitter 启动时记录 jsonl 当前 EOF 作 watermark（重启场景见 §9） |
| `src/codex-prompt-detector.js` | 新文件 | PTY stdout 嗅探 → POST `/api/openclaw/hook`（event=Notification, source=codex）；**直接 POST quadtodo sessionId**（detector 持有 PTY 引用，不需 sidecar 反查）；命中后先调 emitter.getLatestAssistantContent 做"是否就是 AI 写的字"检查 |
| `src/codex-transcript.js` | **新文件（reviewer iter-2 #1）** | Codex 版的 turn / 全文 helper，签名平行 `claude-transcript.js`：`readLatestCodexTurn(filePath)`、`readLatestCodexTurnFresh(filePath)`（retry × 3 等 jsonl 写完 task_complete 之后的最新 assistant `response_item`）、`buildFullCodexTranscript(filePath)`（markdown 化）、`extractCodexTurnUsageFromLines(lines)`（从最后一条 `event_msg/token_count.payload.info.last_token_usage` 取本轮增量）。`openclaw-hook.js` codex 分支调这些，**不**直接调 `transcript.js loadTranscript`（后者返回 `{turns[]}`，shape 不同） |
| `src/pty.js` | 改 | (a) **新增 export `findCodexSession(nativeSessionId)` —— 返回 `{filePath, cwd, nativeId}`** 平行 `findClaudeSession` (line 238) 的返回 shape，cwd 从 jsonl 头部 `session_meta.payload.cwd` 读，区别于 `transcript.js findCodexFile` 只返回 `filePath`（reviewer iter-2 #3）；(b) Codex spawn 后启动 emitter + detector；(c) exit 时停掉它们；(d) 写 sidecar `~/.quadtodo/codex-sessions/<nativeId>.json`（含 quadtodo session/todoId / cwd）；(e) **同步更新内存反查表 `nativeIdToQuadtodoSession: Map<string, string>`**（处理 sidecar fsync 慢于 jsonl 写入的竞态） |
| `src/usage-parser.js` | **改（reviewer BLOCKER）** | `extractCodex` 重写：扫 `event_msg/token_count.payload.info.total_token_usage` 取 session 累计；扫 `event_msg/token_count.payload.info.last_token_usage` 取 turn 增量；同时保留对 `response_item.message.assistant.token_usage` 的兼容读取（万一未来 Codex 把字段加回来）。**fixture 也要换成真实 Codex 0.125 jsonl 样本**（不能再用造假 fixture） |
| `src/usage-footer.js` | 改 | `extractSessionUsageFromLines` 增加 `tool` 参数，按 tool 调 `extractClaude` / `extractCodex`；docstring 删掉"仅 Claude"那行 |
| `src/routes/openclaw-hook.js` | **改（reviewer MAJOR）** | router body 解构加上 `source`（默认 `'claude'` 兼容老链路），透传到 `hookHandler.handle({...})` |
| `src/openclaw-hook.js` | 改 | `handle()` 签名加 `source`；入口 `if (source === 'codex') return handleCodex(...)` 分流；codex 分支调 `pty.findCodexSession`、`codex-transcript.readLatestCodexTurnFresh`（**不**用 `loadTranscript`，shape 不同）、`extractCodexTurnUsageFromLines` 取本轮 token，`extractUsage('codex', lines)` 取 session 累计 |
| `src/openclaw-bridge.js` | 不动 | 已 tool-agnostic |
| `src/lark-card.js` | 改（小） | `buildPermissionCard` 把 hard-code 的 `'⚠️ Claude Code 等待授权'` (line 37) 提到参数 `headerTitle`，default 仍 Claude 文案；codex call-site 传 `'⚠️ Codex 等待授权'` |
| `src/ask-user-buttons.js` | 改（小） | callback_data 加 `source` 标记；回写键位**用 `\r` / `\x1b`**（不是 `y\n` / `n\n`，见 §5.1） |
| `src/openclaw-wizard.js` | 改（小） | 卡片回写流程中按 source 选择目标 PTY 写入 |
| `src/server.js` | 不动 | `/api/openclaw/hook` 路由复用 |
| `~/.quadtodo/codex-sessions/<nativeId>.json` | 新 sidecar 路径 | quadtodo session/todoId 与 codex nativeId 的映射；磁盘版（崩溃后恢复用） |
| `test/codex-event-emitter.test.js` | 新测试 | jsonl 增量解析 + event 派发（fixture: task_complete / turn_aborted / error / token_count） |
| `test/codex-prompt-detector.test.js` | 新测试 | 5 条命中 + 2 条反例 + debounce 行为 + "AI 自写 prompt-like 文本"反例 |
| `test/codex-usage-parser.test.js` | 新测试（替换造假 fixture） | 用真实 Codex 0.125 jsonl（`fixtures/codex-real-token-count.jsonl`）assert `extractCodex` 取到非 0 token |
| `test/openclaw-hook.codex.test.js` | 新测试 | source=codex 路径，footer 用 extractCodex，附件生成；source 缺省时仍走 Claude（回归保护） |
| `test/usage-footer.test.js` | 改 | 加 codex 用例（assertion: 调用 extractCodex 而非 extractClaude） |
| `test/lark-card.codex.test.js` | 新测试 | header 文案参数化；callback 路由到 PTY write `\r`/`\x1b` |
| `test/pty.findCodexSession.test.js` | 新测试 | 验证 export 已挂、返回 `{filePath, cwd, nativeId}`、多个并行 Codex session 时按 nativeId 各自找到正确 jsonl 且 cwd 从 session_meta 正确读出 |
| `test/codex-transcript.test.js` | 新测试 | `readLatestCodexTurnFresh` retry × 3 行为；`buildFullCodexTranscript` markdown 化；`extractCodexTurnUsageFromLines` 用真实 jsonl |

---

## 8. 节流 & 去重（沿用 Claude hook 规则）

复用 `openclaw-hook.js` 现有节流，**dedup key 不加 source 维度**（reviewer iter-2 #7 修正）：

```
dedup_key = `${sessionId}:${eventType}`
```

理由：PTY 与 sessionId 一对一，同一 sessionId 不会同时存在 Claude 与 Codex；source 仅在 telemetry / 日志里附加输出，不参与 dedup key 计算，避免歧义。

其它规则不变：
- ask_user pending 时 Stop 静默
- Notification 优先级最高，无视 cooldown
- SessionEnd 不节流
- 整体出站沿用 6/min 限流

---

## 9. 错误处理 / 风险（已按 reviewer 反馈扩展）

| 故障点 | 兜底 |
|---|---|
| Codex jsonl 还没 flush 就触发 task_complete | retry × 3，每次 200ms，仍读不到则用最近一条 assistant message（参考 Claude 侧 `readLatestAssistantTurnFresh`） |
| **sidecar fsync 慢于 jsonl 写入**（reviewer 风险 #2） | 用**内存表 + 文件双写**：`pty.spawn` 先写内存 `nativeIdToQuadtodoSession`（同步），再异步 fsync 到 sidecar；emitter 读时先查内存，缺失才退到 sidecar 文件；handler 第三层兜底走 `aiTerminal.sessions.values()` 线性反查（`session.nativeSessionId === incoming.nativeId`） |
| **多 PTY 并行同日 codex session**（reviewer 风险 #1） | emitter 按 nativeId 过滤事件，**不靠 dir mtime**；watcher 监听整个 day dir，每条事件先取 jsonl 文件名里的 nativeId regex (`rollout-.*-<uuid>.jsonl`) 与 own nativeId 比对，不匹配丢弃 |
| **`turn_aborted` 与 `<turn_aborted>` user message 重复**（reviewer 风险 #3，实测于 `~/.codex/sessions/2026/04/24/.../019dbf...jsonl:67`） | emitter 维护 100ms 时间窗 dedup：`event_msg/turn_aborted` 触发时记录 ts，紧接的 `response_item/message/user content[].text === '<turn_aborted>...'` 在窗口内丢弃 |
| **prompt-detector 命中 AI 自写的 `(y/n)` 字面**（reviewer 风险 #4） | 见 §6.2 对策 2：detector 命中后调 `emitter.getLatestAssistantContent()`，若候选 tail 是其后缀 → 取消推送 |
| stdout 嗅探正则误判（AI 打字中） | 命中后 debounce 1.5s 内若有新 stdout 行 → 取消推送 |
| Codex 升级改了 jsonl schema | emitter 用 `j?.payload?.type` 安全访问，未知 type 静默丢弃；vitest 跑 fixture 守住已知 schema |
| Codex 没写 task_complete 就 crash | PTY exit 事件兜底触发 SessionEnd 推送，附件用最后能拿到的 jsonl 内容 |
| **用户用 `--no-record` 或 config 关闭 session log** | emitter 启动 5s 内若 day dir 没出现匹配 nativeId 的 rollout-*.jsonl → 标记 sessionId 为 "no-jsonl" 模式，仅靠 PTY exit 推送 SessionEnd（无 turn-end / footer / 附件） |
| **danger-full-access 模式下 detector 永不命中** | 这是预期行为，不是 bug。call-site 不需要特判，detector 持续监听但默默不命中 |
| **quadtodo 重启 / 进程崩溃 mid-codex-session**（reviewer iter-2 #6） | 内存反查表 `nativeIdToQuadtodoSession` 丢失 → 启动时从 `~/.quadtodo/codex-sessions/*.json` 全量恢复；emitter 启动时跳到当前 jsonl EOF（不重放 downtime 内事件，避免补推过期消息）；该 nativeId 对应的 PTY 若 quadtodo 重启时已死 → emitter 检测到 PTY 不在内存 sessions → 静默退出（最终态 SessionEnd 已无人 fire，可接受） |
| **Codex schema 字段未来迁移**（reviewer iter-2 #4） | parser 测试**不**仅 assert "非 0"，而是用独立路径计算 ground truth：直接从 jsonl 行 grep 出所有 `event_msg/token_count` 行求和 `last_token_usage.total_tokens`，与 `extractCodex` 输出对账。字段被改名 / 移位时，独立 ground truth 也读不到 → 测试同时失败 → 显式报警；fixture 在每次 Codex 升版后通过 `npm run fixtures:refresh-codex` 脚本回放真实 session 重新捕获 |

---

## 10. 验收标准

### Codex 主流程（手测 + e2e）

- [ ] Web 选 codex 创建 todo → PTY 启动 Codex 0.125+ → `~/.codex/sessions/.../rollout-*.jsonl` 出现
- [ ] sidecar `~/.quadtodo/codex-sessions/<nativeId>.json` 生成，含 quadtodo session/todoId
- [ ] Codex 跑完一轮（jsonl 出现 `event_msg/task_complete`） → 飞书 thread 收到一条 markdown，footer 显示 `turn / session token / cost`（pricing 命中 `gpt-5*`），且 token 数**非 0**（防 `extractCodex` 字段读错的回归）
- [ ] Telegram topic 收到等价 V2 文本，footer 一致
- [ ] **严格审批模式下** (`codex --ask-for-approval=on-request` 或 `untrusted`) Codex 输出权限 prompt → 飞书 interactive card / Telegram inline keyboard 1.5s 内推到
- [ ] 飞书按 ✅ → 对应 PTY 收到 `\r`（Enter，用 `pty.write` mock 验证；**不是** `y\n`）
- [ ] Telegram 按 ❌ → 对应 PTY 收到 `\x1b`（Esc）
- [ ] **danger-full-access 默认模式**下跑同样路径 → detector 不命中、不推卡片（确认默认模式不会误推）
- [ ] Ctrl-C 中断（jsonl `event_msg/turn_aborted`）→ IM 收到 🛑 文案 1 条（不是 2 条 —— dedup 验证）
- [ ] PTY exit → IM 收到 ✅ 收尾 + 完整 transcript .md 附件
- [ ] 飞书 ask-user 卡片 header 文案是 `'⚠️ Codex 等待授权'` 而非 `'⚠️ Claude Code 等待授权'`

### Claude 零回归

- [ ] 现有 vitest 全绿（`test/openclaw-hook.test.js` 等）
- [ ] 手测：Claude todo 跑一轮，飞书 / Telegram 推送格式与改动前一致
- [ ] `routes/openclaw-hook.js` 收到无 `source` 字段的请求时仍按 `'claude'` 处理（向后兼容）

### 节流 / 错误兜底 / 风险覆盖

- [ ] ask_user pending 时 Codex Stop 被静默
- [ ] Codex prompt 嗅探：5 个 fixture 命中，2 个反例不命中
- [ ] **detector 命中"AI 自写 prompt-like 文本"反例** → 取消推送（emitter.getLatestAssistantContent 路径）
- [ ] sidecar 缺失时 handler 回退到内存反查表；内存反查也缺失时回退到 `aiTerminal.sessions.values()` 线性查找
- [ ] **多 PTY 并行同日 codex todo**（≥3 个）→ 每个推送只命中自己的 nativeId，无串档
- [ ] **`--no-record` / 关闭日志**模式：仅 PTY exit 触发一条 SessionEnd（无 footer / 附件），不抛错

---

## 11. 实施顺序（已按 reviewer 反馈调整）

reviewer 指出原顺序中 Phase B（turn-end 推送）会调到 footer 的 `extractCodex`，但原 Phase C 才修 `extractCodex` 字段读错问题——会导致中间版本飞书推到的 footer 显示 0 token、$0.000，被误以为"Codex 免费"。**调整为先修 parser，再上推送**：

0. **Phase 0 — 前置依赖**：等 `2026-05-09-gpt-default-pricing-design.md` 落地（pricing.js 含 GPT 价表）；本稿不重复定价工作
1. **Phase A — 基础设施**：sidecar 写 / 读（含内存反查表）+ `pty.findCodexSession` 导出 + emitter 框架（不接 IM，先打 console.log）
2. **Phase B — usage-parser 修正（前置 BLOCKER）**：重写 `extractCodex` 改读 `event_msg/token_count`，换真实 fixture，单测 assert 非 0；同步改 `usage-footer.js` `extractSessionUsageFromLines` 加 tool 参数
3. **Phase C — turn-end 链路**：emitter 解析 task_complete → POST 路由透传 source → handler 按 source=codex 取 codex transcript + extractCodex footer → bridge 推送（Claude 路径只读不改）
4. **Phase D — error / turn_aborted / SessionEnd 三件套**：含 dedup（turn_aborted vs `<turn_aborted>` user message）
5. **Phase E — ask-user 嗅探**：detector（含 §6.2 兜底）+ 卡片 header 参数化 + PTY 回写 `\r`/`\x1b`（飞书先，Telegram 跟上）
6. **Phase F — 测试 + Claude 回归**：vitest 全绿 + 手测两侧 IM + 多 PTY 并发 + danger-full-access 默认模式静默验证

每个 Phase 单独 PR，前一个不接死后一个，便于独立 revert。Phase B 在 Phase C 前合并，避免 reviewer 担心的"footer 显示 $0"中间态。
