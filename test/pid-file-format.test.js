import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writePidFile, readPidFile } from '../src/cli.js'

describe('pid file JSON format', () => {
  let dir
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aq-pid-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('writes JSON with pid/port/host/startedAt', () => {
    writePidFile(dir, { pid: 12345, port: 5678, host: '127.0.0.1' })
    const raw = readFileSync(join(dir, 'agentquad.pid'), 'utf8')
    const obj = JSON.parse(raw)
    expect(obj.pid).toBe(12345)
    expect(obj.port).toBe(5678)
    expect(obj.host).toBe('127.0.0.1')
    expect(typeof obj.startedAt).toBe('string')
  })

  it('reads JSON format', () => {
    writeFileSync(join(dir, 'agentquad.pid'), JSON.stringify({ pid: 999, port: 6000, host: 'x' }))
    const got = readPidFile(dir)
    expect(got).toEqual({ pid: 999, port: 6000, host: 'x' })
  })

  it('reads legacy plain-number format and returns { pid }', () => {
    writeFileSync(join(dir, 'agentquad.pid'), '4242')
    const got = readPidFile(dir)
    expect(got.pid).toBe(4242)
    expect(got.port).toBeUndefined()
  })

  it('returns null when pid file missing', () => {
    expect(readPidFile(dir)).toBeNull()
  })
})
