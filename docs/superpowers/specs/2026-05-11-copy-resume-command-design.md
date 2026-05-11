# 复制恢复命令按钮 — 设计

**日期**：2026-05-11
**入口**：「历史会话找回」抽屉（`web/src/transcripts/TranscriptSearchDrawer.tsx`）
**一句话**：在每条 transcript 结果卡片上加一个"复制恢复命令"按钮，点一下把可直接粘贴执行的 `cd <cwd> && <tool-bin> --resume <id>` 写入系统剪贴板。

## 背景与动机

「历史会话找回」抽屉目前每条结果只能：预览、绑定到 todo、解绑。要把会话续上，用户得自己看着 `cwd` 切目录、再凭记忆敲 `claude --resume <uuid>`。命令本身就五个 token，没人想手敲；尤其 claude 的 `--resume` 必须与原 `cwd` 一致，否则在错误的 `~/.claude/projects/<encoded>/` 目录里找不到 jsonl，必失败。

已有的"打开本地终端"按钮（`TodoManage` 里）通过 osascript 解决了这件事，但它：a) 只在 macOS 可用；b) 是 todo 维度的，不在「历史会话找回」流程里；c) 强耦合飞书 / Telegram 回推 hook env。

这次只补一个一键复制，让用户在任意终端（包括非 mac、iTerm2、tmux、SSH 远端）都能自己粘上去续。

## 非目标

- 不替换 / 不修改现有"打开本地终端"按钮。
- 不带飞书 / Telegram 回推的 hook env（保持纯本地恢复语义，复制内容短而透明）。
- 不读运行时 `tools[tool].bin` 配置（前端短期内拿不到，bin 名按惯例硬编码）。
- 不显式适配 PowerShell / cmd —— 项目本就以 macOS+POSIX shell 为主。

## 方案概述

采用纯前端方案：单文件改动 + 一个纯函数 + 单测，无后端 API、无新数据结构。

## 变更点

### 1. `web/src/transcripts/resumeCommand.ts`（新增）

纯函数模块，签名：

```ts
export type ResumeTool = 'claude' | 'codex' | 'cursor'

export function buildResumeCommand(input: {
  tool: ResumeTool
  native_id: string
  cwd: string | null
}): { command: string; warnings: string[] }
```

- 工具到 bin 的硬编码映射：
  - `claude` → `claude`
  - `codex` → `codex`
  - `cursor` → `cursor-agent`
- 子命令形式：
  - `codex` → `resume <id>`
  - `claude` / `cursor` → `--resume <id>`
- POSIX 单引号转义 `posixEscape(s)`：`'` → `'\''`，整段外裹单引号。空串 → `''`。
- `cwd` 非空：`cd <esc-cwd> && <bin> <subcmd>`
- `cwd` 为空：`<bin> <subcmd>` + `warnings.push('cwd_missing')`
- `tool` 不在白名单：抛错（调用方应已先用 `canCopy` 防住）。

### 2. `web/src/transcripts/resumeCommand.test.ts`（新增）

vitest 用例覆盖五个分支：

1. claude + 正常 cwd → `cd '/Users/x/proj' && claude --resume <uuid>`，无 warnings。
2. claude + `cwd=null` → `claude --resume <uuid>`，`warnings=['cwd_missing']`。
3. codex + cwd → `cd '/x' && codex resume <uuid>`。
4. cursor + cwd → `cd '/x' && cursor-agent --resume <uuid>`。
5. cwd 含单引号 `/Users/O'Reilly/x` → 转义为 `cd '/Users/O'\''Reilly/x' && ...`，命令在 bash/zsh 下可直接执行。

### 3. `web/src/transcripts/TranscriptSearchDrawer.tsx`（改）

