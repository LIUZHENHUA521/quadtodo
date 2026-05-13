# Claude Stop hook 误触发导致状态错乱修复

**Date**: 2026-05-13
**Owner**: lzh
**Status**: Approved (用户口头确认 A+B 一起做)

## Background

TodoCard 的 Claude Code 历史会话偶发"会话还在跑但徽标消失"的状态。用户的观察：

> "我发现了，应该是某个 hook 提前触发了结束，然后就 idle 了，过了一会，真的结束的时候，又变成待确认了"

排查链路：

- 后端：`openclaw-hook.js` 收到 Claude `Stop` 事件 → 立即调
  `aiTerminal.notifyTurnDone(sessionId)` + `markSessionAwaitingReply(sessionId, true)` +
  `dispatcher.onSessionIdle(sessionId)` → status 翻成 `idle`、`lastTurnDoneAt` 推进、
  `awaitingReply=true`。
- 前端：`deriveAiState('idle', unread, true)` → unread=true 时 "待确认"；unread=false 时 "idle"
  且 idle 不渲染徽标。
- 用户路径：Claude `Stop` hook 在 `stop_reason !== 'end_turn'` 的边界态（中间停顿、 sub-agent
  完成、自家 hook bug 等）也会 fire → 第一次 fire 时还在跑的 PTY 把 unread 标推进 → 用户瞄
  一眼焦点把 unread 清掉 → 徽标消失 → 真正结束时再 fire 一次 → 又跳成"待确认"。

JSONL 兜底 watcher 已经做了 `stop_reason === 'end_turn'` 这层校验，但 Stop hook 走的是
HTTP 路径，绕开了 watcher 的判断。

## Goal

让"Claude 是否真正结束本轮"的判定只信任**一份事实源**：JSONL 末行
`assistant.stop_reason === 'end_turn'`。Stop hook 收到事件时必须用这份事实源校验后再翻状态。

附带做一层 PTY 输出活性兜底，针对 JSONL 读不到 / 网络异常等极端边界。

## Non-goals

- 不动 `notify.js` hook 脚本本身。它已经安装在用户机器上，模板升级路径要慎重，留作后续。
- 不重构 `awaitingReply` 双维状态机。已知的 dispatcher 依赖不变。
- 不改 cursor / codex 的状态判定（cursor 已有 jsonl watcher，codex 无 hook）。

## Design

### B. Stop hook 加 JSONL 校验门（根因侧）

`src/openclaw-hook.js` 现有流程：

```text
handle(evt='stop', sessionId, hookPayload)
  ├─ ① hasPendingAskUser → return skipped
  ├─ ② notifyWebTurnDone(sessionId, todoTitle)   ← 立即翻 idle
  ├─ ③ 读 hookPayload.transcript_path → 读 JSONL → turnText / turnRaw / jsonlPath
  ├─ ④ 推 lark / telegram 消息
  └─ ⑤ markSessionAwaitingReply(true) + dispatcher.onSessionIdle()  ← 状态翻转
```

② 和 ⑤ 都在没看过 JSONL 的情况下就把状态翻成 idle。改：

```text
handle(evt='stop', sessionId, hookPayload)
  ├─ ① hasPendingAskUser → return skipped
  ├─ ② 读 JSONL → 取 turnRaw → stopReason = turnRaw.message.stop_reason
  ├─ ③ turnEndedNormally = (!nativeId || !jsonlPath) || stopReason === 'end_turn'
  │      ↑ 读不到 jsonl 时兜底为 true，不阻塞 dispatcher
  ├─ ④ if (turnEndedNormally) notifyWebTurnDone(sessionId, todoTitle)
  ├─ ⑤ 推 lark / telegram 消息（不受 turnEndedNormally 影响：内容相关的事件继续推）
  └─ ⑥ if (turnEndedNormally) markSessionAwaitingReply(true) + dispatcher.onSessionIdle()
       else logger.warn 记录被 defer 的 hook
```

具体动作：

- 在 `claude-transcript.js` 暴露 `readLatestAssistantStopReason(jsonlPath)`（也可以让上游直接
  读 `turnRaw.message.stop_reason`，但封装成函数便于测试）。
- 把 `notifyWebTurnDone` 调用点从原来的"③ 之前"挪到"③ 之后"。
- 在 `markSessionAwaitingReply(true)` / `dispatcher.onSessionIdle()` 三处加 `turnEndedNormally`
  门。
- 未能确认时 logger.warn，附 `stopReason` + `sessionId`，方便复盘。

**故障路径**：

