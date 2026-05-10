import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadLarkVideo, extractVideoFileKey, videoExtFromContentType } from '../src/lark-video.js'

describe('extractVideoFileKey', () => {
  it('returns null for clearly non-video messages', () => {
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
    expect(r).toMatchObject({ fileKey: 'media_v3_xxx', fileName: 'a.mp4', duration: 12345 })
  })

  it('handles content as object (already parsed)', () => {
    const r = extractVideoFileKey({
      msg_type: 'media',
      content: { file_key: 'mk', file_name: null, duration: null },
    })
    expect(r).toMatchObject({ fileKey: 'mk', fileName: null, duration: null })
  })

  it('falls back to message_type alias', () => {
    const r = extractVideoFileKey({
      message_type: 'media',
      content: '{"file_key":"k"}',
    })
    expect(r?.fileKey).toBe('k')
  })

  it('returns null when media has no file_key (only cover image_key)', () => {
    expect(extractVideoFileKey({
      msg_type: 'media',
      content: '{"image_key":"only_cover"}',
    })).toBe(null)
  })

  // ── 容错：不同 msg_type / 嵌套路径 / 文件名后缀兜底 ─────────────────
  it('accepts msg_type=video as a video message', () => {
    const r = extractVideoFileKey({
      msg_type: 'video',
      content: '{"file_key":"media_v","file_name":"x.mov"}',
    })
    expect(r?.fileKey).toBe('media_v')
  })

  it('accepts msg_type=file when file_name has a video extension', () => {
    const r = extractVideoFileKey({
      msg_type: 'file',
      content: '{"file_key":"file_v","file_name":"clip.mp4"}',
    })
    expect(r?.fileKey).toBe('file_v')
    expect(r?.fileName).toBe('clip.mp4')
  })

  it('rejects msg_type=file when file_name is non-video', () => {
    expect(extractVideoFileKey({
      msg_type: 'file',
      content: '{"file_key":"file_pdf","file_name":"report.pdf"}',
    })).toBe(null)
  })

  it('accepts unknown msg_type when file_name is a video and file_key present', () => {
    const r = extractVideoFileKey({
      msg_type: 'unknown_type',
      content: '{"file_key":"any","file_name":"a.webm"}',
    })
    expect(r?.fileKey).toBe('any')
  })

  it('finds file_key under content.video.file_key fallback path', () => {
    const r = extractVideoFileKey({
      msg_type: 'media',
      content: '{"video":{"file_key":"nested_key","file_name":"y.mp4"}}',
    })
    expect(r?.fileKey).toBe('nested_key')
    expect(r?.fileName).toBe('y.mp4')
  })

  it('finds file_key under content.media.file_key fallback path', () => {
    const r = extractVideoFileKey({
      msg_type: 'media',
      content: '{"media":{"file_key":"alt_key"}}',
    })
    expect(r?.fileKey).toBe('alt_key')
  })

  it('case-insensitive msg_type match', () => {
    const r = extractVideoFileKey({
      msg_type: 'Media',
      content: '{"file_key":"k"}',
    })
    expect(r?.fileKey).toBe('k')
  })

  // ── 实测飞书 shape：post 富文本里 tag==='media' 的节点（**最关键的一条路径**）──
  it('extracts file_key from post msg containing tag=media node (real Lark shape)', () => {
    const realPayload = {
      msg_type: 'post',
      content: '{"title":"","content":[[{"tag":"media","file_key":"file_v3_0011j_153455b3-9010-456c-82ba-9482b23c7cag","image_key":"img_v3_0211j_9341e90d-d393-4707-9ad3-026f190380dg"}]]}',
    }
    const r = extractVideoFileKey(realPayload)
    expect(r?.fileKey).toBe('file_v3_0011j_153455b3-9010-456c-82ba-9482b23c7cag')
  })

  it('extracts file_name + duration from post media node when present', () => {
    const r = extractVideoFileKey({
      msg_type: 'post',
      content: JSON.stringify({
        content: [[{ tag: 'media', file_key: 'fk', file_name: 'movie.mp4', duration: 8000 }]],
      }),
    })
    expect(r).toMatchObject({ fileKey: 'fk', fileName: 'movie.mp4', duration: 8000 })
  })

  it('returns the first media node when post has multiple media nodes', () => {
    const r = extractVideoFileKey({
      msg_type: 'post',
      content: JSON.stringify({
        content: [
          [{ tag: 'text', text: '看这俩' }],
          [{ tag: 'media', file_key: 'fk_first' }],
          [{ tag: 'media', file_key: 'fk_second' }],
        ],
      }),
    })
    expect(r?.fileKey).toBe('fk_first')
  })

  it('ignores image-only post messages (no media node)', () => {
    expect(extractVideoFileKey({
      msg_type: 'post',
      content: JSON.stringify({
        content: [[{ tag: 'img', image_key: 'img_x' }]],
      }),
    })).toBe(null)
  })

  it('finds media node even when surrounded by text nodes (post with caption)', () => {
    const r = extractVideoFileKey({
      msg_type: 'post',
      content: JSON.stringify({
        content: [
          [{ tag: 'text', text: '看视频：' }, { tag: 'media', file_key: 'fk_with_text' }],
        ],
      }),
    })
    expect(r?.fileKey).toBe('fk_with_text')
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
