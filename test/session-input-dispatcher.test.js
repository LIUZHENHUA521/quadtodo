import { describe, it, expect, vi } from 'vitest'
import { parseTrigger, createSessionInputDispatcher } from '../src/session-input-dispatcher.js'

function makeDeps({ awaitingReply = true, hasSession = true } = {}) {
  const writes = []
  const pty = {
    write: vi.fn((sid, data) => { writes.push({ sid, data }) }),
    has: vi.fn(() => hasSession),
  }
  const aiTerminal = {
    isSessionAwaitingReply: vi.fn(() => awaitingReply),
  }
  return { pty, aiTerminal, writes }
}

describe('parseTrigger', () => {
  it('普通文本 → queue_or_send', () => {
    expect(parseTrigger('hello')).toEqual({ mode: 'queue_or_send', stripped: 'hello' })
  })

  it('单 ! 前缀 → soft_interrupt，去掉 !', () => {
    expect(parseTrigger('!算了')).toEqual({ mode: 'soft_interrupt', stripped: '算了' })
  })

  it('双 !! 前缀 → hard_cancel', () => {
    expect(parseTrigger('!!stop')).toEqual({ mode: 'hard_cancel', stripped: '' })
  })

  it('精确 /stop → hard_cancel', () => {
    expect(parseTrigger('/stop')).toEqual({ mode: 'hard_cancel', stripped: '' })
  })

  it('/stop 带参数（/stop all）不算 hard_cancel，由 wizard 自己处理 admin 杀 session', () => {
    expect(parseTrigger('/stop all').mode).toBe('queue_or_send')
  })

  it('单 ! 但只有 ! 一个字符 → 视为空 soft_interrupt', () => {
    expect(parseTrigger('!')).toEqual({ mode: 'soft_interrupt', stripped: '' })
  })

  it('前后空白 trim', () => {
    expect(parseTrigger('  !  hi  ')).toEqual({ mode: 'soft_interrupt', stripped: 'hi' })
  })
})

describe('send: idle path', () => {
  it('idle + 普通文本 → 直接 pty.write + \\r', async () => {
    vi.useFakeTimers()
    const { pty, aiTerminal, writes } = makeDeps({ awaitingReply: true })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    const result = await d.send({ sessionId: 'sid1', text: 'hello' })
    await vi.advanceTimersByTimeAsync(100)
    expect(result).toMatchObject({ action: 'sent' })
    expect(writes).toEqual([
      { sid: 'sid1', data: 'hello' },
      { sid: 'sid1', data: '\r' },
    ])
    vi.useRealTimers()
  })

  it('idle + ! 前缀 → 等同普通投递（去掉 !）', async () => {
    vi.useFakeTimers()
    const { pty, aiTerminal, writes } = makeDeps({ awaitingReply: true })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    const result = await d.send({ sessionId: 'sid1', text: '!算了' })
    await vi.advanceTimersByTimeAsync(100)
    expect(result).toMatchObject({ action: 'sent' })
    expect(writes[0]).toEqual({ sid: 'sid1', data: '算了' })
    vi.useRealTimers()
  })

  it('idle + /stop → noop_idle，不写 PTY', async () => {
    const { pty, aiTerminal, writes } = makeDeps({ awaitingReply: true })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    const result = await d.send({ sessionId: 'sid1', text: '/stop' })
    expect(result).toMatchObject({ action: 'noop_idle' })
    expect(writes).toEqual([])
  })

  it('idle + 普通文本 + imagePaths → 拼 @path 前缀', async () => {
    vi.useFakeTimers()
    const { pty, aiTerminal, writes } = makeDeps({ awaitingReply: true })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    const result = await d.send({ sessionId: 'sid1', text: 'caption', imagePaths: ['/tmp/a.png', '/tmp/b.png'] })
    await vi.advanceTimersByTimeAsync(100)
    expect(result).toMatchObject({ action: 'sent' })
    expect(writes[0]).toEqual({ sid: 'sid1', data: '@/tmp/a.png @/tmp/b.png caption' })
    vi.useRealTimers()
  })

  it('PTY 不存在 → session_ended', async () => {
    const { pty, aiTerminal } = makeDeps({ hasSession: false })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    const result = await d.send({ sessionId: 'sid1', text: 'hello' })
    expect(result).toMatchObject({ action: 'session_ended' })
  })
})

