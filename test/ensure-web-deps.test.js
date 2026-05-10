import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const SCRIPT = resolve(__dirname, '../scripts/ensure-web-deps.js')

describe('ensure-web-deps', () => {
  it('exits 0 silently when web/node_modules already exists', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'qt-ewd-'))
    try {
      mkdirSync(join(tmp, 'web', 'node_modules'), { recursive: true })
      writeFileSync(join(tmp, 'web', 'package.json'), '{"name":"web"}')
      const r = spawnSync('node', [SCRIPT], { cwd: tmp, encoding: 'utf8' })
      expect(r.status).toBe(0)
      expect(r.stderr).toBe('')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('reports a clear actionable error when web/package.json is missing', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'qt-ewd-'))
    try {
      const r = spawnSync('node', [SCRIPT], { cwd: tmp, encoding: 'utf8' })
      expect(r.status).not.toBe(0)
      expect(r.stderr + r.stdout).toMatch(/web\/package\.json/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
