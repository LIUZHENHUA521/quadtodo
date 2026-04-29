import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createOpenClawBridge } from '../src/openclaw-bridge.js'

function makeFakeProc({ exitCode = 0, stdout = '', stderr = '', errorAfterMs = null } = {}) {
  const proc = new EventEmitter()
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = vi.fn()
  setImmediate(() => {
    if (errorAfterMs != null) {
      setTimeout(() => proc.emit('error', new Error('boom')), errorAfterMs)
      return
    }
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout))
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr))
    setImmediate(() => proc.emit('close', exitCode))
  })
  return proc
}

function makeBridge({ openclaw, spawnImpl }) {
  return createOpenClawBridge({
    getConfig: () => ({ openclaw }),
    spawnFn: spawnImpl,
    logger: { warn() {}, info() {} },
  })
}

describe('openclaw-bridge.postText', () => {
  let calls = []
  beforeEach(() => { calls = [] })

  function spy(opts) {
    return (bin, args, options) => {
      calls.push({ bin, args, options })
      return makeFakeProc(opts || {})
    }
  }

  it('returns disabled when config.enabled=false', async () => {
    const bridge = makeBridge({
      openclaw: { enabled: false, targetUserId: 'u1' },
      spawnImpl: spy({ stdout: '{}' }),
    })
    const r = await bridge.postText({ message: 'hi' })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('disabled')
    expect(calls).toHaveLength(0)
  })

  it('returns misconfigured when targetUserId missing', async () => {
    const bridge = makeBridge({
      openclaw: { enabled: true, targetUserId: '' },
      spawnImpl: spy({ stdout: '{}' }),
    })
    const r = await bridge.postText({ message: 'hi' })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('misconfigured')
  })

  it('shells out to openclaw message send with correct args', async () => {
    const bridge = makeBridge({
      openclaw: { enabled: true, targetUserId: 'peer-x@im.wechat', channel: 'openclaw-weixin' },
      spawnImpl: spy({ stdout: '{"ok":1}' }),
    })
    const r = await bridge.postText({ message: 'hello' })
    expect(r.ok).toBe(true)
    expect(r.payload).toEqual({ ok: 1 })
    expect(calls).toHaveLength(1)
    expect(calls[0].bin).toBe('openclaw')
    const args = calls[0].args
    expect(args).toContain('message')
    expect(args).toContain('send')
    expect(args).toContain('--channel')
    expect(args).toContain('openclaw-weixin')
    expect(args).toContain('--target')
    expect(args).toContain('peer-x@im.wechat')
    expect(args).toContain('--message')
    expect(args).toContain('hello')
    expect(args).toContain('--json')
  })

  it('respects rate limit', async () => {
    const bridge = makeBridge({
      openclaw: {
        enabled: true,
        targetUserId: 'peer-x',
        askUser: { rateLimitPerMin: 2 },
      },
      spawnImpl: spy({ stdout: '{}' }),
    })
    const r1 = await bridge.postText({ message: 'a' })
    const r2 = await bridge.postText({ message: 'b' })
    const r3 = await bridge.postText({ message: 'c' })
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    expect(r3.ok).toBe(false)
    expect(r3.reason).toBe('rate_limited')
  })

  it('returns cli_failed on non-zero exit', async () => {
    const bridge = makeBridge({
      openclaw: { enabled: true, targetUserId: 'peer-x' },
      spawnImpl: spy({ exitCode: 2, stderr: 'auth fail' }),
    })
    const r = await bridge.postText({ message: 'hi' })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('cli_failed')
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toContain('auth fail')
  })

  it('uses session route when sessionId provided', async () => {
    const bridge = makeBridge({
      openclaw: { enabled: true, targetUserId: 'config-default@im.wechat' },
      spawnImpl: spy({ stdout: '{}' }),
    })
    bridge.registerSessionRoute('s-1', { targetUserId: 'session-target@im.wechat', account: 'acc-1' })
    await bridge.postText({ sessionId: 's-1', message: 'hi' })
    const args = calls[0].args
    expect(args).toContain('session-target@im.wechat')
    expect(args).toContain('--account')
    expect(args).toContain('acc-1')
    // and not the config default
    expect(args).not.toContain('config-default@im.wechat')
  })

  it('falls back to config target when no session route', async () => {
    const bridge = makeBridge({
      openclaw: { enabled: true, targetUserId: 'config-default@im.wechat' },
      spawnImpl: spy({ stdout: '{}' }),
    })
    await bridge.postText({ sessionId: 's-unknown', message: 'hi' })
    const args = calls[0].args
    expect(args).toContain('config-default@im.wechat')
  })

  it('auto-appends @im.wechat suffix when target lacks it (openclaw-weixin)', async () => {
    const bridge = makeBridge({
      openclaw: { enabled: true, targetUserId: 'o9cq80wQ', channel: 'openclaw-weixin' },
      spawnImpl: spy({ stdout: '{"ok":1}' }),
    })
    const r = await bridge.postText({ message: 'hi' })
    expect(r.ok).toBe(true)
    const args = calls[0].args
    const tIdx = args.indexOf('--target')
    expect(args[tIdx + 1]).toBe('o9cq80wQ@im.wechat')
  })

  it('does NOT append suffix if target already has @ in it', async () => {
    const bridge = makeBridge({
      openclaw: { enabled: true, targetUserId: 'someone@other.example', channel: 'openclaw-weixin' },
      spawnImpl: spy({ stdout: '{}' }),
    })
    await bridge.postText({ message: 'hi' })
    const args = calls[0].args
    const tIdx = args.indexOf('--target')
    expect(args[tIdx + 1]).toBe('someone@other.example')
  })

  it('does NOT append suffix for unknown channels', async () => {
    const bridge = makeBridge({
      openclaw: { enabled: true, targetUserId: 'plain-id', channel: 'discord' },
      spawnImpl: spy({ stdout: '{}' }),
    })
    await bridge.postText({ message: 'hi' })
    const args = calls[0].args
    const tIdx = args.indexOf('--target')
    expect(args[tIdx + 1]).toBe('plain-id')
  })

  it('describe reports status snapshot', () => {
    const bridge = makeBridge({
      openclaw: {
        enabled: true,
        targetUserId: 'peer',
        askUser: { rateLimitPerMin: 6 },
      },
      spawnImpl: spy({ stdout: '{}' }),
    })
    const d = bridge.describe()
    expect(d.enabled).toBe(true)
    expect(d.targetUserIdSet).toBe(true)
    expect(d.rateLimit.perMin).toBe(6)
    expect(d).not.toHaveProperty('tokenEnvSet')
  })
})
