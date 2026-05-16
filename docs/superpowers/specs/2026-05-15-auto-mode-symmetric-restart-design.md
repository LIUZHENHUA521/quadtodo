# Auto-mode 切换对称重启（修复"切回默认不生效"）

## 背景

`SessionFocus` 顶栏（`web/src/components/SessionFocus/FocusSubbar.tsx`）的"托管模式"下拉支持
三档：`默认（需确认）` / `半托管（编辑自动通过）` / `完全托管（全自动）`。用户反馈：
**从"完全托管"切回"默认"后，UI Tag 文案变成"默认"，但 Claude CLI 仍然以 bypass 模式在跑，
切换没生效。**

`acceptEdits` 同理也会出现"看上去切了，实际没切"。Codex / Cursor 则连切到 bypass 都不会重启。

## 根因

`src/routes/ai-terminal.js` `handleSetAutoMode`（行 1129）的守卫条件：

```js
if (nextAutoMode !== 'bypass' || session.tool !== 'claude') return
```

只在"切到 bypass 且工具是 claude"时才走重启 PTY 的路径。其它方向（切回 default / acceptEdits，
或工具是 codex/cursor）只更新 `session.autoMode` 元数据并广播 `auto_mode` 事件，**没有重启
CLI 进程**——而 permission mode 是通过启动 CLI 时的命令行参数（如 `claude --permission-mode
bypassPermissions`、`codex --dangerously-bypass-approvals-and-sandbox`、`cursor --yolo`）注入的，
不重启进程就改不了。

`src/pty.js:20-42` 的 `buildPermissionArgs` 已经把三家 CLI 的三种 mode flag 全部映射好；
重启机制（`spawnSession` + `--resume + permissionMode` + `pty.stop` 旧 session）也已成熟。
**只是后端 `handleSetAutoMode` 的守卫做窄了，没把这套机制用上。**

## 方案

**对称重启**：只要前后 effective mode 不同（`'default' / 'acceptEdits' / 'bypass'`），就重启 PTY，
用新 mode 对应的 flag 启动新的 CLI 进程，老 PTY 用 `--resume <nativeSessionId>` 续接历史。
适用于 claude / codex / cursor 三家。

### 服务端改动（`src/routes/ai-terminal.js` `handleSetAutoMode`）

把守卫条件从

```js
if (nextAutoMode !== 'bypass' || session.tool !== 'claude') return
```

改为基于 mode 比较的对称分支：

1. `prevEffective = session.permissionMode || 'default'`
2. `nextEffective = nextAutoMode || 'default'`
3. 如果 `prevEffective === nextEffective` → 仅更新元数据 + 广播 `auto_mode`，直接 return（no-op）。
4. 否则进入重启路径：
   - 工具门禁：claude / codex / cursor 都走重启。其它（如 `'ai'` 兜底）跳过。
   - `nativeSessionId` 缺失 → 走现有的"软通知"路径，但把硬编码 `"全托管"` 字样改成中性
     表达："切换将仅对后续启动/恢复的会话生效。"
   - 广播 `auto_mode_switching` 时 `target` 用 `nextEffective`（而不是硬编码 `'bypass'`）。
   - `spawnSession` 的 `permissionMode` 字段传 `nextEffective`，让 `buildPermissionArgs`
     自然落到对的 flag 上：
     - claude: default → 无 flag；acceptEdits → `--permission-mode acceptEdits`；bypass → `--permission-mode bypassPermissions`
     - codex: default → 无 flag；acceptEdits → `--ask-for-approval on-request --sandbox workspace-write`；bypass → `--dangerously-bypass-approvals-and-sandbox`
     - cursor: default → 无 flag；acceptEdits → `--force`；bypass → `--yolo`
   - 失败回退路径（`restoreSessionAsCurrent` + `auto_mode_notice reason: 'restart_failed'`）
     的 message 也去掉"全托管"硬编码字样，改用 `nextEffective` 渲染。
   - 成功路径继续广播 `session_restarted`，并把 `autoMode: nextEffective` 透出。

