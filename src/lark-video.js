/**
 * 飞书视频入站：跟 lark-image 类似，但用 getMessageResource(type:'file')。
 *
 * 飞书的视频消息 msg_type === 'media'，content 形如：
 *   { file_key: 'media_v3_xxx', image_key: 'img_v2_xxx'(封面，可选), file_name: 'a.mp4', duration: 12345 }
 *
 * extractVideoFileKey 只处理 msg_type === 'media' 的消息，避免误吃 image 消息封面。
 * 当前只支持单视频（飞书一次发一条），返回 null 或 { fileKey, fileName, duration }。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DEFAULT_DIR = join(homedir(), '.quadtodo', 'lark-uploads')

const CONTENT_TYPE_TO_EXT = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/x-msvideo': 'avi',
  'video/x-matroska': 'mkv',
  'video/webm': 'webm',
  'video/3gpp': '3gp',
  'video/mpeg': 'mpeg',
}

export function videoExtFromContentType(headers) {
  const ct = String(
    headers?.['content-type']
    || headers?.['Content-Type']
    || ''
  ).toLowerCase()
  for (const [type, ext] of Object.entries(CONTENT_TYPE_TO_EXT)) {
    if (ct.includes(type)) return ext
  }
  return 'mp4'  // 飞书视频默认 mp4，未知 mime 兜底成 mp4 比 bin 更安全
}

/**
 * 从飞书 message 提取视频 file_key。仅 msg_type === 'media' 才处理。
 * @returns {{ fileKey: string, fileName: string|null, duration: number|null } | null}
 */
export function extractVideoFileKey(message = {}) {
  if (!message || typeof message !== 'object') return null
  // msg_type 在不同事件层级名字不同：直接 message 上是 message_type，
  // 而 raw event message 上是 msg_type。两种都试。
  const msgType = message.msg_type || message.message_type
  if (msgType !== 'media') return null

  let content = message.content
  if (typeof content === 'string') {
    try { content = JSON.parse(content) } catch { content = null }
  }
  if (!content || typeof content !== 'object') return null

  if (typeof content.file_key !== 'string' || !content.file_key) return null

  return {
    fileKey: content.file_key,
    fileName: typeof content.file_name === 'string' ? content.file_name : null,
    duration: typeof content.duration === 'number' ? content.duration : null,
  }
}

/**
 * @param opts.apiClient lark-api-client 实例（必须有 getMessageResource）
 * @param opts.messageId 飞书 message_id
 * @param opts.fileKey content.file_key
 * @param opts.fileName 用于推扩展名（可选；优先级低于 content-type）
 * @param opts.destDir 目标目录
 * @returns {Promise<{ ok: true, localPath } | { ok: false, reason, detail? }>}
 */
export async function downloadLarkVideo({
  apiClient,
  messageId,
  fileKey,
  fileName = null,
  destDir = DEFAULT_DIR,
} = {}) {
  if (!apiClient?.getMessageResource) return { ok: false, reason: 'apiClient_required' }
  if (!messageId) return { ok: false, reason: 'messageId_required' }
  if (!fileKey) return { ok: false, reason: 'fileKey_required' }

  const r = await apiClient.getMessageResource({ messageId, fileKey, type: 'file' })
  if (!r?.ok) return { ok: false, reason: r?.reason || 'lark_resource_failed', detail: r?.detail }
  if (typeof r.writeFile !== 'function') return { ok: false, reason: 'no_writefile' }

  try {
    mkdirSync(destDir, { recursive: true })
  } catch (e) {
    return { ok: false, reason: 'mkdir_failed', detail: e.message }
  }

  // 优先：content-type → mime → ext；fallback：file_name 后缀
  let ext = videoExtFromContentType(r.headers || {})
  if (ext === 'mp4' && fileName) {
    const dot = fileName.lastIndexOf('.')
    if (dot > 0 && dot < fileName.length - 1) {
      const guess = fileName.slice(dot + 1).toLowerCase()
      if (/^[a-z0-9]{2,5}$/.test(guess)) ext = guess
    }
  }
  const localName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
  const localPath = join(destDir, localName)
  try {
    await r.writeFile(localPath)
  } catch (e) {
    return { ok: false, reason: 'write_failed', detail: e.message }
  }
  return { ok: true, localPath }
}
