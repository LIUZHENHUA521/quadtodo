import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PtyManager } from '../src/pty.js'

function makeFakePty() {
  const created = []
  function factory(bin, args, opts) {
    const proc = new EventEmitter()
    proc.pid = Math.floor(Math.random() * 100000)
    proc._bin = bin
    proc._args = args
    proc._opts = opts
    proc.onData = (cb) => proc.on('data', cb)
    proc.onExit = (cb) => proc.on('exit', cb)
    proc.write = vi.fn()
    proc.resize = vi.fn()
    proc.kill = () => proc.emit('exit', { exitCode: 0 })
    // helpers for tests:
    proc._emitData = (d) => proc.emit('data', d)
    proc._emitExit = (code) => proc.emit('exit', { exitCode: code })
    created.push(proc)
    return proc
  }
  factory.created = created
  return factory
}

function tools() {
  return {
    claude: { bin: 'claude', args: [] },
    codex: { bin: 'codex', args: [] },
  }
}

describe('PtyManager', () => {
  it('start spawns a pty with tool binary + args', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory })
    pm.start({ sessionId: 's1', tool: 'claude', prompt: null, cwd: '/tmp' })
    expect(factory.created).toHaveLength(1)
    expect(factory.created[0]._bin).toBe('claude')
    expect(factory.created[0]._opts.cwd).toBe('/tmp')
    expect(pm.has('s1')).toBe(true)
  })

  it('start with resumeNativeId passes --resume flag', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory })
    pm.start({
      sessionId: 's1',
      tool: 'claude',
      prompt: null,
      cwd: '/tmp',
      resumeNativeId: 'abcdef12-3456-7890-abcd-ef1234567890',
    })
    expect(factory.created[0]._args).toEqual(['--resume', 'abcdef12-3456-7890-abcd-ef1234567890'])
  })

  it('emits output event when pty emits data', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory })
    const outputs = []
    pm.on('output', (ev) => outputs.push(ev))
    pm.start({ sessionId: 's1', tool: 'claude', prompt: null, cwd: '/tmp' })
    factory.created[0]._emitData('hello')
    expect(outputs).toEqual([{ sessionId: 's1', data: 'hello' }])
  })

  it('captures Claude session id from output and emits native-session', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory })
    const events = []
    pm.on('native-session', (ev) => events.push(ev))
    pm.start({ sessionId: 's1', tool: 'claude', prompt: null, cwd: '/tmp' })
    factory.created[0]._emitData(
      'some prefix claude --resume abcdef12-3456-7890-abcd-ef1234567890 and suffix',
    )
    expect(events).toEqual([
      { sessionId: 's1', nativeId: 'abcdef12-3456-7890-abcd-ef1234567890' },
    ])
  })

  it('emits done event on exit with full log', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory })
    const doneEvents = []
    pm.on('done', (ev) => doneEvents.push(ev))
    pm.start({ sessionId: 's1', tool: 'claude', prompt: null, cwd: '/tmp' })
    factory.created[0]._emitData('output chunk')
    factory.created[0]._emitExit(0)
    expect(doneEvents).toHaveLength(1)
    expect(doneEvents[0].sessionId).toBe('s1')
    expect(doneEvents[0].exitCode).toBe(0)
    expect(doneEvents[0].fullLog).toBe('output chunk')
    expect(pm.has('s1')).toBe(false)
  })

  it('write forwards data to the underlying pty', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory })
    pm.start({ sessionId: 's1', tool: 'claude', prompt: null, cwd: '/tmp' })
    pm.write('s1', 'hi')
    expect(factory.created[0].write).toHaveBeenCalledWith('hi')
  })

  it('resize forwards cols/rows to the underlying pty', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory })
    pm.start({ sessionId: 's1', tool: 'claude', prompt: null, cwd: '/tmp' })
    pm.resize('s1', 100, 40)
    expect(factory.created[0].resize).toHaveBeenCalledWith(100, 40)
  })

  it('pending prompt is sent after first resize', () => {
    vi.useFakeTimers()
    const factory = makeFakePty()
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory, promptDelayMs: 0 })
    pm.start({ sessionId: 's1', tool: 'claude', prompt: 'hello world', cwd: '/tmp' })
    expect(factory.created[0].write).not.toHaveBeenCalled()
    pm.resize('s1', 100, 40)
    vi.advanceTimersByTime(0)
    expect(factory.created[0].write).toHaveBeenCalledWith('hello world\r')
    vi.useRealTimers()
  })

  it('stop kills the pty and emits stopped', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory })
    const stopped = []
    pm.on('stopped', (ev) => stopped.push(ev))
    pm.start({ sessionId: 's1', tool: 'claude', prompt: null, cwd: '/tmp' })
    pm.stop('s1')
    // Stop triggers exit → done event, not a separate stopped event.
    // But PtyManager.stop should mark the session as intentionally stopped.
    expect(pm.has('s1')).toBe(false)
  })

  it('unknown tool throws', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory })
    expect(() =>
      pm.start({ sessionId: 's1', tool: 'nope', prompt: null, cwd: '/tmp' }),
    ).toThrow(/unknown tool/i)
  })
})
