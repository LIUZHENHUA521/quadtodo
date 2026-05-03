/**
 * 把 Telegram 入站图片下载到本地，让 PTY 写 `@<path>` 喂给 Claude Code 做 attach。
 *
 * 流程：
 *   1) callApi('getFile', { file_id }) → 拿 file_path（telegram 服务器上的相对路径）
 *   2) GET https://api.telegram.org/file/bot<TOKEN>/<file_path> → 下载二进制
 *   3) 写到 destDir，返回 { localPath, fileSize }
 *
 * 默认存到 ~/.quadtodo/tg-uploads/<ts>-<rand>.<ext>，不主动清理（量级小，磁盘占用可忽略）
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { Buffer } from 'node:buffer'

const DEFAULT_DIR = join(homedir(), '.quadtodo', 'tg-uploads')
const DOWNLOAD_TIMEOUT_MS = 30_000
const MAX_PHOTO_SIZE_MB = 20  // Telegram 限制 ~20MB

/**
 * Telegram message.photo 是 array of PhotoSize，按分辨率从小到大排
 * 选最大那张（通常 width >= 1280 的原图）
 */
export function pickLargestPhoto(photos) {
  if (!Array.isArray(photos) || photos.length === 0) return null
  return photos.reduce((acc, p) =>
    (p?.file_size || 0) > (acc?.file_size || 0) ? p : acc, photos[0])
}

/**
 * @param {object} opts
 * @param opts.token Telegram bot token
 * @param opts.fetchFn (url, opts) => Response（默认全局 fetch；测试可注入）
 * @param opts.fileId Telegram file_id
 * @param opts.destDir 下载目标目录（默认 ~/.quadtodo/tg-uploads）
 * @param opts.fileSize 可选，预先校验 ≤ 20MB
 * @returns {{ localPath: string, fileSize: number, ext: string }}
 */
export async function downloadTelegramFile({
  token,
  fetchFn,
  fileId,
  destDir = DEFAULT_DIR,
  fileSize = null,
} = {}) {
  if (!token) throw new Error('token_required')
  if (!fileId) throw new Error('fileId_required')
  if (fileSize && fileSize > MAX_PHOTO_SIZE_MB * 1024 * 1024) {
    throw new Error(`file_too_large: ${(fileSize / 1024 / 1024).toFixed(1)}MB > ${MAX_PHOTO_SIZE_MB}MB`)
  }
  const fetcher = fetchFn || fetch

  // 1. getFile → file_path
  const ctrl1 = new AbortController()
  const t1 = setTimeout(() => ctrl1.abort(), DOWNLOAD_TIMEOUT_MS)
  let filePath
  try {
    const resp = await fetcher(`https://api.telegram.org/bot${token}/getFile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
      signal: ctrl1.signal,
    })
    const data = await resp.json().catch(() => null)
    if (!data?.ok || !data.result?.file_path) {
      throw new Error(`getFile_failed: ${data?.description || resp.status}`)
    }
    filePath = data.result.file_path
  } finally {
    clearTimeout(t1)
  }

  // 2. download binary
  const ctrl2 = new AbortController()
  const t2 = setTimeout(() => ctrl2.abort(), DOWNLOAD_TIMEOUT_MS)
  let buf
  try {
    const resp = await fetcher(`https://api.telegram.org/file/bot${token}/${filePath}`, {
      signal: ctrl2.signal,
    })
    if (!resp.ok) throw new Error(`download_failed: HTTP ${resp.status}`)
    const ab = await resp.arrayBuffer()
    buf = Buffer.from(ab)
  } finally {
    clearTimeout(t2)
  }

  // 3. write to disk
  mkdirSync(destDir, { recursive: true })
  const ext = (filePath.split('.').pop() || 'bin').toLowerCase()
  const localName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
  const localPath = join(destDir, localName)
  writeFileSync(localPath, buf)
  return { localPath, fileSize: buf.length, ext }
}