describe('send: busy + queue', () => {
  it('busy + 普通文本 → 入队，触发 onQueueFirstEnqueue', async () => {
    const { pty, aiTerminal, writes } = makeDeps({ awaitingReply: false })
    const onFirst = vi.fn().mockResolvedValue({ messageId: 'first-echo' })
    const onMore = vi.fn().mockResolvedValue()
    const d = createSessionInputDispatcher({
      pty, aiTerminal,
      callbacks: { onQueueFirstEnqueue: onFirst, onQueueAdditionalEnqueue: onMore },
    })
    const result = await d.send({ sessionId: 'sid1', text: 'hello', channel: 'telegram' })
    expect(result).toMatchObject({ action: 'queued', queueSize: 1 })
    expect(writes).toEqual([])
    expect(onFirst).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sid1', channel: 'telegram', queueSize: 1 }))
    expect(onMore).not.toHaveBeenCalled()
  })

  it('busy + 连续 3 条 → 第 2/3 条触发 onQueueAdditionalEnqueue', async () => {
    const { pty, aiTerminal } = makeDeps({ awaitingReply: false })
    const onFirst = vi.fn().mockResolvedValue()
    const onMore = vi.fn().mockResolvedValue()
    const d = createSessionInputDispatcher({
      pty, aiTerminal,
      callbacks: { onQueueFirstEnqueue: onFirst, onQueueAdditionalEnqueue: onMore },
    })
    await d.send({ sessionId: 'sid1', text: 'a' })
    await d.send({ sessionId: 'sid1', text: 'b' })
    await d.send({ sessionId: 'sid1', text: 'c' })
    expect(onFirst).toHaveBeenCalledTimes(1)
    expect(onMore).toHaveBeenCalledTimes(2)
  })

  it('describe() 反映 per-sid 队列长度', async () => {
    const { pty, aiTerminal } = makeDeps({ awaitingReply: false })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    await d.send({ sessionId: 'sid1', text: 'a' })
    await d.send({ sessionId: 'sid1', text: 'b' })
    await d.send({ sessionId: 'sid2', text: 'x' })
    const desc = d.describe()
    expect(desc.sessions).toBe(2)
    expect(desc.byId.sid1.queueSize).toBe(2)
    expect(desc.byId.sid2.queueSize).toBe(1)
  })
})

describe('onSessionIdle: flush queue', () => {
  it('合并 3 条文本 → 单次 pty.write 用 \\n 拼', async () => {
    vi.useFakeTimers()
    const { pty, aiTerminal, writes } = makeDeps({ awaitingReply: false })
    const onFlush = vi.fn().mockResolvedValue()
    const d = createSessionInputDispatcher({
      pty, aiTerminal,
      callbacks: { onFlush },
    })
    await d.send({ sessionId: 'sid1', text: 'a' })
    await d.send({ sessionId: 'sid1', text: 'b' })
    await d.send({ sessionId: 'sid1', text: 'c' })
    await d.onSessionIdle('sid1')
    await vi.advanceTimersByTimeAsync(100)
    expect(writes).toEqual([
      { sid: 'sid1', data: 'a\nb\nc' },
      { sid: 'sid1', data: '\r' },
    ])
    expect(onFlush).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sid1', count: 3 }))
    expect(d.describe().byId.sid1).toBeUndefined()
    vi.useRealTimers()
  })

  it('imagePaths 跨条目合并到 payload 前面', async () => {
    vi.useFakeTimers()
    const { pty, aiTerminal, writes } = makeDeps({ awaitingReply: false })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    await d.send({ sessionId: 'sid1', text: 'first', imagePaths: ['/tmp/a.png'] })
    await d.send({ sessionId: 'sid1', text: 'second', imagePaths: ['/tmp/b.png'] })
    await d.onSessionIdle('sid1')
    await vi.advanceTimersByTimeAsync(100)
    expect(writes[0].data).toBe('@/tmp/a.png @/tmp/b.png first\nsecond')
    vi.useRealTimers()
  })

  it('空队列 onSessionIdle → noop，不写 PTY', async () => {
    const { pty, aiTerminal, writes } = makeDeps({ awaitingReply: false })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    await d.onSessionIdle('sid1')
    expect(writes).toEqual([])
  })
})

