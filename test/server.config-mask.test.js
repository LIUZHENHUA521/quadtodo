import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { createServer } from '../src/server.js'

describe('GET /api/config token mask', () => {
  let tmp, srv, originalHome

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'qt-cfg-mask-'))
    // 隔离 ~/.openclaw/openclaw.json fallback
    originalHome = process.env.HOME
    process.env.HOME = tmp
  })

  afterEach(async () => {
    if (srv) {
      try { await srv.close() } catch {}
      srv = null
    }
    process.env.HOME = originalHome
    try { rmSync(tmp, { recursive: true, force: true }) } catch {}
  })

  it('masks token + adds source field when token is set in quadtodo config', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      telegram: { enabled: false, botToken: '7846123456:AAH9xK_abcdefg1234' },
    }))
    srv = createServer({ configRootDir: tmp })
    const r = await request(srv.app).get('/api/config')
    expect(r.status).toBe(200)
    expect(r.body.config.telegram.botToken).toBeUndefined()
    expect(r.body.config.telegram.botTokenMasked).toBe('tg_***1234')
    expect(r.body.config.telegram.botTokenSource).toBe('quadtodo')
  })

  it('returns missing when no token anywhere', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ telegram: { enabled: false } }))
    srv = createServer({ configRootDir: tmp })
    const r = await request(srv.app).get('/api/config')
    expect(r.body.config.telegram.botToken).toBeUndefined()
    expect(r.body.config.telegram.botTokenMasked).toBeNull()
    expect(r.body.config.telegram.botTokenSource).toBe('missing')
  })
})
