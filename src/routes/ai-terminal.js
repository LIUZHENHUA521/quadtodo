import { existsSync } from 'node:fs'
import { Router } from 'express'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createNotifier } from '../notifier.js'

const MAX_OUTPUT_BUFFER = 512 * 1024
const CLEANUP_MS = 30 * 60_000
const AUTO_CONFIRM_COOLDOWN_MS = 3000
const AUTO_CONFIRM_BYPASS_COOLDOWN_MS = 1500
const EDIT_CONFIRM_RE = /Do you want to (make this edit|create|write|apply)/i

export function createAiTerminal({ db, pty, logDir, defaultCwd, getDefaultCwd, getWebhookConfig, notifier: injectedNotifier }) {
  /** @type {Map<string, any>} */
  const sessions = new Map()
  /** @type {Map<string, string>} */
  const todoSessionMap = new Map()
  /** @type {Map<string, string>} */
  const nativeSessionMap = new Map()
  const notifier = injectedNotifier || createNotifier({ getWebhookConfig })

  function resolveSessionCwd(requestedCwd) {
    const fallback = getDefaultCwd?.() || defaultCwd || process.env.HOME || process.cwd()
    if (requestedCwd && existsSync(requestedCwd)) return requestedCwd
    if (fallback && existsSync(fallback)) return fallback
    return process.env.HOME || process.cwd()
  }

  function mergeTodoAiSessions(todo, nextSession) {
    const history = Array.isArray(todo?.aiSessions) ? todo.aiSessions : (todo?.aiSession ? [todo.aiSession] : [])
    const filtered = history.filter((item) => {
      if (!item) return false
      if (item.sessionId === nextSession.sessionId) return false
      if (nextSession.nativeSessionId && item.tool === nextSession.tool && item.nativeSessionId === nextSession.nativeSessionId) {
        return false
      }
      return true
    })
    return [nextSession, ...filtered]
  }

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

  function shouldAutoConfirm(session, confirmMatch) {
    if (!confirmMatch || !session.autoMode) return false
    if (session.autoMode === 'bypass') return true
    if (session.autoMode === 'acceptEdits') {
      return EDIT_CONFIRM_RE.test(session.recentOutput || '')
    }
    return false
  }

  function maybeAutoConfirm(session, confirmMatch) {
    if (!shouldAutoConfirm(session, confirmMatch)) return false
    const now = Date.now()
    const cooldown = session.autoMode === 'bypass' ? AUTO_CONFIRM_BYPASS_COOLDOWN_MS : AUTO_CONFIRM_COOLDOWN_MS
    if (now - (session.lastAutoConfirmAt || 0) < cooldown) return false
    session.lastAutoConfirmAt = now
    session.recentOutput = ''
    session.status = 'running'
    setTimeout(() => {
      pty.write(session.sessionId, '\r')
    }, 200)
    broadcastToSession(session, { type: 'auto_mode', autoMode: session.autoMode || null })
    return true
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
    session.recentOutput = `${session.recentOutput || ''}${data}`.slice(-4000)

    const confirmMatch = notifier.detectConfirmMatch(session.recentOutput)
    if (confirmMatch && maybeAutoConfirm(session, confirmMatch)) {
      return
    }
    if (confirmMatch && session.status !== 'pending_confirm') {
      session.status = 'pending_confirm'
      const todo = db.getTodo(session.todoId)
      if (todo) {
        const current = (todo.aiSessions || []).find(item => item.sessionId === sessionId) || todo.aiSession || {}
        db.updateTodo(session.todoId, {
          status: 'ai_pending',
          aiSessions: mergeTodoAiSessions(todo, {
            ...current,
            sessionId: session.sessionId,
            tool: session.tool,
            nativeSessionId: session.nativeSessionId || current.nativeSessionId || null,
            status: 'pending_confirm',
            startedAt: session.startedAt,
            completedAt: null,
            prompt: session.prompt,
          }),
        })
      }
      const snippet = session.recentOutput.slice(-500)
      broadcastToSession(session, { type: 'pending_confirm', snippet, matchedKeyword: confirmMatch })
      if (notifier.canNotifyPendingConfirm()) {
        void notifier.notify({
          sessionId,
          todoTitle: todo?.title,
          tool: session.tool,
          cwd: session.cwd,
          reason: 'pending_confirm',
          matchedKeyword: confirmMatch,
          snippet,
        }).catch((e) => {
          console.warn('[ai-terminal] pending_confirm webhook failed:', e.message)
        })
      }
    } else {
      const keywordMatch = notifier.detectKeywordMatch(session.recentOutput)
      if (keywordMatch) {
        const todo = db.getTodo(session.todoId)
        void notifier.notify({
          sessionId,
          todoTitle: todo?.title,
          tool: session.tool,
          cwd: session.cwd,
          reason: 'keyword_match',
          matchedKeyword: keywordMatch,
          snippet: session.recentOutput.slice(-500),
        }).catch((e) => {
          console.warn('[ai-terminal] keyword webhook failed:', e.message)
        })
      }
    }
    broadcastToSession(session, { type: 'output', data })
  })

  pty.on('native-session', ({ sessionId, nativeId }) => {
    const session = sessions.get(sessionId)
    if (!session) return
    if (session.nativeSessionId && session.nativeSessionId !== nativeId) {
      nativeSessionMap.delete(`${session.tool}:${session.nativeSessionId}`)
    }
    session.nativeSessionId = nativeId
    nativeSessionMap.set(`${session.tool}:${nativeId}`, sessionId)
    const todo = db.getTodo(session.todoId)
    if (todo) {
      const current = (todo.aiSessions || []).find(item => item.sessionId === sessionId) || todo.aiSession
      if (!current) return
      const nextAi = { ...current, nativeSessionId: nativeId, cwd: session.cwd || current.cwd || null }
      db.updateTodo(session.todoId, {
        aiSessions: mergeTodoAiSessions(todo, nextAi),
      })
    }
  })

  pty.on('done', ({ sessionId, exitCode, fullLog, nativeId, stopped }) => {
    const session = sessions.get(sessionId)
    if (!session) return
    if (session.nativeSessionId) nativeSessionMap.delete(`${session.tool}:${session.nativeSessionId}`)

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
        ...((todo.aiSessions || []).find(item => item.sessionId === session.sessionId) || todo.aiSession || {}),
        sessionId: session.sessionId,
        tool: session.tool,
        nativeSessionId: nativeId || session.nativeSessionId || null,
        cwd: session.cwd || null,
        status: aiStatus,
        startedAt: session.startedAt,
        completedAt: session.completedAt,
        prompt: session.prompt,
      }
      db.updateTodo(session.todoId, {
        status: todoStatus,
        aiSessions: mergeTodoAiSessions(todo, newAi),
      })
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
      if (resumeNativeId) {
        const existingNativeSessionId = nativeSessionMap.get(`${tool}:${resumeNativeId}`)
        if (existingNativeSessionId) {
          res.json({ ok: true, sessionId: existingNativeSessionId, reused: true })
          return
        }
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
      const sessionCwd = resolveSessionCwd(cwd)
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
        recentOutput: '',
        cwd: sessionCwd,
        autoMode: null,
        lastAutoConfirmAt: 0,
      }
      sessions.set(sessionId, session)
      todoSessionMap.set(todoId, sessionId)
      if (resumeNativeId) {
        nativeSessionMap.set(`${tool}:${resumeNativeId}`, sessionId)
      }

      db.updateTodo(todoId, {
        status: 'ai_running',
        aiSessions: mergeTodoAiSessions(todo, {
          sessionId,
          tool,
          nativeSessionId: resumeNativeId || null,
          cwd: sessionCwd,
          status: 'running',
          startedAt: session.startedAt,
          completedAt: null,
          prompt,
        }),
      })

      try {
        pty.start({
          sessionId,
          tool,
          prompt: resumeNativeId ? null : prompt,
          cwd: sessionCwd,
          resumeNativeId: resumeNativeId || undefined,
        })
      } catch (error) {
        sessions.delete(sessionId)
        if (todoSessionMap.get(todoId) === sessionId) todoSessionMap.delete(todoId)
        if (resumeNativeId) nativeSessionMap.delete(`${tool}:${resumeNativeId}`)
        throw error
      }

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
    ws.send(JSON.stringify({ type: 'auto_mode', autoMode: session.autoMode || null }))
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
    } else if (msg.type === 'set_auto_mode') {
      const session = sessions.get(sessionId)
      if (!session) return
      session.autoMode = msg.autoMode || null
      session.lastAutoConfirmAt = 0
      broadcastToSession(session, { type: 'auto_mode', autoMode: session.autoMode || null })
      const confirmMatch = notifier.detectConfirmMatch(session.recentOutput || '')
      maybeAutoConfirm(session, confirmMatch)
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
        if (s.nativeSessionId) nativeSessionMap.delete(`${s.tool}:${s.nativeSessionId}`)
      }
    }
  }, 5 * 60_000)
  cleanupTimer.unref?.()

  function close() {
    clearInterval(cleanupTimer)
    for (const id of sessions.keys()) pty.stop(id)
    sessions.clear()
    todoSessionMap.clear()
    nativeSessionMap.clear()
  }

  function recoverPendingTodosOnStartup() {
    const todos = db.listTodos()
      .filter(todo => ['ai_running', 'ai_pending'].includes(todo.status))
    for (const todo of todos) {
      const recoverable = (todo.aiSessions || []).find(item => item?.nativeSessionId && (item.status === 'running' || item.status === 'pending_confirm'))
        || (todo.aiSessions || []).find(item => item?.nativeSessionId)
      if (!recoverable) {
        db.updateTodo(todo.id, { status: 'todo' })
        continue
      }
      if (nativeSessionMap.has(`${recoverable.tool}:${recoverable.nativeSessionId}`)) continue
      const sessionId = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      const cwd = resolveSessionCwd(recoverable.cwd || todo.workDir)
      const session = {
        sessionId,
        todoId: todo.id,
        tool: recoverable.tool,
        prompt: recoverable.prompt,
        status: 'running',
        startedAt: Date.now(),
        completedAt: null,
        browsers: new Set(),
        outputHistory: [],
        outputSize: 0,
        nativeSessionId: recoverable.nativeSessionId,
        recentOutput: '',
        cwd,
        autoMode: null,
        lastAutoConfirmAt: 0,
      }
      sessions.set(sessionId, session)
      todoSessionMap.set(todo.id, sessionId)
      nativeSessionMap.set(`${recoverable.tool}:${recoverable.nativeSessionId}`, sessionId)
      db.updateTodo(todo.id, {
        status: 'ai_running',
        aiSessions: mergeTodoAiSessions(todo, {
          ...recoverable,
          sessionId,
          cwd,
          status: 'running',
          startedAt: Date.now(),
          completedAt: null,
        }),
      })
      try {
        pty.start({
          sessionId,
          tool: recoverable.tool,
          prompt: null,
          cwd,
          resumeNativeId: recoverable.nativeSessionId,
        })
      } catch (e) {
        console.warn('[ai-terminal] auto-recover failed:', e.message)
        sessions.delete(sessionId)
        todoSessionMap.delete(todo.id)
        nativeSessionMap.delete(`${recoverable.tool}:${recoverable.nativeSessionId}`)
        db.updateTodo(todo.id, { status: 'todo' })
      }
    }
  }

  recoverPendingTodosOnStartup()

  return {
    router,
    sessions,
    todoSessionMap,
    nativeSessionMap,
    addBrowser,
    removeBrowser,
    handleBrowserMessage,
    broadcastToSession,
    close,
  }
}
