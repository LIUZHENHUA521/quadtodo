import { describe, expect, it } from 'vitest'
import { deriveAiState, AI_STATE_LABEL, AI_STATE_PILL_LABEL } from '../web/src/design/aiPresentationState.ts'

describe('deriveAiState', () => {
  it('returns running when status is running, regardless of unread', () => {
    expect(deriveAiState('running', false)).toBe('running')
    expect(deriveAiState('running', true)).toBe('running')
  })

  it('returns pending when not running but unread', () => {
    expect(deriveAiState('done', true)).toBe('pending')
    expect(deriveAiState('failed', true)).toBe('pending')
    expect(deriveAiState('stopped', true)).toBe('pending')
    expect(deriveAiState('pending_confirm', true)).toBe('pending')
    expect(deriveAiState(undefined, true)).toBe('pending')
    expect(deriveAiState(null, true)).toBe('pending')
  })

  it('returns idle when not running and not unread (including pending_confirm with no unread)', () => {
    expect(deriveAiState('done', false)).toBe('idle')
    expect(deriveAiState('failed', false)).toBe('idle')
    expect(deriveAiState('stopped', false)).toBe('idle')
    expect(deriveAiState('pending_confirm', false)).toBe('idle')
    expect(deriveAiState(undefined, false)).toBe('idle')
    expect(deriveAiState(null, false)).toBe('idle')
  })
})

describe('AI_STATE_LABEL / AI_STATE_PILL_LABEL', () => {
  it('inline label has icon prefix', () => {
    expect(AI_STATE_LABEL.running).toBe('● running')
    expect(AI_STATE_LABEL.pending).toBe('⚠ 待确认')
    expect(AI_STATE_LABEL.idle).toBe('○ 空闲')
  })

  it('pill label is plain text only', () => {
    expect(AI_STATE_PILL_LABEL.running).toBe('running')
    expect(AI_STATE_PILL_LABEL.pending).toBe('待确认')
    expect(AI_STATE_PILL_LABEL.idle).toBe('idle')
  })
})
