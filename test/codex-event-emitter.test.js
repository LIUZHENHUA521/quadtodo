import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCodexEventEmitter } from '../src/codex-event-emitter.js'

let dir, file

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-emit-'))
  file = join(dir, 'rollout-test.jsonl')
  writeFileSync(file, '')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function appendLine(obj) {
  appendFileSync(file, JSON.stringify(obj) + '\n')
}

// vitest fork pool 大并发跑全套时，emitter 内部用的 fs.watchFile 共享中央 poll
// 线程会被挤压；硬等待 100/300ms 并不可靠。这里用 vi.waitFor 主动轮询断言，
// 既给单跑保留快速通道，又能在 batch 下兜住 1s 的 OS 延迟。
const WAIT_OPTS = { timeout: 3000, interval: 30 }

describe('codex-event-emitter', () => {
  it('detects task_complete and emits Stop event', async () => {
    const events = []
    const em = createCodexEventEmitter({
      filePath: file,
      nativeId: 'abc',
      onEvent: (evt) => events.push(evt),
    })
    em.start()
    appendLine({ timestamp: 't', type: 'event_msg', payload: { type: 'task_started' } })
    appendLine({ timestamp: 't', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'T1' } })
    await vi.waitFor(() => expect(events.find(e => e.event === 'Stop')).toBeTruthy(), WAIT_OPTS)
    em.stop()
  })

  it('detects turn_aborted and dedups within 100ms against <turn_aborted> user message', async () => {
    const events = []
    const em = createCodexEventEmitter({
      filePath: file, nativeId: 'abc',
      onEvent: (e) => events.push(e),
    })
    em.start()
    appendLine({ timestamp: 't', type: 'event_msg', payload: { type: 'turn_aborted' } })
    appendLine({ timestamp: 't', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<turn_aborted>...' }] } })
    // 等到 TurnAborted 出现，且至少一次额外 poll 之后再判 length
    // （否则可能在 dedup 同伴消息到达前就采样）
    await vi.waitFor(() => expect(events.some(e => e.event === 'TurnAborted')).toBe(true), WAIT_OPTS)
    await new Promise(r => setTimeout(r, 80))
    em.stop()
    expect(events.filter(e => e.event === 'TurnAborted').length).toBe(1)
  })

  it('detects event_msg/error and emits Error event with message', async () => {
    const events = []
    const em = createCodexEventEmitter({
      filePath: file, nativeId: 'abc',
      onEvent: (e) => events.push(e),
    })
    em.start()
    appendLine({ timestamp: 't', type: 'event_msg', payload: { type: 'error', message: 'boom' } })
    await vi.waitFor(() => {
      const err = events.find(e => e.event === 'Error')
      expect(err?.rawEventPayload?.message).toBe('boom')
    }, WAIT_OPTS)
    em.stop()
  })

  it('getLatestAssistantContent returns latest response_item assistant text', async () => {
    const em = createCodexEventEmitter({ filePath: file, nativeId: 'abc', onEvent: () => {} })
    em.start()
    appendLine({ timestamp: 't', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello world' }] } })
    await vi.waitFor(() => expect(em.getLatestAssistantContent()).toContain('hello world'), WAIT_OPTS)
    em.stop()
  })

  it('ignores events not for own nativeId when watching shared dir', async () => {
    // emitter only reads its own filePath, so foreign rollouts in same dir don't matter — verified by construction
    const events = []
    const otherFile = join(dir, 'rollout-other.jsonl')
    writeFileSync(otherFile, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n')
    const em = createCodexEventEmitter({ filePath: file, nativeId: 'abc', onEvent: (e) => events.push(e) })
    em.start()
    // 这条没有正向触发条件，只能等一段固定时间确认没有错触发
    await new Promise(r => setTimeout(r, 300))
    em.stop()
    expect(events.length).toBe(0)
  })

  it('within 100ms window, only one TurnAborted is emitted', async () => {
    const events = []
    const em = createCodexEventEmitter({ filePath: file, nativeId: 'abc', onEvent: (e) => events.push(e) })
    em.start()
    appendLine({ type: 'event_msg', payload: { type: 'turn_aborted' } })
    await vi.waitFor(() => expect(events.some(e => e.event === 'TurnAborted')).toBe(true), WAIT_OPTS)
    appendLine({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: '<turn_aborted>...' }] } })
    await new Promise(r => setTimeout(r, 200))
    em.stop()
    expect(events.filter(e => e.event === 'TurnAborted').length).toBe(1)
  })
})
