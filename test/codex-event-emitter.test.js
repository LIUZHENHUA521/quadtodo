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
    await new Promise(r => setTimeout(r, 100))
    em.stop()
    expect(events.find(e => e.event === 'Stop')).toBeTruthy()
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
    await new Promise(r => setTimeout(r, 200))
    em.stop()
    const aborted = events.filter(e => e.event === 'TurnAborted')
    expect(aborted.length).toBe(1)
  })

  it('detects event_msg/error and emits Error event with message', async () => {
    const events = []
    const em = createCodexEventEmitter({
      filePath: file, nativeId: 'abc',
      onEvent: (e) => events.push(e),
    })
    em.start()
    appendLine({ timestamp: 't', type: 'event_msg', payload: { type: 'error', message: 'boom' } })
    await new Promise(r => setTimeout(r, 100))
    em.stop()
    const err = events.find(e => e.event === 'Error')
    expect(err?.rawEventPayload?.message).toBe('boom')
  })

  it('getLatestAssistantContent returns latest response_item assistant text', async () => {
    const em = createCodexEventEmitter({ filePath: file, nativeId: 'abc', onEvent: () => {} })
    em.start()
    appendLine({ timestamp: 't', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello world' }] } })
    await new Promise(r => setTimeout(r, 100))
    expect(em.getLatestAssistantContent()).toContain('hello world')
    em.stop()
  })

  it('ignores events not for own nativeId when watching shared dir', async () => {
    // emitter only reads its own filePath, so foreign rollouts in same dir don't matter — verified by construction
    const events = []
    const otherFile = join(dir, 'rollout-other.jsonl')
    writeFileSync(otherFile, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n')
    const em = createCodexEventEmitter({ filePath: file, nativeId: 'abc', onEvent: (e) => events.push(e) })
    em.start()
    await new Promise(r => setTimeout(r, 200))
    em.stop()
    expect(events.length).toBe(0)
  })
})
