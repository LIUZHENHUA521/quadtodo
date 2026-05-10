/**
 * 飞书视频入站：跟 lark-image 类似，但用 getMessageResource(type:'file')。
 *
 * 实测飞书发视频时，事件 shape 是：
 *   msg_type: 'post'
 *   content: { title:'', content: [[{ tag:'media', file_key:'file_v3_xxx', image_key:'img_v3_xxx' }]] }
 *
 * 也可能（理论上 / 其他版本）出现：
 *   msg_type: 'media' / 'video', 顶层 content.file_key
 *   msg_type: 'file',  content.file_key + file_name 后缀是视频
 *
 * extractVideoFileKey 把以上几种 shape 都覆盖。
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

const VIDEO_MSG_TYPES = new Set(['media', 'video'])
const VIDEO_FILE_NAME_RE = /\.(mp4|mov|m4v|webm|mkv|avi|3gp|mpeg|mpg|wmv|flv)$/i

/**
 * 从飞书 message 提取视频 file_key。
 *
 * 识别优先级：
 *   ① post 富文本里的 media 节点 —— 实测飞书发视频走的就是这条
 *   ② msg_type ∈ {media, video} → content.file_key（顶层）
 *   ③ msg_type='file' 且 file_name 是视频后缀 → content.file_key
 *   ④ 兜底嵌套：content.video.file_key / content.media.file_key
 *   ⑤ 兜底：未知 msg_type 但 content 里有 file_key + 文件名是视频后缀
 *
 * @returns {{ fileKey: string, fileName: string|null, duration: number|null, msgType: string|null } | null}
 */
export function extractVideoFileKey(message = {}) {
  if (!message || typeof message !== 'object') return null
  const msgType = message.msg_type || message.message_type || null

  let content = message.content
  if (typeof content === 'string') {
    try { content = JSON.parse(content) } catch { content = null }
  }
  if (!content || typeof content !== 'object') return null

  // ① post 富文本里的 media 节点
  if (Array.isArray(content.content)) {
    for (const line of content.content) {
      if (!Array.isArray(line)) continue
      for (const node of line) {
        if (node && node.tag === 'media' && typeof node.file_key === 'string' && node.file_key) {
          return {
            fileKey: node.file_key,
            fileName: typeof node.file_name === 'string' ? node.file_name : null,
            duration: typeof node.duration === 'number' ? node.duration : null,
            msgType,
          }
        }
      }
    }
  }

  // ②③④⑤ 顶层 / 嵌套 file_key
  const fileKey = pickFirstString([
    content.file_key,
    content.video && content.video.file_key,
    content.media && content.media.file_key,
  ])
  if (!fileKey) return null

  const fileName = pickFirstString([
    content.file_name,
    content.video && content.video.file_name,
    content.media && content.media.file_name,
  ]) || null

  let claim = false
  if (msgType && VIDEO_MSG_TYPES.has(String(msgType).toLowerCase())) {
    claim = true
  } else if (fileName && VIDEO_FILE_NAME_RE.test(fileName)) {
    claim = true
  }
  if (!claim) return null

  const duration = typeof content.duration === 'number' ? content.duration : null

  return { fileKey, fileName, duration, msgType }
}

function pickFirstString(candidates) {
  for (const c of candidates) {
    if (typeof c === 'string' && c) return c
  }
  return null
}

/**
 * @param opts.apiClient lark-api-client 实例（必须有 getMessageResource）
 * @param opts.messageId 飞书 message_id
 * @param opts.fileKey content.file_key 或 post media 节点的 file_key
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
