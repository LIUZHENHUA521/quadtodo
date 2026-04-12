const DEFAULT_CONFIRM_PATTERNS = [
  /Press Enter to confirm/i,
  /Do you want to proceed/i,
  /Do you want to /i,
  /Continue\?/i,
  /Proceed\?/i,
  /\(y\/n\)/i,
  /\[Y\/n\]/i,
  /\[yes\/no\]/i,
  /确认/i,
  /是否继续/i,
  /按回车确认/i,
]

function compactText(text = '') {
  return String(text)
    .replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeWebhookConfig(config) {
  return {
    enabled: Boolean(config?.enabled),
    provider: config?.provider || 'wecom',
    url: config?.url || '',
    keywords: Array.isArray(config?.keywords) ? config.keywords.map(item => String(item).trim()).filter(Boolean) : [],
    cooldownMs: Number(config?.cooldownMs) > 0 ? Number(config.cooldownMs) : 180000,
    notifyOnPendingConfirm: config?.notifyOnPendingConfirm !== false,
    notifyOnKeywordMatch: config?.notifyOnKeywordMatch !== false,
  }
}

function buildPatterns(config) {
  const userPatterns = config.keywords
    .map(keyword => {
      try {
        return new RegExp(keyword, 'i')
      } catch {
        return new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      }
    })
  return [...DEFAULT_CONFIRM_PATTERNS, ...userPatterns]
}

async function postWebhook(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`webhook_failed_${res.status}`)
  }
}

function buildMessagePayload(provider, text) {
  if (provider === 'feishu') {
    return {
      msg_type: 'text',
      content: { text },
    }
  }
  return {
    msgtype: 'text',
    text: { content: text },
  }
}

export function createNotifier({ getWebhookConfig, getAppUrl = () => 'http://127.0.0.1:5677/' } = {}) {
  const sentState = new Map()

  function shouldNotify({ sessionId, fingerprint, cooldownMs }) {
    const key = `${sessionId}:${fingerprint}`
    const lastAt = sentState.get(key) || 0
    const now = Date.now()
    if (now - lastAt < cooldownMs) return false
    sentState.set(key, now)
    return true
  }

  function detectKeywordMatch(text) {
    const config = normalizeWebhookConfig(getWebhookConfig?.())
    const haystack = compactText(text)
    if (!config.enabled || !config.notifyOnKeywordMatch || !haystack) return null
    for (const pattern of buildPatterns(config)) {
      if (pattern.test(haystack)) {
        return pattern.source
      }
    }
    return null
  }

  function detectConfirmMatch(text) {
    const haystack = compactText(text)
    if (!haystack) return null
    for (const pattern of DEFAULT_CONFIRM_PATTERNS) {
      if (pattern.test(haystack)) {
        return pattern.source
      }
    }
    return null
  }

  async function notify({ sessionId, todoTitle, tool, cwd, reason, matchedKeyword, snippet }) {
    const config = normalizeWebhookConfig(getWebhookConfig?.())
    if (!config.enabled || !config.url) return false

    const fingerprint = reason === 'pending_confirm'
      ? 'pending_confirm'
      : `keyword:${matchedKeyword || 'unknown'}`

    if (!shouldNotify({ sessionId, fingerprint, cooldownMs: config.cooldownMs })) {
      return false
    }

    const lines = [
      '[quadtodo] AI 需要人工确认',
      `任务: ${todoTitle || '-'}`,
      `工具: ${tool || '-'}`,
      `原因: ${reason === 'pending_confirm' ? 'pending_confirm' : 'keyword_match'}`,
      matchedKeyword ? `关键词: ${matchedKeyword}` : null,
      cwd ? `目录: ${cwd}` : null,
      `会话: ${String(sessionId).slice(0, 16)}`,
      `访问: ${getAppUrl()}`,
      snippet ? `上下文: ${compactText(snippet).slice(0, 240)}` : null,
    ].filter(Boolean)

    await postWebhook(config.url, buildMessagePayload(config.provider, lines.join('\n')))
    return true
  }

  function canNotifyPendingConfirm() {
    const config = normalizeWebhookConfig(getWebhookConfig?.())
    return config.enabled && config.notifyOnPendingConfirm && Boolean(config.url)
  }

  return {
    detectConfirmMatch,
    detectKeywordMatch,
    notify,
    canNotifyPendingConfirm,
  }
}
