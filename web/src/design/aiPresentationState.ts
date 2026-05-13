import type { AiStatus } from '../api'

export type AiPresentationState = 'running' | 'pending' | 'idle'

/**
 * 单一来源：把后端 AiStatus + 前端 unread 推导成 3 态展示态。
 *
 * 规则：
 *   - status === 'running'  →  running（claude 正在执行）
 *   - 否则 unread === true  →  pending（claude 回复了，用户没看）
 *   - 其它一切             →  idle
 *
 * 注意：status === 'pending_confirm' 不再是 pending 的充分条件；
 * 用户看过后即归 idle，直到后端把 status 推回 running。
 */
export function deriveAiState(
  status: AiStatus | undefined | null,
  unread: boolean,
): AiPresentationState {
  if (status === 'running') return 'running'
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
