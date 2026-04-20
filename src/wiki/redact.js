// API key / secret redaction for wiki source markdown.
// Catches obvious leak patterns; not a security guarantee — user should never
// paste real production secrets into todo descriptions, this is a seatbelt.

const PATTERNS = [
  // Anthropic / OpenAI sk- style keys
  /\bsk-[A-Za-z0-9_\-]{20,}\b/g,
  // AWS access key id
  /\bAKIA[0-9A-Z]{16}\b/g,
  // GitHub tokens (personal, oauth, server-to-server, refresh)
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  // Google API key
  /\bAIza[0-9A-Za-z_\-]{30,}\b/g,
  // Slack tokens
  /\bxox[baprs]-[A-Za-z0-9\-]{10,}\b/g,
]

// env-style SECRET_KEY=..., API_TOKEN=..., etc. Replace value but keep key.
const ENV_LINE = /\b([A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD))\s*=\s*\S+/g

// inline key: "value", api_key: 'value', password = "value"
const INLINE_KV = /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|token)\b\s*[:=]\s*['"]?[^\s'",}]{6,}/gi

export function redact(input) {
  if (input == null) return ''
  let s = typeof input === 'string' ? input : String(input)
  for (const re of PATTERNS) s = s.replace(re, '[REDACTED]')
  s = s.replace(ENV_LINE, (_, key) => `${key}=[REDACTED]`)
  s = s.replace(INLINE_KV, (match, key) => {
    const sep = match.includes(':') ? ':' : '='
    return `${key}${sep} [REDACTED]`
  })
  return s
}
