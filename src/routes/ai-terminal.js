import { Router } from 'express'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_OUTPUT_BUFFER = 512 * 1024
const CLEANUP_MS = 30 * 60_000

export function createAiTerminal({ db, pty, logDir }) {
  /** @type {Map<string, any>} */
  const sessions = new Map()
  /** @type {Map<string, string>} */
  const todoSessionMap = new Map()

  function broadcastToSession(session, msg) {
    const data = JSON.stringify(msg)
    for (const ws of session.browsers) {
      if (ws.readyState === ws.OPEN) ws.send(data)
    }
  }

  function appendOutput(session, data) {
    session.outputHistory.push(data)
    session.outputSize += data.length
    while (session.outputSize > MAX_OUTPUT_BUFFER && session.outputHistory.length > 1) {
      const removed = session.outputHistory.shift()
      session.outputSize -= removed.length
    }
  }

  async function writeFullLog(sessionId, fullLog) {
    if (!logDir || !fullLog) return
    try {
      await mkdir(logDir, { recursive: true })
      const tail = fullLog.length > MAX_OUTPUT_BUFFER ? fullLog.slice(-MAX_OUTPUT_BUFFER) : fullLog
      await writeFile(join(logDir, `${sessionId}.log`), tail, 'utf8')
    } catch (e) {
      console.warn('[ai-terminal] write log failed:', e.message)
    }
  }

  // ─── PTY event wiring ───

  pty.on('output', ({ sessionId, data }) => {
    const session = sessions.get(sessionId)
    if (!session) return
    appendOutput(session, data)
    broadcastToSession(session, { type: 'output', data })
  })

  pty.on('native-session', ({ sessionId, nativeId }) => {
    const session = sessions.get(sessionId)
    if (!session) return
    session.nativeSessionId = nativeId
    const todo = db.getTodo(session.todoId)
    if (todo && todo.aiSession) {
      db.updateTodo(session.todoId, {
        aiSession: { ...todo.aiSession, nativeSessionId: nativeId },
      })
    }
  })

  pty.on('done', ({ sessionId, exitCode, fullLog, nativeId, stopped }) => {
    const session = sessions.get(sessionId)
    if (!session) return

    let aiStatus, todoStatus
    if (stopped) {
      aiStatus = 'stopped'
      todoStatus = 'todo'
    } else if (exitCode === 0) {
      aiStatus = 'done'
      todoStatus = 'ai_done'
    } else {
      aiStatus = 'failed'
      todoStatus = 'todo'
    }

    session.status = aiStatus
    session.completedAt = Date.now()

    const todo = db.getTodo(session.todoId)
    if (todo) {
      const newAi = {
        ...(todo.aiSession || {}),
        sessionId: session.sessionId,
        tool: session.tool,
        nativeSessionId: nativeId || todo.aiSession?.nativeSessionId || null,
        status: aiStatus,
        startedAt: session.startedAt,
        completedAt: session.completedAt,
        prompt: session.prompt,
      }
      db.updateTodo(session.todoId, { status: todoStatus, aiSession: newAi })
    }

    writeFullLog(sessionId, fullLog)
    broadcastToSession(session, { type: 'done', exitCode, status: aiStatus })
  })

  // ─── REST ───

  const router = Router()

  router.post('/exec', (req, res) => {
    try {
      const { todoId, prompt, tool, cwd, resumeNativeId } = req.body || {}
      if (!todoId || !prompt || !tool) {
        res.status(400).json({ ok: false, error: 'missing todoId, prompt, or tool' })
        return
      }
      if (!['claude', 'codex'].includes(tool)) {
        res.status(400).json({ ok: false, error: 'invalid tool' })
        return
      }
      const todo = db.getTodo(todoId)
      if (!todo) {
        res.status(404).json({ ok: false, error: 'todo_not_found' })
        return
      }
      const existingId = todoSessionMap.get(todoId)
      if (existingId) {
        const existing = sessions.get(existingId)
        if (existing && (existing.status === 'running' || existing.status === 'pending_confirm')) {
          res.status(409).json({ ok: false, error: 'todo_session_running', sessionId: existingId })
          return
        }
      }

      const sessionId = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      const session = {
        sessionId,
        todoId,
        tool,
        prompt,
        status: 'running',
        startedAt: Date.now(),
        completedAt: null,
        browsers: new Set(),
        outputHistory: [],
        outputSize: 0,
        nativeSessionId: resumeNativeId || null,
      }
      sessions.set(sessionId, session)
      todoSessionMap.set(todoId, sessionId)

      db.updateTodo(todoId, {
        status: 'ai_running',
        aiSession: {
          sessionId,
          tool,
          nativeSessionId: resumeNativeId || null,
          status: 'running',
          startedAt: session.startedAt,
          completedAt: null,
          prompt,
        },
      })

      pty.start({
        sessionId,
        tool,
        prompt: resumeNativeId ? null : prompt,
        cwd: cwd || process.env.HOME || process.cwd(),
        resumeNativeId: resumeNativeId || undefined,
      })

      res.json({ ok: true, sessionId })
    } catch (e) {
      console.error('[ai-terminal/exec]', e)
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  router.post('/stop', (req, res) => {
    try {
      const { sessionId } = req.body || {}
      const session = sessions.get(sessionId)
      if (!session) {
        res.status(404).json({ ok: false, error: 'session_not_found' })
        return
      }
      pty.stop(sessionId)
      // pty 'done' event will fire and broadcast 'done' to browsers;
      // that handler sets todo.status to 'todo' because stopped=true.
      broadcastToSession(session, { type: 'stopped' })
      res.json({ ok: true })
    } catch (e) {
      console.error('[ai-terminal/stop]', e)
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  // ─── WebSocket hooks (called from server.js on upgrade) ───

  function addBrowser(sessionId, ws) {
    const session = sessions.get(sessionId)
    if (!session) {
      try {
        ws.send(JSON.stringify({ type: 'error', error: 'session_not_found' }))
        ws.close?.(4004, 'session_not_found')
      } catch { /* ignore */ }
      return
    }
    session.browsers.add(ws)
    if (session.outputHistory.length > 0) {
      ws.send(JSON.stringify({ type: 'replay', chunks: session.outputHistory }))
    }
    if (session.status === 'done' || session.status === 'failed' || session.status === 'stopped') {
      ws.send(JSON.stringify({ type: 'done', status: session.status }))
    }
  }

  function removeBrowser(sessionId, ws) {
    const session = sessions.get(sessionId)
    if (!session) return
    session.browsers.delete(ws)
  }

  function handleBrowserMessage(sessionId, msg) {
    if (msg.type === 'input') {
      pty.write(sessionId, msg.data)
    } else if (msg.type === 'resize') {
      pty.resize(sessionId, msg.cols, msg.rows)
    }
  }

  // ─── Cleanup of stale finished sessions (30 min) ───

  const cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - CLEANUP_MS
    for (const [id, s] of sessions) {
      if (s.status !== 'running' && s.status !== 'pending_confirm'
          && s.completedAt && s.completedAt < cutoff
          && s.browsers.size === 0) {
        sessions.delete(id)
        if (todoSessionMap.get(s.todoId) === id) todoSessionMap.delete(s.todoId)
      }
    }
  }, 5 * 60_000)
  cleanupTimer.unref?.()

  function close() {
    clearInterval(cleanupTimer)
    for (const id of sessions.keys()) pty.stop(id)
    sessions.clear()
    todoSessionMap.clear()
  }

  return {
    router,
    sessions,
    todoSessionMap,
    addBrowser,
    removeBrowser,
    handleBrowserMessage,
    broadcastToSession,
    close,
  }
}