### 前端改动（`web/src/AiTerminalMini.tsx`）

1. `case 'session_restarted'`：在现有的状态切换 / `message.info` 后，额外向 termRef 写一行
   红色提示：
   ```
   \r\n\x1b[31m=== 已重启进程以应用新模式：<modeLabel> ===\x1b[0m\r
   ```
   `<modeLabel>` 用 i18n key 派生（已有 `session:terminal.toolbar.autoMode.tagDefault` /
   `tagAcceptEdits` / `tagBypass`）。新增一个 i18n key
   `session:terminal.writeln.restartedForMode`（带 `{{label}}` 插值）。
2. `case 'auto_mode_switching'` 已经读取 `msg.target` 写入 optimistic Tag，无需改动。

### 不动的地方

- `FocusSubbar.tsx:198` 的 `key === 'default' ? null : key` 映射保留（决策 4b）：后端
  `msg.autoMode || null` 视 null 为 default，行为等价，省得连带改全链路的 `autoMode || 'default'`
  兜底点。
- `localStorage.removeItem('quadtodo.autoMode')` 对 `null` 的处理保留。

## 单元在哪里、互相怎么通

| 单元 | 职责 | 接口 | 依赖 |
|---|---|---|---|
| `handleSetAutoMode` (src/routes/ai-terminal.js) | 判断是否需要重启 PTY；编排"广播 → spawn → stop 旧"序列 | WS 入口 `{type:'set_auto_mode', autoMode}`；调用 `spawnSession` / `broadcastToSession` / `restoreSessionAsCurrent` | `sessions` Map、`pty.stop`、`db` |
| `buildPermissionArgs` (src/pty.js) | mode → CLI flag 映射 | `(tool, mode) → string[]` | 无外部状态，纯函数 |
| `spawnSession` (src/routes/ai-terminal.js) | 起新 PTY、注入 env、写 DB、注册 native map | `({todoId, tool, cwd, resumeNativeId, permissionMode, ignoreExistingNativeSessionId})` | `pty.spawn`、`db`、`mergeTodoAiSessions` |
| `AiTerminalMini` 的 message 分发 (web/src/AiTerminalMini.tsx) | 接 `auto_mode_switching` / `session_restarted` / `auto_mode_notice`，更新 Tag、切 sessionId、写终端横幅 | WS onmessage | `useAiSessionStore`、`termRef` |

`handleSetAutoMode` 是这次唯一需要重写守卫逻辑的单元；其它都已经是稳定接口，本次只复用。

## 数据流

```
用户切换下拉
  ├─ FocusSubbar.onClick → AutoModeController.setAutoMode(mode)
  │   └─ AiTerminalMini.handleSetAutoMode
  │       ├─ setAutoMode(mode) + localStorage
  │       └─ ws.send({type:'set_auto_mode', autoMode: mode})  // 前端不再早返回
  └─ 后端 handleSetAutoMode
      ├─ 比较 prev vs next
      ├─ 相同 → broadcast auto_mode（no-op 元数据回声）
      └─ 不同 ──┬─ nativeSessionId 缺失 → auto_mode_notice (软通知，下次启动生效)
                ├─ 工具不在 {claude,codex,cursor}（如兜底 'ai'） → 不重启，仅广播 auto_mode
                └─ 否则:
                    broadcast auto_mode_switching{target: next}
                    session.replacedBySessionId = '__pending__'
                    try spawnSession({permissionMode: next, resumeNativeId, ignoreExistingNativeSessionId: true})
                      ├─ 失败 → restoreSessionAsCurrent + auto_mode_notice{reason:'restart_failed'}
                      └─ 成功 → broadcast session_restarted{newSessionId, autoMode: next}
                                 pty.stop(oldSessionId)
                                 (前端) WS 重连到新 sessionId，term.writeln 红色"已重启进程以应用新模式：X"
```

