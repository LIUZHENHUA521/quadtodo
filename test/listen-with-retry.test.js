import { describe, it, expect, afterEach } from 'vitest'
import { createServer } from 'node:http'
import { listenWithRetry } from '../src/server.js'

describe('listenWithRetry', () => {
  const servers = []
  afterEach(async () => {
    for (const s of servers) await new Promise((r) => s.close(r))
    servers.length = 0
  })

  it('listens on requested port when free', async () => {
    const s = createServer()
    servers.push(s)
    const port = await listenWithRetry(s, 0, '127.0.0.1')
    expect(port).toBeGreaterThan(0)
    expect(s.address().port).toBe(port)
  })

  it('retries port+1 once when EADDRINUSE', async () => {
    const blocker = createServer().listen(0, '127.0.0.1')
    await new Promise((r) => blocker.once('listening', r))
    servers.push(blocker)
    const taken = blocker.address().port

    const s = createServer()
    servers.push(s)
    const port = await listenWithRetry(s, taken, '127.0.0.1')
    expect(port).toBe(taken + 1)
  })

  it('throws when both port and port+1 are taken', async () => {
    const b1 = createServer().listen(0, '127.0.0.1')
    await new Promise((r) => b1.once('listening', r))
    servers.push(b1)
    const taken = b1.address().port

    const b2 = createServer().listen(taken + 1, '127.0.0.1')
    await new Promise((r) => b2.once('listening', r))
    servers.push(b2)

    const s = createServer()
    servers.push(s)
    await expect(listenWithRetry(s, taken, '127.0.0.1')).rejects.toThrow(/EADDRINUSE/)
  })

  it('propagates non-EADDRINUSE errors immediately', async () => {
    const s = createServer()
    servers.push(s)
    await expect(listenWithRetry(s, 65536, '127.0.0.1')).rejects.toThrow()
  })
})
