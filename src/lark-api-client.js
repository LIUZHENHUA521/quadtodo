import * as Lark from '@larksuiteoapi/node-sdk'

function isBlank(value) {
  return value == null || String(value) === ''
}

function normalizePayload(response) {
  return response?.data || response || null
}

function normalizeError(error) {
  return error?.message || error?.description || String(error)
}

function defaultClientFactory({ appId, appSecret }) {
  return new Lark.Client({
    appId,
    appSecret,
    appType: Lark.AppType.SelfBuild,
  })
}

export function createLarkApiClient({ appId, appSecret, clientFactory = defaultClientFactory, logger = console } = {}) {
  let client = null

  function hasCredentials() {
    return !isBlank(appId) && !isBlank(appSecret)
  }

  function getClient() {
    if (!hasCredentials()) return null
    if (!client) client = clientFactory({ appId, appSecret })
    return client
  }

  async function sendMessage({ chatId, text } = {}) {
    if (!hasCredentials()) return { ok: false, reason: 'lark_credentials_missing' }
    if (isBlank(chatId)) return { ok: false, reason: 'chatId_required' }
    if (isBlank(text)) return { ok: false, reason: 'text_required' }
    try {
      const response = await getClient().im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: String(chatId),
          msg_type: 'text',
          content: JSON.stringify({ text: String(text) }),
        },
      })
      return { ok: true, payload: normalizePayload(response) }
    } catch (e) {
      const detail = normalizeError(e)
      logger.warn?.(`[lark-api] send failed: ${detail}`)
      return { ok: false, reason: 'lark_send_failed', detail }
    }
  }

  async function replyInThread({ rootMessageId, text } = {}) {
    if (!hasCredentials()) return { ok: false, reason: 'lark_credentials_missing' }
    if (isBlank(rootMessageId)) return { ok: false, reason: 'rootMessageId_required' }
    if (isBlank(text)) return { ok: false, reason: 'text_required' }
    try {
      const response = await getClient().im.message.reply({
        path: { message_id: String(rootMessageId) },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text: String(text) }),
          reply_in_thread: true,
        },
      })
      return { ok: true, payload: normalizePayload(response) }
    } catch (e) {
      const detail = normalizeError(e)
      logger.warn?.(`[lark-api] reply failed: ${detail}`)
      return { ok: false, reason: 'lark_reply_failed', detail }
    }
  }

  async function testConnection() {
    if (!hasCredentials()) return { ok: false, reason: 'lark_credentials_missing' }
    try {
      const sdkClient = getClient()
      if (sdkClient.auth?.tenantAccessToken?.internal) {
        await sdkClient.auth.tenantAccessToken.internal({
          data: { app_id: String(appId), app_secret: String(appSecret) },
        })
      } else {
        await sendMessage({ chatId: '', text: '' })
      }
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: 'lark_client_init_failed', detail: normalizeError(e) }
    }
  }

  return { sendMessage, replyInThread, testConnection }
}
