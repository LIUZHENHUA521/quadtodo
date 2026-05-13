import { createElement, type ReactNode } from 'react'
import { Zap, Pause, MessageCircleWarning } from 'lucide-react'
import type { AiStatus } from '../api'

export type AiPresentationState = 'running' | 'pending' | 'idle'

/**
 * 单一来源：把后端 AiStatus + unread + awaitingReply 推导成 3 态展示态。
 *
 * 规则：
 *   - status === 'running'                                      → running
 *   - status === 'idle'                                         → unread 时 pending，否则 idle
 *   - 其它非 running 状态 + unread                                     →  pending
 *   - 其它一切                                                          →  idle
 *
 * 后端现在把"PTY 还活着但一轮已结束"建模为真实 status === 'idle'。
 * awaitingReply 只作为旧接口/dispatcher 的兼容信号保留：若后端仍短暂返回
 * running+awaitingReply=true，前端按 idle 处理。
 *
 * 注意：status === 'pending_confirm' 不再是 pending 的充分条件；
 * 用户看过后即归 idle，直到后端把 status 推回 running。
 */
export function deriveAiState(
  status: AiStatus | undefined | null,
  unread: boolean,
  awaitingReply: boolean = false,
): AiPresentationState {
  if (status === 'idle') return unread ? 'pending' : 'idle'
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

/** 卡片内联展示用，纯文字 */
export const AI_STATE_LABEL: Record<AiPresentationState, string> = {
  running: 'running',
  pending: '待确认',
  idle:    '空闲',
}

/** 卡片内联展示用图标，与顶栏 StatPill 一致 */
export const AI_STATE_ICON: Record<AiPresentationState, () => ReactNode> = {
  running: () => createElement(Zap, { size: 11 }),
  pending: () => createElement(MessageCircleWarning, { size: 11 }),
  idle:    () => createElement(Pause, { size: 11 }),
}

/** 顶栏 pill 用，纯文字 */
export const AI_STATE_PILL_LABEL: Record<AiPresentationState, string> = {
  running: 'running',
  pending: '待确认',
  idle:    'idle',
}
