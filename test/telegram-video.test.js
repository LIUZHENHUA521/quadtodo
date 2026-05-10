import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractTelegramVideo, downloadTelegramVideo } from '../src/telegram-video.js'

describe('extractTelegramVideo', () => {
  it('returns null when message has no video-like field', () => {
    expect(extractTelegramVideo({})).toBe(null)
    expect(extractTelegramVideo({ text: 'hi' })).toBe(null)
    expect(extractTelegramVideo(null)).toBe(null)
  })

  it('extracts msg.video', () => {
    const r = extractTelegramVideo({
      video: { file_id: 'BAACAg…', file_size: 1234567, file_name: 'demo.mp4' },
    })
    expect(r).toEqual({ fileId: 'BAACAg…', fileSize: 1234567, fileName: 'demo.mp4', kind: 'video' })
  })

  it('extracts msg.video_note (no file_name)', () => {
    const r = extractTelegramVideo({
      video_note: { file_id: 'DQACAg…', file_size: 50000 },
    })
    expect(r).toEqual({ fileId: 'DQACAg…', fileSize: 50000, fileName: null, kind: 'video_note' })
  })

  it('extracts msg.animation', () => {
    const r = extractTelegramVideo({
      animation: { file_id: 'CgACAg…', file_size: 333, file_name: 'meme.gif' },
    })
    expect(r).toEqual({ fileId: 'CgACAg…', fileSize: 333, fileName: 'meme.gif', kind: 'animation' })
  })

  it('extracts msg.document only when mime starts with video/', () => {
    const ok = extractTelegramVideo({
      document: { file_id: 'DOC1', file_size: 10, file_name: 'a.mp4', mime_type: 'video/mp4' },
    })
    expect(ok.kind).toBe('document_video')
    expect(ok.fileId).toBe('DOC1')

    const skipPdf = extractTelegramVideo({
      document: { file_id: 'DOC2', mime_type: 'application/pdf' },
    })
    expect(skipPdf).toBe(null)

    const skipNoMime = extractTelegramVideo({
      document: { file_id: 'DOC3' },
    })
    expect(skipNoMime).toBe(null)
  })

  it('prefers video over animation when both present (defensive)', () => {
    const r = extractTelegramVideo({
      video: { file_id: 'V', file_size: 1 },
      animation: { file_id: 'A', file_size: 1 },
    })
    expect(r.kind).toBe('video')
  })
})

describe('downloadTelegramVideo', () => {
  let tmp
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'qt-tg-vid-')) })
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch {} })

  it('downloads video via getFile + binary fetch', async () => {
    const fakeBytes = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])  // mp4 header-ish
    const fetchFn = async (url) => {
      if (url.includes('/getFile')) {
        return {
          ok: true,
          json: async () => ({ ok: true, result: { file_path: 'videos/file_99.mp4', file_size: 8 } }),
        }
      }
      return {
        ok: true,
        arrayBuffer: async () => fakeBytes.buffer.slice(fakeBytes.byteOffset, fakeBytes.byteOffset + fakeBytes.byteLength),
      }
    }
    const r = await downloadTelegramVideo({ token: 'TKN', fetchFn, fileId: 'BAACAg…', destDir: tmp })
    expect(r.localPath).toMatch(/\.mp4$/)
    expect(r.fileSize).toBe(8)
    expect(readFileSync(r.localPath)).toEqual(fakeBytes)
  })

  it('rejects video > 20MB before any network call', async () => {
    let called = false
    const fetchFn = async () => { called = true; return {} }
    await expect(downloadTelegramVideo({
      token: 'TKN', fetchFn, fileId: 'x', fileSize: 25 * 1024 * 1024, destDir: tmp,
    })).rejects.toThrow(/file_too_large/)
    expect(called).toBe(false)
  })

  it('throws on download failure', async () => {
    const fetchFn = async (url) => {
      if (url.includes('/getFile')) {
        return { ok: true, json: async () => ({ ok: true, result: { file_path: 'v/x.mp4' } }) }
      }
      return { ok: false, status: 502 }
    }
    await expect(downloadTelegramVideo({
      token: 'TKN', fetchFn, fileId: 'x', destDir: tmp,
    })).rejects.toThrow(/download_failed/)
  })
})
