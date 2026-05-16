import { describe, expect, it } from 'vitest'
import {
  deriveAiState,
  isClosedAiStatus,
  AI_STATE_LABEL_KEY,
  AI_STATE_PILL_LABEL_KEY,
} from '../web/src/design/aiPresentationState.ts'

describe('deriveAiState', () => {
  it('returns running when status is running, regardless of unread', () => {
    expect(deriveAiState('running', false)).toBe('running')
    expect(deriveAiState('running', true)).toBe('running')
  })

  it('returns pending when alive but unread (idle / pending_confirm / unknown)', () => {
    expect(deriveAiState('idle', true)).toBe('pending')
    expect(deriveAiState('pending_confirm', true)).toBe('pending')
    expect(deriveAiState(undefined, true)).toBe('pending')
    expect(deriveAiState(null, true)).toBe('pending')
  })

  it('returns idle for closed PTY states regardless of unread', () => {
    // PTY 已死的会话（done/failed/stopped）即便本地 lastSeen 落后于 lastTurnDoneAt，也
    // 不能让顶栏「待确认」pill 把它当成阻塞型动作项——进程已结束就该归 idle 让
    // FocusSubbar / TodoCard 走"进程已结束"分支。
    expect(deriveAiState('done', true)).toBe('idle')
    expect(deriveAiState('failed', true)).toBe('idle')
    expect(deriveAiState('stopped', true)).toBe('idle')
    expect(deriveAiState('done', false)).toBe('idle')
    expect(deriveAiState('failed', false)).toBe('idle')
    expect(deriveAiState('stopped', false)).toBe('idle')
  })

  it('returns idle when backend status is real idle and not unread', () => {
    expect(deriveAiState('idle', false)).toBe('idle')
  })

  it('returns idle when status missing and not unread', () => {
    expect(deriveAiState(undefined, false)).toBe('idle')
    expect(deriveAiState(null, false)).toBe('idle')
  })

  it('pending_confirm 恒为 pending（独立于 unread）—— agent 请求授权是阻塞动作项', () => {
    expect(deriveAiState('pending_confirm', false)).toBe('pending')
    expect(deriveAiState('pending_confirm', true)).toBe('pending')
    expect(deriveAiState('pending_confirm', false, false)).toBe('pending')
    expect(deriveAiState('pending_confirm', false, true)).toBe('pending')
  })

  it('treats running+awaitingReply as not-running (PTY alive but stop hook fired)', () => {
    // cursor/claude/codex 共同语义：PTY 还活着但一轮已结束，等用户下一条输入
    expect(deriveAiState('running', false, true)).toBe('idle')
    expect(deriveAiState('running', true, true)).toBe('pending')
    // 默认 awaitingReply=false 保留原 running 语义
    expect(deriveAiState('running', false, false)).toBe('running')
    expect(deriveAiState('running', false)).toBe('running')
  })
})

describe('isClosedAiStatus', () => {
  it('returns true for terminal PTY states', () => {
    expect(isClosedAiStatus('done')).toBe(true)
    expect(isClosedAiStatus('failed')).toBe(true)
    expect(isClosedAiStatus('stopped')).toBe(true)
  })

  it('returns false for live states and missing status', () => {
    expect(isClosedAiStatus('running')).toBe(false)
    expect(isClosedAiStatus('idle')).toBe(false)
    expect(isClosedAiStatus('pending_confirm')).toBe(false)
    expect(isClosedAiStatus(undefined)).toBe(false)
    expect(isClosedAiStatus(null)).toBe(false)
  })
})

describe('AI_STATE_LABEL_KEY / AI_STATE_PILL_LABEL_KEY', () => {
  it('inline label maps each state to a session namespace i18n key', () => {
    expect(AI_STATE_LABEL_KEY.running).toBe('session:aiState.label.running')
    expect(AI_STATE_LABEL_KEY.pending).toBe('session:aiState.label.pending')
    expect(AI_STATE_LABEL_KEY.idle).toBe('session:aiState.label.idle')
  })

  it('pill label maps each state to a session namespace i18n key', () => {
    expect(AI_STATE_PILL_LABEL_KEY.running).toBe('session:aiState.pill.running')
    expect(AI_STATE_PILL_LABEL_KEY.pending).toBe('session:aiState.pill.pending')
    expect(AI_STATE_PILL_LABEL_KEY.idle).toBe('session:aiState.pill.idle')
  })
})