- JSONL 没找到 → `turnEndedNormally=true` → 退回旧行为，不阻塞 IM 队列。
- JSONL 找到但 `stop_reason !== 'end_turn'` → defer。
  - 后续真 end_turn 时 Stop hook 再次 fire（Claude Code 自家保证）→ 此时 JSONL 末行 stop_reason
    已经是 `end_turn` → 正常翻状态。
  - 或者 PTY 直接退出（`/exit` / Ctrl+D）→ pty.js 'done' 走自己的清理路径，与 hook 无关。
- JSONL 找到但仍然 stale（`fresh === false`）→ 用 stale 的 stop_reason 判断；同时
  `readLatestAssistantTurnFresh` 已经 retry 1.25s。
  - 若 1.25s 后 stop_reason 仍非 `end_turn`，说明这次 Stop 极大概率是误触发，defer 正确。

### A. /sessions 加 effectiveStatus（防御侧）

`src/routes/ai-terminal.js` 的 `GET /sessions` 输出新增字段 `effectiveStatus`：

```text
effectiveStatus =
  if PTY exited                                         → session.status
  else if lastOutputAt > (lastTurnDoneAt || 0) + 500ms  → 'running'
  else                                                  → session.status
```

逻辑解释：PTY 还在喷输出，且最近一次输出晚于"上次声明结束"，说明那次"结束"是假的——把状态强制
回 running。500ms grace 用来吸收"end_turn 之后那几帧 TUI 重绘"。

前端 `web/src/components/TodoCard/TodoCard.tsx`：

```ts
// 老：liveSession?.status ?? session.status
// 新：liveSession?.effectiveStatus ?? liveSession?.status ?? session.status
const sessionState = deriveAiState(
  liveSession?.effectiveStatus ?? liveSession?.status ?? session.status,
  sessionUnread,
  liveSession?.awaitingReply ?? false,
)
```

`liveSessions` API 类型 `LiveSession` 同步加可选 `effectiveStatus`。

### 为什么 A+B 都做

- B 杀了根因（Stop hook 假阳性），未来不会再因 hook 错乱翻 idle。
- A 是定量的"PTY 在喷 → 一定是 running"兜底，覆盖 B 没盖到的边界（JSONL 文件被删 / 读 IO 异常 /
  其它工具链路也走错）。两层正交，互不影响。

## Files Touched

- `src/claude-transcript.js`：导出 `readLatestAssistantStopReason(jsonlPath)`。
- `src/openclaw-hook.js`：挪 `notifyWebTurnDone`，加 `turnEndedNormally` 门。
- `src/routes/ai-terminal.js`：`GET /sessions` 输出 `effectiveStatus`。
- `web/src/api.ts`：`LiveSession` 加可选 `effectiveStatus`。
- `web/src/components/TodoCard/TodoCard.tsx`：`deriveAiState` 入参优先用 `effectiveStatus`。
- `test/openclaw-hook.test.js`（或新建 `openclaw-hook.stop-gating.test.js`）：覆盖
  end_turn 通过、非 end_turn defer、jsonl 缺失兜底 3 个用例。
- `test/ai-terminal.effective-status.test.js`（新）：覆盖 effectiveStatus 三态。

## Verification

- **手动复测**：todo 启动 Claude → 完成一轮 → 立刻发第二条 prompt → 第二轮回复期间 TodoCard 看
  到 running 徽标，且**中途不出现 idle 闪烁**（之前会闪一下"待确认"再回 running）。
- **单测**：
  - `openclaw-hook.test.js` 覆盖 stopReason 校验门 3 个分支。
  - `ai-terminal.effective-status.test.js` 覆盖 effectiveStatus 决策。
- **回归**：`npm test` 全绿；老 ai-terminal / openclaw-hook 测试不动。
- **日志**：当 hook 被 defer 时，输出 `[openclaw-hook] Stop hook deferred: stopReason=... sid=...`。

## Risks

- **JSONL 还没 flush 时被误判 defer**：`readLatestAssistantTurnFresh` 已 retry 1.25s。如果仍
  stale，说明 Claude 极少见地 hook 早于 IO flush；后续 JSONL watcher 2s 周期会兜底——即便
  彻底丢这次 hook，最多延迟 2s 看到状态变化，UX 可接受。
- **dispatcher 死锁**：仅在 jsonl 一直读不到 end_turn 且 PTY 一直不退出时发生；此场景下原本
  Claude 也没真结束，dispatcher 维持 busy 是正确的。

## Out of scope (Future)

- `notify.js` 模板升级：让 hook 脚本本身先 peek transcript_path 再决定要不要 POST。
- 完全状态机重构：`status + awaitingReply` 合并到一个 `effectiveStatus` 单维。
