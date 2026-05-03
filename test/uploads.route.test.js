import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { Buffer } from 'node:buffer'
import { createUploadsRouter } from '../src/routes/uploads.js'

function makeApp(uploadDir) {
  const app = express()
  app.use(express.json({ limit: '30mb' }))
  app.use('/api/uploads', createUploadsRouter({ uploadDir, logger: { info() {}, warn() {} } }))
  return app
}

async function postJson(app, path, body) {
  const url = await new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = server.address().port
      resolve({ port, server })
    })
  })
  try {
    const r = await fetch(`http://127.0.0.1:${url.port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await r.json()
    return { status: r.status, body: data }
  } finally {
    url.server.close()
  }
}

describe('POST /api/uploads/image', () => {
  let tmp
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'qt-up-')) })
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch {} })

  it('saves base64 PNG to disk and returns path', async () => {
    const app = makeApp(tmp)
    const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])  // PNG magic
    const r = await postJson(app, '/api/uploads/image', {
      filename: 'paste.png', mime: 'image/png',
      dataBase64: png.toString('base64'),
    })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(r.body.path).toMatch(/\.png$/)
    expect(r.body.fileSize).toBe(8)
    expect(existsSync(r.body.path)).toBe(true)
    expect(readFileSync(r.body.path)).toEqual(png)
  })

  it('rejects empty / missing dataBase64', async () => {
    const app = makeApp(tmp)
    const r = await postJson(app, '/api/uploads/image', { filename: 'x.png' })
    expect(r.status).toBe(400)
    expect(r.body.ok).toBe(false)
    expect(r.body.error).toBe('dataBase64_required')
  })

  it('rejects file > 20MB', async () => {
    const app = makeApp(tmp)
    // 22MB decoded (≈ 29MB base64 string) — 在 express.json 30MB 上限内，
    // 但超过 route 自己的 20MB 检查，让 route 自身的 limit 命中
    const decodedBytes = 22 * 1024 * 1024
    const huge = 'A'.repeat(Math.ceil(decodedBytes * 4 / 3))
    const r = await postJson(app, '/api/uploads/image', {
      filename: 'big.png', mime: 'image/png', dataBase64: huge,
    })
    expect(r.status).toBe(413)
    expect(r.body.error).toBe('file_too_large')
  })

  it('falls back to mime when filename has no ext', async () => {
    const app = makeApp(tmp)
    const r = await postJson(app, '/api/uploads/image', {
      filename: '', mime: 'image/jpeg',
      dataBase64: Buffer.from([0xff, 0xd8]).toString('base64'),
    })
    expect(r.status).toBe(200)
    expect(r.body.path).toMatch(/\.jpeg$/)
  })

  it('falls back to .bin for unsafe / unknown ext', async () => {
    const app = makeApp(tmp)
    const r = await postJson(app, '/api/uploads/image', {
      filename: 'evil.exe', mime: 'application/x-msdownload',
      dataBase64: 'AAAA',
    })
    expect(r.status).toBe(200)
    expect(r.body.path).toMatch(/\.bin$/)
  })

  it('handles SVG safely', async () => {
    const app = makeApp(tmp)
    const r = await postJson(app, '/api/uploads/image', {
      filename: 'icon.svg', mime: 'image/svg+xml',
      dataBase64: Buffer.from('<svg/>').toString('base64'),
    })
    expect(r.status).toBe(200)
    expect(r.body.path).toMatch(/\.svg$/)
  })
})
