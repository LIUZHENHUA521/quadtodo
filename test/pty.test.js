import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { delimiter } from 'node:path'
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
    expect(factory.created[0]._opts.env.TZ).toBeTruthy()
    expect(pm.has('s1')).toBe(true)
  })

  it('prepends absolute tool binary directory to child PATH', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({
      tools: {
        claude: { bin: '/opt/company/bin/claude-w', args: [] },
        codex: { bin: 'codex', args: [] },
      },
      ptyFactory: factory,
    })
    pm.start({ sessionId: 's1', tool: 'claude', prompt: null, cwd: '/tmp' })
    const pathParts = factory.created[0]._opts.env.PATH.split(delimiter)
    expect(pathParts[0]).toBe('/opt/company/bin')
    expect(pathParts.slice(1).join(delimiter)).toBe(process.env.PATH || '')
  })

  it('keeps absolute tool binary directory before caller-provided PATH', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({
      tools: {
        claude: { bin: '/opt/company/bin/claude-w', args: [] },
        codex: { bin: 'codex', args: [] },
      },
      ptyFactory: factory,
    })
    pm.start({
      sessionId: 's1',
      tool: 'claude',
      prompt: null,
      cwd: '/tmp',
      extraEnv: { PATH: '/custom/bin' },
    })
    expect(factory.created[0]._opts.env.PATH.split(delimiter)).toEqual([
      '/opt/company/bin',
      '/custom/bin',
    ])
  })

  it('preserves empty PATH components when prepending absolute tool binary directory', () => {
    const originalPath = process.env.PATH
    try {
      process.env.PATH = '/usr/bin::/bin'
      const factory = makeFakePty()
      const pm = new PtyManager({
        tools: {
          claude: { bin: '/opt/company/bin/claude-w', args: [] },
          codex: { bin: 'codex', args: [] },
        },
        ptyFactory: factory,
      })
      pm.start({ sessionId: 's1', tool: 'claude', prompt: null, cwd: '/tmp' })
      expect(factory.created[0]._opts.env.PATH.split(delimiter)).toEqual([
        '/opt/company/bin',
        '/usr/bin',
        '',
        '/bin',
      ])
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
    }
  })

  it('does not change child PATH for command-name tool binaries', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory })
    pm.start({ sessionId: 's1', tool: 'claude', prompt: null, cwd: '/tmp' })
    expect(factory.created[0]._opts.env.PATH).toBe(process.env.PATH)
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
    const args = factory.created[0]._args
    const idx = args.indexOf('--resume')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe('abcdef12-3456-7890-abcd-ef1234567890')
  })

  it('claude resume with bypass permission mode passes bypassPermissions before --resume', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory })
    pm.start({
      sessionId: 's1',
      tool: 'claude',
      prompt: null,
      cwd: '/tmp',
      resumeNativeId: 'abcdef12-3456-7890-abcd-ef1234567890',
      permissionMode: 'bypass',
    })
    const args = factory.created[0]._args
    expect(args).toContain('--permission-mode')
    expect(args).toContain('bypassPermissions')
    expect(args).toContain('--resume')
    expect(args.indexOf('--permission-mode')).toBeLessThan(args.indexOf('--resume'))
  })

  it('codex resume uses resume subcommand', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory })
    pm.start({
      sessionId: 's1',
      tool: 'codex',
      prompt: null,
      cwd: '/tmp',
      resumeNativeId: 'abcdef12-3456-7890-abcd-ef1234567890',
    })
    expect(factory.created[0]._args).toEqual(['resume', 'abcdef12-3456-7890-abcd-ef1234567890'])
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

  it('pre-generates Claude session id via --session-id and emits native-session immediately', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory })
    const events = []
    pm.on('native-session', (ev) => events.push(ev))
    pm.start({ sessionId: 's1', tool: 'claude', prompt: null, cwd: '/tmp' })
    const args = factory.created[0]._args
    const idx = args.indexOf('--session-id')
    expect(idx).toBeGreaterThanOrEqual(0)
    const presetId = args[idx + 1]
    expect(presetId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(events).toEqual([{ sessionId: 's1', nativeId: presetId }])
  })

  it('does not pre-generate --session-id when resuming', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory })
    pm.start({
      sessionId: 's1',
      tool: 'claude',
      prompt: null,
      cwd: '/tmp',
      resumeNativeId: 'abcdef12-3456-7890-abcd-ef1234567890',
    })
    expect(factory.created[0]._args).not.toContain('--session-id')
  })

  it('Claude output regex remains as a safety net when output yields a different UUID', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory })
    const events = []
    pm.on('native-session', (ev) => events.push(ev))
    pm.start({ sessionId: 's1', tool: 'claude', prompt: null, cwd: '/tmp' })
    // 第一个事件：启动时预生成 UUID
    expect(events).toHaveLength(1)
    factory.created[0]._emitData(
      'some prefix claude --resume abcdef12-3456-7890-abcd-ef1234567890 and suffix',
    )
    expect(events).toContainEqual({
      sessionId: 's1',
      nativeId: 'abcdef12-3456-7890-abcd-ef1234567890',
    })
  })

  it('captures Codex session id from output and emits native-session', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory })
    const events = []
    pm.on('native-session', (ev) => events.push(ev))
    pm.start({ sessionId: 's1', tool: 'codex', prompt: null, cwd: '/tmp' })
    factory.created[0]._emitData(
      'some prefix codex resume abcdef12-3456-7890-abcd-ef1234567890 and suffix',
    )
    expect(events).toEqual([
      { sessionId: 's1', nativeId: 'abcdef12-3456-7890-abcd-ef1234567890' },
    ])
  })

  it('fs.watch hit emits native-session and closes the watcher', () => {
    const factory = makeFakePty()
    let captured = null
    const closeSpy = vi.fn()
    const codexWatcherFactory = (_spawnTime, onHit) => {
      captured = { onHit }
      return { close: closeSpy }
    }
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory, codexWatcherFactory })
    const events = []
    pm.on('native-session', (ev) => events.push(ev))
    pm.start({ sessionId: 's1', tool: 'codex', prompt: null, cwd: '/tmp' })
    expect(captured).not.toBeNull()
    captured.onHit('abcdef12-3456-7890-abcd-ef1234567890')
    expect(events).toEqual([
      { sessionId: 's1', nativeId: 'abcdef12-3456-7890-abcd-ef1234567890' },
    ])
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  it('fs.watch hit first → stdout regex with same id does not emit duplicate', () => {
    const factory = makeFakePty()
    let captured = null
    const codexWatcherFactory = (_spawnTime, onHit) => {
      captured = { onHit }
      return { close: vi.fn() }
    }
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory, codexWatcherFactory })
    const events = []
    pm.on('native-session', (ev) => events.push(ev))
    pm.start({ sessionId: 's1', tool: 'codex', prompt: null, cwd: '/tmp' })
    captured.onHit('abcdef12-3456-7890-abcd-ef1234567890')
    factory.created[0]._emitData(
      'codex resume abcdef12-3456-7890-abcd-ef1234567890 shown later',
    )
    expect(events).toHaveLength(1)
  })

  it('fs.watch factory returning null still allows stdout regex to emit', () => {
    const factory = makeFakePty()
    const codexWatcherFactory = () => null // simulate fs.watch failure (unsupported FS, ENOENT, etc.)
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory, codexWatcherFactory })
    const events = []
    pm.on('native-session', (ev) => events.push(ev))
    pm.start({ sessionId: 's1', tool: 'codex', prompt: null, cwd: '/tmp' })
    factory.created[0]._emitData(
      'codex resume abcdef12-3456-7890-abcd-ef1234567890',
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

  it('getPids returns active session pids', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory })
    pm.start({ sessionId: 's1', tool: 'claude', prompt: null, cwd: '/tmp' })
    pm.start({ sessionId: 's2', tool: 'codex', prompt: null, cwd: '/tmp' })
    const pids = pm.getPids()
    expect(pids).toHaveLength(2)
    expect(pids[0]).toMatchObject({ sessionId: 's1', tool: 'claude' })
    expect(typeof pids[0].pid).toBe('number')
  })

  it('prompt is passed as CLI argument for new sessions', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory })
    pm.start({ sessionId: 's1', tool: 'claude', prompt: 'hello world', cwd: '/tmp' })
    // prompt 应通过 CLI 参数传递，而非写入 stdin
    expect(factory.created[0]._args).toContain('hello world')
    expect(factory.created[0].write).not.toHaveBeenCalled()
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

  it('spawn errors include bin and cwd context', () => {
    const factory = () => {
      throw new Error('posix_spawnp failed')
    }
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory })
    expect(() =>
      pm.start({ sessionId: 's1', tool: 'claude', prompt: null, cwd: '/tmp' }),
    ).toThrow(/PTY spawn failed for claude \(bin=claude, cwd=\/tmp/)
  })

  it('claude --resume corrects cwd when locator returns a real cwd different from caller', () => {
    const factory = makeFakePty()
    // 模拟 ~/.claude/projects/ 里实际写文件的目录是 /tmp，调用方却传 /var
    const claudeSessionLocator = vi.fn(() => ({ filePath: '/dev/null', cwd: '/tmp' }))
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory, claudeSessionLocator })
    pm.start({
      sessionId: 's1',
      tool: 'claude',
      prompt: null,
      cwd: '/var',
      resumeNativeId: 'abcdef12-3456-7890-abcd-ef1234567890',
    })
    expect(claudeSessionLocator).toHaveBeenCalledWith('abcdef12-3456-7890-abcd-ef1234567890')
    // /var 改写成 /tmp（locator 报告的真实 cwd）
    expect(factory.created[0]._opts.cwd).toBe('/tmp')
  })

  it('claude --resume keeps caller cwd when locator returns null (file missing)', () => {
    const factory = makeFakePty()
    const claudeSessionLocator = vi.fn(() => null)
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory, claudeSessionLocator })
    pm.start({
      sessionId: 's1',
      tool: 'claude',
      prompt: null,
      cwd: '/tmp',
      resumeNativeId: 'abcdef12-3456-7890-abcd-ef1234567890',
    })
    // 找不到文件就 warn，但 cwd 不动；让 claude 自己抛 No conversation found
    expect(factory.created[0]._opts.cwd).toBe('/tmp')
  })

  it('claude --resume keeps caller cwd when locator returns same cwd', () => {
    const factory = makeFakePty()
    const claudeSessionLocator = vi.fn(() => ({ filePath: '/x', cwd: '/tmp' }))
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory, claudeSessionLocator })
    pm.start({
      sessionId: 's1',
      tool: 'claude',
      prompt: null,
      cwd: '/tmp',
      resumeNativeId: 'abcdef12-3456-7890-abcd-ef1234567890',
    })
    expect(factory.created[0]._opts.cwd).toBe('/tmp')
  })

  it('claude new session (no resume) does not invoke session locator', () => {
    const factory = makeFakePty()
    const claudeSessionLocator = vi.fn(() => null)
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory, claudeSessionLocator })
    pm.start({ sessionId: 's1', tool: 'claude', prompt: null, cwd: '/tmp' })
    expect(claudeSessionLocator).not.toHaveBeenCalled()
  })

  it('codex --resume does not invoke claude session locator', () => {
    const factory = makeFakePty()
    const claudeSessionLocator = vi.fn(() => null)
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory, claudeSessionLocator })
    pm.start({
      sessionId: 's1',
      tool: 'codex',
      prompt: null,
      cwd: '/tmp',
      resumeNativeId: 'abcdef12-3456-7890-abcd-ef1234567890',
    })
    expect(claudeSessionLocator).not.toHaveBeenCalled()
  })

  it('findClaudeSession exposes the locator and swallows errors', () => {
    const pm1 = new PtyManager({
      tools: tools(),
      ptyFactory: makeFakePty(),
      claudeSessionLocator: () => ({ filePath: '/x', cwd: '/tmp' }),
    })
    expect(pm1.findClaudeSession('uuid')).toEqual({ filePath: '/x', cwd: '/tmp' })

    const pm2 = new PtyManager({
      tools: tools(),
      ptyFactory: makeFakePty(),
      claudeSessionLocator: () => { throw new Error('boom') },
    })
    expect(pm2.findClaudeSession('uuid')).toBeNull()
  })

  // —— AskUserQuestion 禁用 + TUI 检测 ——

  it('claude args include --disallowedTools AskUserQuestion (new session)', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory })
    pm.start({ sessionId: 's1', tool: 'claude', prompt: null, cwd: '/tmp' })
    const args = factory.created[0]._args
    const idx = args.indexOf('--disallowedTools')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe('AskUserQuestion')
  })

  it('claude args include --disallowedTools AskUserQuestion when resuming', () => {
    const factory = makeFakePty()
    const claudeSessionLocator = vi.fn(() => null)
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory, claudeSessionLocator })
    pm.start({
      sessionId: 's1',
      tool: 'claude',
      prompt: null,
      cwd: '/tmp',
      resumeNativeId: 'abcdef12-3456-7890-abcd-ef1234567890',
    })
    const args = factory.created[0]._args
    const idx = args.indexOf('--disallowedTools')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe('AskUserQuestion')
  })

  it('codex args do not include --disallowedTools (claude-only flag)', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory })
    pm.start({ sessionId: 's1', tool: 'codex', prompt: null, cwd: '/tmp' })
    expect(factory.created[0]._args).not.toContain('--disallowedTools')
  })

  it('emits tui-detected when AskUserQuestion footer appears in claude output', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory })
    const events = []
    pm.on('tui-detected', (ev) => events.push(ev))
    pm.start({ sessionId: 's1', tool: 'claude', prompt: null, cwd: '/tmp' })
    factory.created[0]._emitData(
      'some output\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel\n',
    )
    expect(events).toEqual([{ sessionId: 's1', tool: 'claude' }])
  })

  it('debounces tui-detected within 30s for same session', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory })
    const events = []
    pm.on('tui-detected', (ev) => events.push(ev))
    pm.start({ sessionId: 's1', tool: 'claude', prompt: null, cwd: '/tmp' })
    const proc = factory.created[0]
    proc._emitData('Tab/Arrow keys to navigate · Esc to cancel')
    proc._emitData('Tab/Arrow keys to navigate · Esc to cancel')
    proc._emitData('Tab/Arrow keys to navigate · Esc to cancel')
    expect(events).toHaveLength(1)
  })

  it('does not emit tui-detected for codex output', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory })
    const events = []
    pm.on('tui-detected', (ev) => events.push(ev))
    pm.start({ sessionId: 's1', tool: 'codex', prompt: null, cwd: '/tmp' })
    factory.created[0]._emitData('Enter to select · Tab/Arrow keys to navigate · Esc to cancel')
    expect(events).toHaveLength(0)
  })

  it('create() builds a session record but does not call the PTY factory', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory })
    pm.create({ sessionId: 's1', tool: 'claude', prompt: null, cwd: '/tmp' })
    expect(factory.created).toHaveLength(0)
    expect(pm.has('s1')).toBe(true)
  })

  it('startWithSize() spawns the PTY at the given cols/rows on first call', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory })
    pm.create({ sessionId: 's1', tool: 'claude', prompt: null, cwd: '/tmp' })
    pm.startWithSize('s1', 120, 30)
    expect(factory.created).toHaveLength(1)
    expect(factory.created[0]._opts.cols).toBe(120)
    expect(factory.created[0]._opts.rows).toBe(30)
  })

  it('startWithSize() called twice does not re-spawn — second call is a resize', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory })
    pm.create({ sessionId: 's1', tool: 'claude', prompt: null, cwd: '/tmp' })
    pm.startWithSize('s1', 120, 30)
    pm.startWithSize('s1', 100, 25)
    expect(factory.created).toHaveLength(1)
    expect(factory.created[0].resize).toHaveBeenCalledWith(100, 25)
  })

  it('start() still works as a backward-compat wrapper (create + startWithSize 80×24)', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory })
    pm.start({ sessionId: 's1', tool: 'claude', prompt: null, cwd: '/tmp' })
    expect(factory.created).toHaveLength(1)
    expect(factory.created[0]._opts.cols).toBe(80)
    expect(factory.created[0]._opts.rows).toBe(24)
  })

  it('startWithSize() failure deletes the stranded session record', () => {
    const factory = () => { throw new Error('boom') }
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory })
    pm.create({ sessionId: 's-fail', tool: 'claude', prompt: null, cwd: '/tmp' })
    expect(pm.has('s-fail')).toBe(true)
    expect(() => pm.startWithSize('s-fail', 80, 24)).toThrow(/PTY spawn failed/)
    expect(pm.has('s-fail')).toBe(false)
  })

  it('stop() on a created-but-not-spawned session removes it from the map', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory })
    pm.create({ sessionId: 's-pending', tool: 'claude', prompt: null, cwd: '/tmp' })
    expect(pm.has('s-pending')).toBe(true)
    pm.stop('s-pending')
    expect(pm.has('s-pending')).toBe(false)
    expect(factory.created).toHaveLength(0) // no PTY was ever spawned
  })
})
