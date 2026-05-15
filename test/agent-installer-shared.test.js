import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildMarker,
  isAgentquadManaged,
  writeJsonAtomic,
  writeRuntimeMcpConfig,
  cleanupRuntimeMcpConfig,
} from '../src/agent-installer-shared.js'

describe('agent-installer-shared', () => {
  let dir
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aq-shared-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  describe('buildMarker', () => {
    it('returns object with version, port, generatedAt (iso)', () => {
      const m = buildMarker({ version: '0.4.0', port: 5677 })
      expect(m.version).toBe('0.4.0')
      expect(m.port).toBe(5677)
      expect(typeof m.generatedAt).toBe('string')
      expect(() => new Date(m.generatedAt)).not.toThrow()
    })
  })

  describe('isAgentquadManaged', () => {
    it('true when _agentquadManaged is an object with version', () => {
      expect(isAgentquadManaged({ _agentquadManaged: { version: '0.4.0' } })).toBe(true)
    })
    it('false when missing or boolean true (legacy hook installer style)', () => {
      expect(isAgentquadManaged({})).toBe(false)
      expect(isAgentquadManaged({ _agentquadManaged: true })).toBe(false)
    })
  })

  describe('writeJsonAtomic', () => {
    it('writes and is readable', () => {
      const p = join(dir, 'x.json')
      writeJsonAtomic(p, { a: 1 })
      expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ a: 1 })
    })
    it('does not leave .tmp behind on success', () => {
      const p = join(dir, 'y.json')
      writeJsonAtomic(p, { a: 1 })
      expect(existsSync(p + '.tmp')).toBe(false)
    })
  })

  describe('writeRuntimeMcpConfig + cleanupRuntimeMcpConfig', () => {
    it('writes claude-format mcp config with given port', () => {
      const out = writeRuntimeMcpConfig({ runtimeDir: dir, sessionId: 'sid1', port: 5678, tool: 'claude' })
      expect(out.path).toMatch(/mcp-sid1\.json$/)
      const raw = JSON.parse(readFileSync(out.path, 'utf8'))
      expect(raw.mcpServers.agentquad.url).toBe('http://127.0.0.1:5678/mcp')
      expect(raw.mcpServers.agentquad.transport ?? 'http').toBe('http')
    })

    it('writes codex-format toml config when tool=codex', () => {
      const out = writeRuntimeMcpConfig({ runtimeDir: dir, sessionId: 'sid2', port: 5678, tool: 'codex' })
      expect(out.path).toMatch(/mcp-sid2\.toml$/)
      const raw = readFileSync(out.path, 'utf8')
      expect(raw).toMatch(/\[mcp_servers\.agentquad\]/)
      expect(raw).toMatch(/http:\/\/127\.0\.0\.1:5678\/mcp/)
    })

    it('cleanup removes the file silently when missing', () => {
      cleanupRuntimeMcpConfig({ runtimeDir: dir, sessionId: 'ghost' })  // no-throw
      const out = writeRuntimeMcpConfig({ runtimeDir: dir, sessionId: 'sid3', port: 5678, tool: 'claude' })
      cleanupRuntimeMcpConfig({ runtimeDir: dir, sessionId: 'sid3' })
      expect(existsSync(out.path)).toBe(false)
    })
  })
})
