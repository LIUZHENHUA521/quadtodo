/**
 * Web 端粘贴/拖拽图片上传：
 *   POST /api/uploads/image
 *     body: { filename: 'paste.png', mime: 'image/png', dataBase64: '...' }
 *     返回：{ ok: true, path: '/Users/.../...png', fileSize: number }
 *
 * 用 base64 JSON 而不是 multipart：
 *   - 不引新依赖（multer / busboy）
 *   - 粘贴图通常 <2MB，base64 33% 开销可忍
 *   - 大文件 / 多文件场景以后真有需求再换 multipart
 *
 * 文件落到 ~/.quadtodo/web-uploads/<ts>-<rand>.<ext>，跟 telegram tg-uploads 同模式。
 */
import { Router } from 'express'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { Buffer } from 'node:buffer'

const DEFAULT_UPLOAD_DIR = join(homedir(), '.quadtodo', 'web-uploads')
const MAX_BYTES = 20 * 1024 * 1024  // 20MB，跟 telegram 一致

const SAFE_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'heif',
  'pdf', 'txt', 'md', 'json', 'log', 'csv',
])

function sanitizeExt(filename, mime) {
  // 优先 filename 后缀；缺失或不安全 → 退到 mime 推断
  const m = String(filename || '').match(/\.([a-zA-Z0-9]{1,8})$/)
  let ext = m ? m[1].toLowerCase() : null
  if (!ext || !SAFE_EXTS.has(ext)) {
    if (/^image\/(png|jpeg|jpg|gif|webp|bmp|svg)/.test(mime || '')) {
      ext = mime.split('/')[1].replace('+xml', '').toLowerCase()
    } else if (/^application\/pdf/.test(mime || '')) {
      ext = 'pdf'
    } else {
      ext = 'bin'
    }
  }
  return ext
}

export function createUploadsRouter({ uploadDir = DEFAULT_UPLOAD_DIR, logger = console } = {}) {
  const router = Router()

  router.post('/image', (req, res) => {
    try {
      const { filename, mime, dataBase64 } = req.body || {}
      if (!dataBase64 || typeof dataBase64 !== 'string') {
        return res.status(400).json({ ok: false, error: 'dataBase64_required' })
      }
      // 大致预估 base64 解码后大小：bytes ≈ b64len * 3/4
      if (dataBase64.length * 3 / 4 > MAX_BYTES) {
        return res.status(413).json({ ok: false, error: 'file_too_large', limitMB: 20 })
      }
      const buf = Buffer.from(dataBase64, 'base64')
      if (buf.length > MAX_BYTES) {
        return res.status(413).json({ ok: false, error: 'file_too_large', limitMB: 20 })
      }
      mkdirSync(uploadDir, { recursive: true })
      const ext = sanitizeExt(filename, mime)
      const localName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
      const localPath = join(uploadDir, localName)
      writeFileSync(localPath, buf)
      logger.info?.(`[uploads] saved ${(buf.length / 1024).toFixed(1)}kB → ${localPath}`)
      res.json({ ok: true, path: localPath, fileSize: buf.length, ext })
    } catch (e) {
      logger.warn?.(`[uploads] save failed: ${e.message}`)
      res.status(500).json({ ok: false, error: e.message || 'upload_failed' })
    }
  })

  return router
}
