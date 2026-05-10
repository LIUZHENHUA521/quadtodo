import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PtyManager } from '../src/pty.js'

describe('PtyManager codex spawn', () => {
  it('writes sidecar + memory map after detecting Codex nativeId', async () => {
    const fakeSidecar = { write: vi.fn(async () => {}), clear: vi.fn() }
    const fakePty = { write: vi.fn(), onData: () => {}, onExit: () => {}, kill: () => {} }
    const ptyFactory = vi.fn(() => fakePty)
    const codexWatcherFactory = (_t, hit) => { setTimeout(() => hit('native-uuid-1'), 10); return { close() {} } }
    const mgr = new PtyManager({
      tools: { codex: { bin: '/usr/bin/codex', args: [] } },
      ptyFactory,
      codexWatcherFactory,
      sidecar: fakeSidecar,
    })
    const sess = await mgr.spawn({ tool: 'codex', sessionId: 'qs1', cwd: '/proj', todoId: 't1' })
    await new Promise(r => setTimeout(r, 30))
    expect(fakeSidecar.write).toHaveBeenCalledWith({
      nativeId: 'native-uuid-1', quadtodoSessionId: 'qs1', todoId: 't1', cwd: '/proj',
    })
    sess.kill()
    expect(fakeSidecar.clear).toHaveBeenCalledWith('native-uuid-1')
  })

  it('emits codex-prompt when injected prompt detector fires onMatch', async () => {
    const fakeSidecar = { write: vi.fn(async () => {}), clear: vi.fn() }
    const fakePty = { write: vi.fn(), onData: () => {}, onExit: () => {}, kill: () => {} }
    const ptyFactory = vi.fn(() => fakePty)
    const codexWatcherFactory = (_t, hit) => { setTimeout(() => hit('native-uuid-3'), 10); return { close() {} } }
    let capturedOnMatch = null
    const codexPromptDetectorFactory = vi.fn(({ onMatch }) => {
      capturedOnMatch = onMatch
      return { start: vi.fn(), stop: vi.fn() }
    })
    const mgr = new PtyManager({
      tools: { codex: { bin: '/usr/bin/codex', args: [] } },
      ptyFactory,
      codexWatcherFactory,
      sidecar: fakeSidecar,
      codexPromptDetectorFactory,
    })
    const events = []
    mgr.on('codex-prompt', (e) => events.push(e))
    await mgr.spawn({ tool: 'codex', sessionId: 'qs3', cwd: '/proj', todoId: 't3' })
    await new Promise(r => setTimeout(r, 30))
    expect(codexPromptDetectorFactory).toHaveBeenCalled()
    expect(typeof capturedOnMatch).toBe('function')
    capturedOnMatch({ promptText: 'Approve? (y/n)', matchedPattern: 're' })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      sessionId: 'qs3',
      nativeId: 'native-uuid-3',
      promptText: 'Approve? (y/n)',
      matchedPattern: 're',
    })
  })

  it('emits synthetic SessionEnd via emitter on PTY exit before clearing sidecar', async () => {
    const fakeSidecar = { write: vi.fn(async () => {}), clear: vi.fn() }
    const fakeEmitter = { start: vi.fn(), stop: vi.fn(), emitSynthetic: vi.fn() }
    const eventEmitterFactory = vi.fn(() => fakeEmitter)
    let exitCb = null
    const fakePty = {
      write: vi.fn(),
      onData: () => {},
      onExit: (cb) => { exitCb = cb },
      kill: () => {},
    }
    const ptyFactory = vi.fn(() => fakePty)
    const codexWatcherFactory = (_t, hit) => { setTimeout(() => hit('native-uuid-2'), 10); return { close() {} } }
    const mgr = new PtyManager({
      tools: { codex: { bin: '/usr/bin/codex', args: [] } },
      ptyFactory,
      codexWatcherFactory,
      sidecar: fakeSidecar,
      eventEmitterFactory,
      codexSessionLocator: (id) => ({ filePath: `/tmp/fake-${id}.jsonl`, cwd: '/proj2', nativeId: id }),
    })
    await mgr.spawn({ tool: 'codex', sessionId: 'qs2', cwd: '/proj2', todoId: 't2' })
    // Wait for native id detection + emitter start
    await new Promise(r => setTimeout(r, 30))
    expect(fakeEmitter.start).toHaveBeenCalled()

    // Simulate PTY process exiting cleanly
    expect(typeof exitCb).toBe('function')
    exitCb({ exitCode: 0 })

    // emitSynthetic must run BEFORE stop() so the SessionEnd event reaches the IM bridge
    expect(fakeEmitter.emitSynthetic).toHaveBeenCalledWith(expect.objectContaining({
      event: 'SessionEnd',
      nativeId: 'native-uuid-2',
    }))
    const synthOrder = fakeEmitter.emitSynthetic.mock.invocationCallOrder[0]
    const stopOrder = fakeEmitter.stop.mock.invocationCallOrder[0]
    expect(synthOrder).toBeLessThan(stopOrder)

    // sidecar still cleared after exit
    expect(fakeSidecar.clear).toHaveBeenCalledWith('native-uuid-2')
  })
})
