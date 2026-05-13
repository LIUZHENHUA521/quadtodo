import { describe, it, expect } from 'vitest'
import { computeEffectiveStatus } from '../src/routes/ai-terminal.js'

// effectiveStatus 兜底：当 PTY 还在喷输出（lastOutputAt > lastTurnDoneAt + 500ms）但 hook/watcher
// 已经把 status 翻成 idle 时，前端徽标会消失。这层兜底把 status 强制回 'running'，让
// TodoCard、TopbarDispatch、FocusSubbar 都能看见会话还在跑。

describe('computeEffectiveStatus', () => {
  const now = 1_000_000

  it('LIVE 且 lastOutputAt 晚于 lastTurnDoneAt+500ms → running', () => {
    const session = { status: 'idle', lastOutputAt: now - 100, lastTurnDoneAt: now - 5000 }
    expect(computeEffectiveStatus(session, now)).toBe('running')
  })

  it('LIVE 且 lastOutputAt 在 grace 之内（<= +500ms）→ 保持原 status', () => {
    const session = { status: 'idle', lastOutputAt: now - 5000 + 400, lastTurnDoneAt: now - 5000 }
    expect(computeEffectiveStatus(session, now)).toBe('idle')
  })

  it('LIVE 且没有 lastOutputAt → 保持原 status', () => {
    const session = { status: 'idle', lastOutputAt: null, lastTurnDoneAt: now - 5000 }
    expect(computeEffectiveStatus(session, now)).toBe('idle')
  })

  it('PTY 已退出（status=done/failed/stopped）→ 不兜底，原样返回', () => {
    expect(computeEffectiveStatus({ status: 'done', lastOutputAt: now, lastTurnDoneAt: 0 }, now)).toBe('done')
    expect(computeEffectiveStatus({ status: 'failed', lastOutputAt: now, lastTurnDoneAt: 0 }, now)).toBe('failed')
    expect(computeEffectiveStatus({ status: 'stopped', lastOutputAt: now, lastTurnDoneAt: 0 }, now)).toBe('stopped')
  })

  it('status=running 且 lastOutputAt 晚于 turn done → 仍然 running（一致）', () => {
    const session = { status: 'running', lastOutputAt: now, lastTurnDoneAt: 0 }
    expect(computeEffectiveStatus(session, now)).toBe('running')
  })

  it('status=pending_confirm 且 PTY 还在喷 → running（盖掉 stale pending）', () => {
    const session = { status: 'pending_confirm', lastOutputAt: now - 100, lastTurnDoneAt: now - 5000 }
    expect(computeEffectiveStatus(session, now)).toBe('running')
  })

  it('lastTurnDoneAt 未设置时（首轮还没结束过）→ lastOutputAt 任意值都视为 running', () => {
    const session = { status: 'idle', lastOutputAt: now, lastTurnDoneAt: 0 }
    expect(computeEffectiveStatus(session, now)).toBe('running')
  })

  it('null / 非法 session → null', () => {
    expect(computeEffectiveStatus(null, now)).toBeNull()
    expect(computeEffectiveStatus(undefined, now)).toBeNull()
  })
})
