import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadTelegramFile, pickLargestPhoto } from '../src/telegram-image.js'

describe('pickLargestPhoto', () => {
  it('returns null on empty / non-array', () => {
    expect(pickLargestPhoto(null)).toBe(null)
    expect(pickLargestPhoto([])).toBe(null)
    expect(pickLargestPhoto(undefined)).toBe(null)
  })

  it('picks photo with largest file_size', () => {
    const photos = [
      { file_id: 'a', file_size: 1000 },
      { file_id: 'b', file_size: 50000 },
      { file_id: 'c', file_size: 8000 },
    ]
    expect(pickLargestPhoto(photos).file_id).toBe('b')
  })

  it('handles missing file_size as 0', () => {
    const photos = [
      { file_id: 'a' },
      { file_id: 'b', file_size: 100 },
    ]
    expect(pickLargestPhoto(photos).file_id).toBe('b')
  })
})

describe('downloadTelegramFile', () => {
  let tmp
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'qt-tg-img-')) })
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch {} })

  it('downloads file via getFile + binary fetch, writes to destDir', async () => {
    const calls = []
    const fakePixelData = Buffer.from([0x89, 0x50, 0x4E, 0x47])  // PNG magic
    const fetchFn = async (url, opts) => {
      calls.push({ url, method: opts?.method || 'GET' })
      if (url.includes('/getFile')) {
        return {
          ok: true,
          json: async () => ({ ok: true, result: { file_path: 'photos/file_42.jpg', file_size: 4 } }),
        }
      }
      // binary download
      return {
        ok: true,
        arrayBuffer: async () => fakePixelData.buffer.slice(fakePixelData.byteOffset, fakePixelData.byteOffset + fakePixelData.byteLength),
      }
    }

    const r = await downloadTelegramFile({
      token: 'TKN', fetchFn, fileId: 'BAQNN…', destDir: tmp,
    })
    expect(calls).toHaveLength(2)
    expect(calls[0].url).toContain('/botTKN/getFile')
    expect(calls[1].url).toContain('/file/botTKN/photos/file_42.jpg')
    expect(r.localPath).toMatch(/^.*\.jpg$/)
    expect(r.fileSize).toBe(4)
    expect(r.ext).toBe('jpg')
    // 真的写到磁盘了
    expect(readFileSync(r.localPath)).toEqual(fakePixelData)
  })

  it('rejects file > 20MB', async () => {
    await expect(downloadTelegramFile({
      token: 'TKN', fetchFn: async () => {}, fileId: 'x', fileSize: 25 * 1024 * 1024, destDir: tmp,
    })).rejects.toThrow(/file_too_large/)
  })

  it('throws on getFile failure', async () => {
    const fetchFn = async () => ({
      ok: false, status: 400,
      json: async () => ({ ok: false, description: 'file not found' }),
    })
    await expect(downloadTelegramFile({
      token: 'TKN', fetchFn, fileId: 'bad', destDir: tmp,
    })).rejects.toThrow(/getFile_failed/)
  })

  it('throws on binary download failure', async () => {
    const fetchFn = async (url) => {
      if (url.includes('/getFile')) {
        return { ok: true, json: async () => ({ ok: true, result: { file_path: 'a/b.jpg' } }) }
      }
      return { ok: false, status: 404 }
    }
    await expect(downloadTelegramFile({
      token: 'TKN', fetchFn, fileId: 'x', destDir: tmp,
    })).rejects.toThrow(/download_failed/)
  })

  it('infers ext from file_path', async () => {
    const fetchFn = async (url) => {
      if (url.includes('/getFile')) {
        return { ok: true, json: async () => ({ ok: true, result: { file_path: 'docs/screen.PNG' } }) }
      }
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }
    }
    const r = await downloadTelegramFile({ token: 'T', fetchFn, fileId: 'x', destDir: tmp })
    expect(r.ext).toBe('png')   // 小写化
    expect(r.localPath).toMatch(/\.png$/)
  })

  it('throws if token missing', async () => {
    await expect(downloadTelegramFile({ fileId: 'x' })).rejects.toThrow(/token_required/)
  })

  it('throws if fileId missing', async () => {
    await expect(downloadTelegramFile({ token: 'T' })).rejects.toThrow(/fileId_required/)
  })
})