## 错误处理

- **`prevEffective === nextEffective`**：不重启，避免空转一次 PTY。
- **没有 nativeSessionId（PTY 还没拿到 native id）**：走现有 `auto_mode_notice` 软通知路径；
  下次启动或 resume 时会用 DB 里持久化的 `permissionMode` 拿到正确 flag（`recoverPendingTodosOnStartup`
  在 `ai-terminal.js:1369` 已支持）。
- **`spawnSession` 抛错**：复用现有 `restoreSessionAsCurrent` 路径——清掉 `replacedBySessionId`
  标记，把 todo 状态回滚成老 session，推 `auto_mode_notice{reason:'restart_failed'}`。前端
  在 `case 'auto_mode_notice'` 已处理此 reason（恢复 Tag 到 prev、`message.error`），无需改动。
- **未支持的工具**（如 `tool === 'ai'`）：跳过重启，仅广播 `auto_mode`，不阻断。

## 测试

`test/ai-terminal.route.test.js` 新增 6 个回归用例，紧贴现有的
`set_auto_mode bypass restarts...` 风格：

1. **`bypass → default` 重启 claude**：起一条 bypass 的 claude，发 `set_auto_mode default`，断言
   `ctx.pty.created[1].permissionMode === 'default'`，旧 PTY 被 stop，广播 `session_restarted`
   带 `autoMode: 'default'`。
2. **`bypass → acceptEdits` 重启 claude**：同上，断言 `permissionMode === 'acceptEdits'`。
3. **`default → acceptEdits` 重启 claude**：覆盖"从默认升档"路径。
4. **codex bypass 重启**：`tool: 'codex'`，断言重启 + `permissionMode === 'bypass'`。
5. **cursor bypass 重启**：`tool: 'cursor'`，断言重启 + `permissionMode === 'bypass'`。
6. **no-op：default → default**：当前态已经是 default，发 `set_auto_mode default` 或 `null`
   → `ctx.pty.created` 仍只有 1 条，没有 `session_restarted` 事件，但有 `auto_mode` 元数据回声。

现有的 5 个 bypass 路径用例继续通过（断言不变）。

## 验收标准

1. 起一条 bypass 模式的 claude → UI Tag 显示"完全托管"，`ps` 看到子进程命令行含
   `--permission-mode bypassPermissions`。
2. 切回"默认"：
   - UI 出现"切换中" loading；
   - 后端 `pty.stop` 旧 session；
   - 新 PTY 命令行**不含** `--permission-mode` flag；
   - 终端中间出现红色 `=== 已重启进程以应用新模式：默认 ===` 横幅；
   - 之后让 claude 改一个文件，应当弹出权限确认 prompt（说明 bypass 真的解除了）。
3. `bypass → acceptEdits → default → bypass` 任意路径，每次切换后 `ps` 看到的子进程 flag
   与 UI Tag 严格一致。
4. codex / cursor 的 bypass 切换同样触发重启，flag 分别为
   `--dangerously-bypass-approvals-and-sandbox` 和 `--yolo`。
5. 当前态与目标态相同（如 default → default）时**不重启**，没有 `session_restarted` 事件。
6. `vitest` 全绿，新增 6 个回归用例通过。
7. 失败回退路径（mock spawnSession 抛错）触发 `auto_mode_notice reason: 'restart_failed'`，
   前端 Tag 回滚到 prev。

## 不在范围

- 不动 `FocusSubbar.tsx` 的 `null` 映射（决策 4b）。
- 不动 i18n 文案里现有的 `default/acceptEdits/bypass` 标签内容；仅新增一个 `writeln.restartedForMode`。
- 不修 `permissionMode` 在 todo 列表卡片 / 设置面板的其它显示链路。
- 不引入 confirm modal——按决策 2c 走静默重启 + 红字横幅。