- import 新增 `CopyOutlined` 和 `buildResumeCommand`。
- 在按钮行（当前 `<Space size={4} style={{ marginTop: 8 }}>` 内）追加：
  ```tsx
  <Tooltip title={canCopy(f) ? undefined : copyDisabledReason(f)}>
    <Button
      size="small"
      icon={<CopyOutlined />}
      disabled={!canCopy(f)}
      onClick={() => handleCopyResume(f)}
    >
      复制恢复命令
    </Button>
  </Tooltip>
  ```
- 辅助：
  - `canCopy(f)`: `!!f.native_id && ['claude','codex','cursor'].includes(f.tool)`。
  - `copyDisabledReason(f)`: 缺 native_id → `'该记录无 native session id'`；工具未知 → `'暂不支持该工具'`。
  - `handleCopyResume(f)`：
    1. `const { command, warnings } = buildResumeCommand({tool, native_id, cwd})`
    2. `await navigator.clipboard.writeText(command)`
    3. 成功：`message.success('已复制：' + truncate(command, 80))`；若 `warnings` 含 `cwd_missing`，再 `message.warning('未识别 cwd，请先 cd 到原工作目录')`。
    4. 失败（剪贴板 API 不可用 / 权限拒绝）：`message.error('复制失败，请手动复制')`。手动 fallback Modal 留 TODO，本次不做。

## 数据流

```
[用户点击按钮]
   ↓
handleCopyResume(f: TranscriptFile)
   ↓
buildResumeCommand({tool, native_id, cwd})  ← 纯函数
   ↓ { command, warnings }
navigator.clipboard.writeText(command)
   ↓
message.success / warning / error
```

无网络调用，无服务端改动。

## 错误处理

| 场景 | 行为 |
|---|---|
| 缺 `native_id` | 按钮 disabled + Tooltip 提示 |
| 工具不在白名单 | 按钮 disabled + Tooltip 提示 |
| `cwd` 为空 | 命令仍生成（仅 `<bin> --resume <id>`），toast 追加 warning |
| 剪贴板写入失败 | toast `复制失败，请手动复制`（手动 fallback 留 TODO） |

## 验收标准

- AC-1：每条 transcript 结果卡片均出现"复制恢复命令"按钮，位置在 `预览 / 改挂 / 解绑` 同一行最右。
- AC-2：点击按钮后命令被写入剪贴板，并出现成功 toast（命令截断 80 字符显示）。
- AC-3：当 `tool ∈ {claude, codex, cursor}` 且 `native_id` 非空时按钮可点；否则 disabled + Tooltip 提示原因。
- AC-4：`cwd` 为空时命令降级为不带 `cd`，并 toast 追加 `未识别 cwd，请先 cd 到原工作目录`。
- AC-5：命令字符串经 POSIX 单引号转义，对含空格、单引号的路径在 bash/zsh 下可直接执行。
- AC-6：抽屉原有功能（搜索、扫描、绑定、解绑、预览）行为不变，无新 console error / React warning。
- AC-7：`pnpm test`（或 `vitest run`）通过新增 5 个用例。

## 与现有 `buildNativeResumeCommand`（server）的关系

不复用。原因：
- 服务端版本依赖运行时 `tools[tool].bin` 配置（来自 `runtimeConfig`），前端拿不到。
- 服务端版本只支持 `claude / codex`（line 321 显式 throw `invalid_tool`），不支持 cursor。
- 服务端版本不带 `cd`（cwd 在 osascript 那层补）。

两份拼装短期内并存，被单测兜住。**Follow-up**：未来如果新增工具，需要同步两边；或者再做一个"前端读运行时 bin 配置 + 服务端给统一 builder"的改造（YAGNI，本次不做）。

## Follow-ups（不在本次范围内）

- 剪贴板写入失败时的 Modal 手动复制 fallback。
- 可选项："带 cwd / 不带 cwd"、"带 IM 回推 env / 不带"的小弹层（方案 C）。
- 前端读运行时 `tools[tool].bin` 配置，统一前后端命令拼装。
