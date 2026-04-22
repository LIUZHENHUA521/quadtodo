import { existsSync } from 'node:fs'
import { Router } from 'express'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import pidusage from 'pidusage'
import { createNotifier } from '../notifier.js'

const MAX_OUTPUT_BUFFER = 512 * 1024
const CLEANUP_MS = 30 * 60_000

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
    session.lastOutputAt = Date.now()
    session.outputBytesTotal = (session.outputBytesTotal || 0) + data.length

    const confirmMatch = notifier.detectConfirmMatch(session.recentOutput)
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

    // 落库一条历史记录，供仪表盘 Tab C 统计使用
    try {
      const todoQuadrant = todo?.quadrant ?? 4
      db.insertSessionLog({
        id: session.sessionId,
        todoId: session.todoId,
        tool: session.tool,
        quadrant: todoQuadrant,
        status: aiStatus,
        exitCode: exitCode ?? null,
        startedAt: session.startedAt,
        completedAt: session.completedAt,
      })
    } catch (e) {
      console.warn('[ai-terminal] insertSessionLog failed:', e.message)
    }
  })

  // ─── REST ───

  const router = Router()

  router.post('/exec', (req, res) => {
    try {
      const { todoId, prompt, tool, cwd, resumeNativeId, permissionMode } = req.body || {}
      if (!todoId || typeof prompt !== 'string' || !tool) {
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
        currentCwd: sessionCwd,
        autoMode: permissionMode && permissionMode !== 'default' ? permissionMode : null,
        lastOutputAt: null,
        outputBytesTotal: 0,
        completedAt: null,
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
          permissionMode: permissionMode || null,
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

  // 返回当前内存中的所有会话（包含已完成的"雕像期"），供仪表盘和宠物视图使用
  router.get('/sessions', (req, res) => {
    try {
      const out = []
      for (const [sessionId, s] of sessions) {
        const todo = db.getTodo(s.todoId)
        out.push({
          sessionId,
          todoId: s.todoId,
          todoTitle: todo?.title || '',
          quadrant: todo?.quadrant || 4,
          tool: s.tool,
          status: s.status,
          autoMode: s.autoMode || null,
          nativeSessionId: s.nativeSessionId || null,
          cwd: s.cwd || null,
          startedAt: s.startedAt,
          completedAt: s.completedAt || null,
          lastOutputAt: s.lastOutputAt || null,
          outputBytesTotal: s.outputBytesTotal || 0,
        })
      }
      res.json({ ok: true, sessions: out })
    } catch (e) {
      console.error('[ai-terminal/sessions]', e)
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  // 聚合历史统计：range=today|week|month
  router.get('/stats', (req, res) => {
    try {
      const range = req.query.range || 'today'
      const now = Date.now()
      let since = now - 86400_000
      if (range === 'week') since = now - 7 * 86400_000
      else if (range === 'month') since = now - 30 * 86400_000
      const stats = db.querySessionStats({ since, until: now })
      res.json({ ok: true, range, since, until: now, stats })
    } catch (e) {
      console.error('[ai-terminal/stats]', e)
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  // 当前所有 PTY 进程的 CPU/内存快照
  router.get('/resource', async (req, res) => {
    try {
      const pids = pty.getPids ? pty.getPids() : []
      if (!pids.length) {
        res.json({ ok: true, resources: [] })
        return
      }
      const pidList = pids.map(p => p.pid)
      let usage = {}
      try {
        usage = await pidusage(pidList)
      } catch (err) {
        // 部分 pid 可能已退出，单独采样避免一错全错
        for (const pid of pidList) {
          try { usage[pid] = await pidusage(pid) } catch { /* skip dead pid */ }
        }
      }
      const now = Date.now()
      const resources = pids.map(({ sessionId, pid, tool }) => {
        const u = usage[pid]
        const session = sessions.get(sessionId)
        const todo = session ? db.getTodo(session.todoId) : null
        return {
          sessionId,
          todoId: session?.todoId || null,
          todoTitle: todo?.title || '',
          tool,
          pid,
          cpu: u?.cpu ?? 0,
          memory: u?.memory ?? 0,
          elapsedMs: session?.startedAt ? (now - session.startedAt) : 0,
        }
      })
      res.json({ ok: true, resources })
    } catch (e) {
      console.error('[ai-terminal/resource]', e)
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

  router.post('/input', (req, res) => {
    try {
      const { sessionId, data } = req.body || {}
      if (!sessionId || typeof data !== 'string') {
        res.status(400).json({ ok: false, error: 'missing sessionId or data' })
        return
      }
      const session = sessions.get(sessionId)
      if (!session) {
        res.status(404).json({ ok: false, error: 'session_not_found' })
        return
      }
      clearPendingConfirm(session)
      pty.write(sessionId, data)
      res.json({ ok: true })
    } catch (e) {
      console.error('[ai-terminal/input]', e)
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

  function clearPendingConfirm(session) {
    if (!session || session.status !== 'pending_confirm') return
    session.status = 'running'
    // 清空 recentOutput，避免旧的 confirm 文本残留导致下次 output 再次匹配
    session.recentOutput = ''
    const todo = db.getTodo(session.todoId)
    if (todo) {
      const current = (todo.aiSessions || []).find(item => item.sessionId === session.sessionId) || todo.aiSession || {}
      db.updateTodo(session.todoId, {
        status: 'ai_running',
        aiSessions: mergeTodoAiSessions(todo, {
          ...current,
          sessionId: session.sessionId,
          tool: session.tool,
          nativeSessionId: session.nativeSessionId || current.nativeSessionId || null,
          status: 'running',
          startedAt: session.startedAt,
          completedAt: null,
          prompt: session.prompt,
        }),
      })
    }
    broadcastToSession(session, { type: 'pending_cleared' })
  }

  function handleBrowserMessage(sessionId, msg) {
    if (msg.type === 'input') {
      const session = sessions.get(sessionId)
      clearPendingConfirm(session)
      pty.write(sessionId, msg.data)
    } else if (msg.type === 'resize') {
      pty.resize(sessionId, msg.cols, msg.rows)
    } else if (msg.type === 'set_auto_mode') {
      const session = sessions.get(sessionId)
      if (!session) return
      session.autoMode = msg.autoMode || null
      broadcastToSession(session, { type: 'auto_mode', autoMode: session.autoMode || null })
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
        currentCwd: cwd,
        autoMode: null,
        lastOutputAt: null,
        outputBytesTotal: 0,
        completedAt: null,
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
