// Pure helpers: given already-read JSONL lines + tool, return usage summary.
// No I/O. No throw on bad lines; returns parseErrorCount instead.

const MODEL_DATE_SUFFIX = /-\d{8}$/ // e.g. "-20260101"

function normalizeModel(name) {
  if (!name) return null
  return String(name).replace(MODEL_DATE_SUFFIX, '')
}

function pickMode(counter) {
  let best = null, bestN = -1
  for (const [k, n] of counter) if (n > bestN) { best = k; bestN = n }
  return best
}

// Shared accumulation: takes normalized records { usage, model, ts } and returns summary.
function accumulateRecords(records, idleThresholdMs) {
  let input = 0, output = 0, cacheR = 0, cacheC = 0
  const modelCounter = new Map()
  const assistantTs = []
  for (const { usage: u = {}, model, ts } of records) {
    input  += Number(u.input_tokens)  || 0
    output += Number(u.output_tokens) || 0
    cacheR += Number(u.cache_read_input_tokens)     || 0
    cacheC += Number(u.cache_creation_input_tokens) || 0
    if (model) modelCounter.set(model, (modelCounter.get(model) || 0) + 1)
    if (!Number.isNaN(ts)) assistantTs.push(ts)
  }
  let activeMs = 0
  assistantTs.sort((a, b) => a - b)
  for (let i = 1; i < assistantTs.length; i++) {
    const dt = assistantTs[i] - assistantTs[i - 1]
    if (dt > 0 && dt <= idleThresholdMs) activeMs += dt
  }
  return {
    inputTokens: input, outputTokens: output,
    cacheReadTokens: cacheR, cacheCreationTokens: cacheC,
    primaryModel: pickMode(modelCounter),
    activeMs,
  }
}

function extractClaude(lines, { idleThresholdMs }) {
  const records = []
  let errors = 0
  for (const line of lines) {
    if (!line || !line.trim()) continue
    let j
    try { j = JSON.parse(line) } catch { errors++; continue }
    const msg = j.message
    if (msg?.role !== 'assistant') continue
    records.push({
      usage: msg.usage || {},
      model: normalizeModel(msg.model),
      ts: j.timestamp ? Date.parse(j.timestamp) : NaN,
    })
  }
  return { ...accumulateRecords(records, idleThresholdMs), parseErrorCount: errors }
}

function extractCodex(lines, { idleThresholdMs }) {
  const records = []
  let errors = 0
  for (const line of lines) {
    if (!line || !line.trim()) continue
    let j
    try { j = JSON.parse(line) } catch { errors++; continue }
    if (j.type !== 'response_item') continue
    const p = j.payload
    if (!p || p.type !== 'message' || p.role !== 'assistant') continue
    records.push({
      usage: p.token_usage || p.usage || {},
      model: normalizeModel(p.model),
      ts: j.timestamp ? Date.parse(j.timestamp) : NaN,
    })
  }
  return { ...accumulateRecords(records, idleThresholdMs), parseErrorCount: errors }
}

export function extractUsage(tool, lines, opts = {}) {
  const o = { idleThresholdMs: 120_000, ...opts }
  if (tool === 'claude') return extractClaude(lines, o)
  if (tool === 'codex')  return extractCodex(lines, o)
  throw new Error(`unknown tool: ${tool}`)
}