describe('send: busy + soft_interrupt', () => {
  it('busy + !xxx → 立刻发 Esc，250ms 后写 xxx + \\r，丢弃旧队列', async () => {
    vi.useFakeTimers()
    const { pty, aiTerminal, writes } = makeDeps({ awaitingReply: false })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    await d.send({ sessionId: 'sid1', text: 'old1' })
    await d.send({ sessionId: 'sid1', text: 'old2' })
    expect(d.describe().byId.sid1.queueSize).toBe(2)
    const promise = d.send({ sessionId: 'sid1', text: '!new' })
    expect(writes).toEqual([{ sid: 'sid1', data: '\x1b' }])
    expect(d.describe().sessions).toBe(0)
    await vi.advanceTimersByTimeAsync(260)
    await vi.advanceTimersByTimeAsync(100)
    const result = await promise
    expect(result).toMatchObject({ action: 'soft_interrupted' })
    expect(writes).toEqual([
      { sid: 'sid1', data: '\x1b' },
      { sid: 'sid1', data: 'new' },
      { sid: 'sid1', data: '\r' },
    ])
    vi.useRealTimers()
  })

  it('250ms 窗口内第 2 个 ! → 降级为入队', async () => {
    vi.useFakeTimers()
    const { pty, aiTerminal, writes } = makeDeps({ awaitingReply: false })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    d.send({ sessionId: 'sid1', text: '!first' }).catch(() => {})
    await vi.advanceTimersByTimeAsync(50)
    const r2 = await d.send({ sessionId: 'sid1', text: '!second' })
    expect(r2).toMatchObject({ action: 'queued' })
    expect(writes.filter((w) => w.data === '\x1b')).toHaveLength(1)
    vi.useRealTimers()
  })

  it('busy + ! 但 stripped 为空 → 仅 Esc，不投递文本', async () => {
    vi.useFakeTimers()
    const { pty, aiTerminal, writes } = makeDeps({ awaitingReply: false })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    const promise = d.send({ sessionId: 'sid1', text: '!' })
    await vi.advanceTimersByTimeAsync(400)
    const result = await promise
    expect(result).toMatchObject({ action: 'soft_interrupted' })
    expect(writes).toEqual([{ sid: 'sid1', data: '\x1b' }])
    vi.useRealTimers()
  })
})

describe('send: busy + hard_cancel', () => {
  it('busy + !! → Ctrl+C，丢弃队列，触发 onHardCancel', async () => {
    const { pty, aiTerminal, writes } = makeDeps({ awaitingReply: false })
    const onHardCancel = vi.fn().mockResolvedValue()
    const d = createSessionInputDispatcher({
      pty, aiTerminal,
      callbacks: { onHardCancel },
    })
    await d.send({ sessionId: 'sid1', text: 'queued1' })
    expect(d.describe().byId.sid1.queueSize).toBe(1)
    const result = await d.send({ sessionId: 'sid1', text: '!!stop now' })
    expect(result).toMatchObject({ action: 'hard_cancelled' })
    expect(writes).toEqual([{ sid: 'sid1', data: '\x03' }])
    expect(d.describe().sessions).toBe(0)
    expect(onHardCancel).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sid1' }))
  })

  it('busy + 精确 /stop → 同 !!', async () => {
    const { pty, aiTerminal, writes } = makeDeps({ awaitingReply: false })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    const result = await d.send({ sessionId: 'sid1', text: '/stop' })
    expect(result).toMatchObject({ action: 'hard_cancelled' })
    expect(writes).toEqual([{ sid: 'sid1', data: '\x03' }])
  })
})

describe('queue limits / lifecycle', () => {
  it('队列满 20 → 第 21 条返回 queue_full', async () => {
    const { pty, aiTerminal } = makeDeps({ awaitingReply: false })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    for (let i = 0; i < 20; i++) {
      const r = await d.send({ sessionId: 'sid1', text: `m${i}` })
      expect(r.action).toBe('queued')
    }
    const result = await d.send({ sessionId: 'sid1', text: 'overflow' })
    expect(result).toMatchObject({ action: 'queue_full', queueSize: 20 })
  })

  it('5 分钟未 flush → onStale 回调被调用，队列保留', async () => {
    vi.useFakeTimers()
    const { pty, aiTerminal } = makeDeps({ awaitingReply: false })
    const onStale = vi.fn().mockResolvedValue()
    const d = createSessionInputDispatcher({
      pty, aiTerminal,
      callbacks: { onStale },
    })
    await d.send({ sessionId: 'sid1', text: 'a' })
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100)
    expect(onStale).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sid1' }))
    expect(d.describe().byId.sid1?.queueSize).toBe(1)
    vi.useRealTimers()
  })

  it('onSessionEnd → 清队列，触发 onSessionEnd 回调暴露未投递消息', async () => {
    const { pty, aiTerminal } = makeDeps({ awaitingReply: false })
    const onEnd = vi.fn().mockResolvedValue()
    const d = createSessionInputDispatcher({
      pty, aiTerminal,
      callbacks: { onSessionEnd: onEnd },
    })
    await d.send({ sessionId: 'sid1', text: 'a' })
    await d.send({ sessionId: 'sid1', text: 'b' })
    await d.onSessionEnd('sid1')
    expect(onEnd).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sid1',
      undeliveredCount: 2,
      undeliveredTexts: ['a', 'b'],
    }))
    expect(d.describe().sessions).toBe(0)
  })
})
