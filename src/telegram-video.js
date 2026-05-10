/**
 * Telegram 视频入站：跟 telegram-image 走同一条 getFile + 下载流水线，
 * 但兼容多种载体：
 *   - msg.video         普通视频（mp4/mov…）
 *   - msg.video_note    圆形短视频（≤1min）
 *   - msg.animation     GIF / 静音 mp4
 *   - msg.document      mime_type 以 video/ 开头的文件
 *
 * 所有文件统一过 Bot API 的 20MB 上限校验（复用 telegram-image 的下载函数）。
 *
 * 不处理：audio / voice / sticker / 非视频 document。
 */
import { downloadTelegramFile } from './telegram-image.js'

/**
 * 从 Telegram message 里挑出"视频载体"。返回 null 表示该消息没有视频。
 * @returns {{ fileId: string, fileSize: number|null, fileName: string|null, kind: string } | null}
 */
export function extractTelegramVideo(msg = {}) {
  if (!msg || typeof msg !== 'object') return null

  // video 是单个对象（不是 photo 那样的数组）
  if (msg.video?.file_id) {
    return {
      fileId: msg.video.file_id,
      fileSize: msg.video.file_size || null,
      fileName: msg.video.file_name || null,
      kind: 'video',
    }
  }

  if (msg.video_note?.file_id) {
    return {
      fileId: msg.video_note.file_id,
      fileSize: msg.video_note.file_size || null,
      fileName: null,  // video_note 没有 file_name
      kind: 'video_note',
    }
  }

  if (msg.animation?.file_id) {
    return {
      fileId: msg.animation.file_id,
      fileSize: msg.animation.file_size || null,
      fileName: msg.animation.file_name || null,
      kind: 'animation',
    }
  }

  // document 包了一层 mime_type；只在 video/* 时认领
  if (msg.document?.file_id) {
    const mime = String(msg.document.mime_type || '').toLowerCase()
    if (mime.startsWith('video/')) {
      return {
        fileId: msg.document.file_id,
        fileSize: msg.document.file_size || null,
        fileName: msg.document.file_name || null,
        kind: 'document_video',
      }
    }
  }

  return null
}

/**
 * 复用 telegram-image 的下载函数。这里单独出一个 thin wrapper，
 * 便于将来给视频独立调参（比如更大的超时、不同目录），现在保持一致。
 *
 * @param opts.token / opts.fetchFn / opts.fileId / opts.fileSize / opts.destDir 同 downloadTelegramFile
 * @returns {Promise<{ localPath: string, fileSize: number, ext: string }>}
 */
export async function downloadTelegramVideo(opts = {}) {
  return downloadTelegramFile(opts)
}
