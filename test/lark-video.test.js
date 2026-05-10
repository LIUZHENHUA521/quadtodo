import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadLarkVideo, extractVideoFileKey, videoExtFromContentType } from '../src/lark-video.js'

describe('extractVideoFileKey', () => {
  it('returns null for non-media messages', () => {
    expect(extractVideoFileKey({ msg_type: 'text', content: '{"text":"hi"}' })).toBe(null)
    expect(extractVideoFileKey({ msg_type: 'image', content: '{"image_key":"img"}' })).toBe(null)
    expect(extractVideoFileKey({ msg_type: 'post', content: '{}' })).toBe(null)
    expect(extractVideoFileKey(null)).toBe(null)
    expect(extractVideoFileKey({})).toBe(null)
  })

  it('extracts file_key + file_name + duration from media message', () => {
    const r = extractVideoFileKey({
      msg_type: 'media',
      content: '{"file_key":"media_v3_xxx","file_name":"a.mp4","duration":12345,"image_key":"img_cover"}',
    })
    expect(r).toEqual({ fileKey: 'media_v3_xxx', fileName: 'a.mp4', duration: 12345 })
  })

  it('handles content as object (already parsed)', () => {
    const r = extractVideoFileKey({
      msg_type: 'media',
      content: { file_key: 'mk', file_name: null, duration: null },
    })
    expect(r).toEqual({ fileKey: 'mk', fileName: null, duration: null })
  })

  it('falls back to message_type alias', () => {
    const r = extractVideoFileKey({
      message_type: 'media',
      content: '{"file_key":"k"}',
    })
    expect(r?.fileKey).toBe('k')
  })

  it('returns null when media has no file_key', () => {
    expect(extractVideoFileKey({
      msg_type: 'media',
      content: '{"image_key":"only_cover"}',
    })).toBe(null)
  })
})

describe('videoExtFromContentType', () => {
  it('maps common video content-types', () => {
    expect(videoExtFromContentType({ 'content-type': 'video/mp4' })).toBe('mp4')
    expect(videoExtFromContentType({ 'Content-Type': 'video/quicktime' })).toBe('mov')
    expect(videoExtFromContentType({ 'content-type': 'video/webm' })).toBe('webm')
  })

  it('falls back to mp4 for unknown', () => {
    expect(videoExtFromContentType({ 'content-type': 'application/octet-stream' })).toBe('mp4')
    expect(videoExtFromContentType({})).toBe('mp4')
    expect(videoExtFromContentType(null)).toBe('mp4')
  })
})

describe('downloadLarkVideo', () => {
  it('calls getMessageResource with type:file and writes to disk', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lark-vid-'))
    try {
      let writtenPath = null
      const apiClient = {
        getMessageResource: vi.fn().mockResolvedValue({
          ok: true,
          headers: { 'content-type': 'video/mp4' },
          writeFile: async (p) => { writtenPath = p; return p },
        }),
      }
      const r = await downloadLarkVideo({
        apiClient, messageId: 'om_x', fileKey: 'media_y', fileName: 'demo.mp4', destDir: tmp,
      })
      expect(r.ok).toBe(true)
      expect(r.localPath).toMatch(/\.mp4$/)
      expect(r.localPath.startsWith(tmp)).toBe(true)
      expect(writtenPath).toBe(r.localPath)
      expect(apiClient.getMessageResource).toHaveBeenCalledWith({
        messageId: 'om_x',
        fileKey: 'media_y',
        type: 'file',
      })
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('uses file_name extension when content-type is generic', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lark-vid-ext-'))
    try {
      const apiClient = {
        getMessageResource: vi.fn().mockResolvedValue({
          ok: true,
          headers: { 'content-type': 'application/octet-stream' },  // → fallback mp4 first
          writeFile: async () => {},
        }),
      }
      const r = await downloadLarkVideo({
        apiClient, messageId: 'om_x', fileKey: 'mk', fileName: 'clip.mov', destDir: tmp,
      })
      expect(r.ok).toBe(true)
      expect(r.localPath).toMatch(/\.mov$/)  // file_name 后缀覆盖了默认 mp4
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('returns structured error when getMessageResource fails', async () => {
    const apiClient = {
      getMessageResource: vi.fn().mockResolvedValue({ ok: false, reason: 'lark_resource_failed', detail: 'forbidden' }),
    }
    const r = await downloadLarkVideo({ apiClient, messageId: 'om_x', fileKey: 'mk' })
    expect(r).toEqual({ ok: false, reason: 'lark_resource_failed', detail: 'forbidden' })
  })

  it('validates required inputs', async () => {
    await expect(downloadLarkVideo({})).resolves.toEqual({ ok: false, reason: 'apiClient_required' })
    await expect(downloadLarkVideo({ apiClient: { getMessageResource: () => {} } })).resolves.toEqual({ ok: false, reason: 'messageId_required' })
    await expect(downloadLarkVideo({ apiClient: { getMessageResource: () => {} }, messageId: 'om_x' })).resolves.toEqual({ ok: false, reason: 'fileKey_required' })
  })

  it('reports write_failed when writeFile throws', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lark-vid-fail-'))
    try {
      const apiClient = {
        getMessageResource: vi.fn().mockResolvedValue({
          ok: true,
          headers: { 'content-type': 'video/mp4' },
          writeFile: async () => { throw new Error('disk full') },
        }),
      }
      const r = await downloadLarkVideo({ apiClient, messageId: 'om_x', fileKey: 'mk', destDir: tmp })
      expect(r.ok).toBe(false)
      expect(r.reason).toBe('write_failed')
      expect(r.detail).toBe('disk full')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
