import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  doctorReport,
  buildDoctorChecks,
  buildStartupBanner,
  collectReachableAddresses,
} from '../src/cli.js'
import { loadConfig, setConfigValue, getConfigValue } from '../src/config.js'

describe('cli helpers', () => {
  let rootDir
  beforeEach(() => { rootDir = mkdtempSync(join(tmpdir(), 'quadtodo-cli-')) })
  afterEach(() => { rmSync(rootDir, { recursive: true, force: true }) })

  it('config round-trip via setConfigValue / getConfigValue', () => {
    loadConfig({ rootDir })
    setConfigValue('tools.claude.bin', '/opt/claude', { rootDir })
    expect(getConfigValue('tools.claude.bin', { rootDir })).toBe('/opt/claude')
  })

  it('setConfigValue coerces integer for port', () => {
    loadConfig({ rootDir })
    setConfigValue('port', '6789', { rootDir })
    expect(getConfigValue('port', { rootDir })).toBe(6789)
    // verify on-disk
    const raw = JSON.parse(readFileSync(join(rootDir, 'config.json'), 'utf8'))
    expect(raw.port).toBe(6789)
  })

  it('doctorReport returns a checklist object', async () => {
    const report = await doctorReport({ rootDir })
    expect(Array.isArray(report.checks)).toBe(true)
    expect(typeof report.ok).toBe('boolean')
    const names = report.checks.map(c => c.name)
    expect(names).toContain('rootDir exists')
    expect(names).toContain('config.json parseable')
    expect(names).toContain('better-sqlite3 loadable')
  })

  describe('buildStartupBanner', () => {
    it('loopback host prints loopback-only hint + how to expose', () => {
      const out = buildStartupBanner({ port: 5677, host: '127.0.0.1', addresses: { tailscale: [], lan: [], loopback: [] } })
      expect(out).toMatch(/loopback only/)
      expect(out).toMatch(/--expose/)
      expect(out).toMatch(/quadtodo config set host 0\.0\.0\.0/)
      expect(out).not.toMatch(/SECURITY/)
    })

    it('exposed host with Tailscale interface highlights it first', () => {
      const out = buildStartupBanner({
        port: 5677,
        host: '0.0.0.0',
        addresses: {
          tailscale: [{ name: 'utun5', address: '100.64.12.34' }],
          lan: [{ name: 'en0', address: '192.168.1.50' }],
          loopback: [],
        },
      })
      expect(out).toMatch(/SECURITY/)
      expect(out).toMatch(/Tailscale \(recommended/)
      expect(out).toMatch(/http:\/\/100\.64\.12\.34:5677/)
      expect(out).toMatch(/MagicDNS/)
      expect(out).toMatch(/http:\/\/192\.168\.1\.50:5677/)
      expect(out.indexOf('100.64.12.34')).toBeLessThan(out.indexOf('192.168.1.50'))
    })

    it('exposed host without Tailscale warns and points at docs', () => {
      const out = buildStartupBanner({
        port: 5677,
        host: '0.0.0.0',
        addresses: { tailscale: [], lan: [{ name: 'en0', address: '192.168.1.50' }], loopback: [] },
      })
      expect(out).toMatch(/No Tailscale interface detected/)
      expect(out).toMatch(/docs\/MOBILE\.md/)
    })

    it('treats a specific non-loopback host as exposed', () => {
      const out = buildStartupBanner({
        port: 5677,
        host: '192.168.1.50',
        addresses: { tailscale: [], lan: [], loopback: [] },
      })
      expect(out).toMatch(/SECURITY/)
      expect(out).not.toMatch(/loopback only/)
    })
  })

  describe('collectReachableAddresses', () => {
    it('returns the expected shape and classifies loopback', () => {
      const out = collectReachableAddresses()
      expect(Array.isArray(out.tailscale)).toBe(true)
      expect(Array.isArray(out.lan)).toBe(true)
      expect(Array.isArray(out.loopback)).toBe(true)
      // 127.0.0.1 总是存在，所以 loopback 必非空
      expect(out.loopback.some((i) => i.address === '127.0.0.1')).toBe(true)
      // 所有分类里的 IPv4 都是点分十进制
      for (const bucket of [out.tailscale, out.lan, out.loopback]) {
        for (const item of bucket) {
          expect(item).toHaveProperty('name')
          expect(item.address).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/)
        }
      }
    })
  })

  it('buildDoctorChecks is pure and sync-returns a predictable set of names', () => {
    const names = buildDoctorChecks()
    expect(names).toEqual([
      'rootDir exists',
      'config.json parseable',
      'better-sqlite3 loadable',
      'node-pty loadable',
      'claude binary',
      'codex binary',
    ])
  })
})
