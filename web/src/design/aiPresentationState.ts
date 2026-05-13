import type { AiStatus } from '../api'

export type AiPresentationState = 'running' | 'pending' | 'idle'

/**
 * 单一来源：把后端 AiStatus + unread + awaitingReply 推导成 3 态展示态。
 *
 * 规则：
 *   - status === 'running' 且 PTY 未收到 turn_done（awaitingReply=false）→ running
 *   - status === 'running' 但 stop hook 已 fire（awaitingReply=true）  →  unread 时 pending，否则 idle
 *   - 其它非 running 状态 + unread                                     →  pending
 *   - 其它一切                                                          →  idle
 *
 * awaitingReply 的存在是为了覆盖 claude/codex/cursor 都有的"PTY 还活着但一轮已结束"语义：
 * status 只在 PTY 退出时才离开 'running'，但 stop hook 在每轮结束就 fire，
 * markSessionAwaitingReply(true) 把 awaitingReply 翻 true；用户敲 Enter / Ctrl+C
 * 提交下一条时再翻回 false（见 src/routes/ai-terminal.js 的 isPendingClearingInput）。
 *
 * 注意：status === 'pending_confirm' 不再是 pending 的充分条件；
 * 用户看过后即归 idle，直到后端把 status 推回 running。
 */
export function deriveAiState(
  status: AiStatus | undefined | null,
  unread: boolean,
  awaitingReply: boolean = false,
): AiPresentationState {
  if (status === 'running' && !awaitingReply) return 'running'
  if (unread) return 'pending'
  return 'idle'
}

const CLOSED_AI_STATUSES: ReadonlySet<AiStatus> = new Set<AiStatus>(['done', 'failed', 'stopped'])

/**
 * PTY 已退出的终态。这类 session 后端会保留至多 30 分钟才清理（见
 * `src/routes/ai-terminal.js` 的 `cleanupTimer`），其间它们仍出现在
 * `/api/ai-terminal/sessions` 返回中。顶栏 idle pill 用本函数把它们排除掉——
 * 用户已经 kill 的 session 不应再显示为"空闲"。
 */
export function isClosedAiStatus(status: AiStatus | undefined | null): boolean {
  return !!status && CLOSED_AI_STATUSES.has(status)
}

/** 卡片内联展示用，带图形字符 */
export const AI_STATE_LABEL: Record<AiPresentationState, string> = {
  running: '● running',
  pending: '⚠ 待确认',
  idle:    '○ 空闲',
}

/** 顶栏 pill 用，纯文字 */
export const AI_STATE_PILL_LABEL: Record<AiPresentationState, string> = {
  running: 'running',
  pending: '待确认',
  idle:    'idle',
}
