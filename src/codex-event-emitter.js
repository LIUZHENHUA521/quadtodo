import { watch, watchFile, unwatchFile, openSync, readSync, closeSync, statSync } from 'node:fs'

const ABORT_DEDUP_MS = 100

/**
 * 监听 codex rollout-*.jsonl 文件增量并把关键事件抛给上层。
 * - task_complete → Stop
 * - turn_aborted  → TurnAborted（与 <turn_aborted> 用户消息 100ms 内去重）
 * - error         → Error
 * 同时记录最新一条 assistant 文本，给 getLatestAssistantContent() 用。
 */
export function createCodexEventEmitter({ filePath, nativeId, onEvent, logger = console } = {}) {
  if (!filePath || !nativeId || !onEvent) throw new Error('filePath, nativeId, onEvent required')

  let pos = 0
  let watcher = null
  let pollTimer = null
  let buffer = ''
  let latestAssistantText = ''
  let lastAbortTs = 0

  function readNew() {
    let stat
    try { stat = statSync(filePath) } catch { return }
    if (stat.size <= pos) return
    const fd = openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(stat.size - pos)
      readSync(fd, buf, 0, buf.length, pos)
      pos = stat.size
      buffer += buf.toString('utf8')
    } finally {
      closeSync(fd)
    }
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      if (!line.trim()) continue
      try { handleLine(JSON.parse(line)) }
      catch (e) { logger.warn?.(`[codex-emitter] bad jsonl line ignored: ${e.message}`) }
    }
  }

  function handleLine(j) {
    const t = j?.type
    const p = j?.payload
    if (t === 'event_msg') {
      const pt = p?.type
      if (pt === 'task_complete') {
        onEvent({ event: 'Stop', nativeId, rawEventPayload: p })
      } else if (pt === 'turn_aborted') {
        lastAbortTs = Date.now()
        onEvent({ event: 'TurnAborted', nativeId, rawEventPayload: p })
      } else if (pt === 'error') {
        onEvent({ event: 'Error', nativeId, rawEventPayload: p })
      }
    } else if (t === 'response_item') {
      const pt = p?.type
      if (pt === 'message' && p?.role === 'assistant' && Array.isArray(p?.content)) {
        const text = p.content.map(c => c?.text || '').join('')
        if (text) latestAssistantText = text
      } else if (pt === 'message' && p?.role === 'user' && Array.isArray(p?.content)) {
        // Dedup with sibling event_msg/turn_aborted
        const txt = p.content.map(c => c?.text || '').join('')
        if (txt.includes('<turn_aborted>') && Date.now() - lastAbortTs < ABORT_DEDUP_MS) {
          // suppress
        }
      }
    }
  }

  function start() {
    // 注意：开始时不要把 pos 推到当前文件末尾，否则 fs.watch 在 macOS 上对刚 append
    // 进来的内容偶尔不触发，会丢首批事件。从 0 起读 + dedup 不必要 —— 文件是会话私有的。
    pos = 0
    readNew()
    try { watcher = watch(filePath, () => readNew()) } catch {}
    // fs.watch 在 APFS / 网络盘上偶尔不触发，watchFile 30ms 轮询做兜底
    watchFile(filePath, { interval: 30, persistent: false }, () => readNew())
    // setInterval 自轮询：watchFile 用 Node 的中央 polling 线程，并发跑很多 emitter
    // 时会被压垮（实测 vitest fork pool 全套 batch 下 watchFile 3 秒不触发）；这里
    // 自己每 50ms statSync 一次，跟 OS 通知双保险，加 stat 廉价。
    pollTimer = setInterval(readNew, 50)
    if (pollTimer.unref) pollTimer.unref()
  }

  function stop() {
    if (watcher) {
      try { watcher.close() } catch {}
      watcher = null
    }
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    try { unwatchFile(filePath) } catch {}
  }

  function getLatestAssistantContent() {
    return latestAssistantText
  }

  // 给 PtyManager.onExit 用：codex 自己不会在 jsonl 里写 SessionEnd（它就只是
  // 进程结束），所以由外层合成一条事件触发"会话整体结束"分支。
  function emitSynthetic(evt) {
    onEvent({ ...evt, nativeId: evt.nativeId ?? nativeId })
  }

  return { start, stop, getLatestAssistantContent, emitSynthetic }
}
