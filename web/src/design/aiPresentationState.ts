import { createElement, type ReactNode } from 'react'
import { Zap, Pause, MessageCircleWarning } from 'lucide-react'
import type { AiStatus } from '../api'

export type AiPresentationState = 'running' | 'pending' | 'idle'

/**
 * 单一来源：把后端 AiStatus + unread + awaitingReply 推导成 3 态展示态。
 *
 * 规则：
 *   1. status === 'pending_confirm'         → pending（agent 工具请求授权，阻塞型动作项，
 *                                              即使用户已读也不归 idle，要等真正按下 y/n 让
 *                                              后端把 status 翻回 running）
 *   2. status ∈ {done,failed,stopped}       → idle（PTY 已死的会话不再算"待确认"。
 *                                              即使本地 lastSeen 落后于 lastTurnDoneAt，也
 *                                              不能让全局顶栏「待确认」pill / 板内 pending
 *                                              筛选把进程已结束的会话当成阻塞型动作项——
 *                                              它在 FocusSubbar / TodoCard / TranscriptView
 *                                              都靠 isClosedAiStatus 单独走"进程已结束"分支。
 *                                              "请验收"是工作流概念，由 todo.status='ai_done'
 *                                              单独控制，跟这里的 pending 不复用同一计数。)
 *   3. status === 'running' 且 !awaitingReply → running
 *   4. unread === true                      → pending（AI 完成一轮回复但用户没看过）
 *   5. 其它 → idle
 *
 * 后端 status === 'pending_confirm' 现在只由 hook 信号（Claude Notification +
 * permissionish / codex-prompt-detector）触发，不再走 PTY 输出正则——避免 AI 回复
 * 文本里出现 "Do you want to..." 这类关键词导致的误判。
 */
export function deriveAiState(
  status: AiStatus | undefined | null,
  unread: boolean,
  awaitingReply: boolean = false,
): AiPresentationState {
  if (status === 'pending_confirm') return 'pending'
  if (isClosedAiStatus(status)) return 'idle'
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

/**
 * 卡片内联展示用 label 的 i18n key（在组件里用 t(...) 翻译）。
 * 之前是直写中文字符串，i18n 迁移后改成键，让消费者翻译。
 */
export const AI_STATE_LABEL_KEY: Record<AiPresentationState, 'session:aiState.label.running' | 'session:aiState.label.pending' | 'session:aiState.label.idle'> = {
  running: 'session:aiState.label.running',
  pending: 'session:aiState.label.pending',
  idle:    'session:aiState.label.idle',
}

/** 卡片内联展示用图标，与顶栏 StatPill 一致 */
export const AI_STATE_ICON: Record<AiPresentationState, () => ReactNode> = {
  running: () => createElement(Zap, { size: 11 }),
  pending: () => createElement(MessageCircleWarning, { size: 11 }),
  idle:    () => createElement(Pause, { size: 11 }),
}

/** 顶栏 pill 用 label 的 i18n key */
export const AI_STATE_PILL_LABEL_KEY: Record<AiPresentationState, 'session:aiState.pill.running' | 'session:aiState.pill.pending' | 'session:aiState.pill.idle'> = {
  running: 'session:aiState.pill.running',
  pending: 'session:aiState.pill.pending',
  idle:    'session:aiState.pill.idle',
}
