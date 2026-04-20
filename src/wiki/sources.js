function pad(n) { return String(n).padStart(2, '0') }

function toDate(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function toDateTime(ts) {
  const d = new Date(ts)
  return `${toDate(ts)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function shortId(id) {
  return String(id).slice(0, 8)
}

function hoursBetween(startMs, endMs) {
  if (!startMs || !endMs) return null
  return +((endMs - startMs) / 3_600_000).toFixed(2)
}

export function sourceFileName(todo, nowMs = Date.now()) {
  return `${toDate(nowMs)}-${shortId(todo.id)}.md`
}

function renderTurn(turn) {
  const roleMap = {
    user: '用户',
    assistant: 'AI',
    thinking: '思考',
    tool_use: `工具调用(${turn.toolName || ''})`,
    tool_result: '工具输出',
    raw: '原始',
  }
  const role = roleMap[turn.role] || turn.role
  const content = String(turn.content || '')
  return `【${role}】${content}`
}

export async function buildSourceMarkdown({
  todo,
  comments = [],
  loadTranscript,
  summarize,
  redact,
  maxTailTurns = 20,
  maxBytes = 128 * 1024,
  now = Date.now(),
}) {
  const lines = []

  const duration = hoursBetween(todo.createdAt, todo.updatedAt)
  lines.push('---')
  lines.push(`todoId: ${todo.id}`)
  lines.push(`title: ${todo.title.replace(/\n/g, ' ')}`)
  lines.push(`quadrant: ${todo.quadrant}`)
  lines.push(`workDir: ${todo.workDir || '-'}`)
  lines.push(`createdAt: ${new Date(todo.createdAt).toISOString()}`)
  lines.push(`completedAt: ${new Date(todo.updatedAt).toISOString()}`)
  if (duration != null) lines.push(`durationHours: ${duration}`)
  lines.push('---')
  lines.push('')
  lines.push(`# ${todo.title}`)
  lines.push('')

  if (todo.description && todo.description.trim()) {
    lines.push('## 描述')
    lines.push(redact(todo.description))
    lines.push('')
  }

  if (comments.length) {
    lines.push(`## 评论（${comments.length}）`)
    for (const c of comments) {
      lines.push(`- [${toDateTime(c.createdAt)}] ${redact(c.content)}`)
    }
    lines.push('')
  }

  const sessions = Array.isArray(todo.aiSessions) ? todo.aiSessions : []
  if (sessions.length) {
    lines.push('## AI 会话')
    let idx = 0
    for (const s of sessions) {
      idx += 1
      const parsed = loadTranscript(s) || { source: 'empty', turns: [] }
      const turns = Array.isArray(parsed.turns) ? parsed.turns : []
      const completed = s.completedAt ? toDateTime(s.completedAt) : '-'
      lines.push(`### Session ${idx} — ${s.tool}（${turns.length} 轮，完成时间 ${completed}）`)

      let summary = ''
      if (turns.length) {
        try {
          summary = await summarize(turns, { tool: s.tool })
        } catch (e) {
          summary = `（摘要失败：${e.message}）`
        }
      }
      if (summary) {
        lines.push(`**摘要**：${redact(summary)}`)
        lines.push('')
      }

      const tail = turns.slice(-maxTailTurns)
      if (tail.length) {
        lines.push(`**最后 ${tail.length} 轮原文**：`)
        lines.push('')
        for (const t of tail) {
          lines.push(redact(renderTurn(t)))
          lines.push('')
        }
      }
    }
  }

  let out = lines.join('\n')
  if (Buffer.byteLength(out, 'utf8') > maxBytes) {
    const head = out.slice(0, maxBytes - 200)
    out = `${head}\n\n...（内容过长已截断，原始 transcript 保留在本地）...\n`
  }
  return out
}
