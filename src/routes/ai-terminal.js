import { existsSync } from 'node:fs'
import { Router } from 'express'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import pidusage from 'pidusage'
import { createNotifier } from '../notifier.js'

const MAX_OUTPUT_BUFFER = 512 * 1024
const CLEANUP_MS = 30 * 60_000

export function createAiTerminal({ db, pty, logDir, defaultCwd, getDefaultCwd, getWebhookConfig, notifier: injectedNotifier, onSessionSpawned = null, onSessionEnded = null }) {
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
      // 用户主动通过删/关 topic 触发的 stop：handleTopicEvent 已把 todo 标 done，
      // 这里别用 stopped→'todo' 的默认逻辑覆写它。只更 aiSessions（记录会话退出状态）。
      const updates = { aiSessions: mergeTodoAiSessions(todo, newAi) }
      if (session.userClosedReason !== 'topic_closed') {
        updates.status = todoStatus
      }
      db.updateTodo(session.todoId, updates)
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

    // Telegram 自动关 topic 钩子：PTY 自然退出 / crash / exit 命令都走这里
    if (typeof onSessionEnded === 'function') {
      try {
        const r = onSessionEnded({
          sessionId,
          todoId: session.todoId,
          exitCode,
          status: aiStatus,
          startedAt: session.startedAt,
          completedAt: session.completedAt,
        })
        if (r && typeof r.catch === 'function') r.catch((e) => console.warn(`[ai-terminal] onSessionEnded failed: ${e.message}`))
      } catch (e) { console.warn(`[ai-terminal] onSessionEnded threw: ${e.message}`) }
    }
  })

  // ─── 程序化 session 启动入口（供 orchestrator 等模块直接调用，跳过 HTTP） ───
  function spawnSession({ todoId, prompt, tool, cwd, resumeNativeId, permissionMode, label, extraEnv, sessionId: externalSessionId, skipTelegram = false }) {
    if (!todoId || typeof prompt !== 'string' || !tool) {
      const err = new Error('missing todoId, prompt, or tool'); err.code = 'bad_request'
      throw err
    }
    if (!['claude', 'codex'].includes(tool)) {
      const err = new Error('invalid tool'); err.code = 'bad_request'
      throw err
    }
    const todo = db.getTodo(todoId)
    if (!todo) {
      const err = new Error('todo_not_found'); err.code = 'not_found'
      throw err
    }
    if (resumeNativeId) {
      const existing = nativeSessionMap.get(`${tool}:${resumeNativeId}`)
      if (existing) return { sessionId: existing, reused: true }
    }

    const sessionId = externalSessionId || `ai-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    let sessionCwd = resolveSessionCwd(cwd)
    // 跟 recoverPendingTodosOnStartup 同样的 claude resume cwd 漂移修正：
    // 前端把 session.cwd 原样回传，但那个 cwd 跟实际 jsonl 落盘的目录可能不一致；
    // 在记到 DB 之前先用文件位置反查真实 cwd，下次再 resume 就不用再纠正了。
    if (resumeNativeId && tool === 'claude' && pty.findClaudeSession) {
      const located = pty.findClaudeSession(resumeNativeId)
      if (located?.cwd && existsSync(located.cwd) && located.cwd !== sessionCwd) {
        console.log(`[ai-terminal] resume cwd corrected for ${resumeNativeId.slice(0, 8)}: ${sessionCwd} → ${located.cwd}`)
        sessionCwd = located.cwd
      }
    }
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
    }
    sessions.set(sessionId, session)
    todoSessionMap.set(todoId, sessionId)
    if (resumeNativeId) nativeSessionMap.set(`${tool}:${resumeNativeId}`, sessionId)

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
        ...(label ? { label } : {}),
      }),
    })

    try {
      // 自动注入 QUADTODO_* env，让 ~/.quadtodo/claude-hooks/notify.js 能识别这是
      // quadtodo 启的 Claude Code → Stop / SessionEnd 事件回推到 quadtodo /api/openclaw/hook。
      // 之前只有 wizard.finalize 会显式传 extraEnv，web/CLI 直接 spawn 的 session 由于缺这些
      // env，hook 脚本 exit 0 → 完成时不推 telegram。caller-supplied 排前面，自动 env 后置覆盖
      // 防止 caller 传错的 sessionId。
      const autoEnv = {
        QUADTODO_SESSION_ID: sessionId,
        QUADTODO_TODO_ID: String(todoId),
        QUADTODO_TODO_TITLE: String(todo.title || ''),
      }
      pty.start({
        sessionId,
        tool,
        prompt: resumeNativeId ? null : prompt,
        cwd: sessionCwd,
        resumeNativeId: resumeNativeId || undefined,
        permissionMode: permissionMode || null,
        extraEnv: { ...(extraEnv || {}), ...autoEnv },
      })
    } catch (error) {
      sessions.delete(sessionId)
      if (todoSessionMap.get(todoId) === sessionId) todoSessionMap.delete(todoId)
      if (resumeNativeId) nativeSessionMap.delete(`${tool}:${resumeNativeId}`)
      throw error
    }

    // Telegram 自动建 topic 钩子（B 方案：默认开，wizard 等已自管 topic 的传 skipTelegram=true）
    if (!skipTelegram && typeof onSessionSpawned === 'function') {
      try {
        const r = onSessionSpawned({ sessionId, todoId, tool })
        if (r && typeof r.catch === 'function') r.catch((e) => console.warn(`[ai-terminal] onSessionSpawned failed: ${e.message}`))
      } catch (e) { console.warn(`[ai-terminal] onSessionSpawned threw: ${e.message}`) }
    }

    return { sessionId, reused: false }
  }

  // ─── REST ───

  const router = Router()

  router.post('/exec', (req, res) => {
    try {
      const result = spawnSession(req.body || {})
      res.json({ ok: true, ...result })
    } catch (e) {
      const status = e.code === 'bad_request' ? 400 : e.code === 'not_found' ? 404 : 500
      if (status >= 500) console.error('[ai-terminal/exec]', e)
      res.status(status).json({ ok: false, error: e.message })
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
    // 这条浏览器走了之后，剩下的浏览器里最小尺寸可能变大，重算一次让 PTY
    // 恢复到能充分利用剩余窗口的尺寸；没有浏览器时什么都不用发，等下一个进来再说。
    if (session.browsers.size > 0) applyAggregatedResize(session)
  }

  // 同一个 session 被多个网页同时打开时（比如你在另一个 tab/window 又开了一遍
  // 同一个 todo），每个 tab 的 xterm fit 出的 cols/rows 都不一样，谁最后发谁
  // 赢就会在两个尺寸之间来回抖，Claude 的 TUI 不停重排、scrollback 全是残影。
  // 取所有在线浏览器上报尺寸的 **最小值** 发给 PTY：最窄的窗口看得下，更宽的
  // tab 只是右边留空白，整体输出保持稳定。
  function applyAggregatedResize(session) {
    let cols = Infinity
    let rows = Infinity
    for (const b of session.browsers) {
      const sz = b.__quadtodoSize
      if (!sz) continue
      if (sz.cols < cols) cols = sz.cols
      if (sz.rows < rows) rows = sz.rows
    }
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return
    if (session.lastAppliedCols === cols && session.lastAppliedRows === rows) return
    session.lastAppliedCols = cols
    session.lastAppliedRows = rows
    pty.resize(session.sessionId, cols, rows)
  }

  // \r=Enter \n=LF \x03=Ctrl+C \x04=Ctrl+D —— 这些才会真正让 Claude/Codex 的 confirm 提示推进
  function isPendingClearingInput(data) {
    if (typeof data !== 'string' || !data) return false
    return /[\r\n\x03\x04]/.test(data)
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

  function handleBrowserMessage(sessionId, msg, ws) {
    if (msg.type === 'input') {
      const session = sessions.get(sessionId)
      // 只有"决定性"按键才视为对 confirm 提示的真实回应：Enter / Ctrl+C / Ctrl+D。
      // 普通可见字符（'a'、'y' 等）不会让 Claude TUI 推进，提示原样保留 —— 若此时清掉
      // pending 状态，紧跟的回显输出会再次匹配 confirm 关键词，把状态翻回 pending_confirm。
      // 浏览器侧每次按键都收到 pending_cleared → pending_confirm 一对消息，导致前端 border
      // 在 1px ↔ 2px 之间反复，肉眼上就是"打字时终端布局抖动"。
      if (isPendingClearingInput(msg.data)) clearPendingConfirm(session)
      pty.write(sessionId, msg.data)
    } else if (msg.type === 'resize') {
      const cols = Number(msg.cols)
      const rows = Number(msg.rows)
      if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return
      const session = sessions.get(sessionId)
      if (!session) return
      if (ws && session.browsers.has(ws)) {
        ws.__quadtodoSize = { cols, rows }
        applyAggregatedResize(session)
      } else {
        // 没拿到 ws 兜底走老路径，保留对非 WS 调用方的兼容
        pty.resize(sessionId, cols, rows)
      }
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
      let recoverable = (todo.aiSessions || []).find(item => item?.nativeSessionId && (item.status === 'running' || item.status === 'pending_confirm'))
        || (todo.aiSessions || []).find(item => item?.nativeSessionId)
      if (!recoverable) {
        db.updateTodo(todo.id, { status: 'todo' })
        continue
      }
      if (nativeSessionMap.has(`${recoverable.tool}:${recoverable.nativeSessionId}`)) continue
      // claude --resume 在错误的 cwd 下会立刻 "No conversation found" 退出。启动恢复前
      // 按 uuid 在 ~/.claude/projects/*/ 实际定位 jsonl：文件没了就放弃恢复（避免起一个
      // 注定失败的 PTY），文件还在就用 jsonl 内嵌的 cwd 字段修正可能漂移的 recoverable.cwd。
      if (recoverable.tool === 'claude' && pty.findClaudeSession) {
        const located = pty.findClaudeSession(recoverable.nativeSessionId)
        if (!located) {
          console.warn(`[ai-terminal] recovery skip: claude session ${recoverable.nativeSessionId.slice(0, 8)} no longer on disk`)
          db.updateTodo(todo.id, { status: 'todo' })
          continue
        }
        if (located.cwd && existsSync(located.cwd) && located.cwd !== recoverable.cwd) {
          console.log(`[ai-terminal] recovery cwd corrected for ${recoverable.nativeSessionId.slice(0, 8)}: ${recoverable.cwd} → ${located.cwd}`)
          recoverable = { ...recoverable, cwd: located.cwd }
        }
      }
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
        // 复活 session 也注入 hook env：即使没 routeUserId，hook script 看到
        // QUADTODO_SESSION_ID 就会 POST 到 quadtodo，端服务自己 fallback 到
        // config.openclaw.targetUserId（兜底推送通道）
        pty.start({
          sessionId,
          tool: recoverable.tool,
          prompt: null,
          cwd,
          resumeNativeId: recoverable.nativeSessionId,
          extraEnv: {
            QUADTODO_SESSION_ID: sessionId,
            QUADTODO_TODO_ID: String(todo.id),
            QUADTODO_TODO_TITLE: String(todo.title || ''),
            QUADTODO_URL: 'http://127.0.0.1:5677',
          },
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
    spawnSession,
    close,
  }
}
