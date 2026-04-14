import { spawn } from 'node:child_process'

const MAX_INPUT_CHARS = 24000

function turnsToText(turns) {
  const lines = []
  for (const t of turns) {
    const role = t.role === 'user' ? '用户'
      : t.role === 'assistant' ? 'AI'
      : t.role === 'thinking' ? '思考'
      : t.role === 'tool_use' ? `工具调用(${t.toolName || ''})`
      : t.role === 'tool_result' ? '工具输出'
      : t.role
    const content = String(t.content || '').slice(0, 2000)
    lines.push(`【${role}】${content}`)
  }
  let text = lines.join('\n\n')
  if (text.length > MAX_INPUT_CHARS) {
    const head = text.slice(0, MAX_INPUT_CHARS / 2)
    const tail = text.slice(-MAX_INPUT_CHARS / 2)
    text = `${head}\n\n...（中间已省略）...\n\n${tail}`
  }
  return text
}

function runCli(cmd, args, input, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM') } catch { /* ignore */ }
      reject(new Error(`${cmd} summarize timeout`))
    }, timeoutMs)
    proc.stdout.on('data', d => { out += d.toString() })
    proc.stderr.on('data', d => { err += d.toString() })
    proc.on('error', e => { clearTimeout(timer); reject(e) })
    proc.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve(out.trim())
      else reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 500)}`))
    })
    if (input != null) {
      proc.stdin.write(input)
      proc.stdin.end()
    }
  })
}

const SYSTEM_PROMPT = `你是一个对话摘要助手。请把下面的 AI 开发会话历史压缩为一段结构化的中文摘要，供继续对话使用。要求：
1) 核心目标与任务背景（1-2 句）
2) 已确认的关键决策 / 结论（要点列表）
3) 仍未解决的问题 / 下一步 TODO（要点列表）
4) 重要的代码路径、函数名、命令（如有）
不要输出客套话，只输出摘要。`

export async function summarizeTurns(turns, { tool = 'claude' } = {}) {
  if (!Array.isArray(turns) || turns.length === 0) return ''
  const body = turnsToText(turns)
  const input = `${SYSTEM_PROMPT}\n\n=== 会话历史 ===\n${body}\n\n=== 请输出摘要 ===\n`

  if (tool === 'codex') {
    try {
      return await runCli('codex', ['exec', '--skip-git-repo-check', '-'], input)
    } catch (e) {
      console.warn('[summarize] codex failed, fallback to claude:', e.message)
    }
  }
  try {
    return await runCli('claude', ['-p', '--output-format', 'text'], input)
  } catch (e) {
    console.warn('[summarize] claude failed:', e.message)
    return `（自动摘要失败：${e.message}）\n\n原始会话片段：\n${body.slice(0, 2000)}`
  }
}
