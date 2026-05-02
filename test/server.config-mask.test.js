import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
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

describe('PUT /api/config token mask', () => {
  let tmp, srv, originalHome

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'qt-cfg-put-'))
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

  it('does not overwrite token when receiving mask string', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      telegram: { enabled: false, botToken: 'REAL_TOKEN_12345678' },
    }))
    srv = createServer({ configRootDir: tmp })
    await request(srv.app).put('/api/config').send({
      telegram: { enabled: false, botToken: 'tg_***5678' },
    })
    const onDisk = JSON.parse(readFileSync(join(tmp, 'config.json'), 'utf8'))
    expect(onDisk.telegram.botToken).toBe('REAL_TOKEN_12345678')
  })

  it('overwrites token when receiving real string', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      telegram: { enabled: false, botToken: 'OLD_TOKEN' },
    }))
    srv = createServer({ configRootDir: tmp })
    await request(srv.app).put('/api/config').send({
      telegram: { botToken: 'NEW_TOKEN_12345' },
    })
    const onDisk = JSON.parse(readFileSync(join(tmp, 'config.json'), 'utf8'))
    expect(onDisk.telegram.botToken).toBe('NEW_TOKEN_12345')
  })

  it('clears token when receiving empty string', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      telegram: { enabled: false, botToken: 'OLD_TOKEN' },
    }))
    srv = createServer({ configRootDir: tmp })
    await request(srv.app).put('/api/config').send({
      telegram: { botToken: '' },
    })
    const onDisk = JSON.parse(readFileSync(join(tmp, 'config.json'), 'utf8'))
    expect(onDisk.telegram.botToken == null || onDisk.telegram.botToken === '').toBe(true)
  })

  it('strips botTokenMasked + botTokenSource from incoming PUT', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      telegram: { enabled: false, botToken: 'REAL_TOKEN_12345678' },
    }))
    srv = createServer({ configRootDir: tmp })
    await request(srv.app).put('/api/config').send({
      telegram: { botTokenMasked: 'tg_***5678', botTokenSource: 'malicious' },
    })
    const onDisk = JSON.parse(readFileSync(join(tmp, 'config.json'), 'utf8'))
    expect(onDisk.telegram.botTokenMasked).toBeUndefined()
    expect(onDisk.telegram.botTokenSource).toBeUndefined()
    expect(onDisk.telegram.botToken).toBe('REAL_TOKEN_12345678')   // 没动
  })

  it('returns mask + source in response (no token leak)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      telegram: { enabled: false, botToken: 'REAL_TOKEN_12345678' },
    }))
    srv = createServer({ configRootDir: tmp })
    const r = await request(srv.app).put('/api/config').send({
      telegram: { enabled: false },
    })
    expect(r.body.config.telegram.botToken).toBeUndefined()
    expect(r.body.config.telegram.botTokenMasked).toBe('tg_***5678')
    expect(r.body.config.telegram.botTokenSource).toBe('quadtodo')
  })
})
