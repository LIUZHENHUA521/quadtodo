import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { Router } from 'express'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import pidusage from 'pidusage'
import { loadConfig, resolveToolsConfig, SUPPORTED_TOOLS, DEFAULT_ROOT_DIR } from '../config.js'
import { writeRuntimeMcpConfig } from '../agent-installer-shared.js'

const MAX_OUTPUT_BUFFER = 5 * 1024 * 1024
const CLEANUP_MS = 30 * 60_000
const MIN_RESIZE_COLS = 30
// PTY 实际使用的 cols 下限。低于这个值的 viewer（例如默认 480px Dock、手机竖屏）
// 不会真的把 PTY 拉窄，而是让 PTY 留在 80 cols 输出，xterm 端做软折行。
// 为什么：Claude 的 TUI/diff 输出包含按 cols 计算好坐标的字符画，一旦 PTY 写下窄行
// 就以 \r\n 形式硬刻进 outputHistory，replay 到更宽的 viewer 仍然窄。
const MIN_PTY_COLS = 80
const LIVE_AI_STATUSES = new Set(['running', 'idle', 'pending_confirm'])
const TERMINAL_RESIZE_STATUSES = new Set(['done', 'failed', 'stopped'])
// 防御：claude end_turn 之后那几帧 TUI redraw 不计为"新一轮的活动"
const EFFECTIVE_STATUS_OUTPUT_GRACE_MS = 500
// 用户按打断键（Ctrl+C / Esc）后到再次轮询 lastOutputAt 的等待时间。
// 取 1500ms：长于 EFFECTIVE_STATUS_OUTPUT_GRACE_MS（500ms），盖住 Claude/Codex 收尾打印
// 那条 "Interrupted by user" 之类的 echo；又短于 stop hook 的常见到达延迟，保证 UI 翻状态
// 比 hook 早。
const INTERRUPT_GRACE_MS = 1500
// "停顿够久才视为真 idle"：等 INTERRUPT_GRACE_MS 之后再看，如果距上次 PTY 输出 ≥ 这个值，
// 才相信 agent 已经停了。低于此值 → 还在喷收尾文本 → 再等一轮。
const INTERRUPT_QUIET_MS = 800
// 兜底的最大重试次数：避免遇到一直喷输出的奇怪 agent 时无限挂钩；超过后让 stop hook /
// jsonl watcher 继续接力，本地静默放弃。
const INTERRUPT_MAX_RETRIES = 3

/**
 * 计算前端展示用的 effectiveStatus —— 用 PTY 输出活性兜底"hook/watcher 判定结束错了"的边界。
 *
 * - status === 'pending_confirm' 原样返回：这是后端用 PTY 输出 (confirm pattern)
 *   主动设上的等待授权态，PTY 最近一定有输出（就是那条提示本身），不能再当成
 *   "stale pending" 升级成 running，否则前端展示会把"待确认"误报成"running"。
 * - 其它 LIVE session（running / idle）且 lastOutputAt 晚于 lastTurnDoneAt + 500ms
 *   → PTY 还在喷新内容、所谓的"turn done"是假的 → 强制 running。
 * - 其余情况返回 session.status 自身。
 *
 * 与 src/openclaw-hook.js 里的 stop_reason 校验门并存：双层防御，互不依赖。
 */
export function computeEffectiveStatus(session, now = Date.now()) {
  if (!session || typeof session !== 'object') return null
  const status = session.status
  if (!LIVE_AI_STATUSES.has(status)) return status
  if (status === 'pending_confirm') return status
  const lastOutputAt = Number(session.lastOutputAt || 0)
  const lastTurnDoneAt = Number(session.lastTurnDoneAt || 0)
  if (!lastOutputAt) return status
  if (lastOutputAt > lastTurnDoneAt + EFFECTIVE_STATUS_OUTPUT_GRACE_MS) return 'running'
  return status
}
function isValidResizeSize(cols, rows) {
  return Number.isFinite(cols) && Number.isFinite(rows) && cols >= MIN_RESIZE_COLS && rows > 0
}

function clampPtyCols(cols) {
  return cols < MIN_PTY_COLS ? MIN_PTY_COLS : cols
}

function canResizeSession(session) {
  return session && !TERMINAL_RESIZE_STATUSES.has(session.status)
}

// 在 spawn PTY 前先确认工具确实在 PATH（或显式 bin 路径）里。
// 比起让 node-pty 抛 ENOENT，这里返回结构化的 tool_missing → 路由层映射成 HTTP 424，
// CLI/前端可以直接展示「跑 agentquad install-tools --claude」修复指引。
function checkToolAvailable(tool, cfg) {
  const tools = resolveToolsConfig(cfg?.tools || {})
  const bin = tools?.[tool]?.bin || tools?.[tool]?.command || tool
  const r = spawnSync('command', ['-v', bin], { encoding: 'utf8', shell: '/bin/sh' })
  return {
    ok: r.status === 0 && r.stdout.trim().length > 0,
    bin,
    resolvedPath: r.stdout.trim() || null,
  }
}

export function createAiTerminal({ db, pty, logDir, defaultCwd, getDefaultCwd, onSessionSpawned = null, onSessionEnded = null, rootDir = DEFAULT_ROOT_DIR }) {
  /** @type {Map<string, any>} */
  const sessions = new Map()
  /** @type {Map<string, string>} */
  const todoSessionMap = new Map()
  /** @type {Map<string, string>} */
  const nativeSessionMap = new Map()

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

  function replaceTodoAiSessionInPlace(todo, nextSession) {
    const history = Array.isArray(todo?.aiSessions) ? todo.aiSessions : (todo?.aiSession ? [todo.aiSession] : [])
    const index = history.findIndex(item => item?.sessionId === nextSession.sessionId)
    if (index === -1) return [...history, nextSession]
    return history.map((item, i) => i === index ? nextSession : item)
  }

  function broadcastToSession(session, msg) {
    const data = JSON.stringify(msg)
    for (const ws of session.browsers) {
      if (ws.readyState === ws.OPEN) ws.send(data)
    }
  }

  function persistLiveSessionState(session, status, todoStatus, extra = {}) {
    const todo = db.getTodo(session.todoId)
    if (!todo) return
    const current = (todo.aiSessions || []).find(item => item.sessionId === session.sessionId) || todo.aiSession || {}
    db.updateTodo(session.todoId, {
      status: todoStatus,
      aiSessions: mergeTodoAiSessions(todo, {
        ...current,
        ...extra,
        sessionId: session.sessionId,
        tool: session.tool,
        nativeSessionId: session.nativeSessionId || current.nativeSessionId || null,
        cwd: session.cwd || current.cwd || null,
        status,
        startedAt: session.startedAt,
        completedAt: null,
        prompt: session.prompt,
      }),
    })
  }

  function markSessionIdleAfterTurn(session, ts) {
    if (!session || session.status !== 'running') return false
    session.status = 'idle'
    session.awaitingReply = true
    session.recentOutput = ''
    // 一旦走到 idle，不管来源是 Stop hook / jsonl watcher / 还是用户打断键调度器，
    // 都要清掉打断 timer：否则 timer 之后还可能再次触发 turn_done 广播。
    clearInterruptTimer(session)
    persistLiveSessionState(session, 'idle', 'ai_done', { lastTurnDoneAt: ts })
    return true
  }

  function markSessionRunningAfterInput(session) {
    if (!session || !LIVE_AI_STATUSES.has(session.status)) return false
    const wasPending = session.status === 'pending_confirm'
    if (session.status === 'running' && session.awaitingReply === false) return false
    session.status = 'running'
    session.awaitingReply = false
    if (wasPending) session.recentOutput = ''
    persistLiveSessionState(session, 'running', 'ai_running')
    if (wasPending) broadcastToSession(session, { type: 'pending_cleared' })
    return true
  }

  // 由 hook 路径调用：Claude Code 的 Notification + permissionish，或 codex-prompt-detector
  // 命中真实的工具授权弹窗时，这里把 session.status 翻成 'pending_confirm'，让
  // /api/ai-terminal/sessions 立刻反映"等授权"状态。
  //
  // 跟旧的 PTY 正则路径相比，区别是：信号源是 agent 本身（Claude Code hook / Codex sidecar），
  // 不会因为 AI 回复文本里出现"Do you want to..."等关键词被误触发。
  //
  // 幂等：已经处于 pending_confirm 直接返回 true；非 LIVE_AI_STATUSES（已 done/failed/stopped）
  // 返回 false 不动状态。
  //
  // 关键守卫：只接受 status === 'running' 的翻转。Claude Code 的 Notification hook 实际上
  // 有两类 —— "权限型"在 AI mid-turn (status=running) 时 fire（真正要 y/n），"idle 提醒型"
  // 在 Stop hook 之后 (status=idle) fire（只是"用户怎么不回复"的催促）。一刀切地把 idle
  // 也翻 pending_confirm，会让 session 在 AI 完成回话之后无故卡在"待确认"，前端没有任何
  // 入口能把它清掉（focus 只清 unread；markSessionRunningAfterInput 需要真实输入）。
  // 所以 idle / 其它非 running 状态下，直接拒绝翻转。
  function markPendingConfirm(sessionId, { source = null } = {}) {
    const session = sessions.get(sessionId)
    if (!session) return false
    if (!LIVE_AI_STATUSES.has(session.status)) return false
    if (session.status === 'pending_confirm') return true
    if (session.status !== 'running') return false
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
    broadcastToSession(session, {
      type: 'pending_confirm',
      snippet: session.recentOutput ? session.recentOutput.slice(-500) : '',
      source: source || 'hook',
    })
    return true
  }

  function notifyTurnDone(sessionId, payload = {}) {
    const session = sessions.get(sessionId)
    if (!session) return false
    const ts = payload.timestamp || Date.now()
    session.lastTurnDoneAt = ts
    const markedIdle = markSessionIdleAfterTurn(session, ts)
    // 持久化到 todo.aiSessions[i].lastTurnDoneAt：即使 server 重启或浏览器关掉，
    // 客户端再开仍能根据 lastTurnDoneAt > 本地 lastSeenAt 判断未读。
    try {
      const todo = db.getTodo(session.todoId)
      if (todo) {
        const current = (todo.aiSessions || []).find(item => item.sessionId === sessionId) || todo.aiSession
        if (current && !markedIdle) {
          db.updateTodo(session.todoId, {
            aiSessions: mergeTodoAiSessions(todo, { ...current, lastTurnDoneAt: ts }),
          })
        }
      }
    } catch (e) {
      console.warn('[ai-terminal] persist lastTurnDoneAt failed:', e.message)
    }
    broadcastToSession(session, {
      ...payload,
      type: 'turn_done',
      event: payload.event || 'stop',
      status: payload.status || session.status || 'idle',
      timestamp: ts,
    })
    return true
  }

  function sendToBrowser(ws, msg) {
    if (!ws || ws.readyState !== ws.OPEN) return
    ws.send(JSON.stringify(msg))
  }

  function restoreSessionAsCurrent(session, todoSnapshot) {
    todoSessionMap.set(session.todoId, session.sessionId)
    if (session.nativeSessionId) nativeSessionMap.set(`${session.tool}:${session.nativeSessionId}`, session.sessionId)
    if (todoSnapshot) {
      db.updateTodo(session.todoId, {
        status: todoSnapshot.status,
        aiSessions: todoSnapshot.aiSessions,
      })
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
    broadcastToSession(session, { type: 'output', data })
  })

  pty.on('native-session', ({ sessionId, nativeId }) => {
    const session = sessions.get(sessionId)
    if (!session) return
    if (session.nativeSessionId && session.nativeSessionId !== nativeId) {
      const oldNativeKey = `${session.tool}:${session.nativeSessionId}`
      if (nativeSessionMap.get(oldNativeKey) === sessionId) nativeSessionMap.delete(oldNativeKey)
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

  // cursor 专属：jsonl tail watcher 检测到末行 role===assistant → 一轮已完成。
  // cursor 自家 stop hook 偶发不 fire（log 实测），所以走 jsonl 兜底。
  // 走的字段跟 Claude Stop hook 一样：notifyTurnDone 设 lastTurnDoneAt，
  // markSessionAwaitingReply(true) 让前端 deriveAiState 知道"PTY 活着但本轮已结束"。
  pty.on('cursor-turn-done', ({ sessionId }) => {
    if (!sessions.has(sessionId)) return
    notifyTurnDone(sessionId, { event: 'stop', status: 'idle' })
    markSessionAwaitingReply(sessionId, true)
  })

  // claude jsonl tail watcher（pty.js 内部 2s 轮询）：
  //   - turn-started：末行是 user/tool_result → Claude 在跑 → awaitingReply=false
  //   - turn-done   ：末行 assistant.stop_reason==='end_turn' → 真完成 → awaitingReply=true
  // 与 stop hook 并存，谁先到谁先生效。markSessionAwaitingReply 幂等。
  pty.on('claude-turn-started', ({ sessionId }) => {
    if (!sessions.has(sessionId)) return
    markSessionAwaitingReply(sessionId, false)
  })
  pty.on('claude-turn-done', ({ sessionId }) => {
    if (!sessions.has(sessionId)) return
    notifyTurnDone(sessionId, { event: 'stop', status: 'idle' })
    markSessionAwaitingReply(sessionId, true)
  })

  pty.on('done', ({ sessionId, exitCode, fullLog, nativeId, stopped }) => {
    const session = sessions.get(sessionId)
    if (!session) return
    if (session.nativeSessionId) {
      const nativeKey = `${session.tool}:${session.nativeSessionId}`
      if (nativeSessionMap.get(nativeKey) === sessionId) nativeSessionMap.delete(nativeKey)
    }

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
    session.awaitingReply = false
    clearInterruptTimer(session)

    const superseded = Boolean(session.replacedBySessionId) || todoSessionMap.get(session.todoId) !== sessionId
    const todo = db.getTodo(session.todoId)
    if (todo) {
      const existingEntry = (todo.aiSessions || []).find(item => item.sessionId === session.sessionId)
      // bypass 热重启的老 session：B 的 spawnSession 已通过 mergeTodoAiSessions
      // 按 tool+nativeSessionId 把老 A 从 aiSessions 里剔除。这里别再 append 回去 ——
      // 否则一次切"完全托管"会留下 2 条历史卡片（B running + A stopped）。
      // session_log 仍由下方 insertSessionLog 写入，Dashboard 统计不会丢这次运行。
      const skipHistoryWrite = superseded && !existingEntry
      if (!skipHistoryWrite) {
        const newAi = {
          ...(existingEntry || todo.aiSession || {}),
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
        const updates = {
          aiSessions: superseded
            ? replaceTodoAiSessionInPlace(todo, newAi)
            : mergeTodoAiSessions(todo, newAi),
        }
        if (!session.userClosedReason && !superseded) {
          updates.status = todoStatus
        }
        db.updateTodo(session.todoId, updates)
      }
    }

    writeFullLog(sessionId, fullLog)
    const replacedByLive = superseded
      && typeof session.replacedBySessionId === 'string'
      && session.replacedBySessionId !== '__pending__'
    if (!replacedByLive) {
      broadcastToSession(session, { type: 'done', exitCode, status: aiStatus })
    }

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
    if (!superseded && typeof onSessionEnded === 'function') {
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
  function spawnSession({ todoId, prompt, tool, cwd, resumeNativeId, permissionMode, label, extraEnv, sessionId: externalSessionId, skipTelegram = false, ignoreExistingNativeSessionId = false, parentTodoId = null }) {
    if (!todoId || typeof prompt !== 'string' || !tool) {
      const err = new Error('missing todoId, prompt, or tool'); err.code = 'bad_request'
      throw err
    }
    if (!SUPPORTED_TOOLS.includes(tool)) {
      const err = new Error('invalid tool'); err.code = 'bad_request'
      throw err
    }
    // 工具不在 PATH（或显式 bin 路径不存在）时立刻报错，不要把 ENOENT 留给 node-pty。
    // 路由层会把 tool_missing 映射成 HTTP 424 + 修复指引。
    const cfg = loadConfig({ rootDir })
    const avail = checkToolAvailable(tool, cfg)
    if (!avail.ok) {
      const err = new Error(`tool_missing: ${tool} (looked for "${avail.bin}" in PATH)`)
      err.code = 'tool_missing'
      err.tool = tool
      err.bin = avail.bin
      err.fix = `agentquad install-tools --${tool}`
      throw err
    }
    const todo = db.getTodo(todoId)
    if (!todo) {
      const err = new Error('todo_not_found'); err.code = 'not_found'
      throw err
    }
    if (resumeNativeId && !ignoreExistingNativeSessionId) {
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
    const effectivePermissionMode = permissionMode || 'default'
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
      permissionMode: effectivePermissionMode,
      autoMode: effectivePermissionMode !== 'default' ? effectivePermissionMode : null,
      lastOutputAt: null,
      lastTurnDoneAt: null,
      outputBytesTotal: 0,
      awaitingReply: false,
      spawned: false,
      spawnFallbackTimer: null,
    }
    sessions.set(sessionId, session)
    todoSessionMap.set(todoId, sessionId)
    if (resumeNativeId) nativeSessionMap.set(`${tool}:${resumeNativeId}`, sessionId)

    try {
      // 自动注入 QUADTODO_* env，让 ~/.agentquad/claude-hooks/notify.js 能识别这是
      // AgentQuad 启的 Claude Code → Stop / SessionEnd 事件回推到 AgentQuad /api/openclaw/hook。
      // 之前只有 wizard.finalize 会显式传 extraEnv，web/CLI 直接 spawn 的 session 由于缺这些
      // env，hook 脚本 exit 0 → 完成时不推 telegram。caller-supplied 排前面，自动 env 后置覆盖
      // 防止 caller 传错的 sessionId。
      const autoEnv = {
        QUADTODO_SESSION_ID: sessionId,
        QUADTODO_TODO_ID: String(todoId),
        QUADTODO_TODO_TITLE: String(todo.title || ''),
      }
      // Task 10: 嵌套深度 + 父 todo id 注入
      const parentDepthRaw = process.env.QUADTODO_DEPTH
      const parentDepth = parentDepthRaw !== undefined && parentDepthRaw !== '' ? Number(parentDepthRaw) : -1
      autoEnv.QUADTODO_DEPTH = String(parentDepth + 1)
      // parentTodoId 优先来自 MCP 工具显式传入；否则 fallback 到 process.env（适合 PTY 嵌套场景，但 AgentQuad 主进程通常没设）
      autoEnv.QUADTODO_PARENT_TODO_ID = parentTodoId != null
        ? String(parentTodoId)
        : String(process.env.QUADTODO_TODO_ID || '')
      // 添加 QUADTODO_URL 让 hook/child agent 知道访问哪个端口
      const cfgPort = cfg?.port || 5677
      autoEnv.QUADTODO_URL = `http://127.0.0.1:${cfgPort}`

      // Task 10: 运行时 MCP 配置注入（C 方案）— claude 走 --mcp-config <file>
      let runtimeMcpPath = null
      if (tool === 'claude') {
        try {
          const runtimeDir = cfg?.agents?.runtimeDir
            ? cfg.agents.runtimeDir.replace(/^~/, homedir())
            : join(homedir(), '.agentquad', 'run')
          const out = writeRuntimeMcpConfig({ runtimeDir, sessionId, port: cfgPort, tool: 'claude' })
          runtimeMcpPath = out.path
        } catch (e) {
          console.warn(`[ai-terminal] runtime mcp config write failed: ${e.message}`)
        }
      }

      // 1. 先 pty.create 让 PtyManager 把 presetClaudeId / resumeNativeId 落进 session 记录。
      pty.create({
        sessionId,
        todoId,
        tool,
        prompt: resumeNativeId ? null : prompt,
        cwd: sessionCwd,
        resumeNativeId: resumeNativeId || undefined,
        permissionMode: permissionMode || null,
        extraEnv: { ...(extraEnv || {}), ...autoEnv },
        mcpConfigPath: runtimeMcpPath,
      })
      // 2. 读出 preset nativeId（claude 新会话 = randomUUID, resume = resumeNativeId, codex 新 = null）。
      //    这是让"首屏即正确"成立的核心：先于 db.updateTodo 拿到值。
      const presetNativeId = pty.getNativeId(sessionId)
      session.nativeSessionId = presetNativeId
      if (presetNativeId && !resumeNativeId) {
        // resume 路径上面已经 set 过；新会话首次得到 nativeId 时补一次。
        nativeSessionMap.set(`${tool}:${presetNativeId}`, sessionId)
      }
      // 3. 一次性把 nativeSessionId 写进 DB（搬进 try 内：失败时不留脏 DB）。
      db.updateTodo(todoId, {
        status: 'ai_running',
        aiSessions: mergeTodoAiSessions(todo, {
          sessionId,
          tool,
          nativeSessionId: presetNativeId,
          cwd: sessionCwd,
          status: 'running',
          startedAt: session.startedAt,
          completedAt: null,
          prompt,
          permissionMode: effectivePermissionMode,
          ...(label ? { label } : {}),
        }),
      })
      // 4. 5s 兜底：前端如果一直没发合法 init（极少见 — /exec 返回后 WS 还没连上），
      // 用老的 80×24 兜底 spawn，避免 session 永远卡在 create 状态。
      session.spawnFallbackTimer = setTimeout(() => {
        session.spawnFallbackTimer = null
        if (session.spawned) return
        console.warn(`[ai-terminal] spawn fallback fired session=${sessionId} (no init within 5s)`)
        session.spawned = true
        pty.startWithSize(sessionId, 80, 24).catch((e) => {
          console.warn(`[ai-terminal] spawn fallback failed: ${e.message}`)
          session.spawned = false
        })
      }, 5000)
      session.spawnFallbackTimer.unref?.()
    } catch (error) {
      sessions.delete(sessionId)
      if (todoSessionMap.get(todoId) === sessionId) todoSessionMap.delete(todoId)
      if (resumeNativeId) {
        const nativeKey = `${tool}:${resumeNativeId}`
        if (nativeSessionMap.get(nativeKey) === sessionId) nativeSessionMap.delete(nativeKey)
      }
      // 新会话的 preset nativeSessionMap 也要清掉（resume 路径在上一个 if 已处理）。
      if (session.nativeSessionId && session.nativeSessionId !== resumeNativeId) {
        const nativeKey = `${tool}:${session.nativeSessionId}`
        if (nativeSessionMap.get(nativeKey) === sessionId) nativeSessionMap.delete(nativeKey)
      }
      // 顺手补：如果 pty.create 已经把 session 占位写进 pty.sessions、但后续步骤抛错，要清掉。
      try { pty.stop(sessionId) } catch { /* ignore */ }
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
      const body = req.body || {}
      const result = spawnSession({
        todoId: body.todoId,
        prompt: body.prompt,
        tool: body.tool,
        cwd: body.cwd,
        resumeNativeId: body.resumeNativeId,
        permissionMode: body.permissionMode,
      })
      res.json({ ok: true, ...result })
    } catch (e) {
      if (e.code === 'tool_missing') {
        return res.status(424).json({
          ok: false,
          code: 'tool_missing',
          tool: e.tool,
          bin: e.bin,
          fix: e.fix,
          message: e.message,
          error: e.message,
        })
      }
      const status = e.code === 'bad_request' ? 400 : e.code === 'not_found' ? 404 : 500
      if (status >= 500) console.error('[ai-terminal/exec]', e)
      res.status(status).json({ ok: false, error: e.message })
    }
  })


  // 返回当前内存中的所有会话（包含已完成的"雕像期"），供仪表盘和宠物视图使用
  router.get('/sessions', (req, res) => {
    try {
      const out = []
      const now = Date.now()
      for (const [sessionId, s] of sessions) {
        const todo = db.getTodo(s.todoId)
        out.push({
          sessionId,
          todoId: s.todoId,
          todoTitle: todo?.title || '',
          quadrant: todo?.quadrant || 4,
          tool: s.tool,
          status: s.status,
          effectiveStatus: computeEffectiveStatus(s, now),
          autoMode: s.autoMode || null,
          nativeSessionId: s.nativeSessionId || null,
          cwd: s.cwd || null,
          startedAt: s.startedAt,
          completedAt: s.completedAt || null,
          lastOutputAt: s.lastOutputAt || null,
          lastTurnDoneAt: s.lastTurnDoneAt || null,
          outputBytesTotal: s.outputBytesTotal || 0,
          awaitingReply: !!s.awaitingReply,
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
      // 只在真正"提交"按键（Enter / Ctrl+C / Ctrl+D）时翻 awaitingReply=false。
      // 普通字符 / 焦点 ANSI 序列 / 粘贴中间态都不算 Claude 正式 busy ——
      // 如果在这里无条件翻 false，dispatcher 会把同一 chat 后续的 IM 消息全部 queue，
      // 而队列只能等下一次 Stop hook 才会 flush，导致飞书消息延迟数分钟才送达。
      if (isPendingClearingInput(data)) markSessionRunningAfterInput(session)
      // running 中遇到打断键 → 排一个 idle 兜底检查（Stop hook 不 fire 时也能翻状态）
      if (session.status === 'running' && isInterruptInput(data)) scheduleInterruptIdleCheck(session)
      writeRestInputToPty(sessionId, data)
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
    if (!canResizeSession(session)) return

    let cols = Infinity
    let rows = Infinity
    for (const b of session.browsers) {
      const sz = b.__quadtodoSize
      if (!sz || !isValidResizeSize(sz.cols, sz.rows)) continue
      if (sz.cols < cols) cols = sz.cols
      if (sz.rows < rows) rows = sz.rows
    }
    if (!isValidResizeSize(cols, rows)) return
    cols = clampPtyCols(cols)
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

  // 用户希望"打断当前轮"的按键：Ctrl+C（\x03）或 Esc（裸 \x1b / \x1b\x1b）。
  // 注意：必须排除 ANSI 转义序列 —— 箭头键是 '\x1b[A'、焦点切换是 '\x1b[I'，
  // 它们都以 \x1b 起头，但不是用户意图上的"打断"。所以只认严格匹配的两种形态。
  // 这里不区分 status：调用方负责按 session.status === 'running' 决定是否调度。
  function isInterruptInput(data) {
    if (typeof data !== 'string' || !data) return false
    if (data.includes('\x03')) return true
    if (data === '\x1b' || data === '\x1b\x1b') return true
    return false
  }

  // running 中的会话遇到用户按 Ctrl+C/Esc 时被调用。
  // 现状：Claude / Codex 自然 turn done 才发 Stop hook 和 stop_reason='end_turn'，
  // 用户打断不发 → session.status 卡在 running、computeEffectiveStatus 又因 lastOutputAt
  // 推进而强转 running，前端徽标永远转圈。
  //
  // 策略：从按下打断键起延后 INTERRUPT_GRACE_MS 检查 lastOutputAt；若 PTY 已经静默
  // ≥ INTERRUPT_QUIET_MS 则视为打断成功，复用 markSessionIdleAfterTurn 走与自然 turn done
  // 同样的持久化路径（todo.status → ai_done、broadcast turn_done），保留会话本身（PTY 不退）。
  // 若 PTY 还在喷收尾输出，重试 INTERRUPT_MAX_RETRIES 次后放弃，留给 stop hook / jsonl
  // watcher 接力（双层防御互不依赖）。
  function scheduleInterruptIdleCheck(session) {
    if (!session) return
    if (session.interruptTimer) {
      clearTimeout(session.interruptTimer)
      session.interruptTimer = null
    }
    session.interruptRetries = 0
    const tryFlip = () => {
      session.interruptTimer = null
      if (!sessions.has(session.sessionId)) return
      if (session.status !== 'running') return
      const lastOutputAt = Number(session.lastOutputAt || 0)
      const now = Date.now()
      if (lastOutputAt > 0 && now - lastOutputAt < INTERRUPT_QUIET_MS) {
        session.interruptRetries = (session.interruptRetries || 0) + 1
        if (session.interruptRetries >= INTERRUPT_MAX_RETRIES) return
        session.interruptTimer = setTimeout(tryFlip, INTERRUPT_GRACE_MS)
        session.interruptTimer.unref?.()
        return
      }
      const ts = now
      session.lastTurnDoneAt = ts
      markSessionIdleAfterTurn(session, ts)
      broadcastToSession(session, {
        type: 'turn_done',
        event: 'interrupted',
        status: session.status || 'idle',
        timestamp: ts,
      })
    }
    session.interruptTimer = setTimeout(tryFlip, INTERRUPT_GRACE_MS)
    session.interruptTimer.unref?.()
  }

  function clearInterruptTimer(session) {
    if (!session) return
    if (session.interruptTimer) {
      clearTimeout(session.interruptTimer)
      session.interruptTimer = null
    }
    session.interruptRetries = 0
  }

  function writeRestInputToPty(sessionId, data) {
    if (typeof data !== 'string') return
    const submit = data.match(/[\r\n]$/)?.[0]
    if (!submit || data.length === 1) {
      pty.write(sessionId, data)
      return
    }
    const text = data.slice(0, -1)
    if (text) pty.write(sessionId, text)
    setTimeout(() => {
      try { pty.write(sessionId, submit) } catch (e) {
        console.warn(`[ai-terminal/input] submit write failed for ${sessionId}: ${e.message}`)
      }
    }, 80)
  }

  function handleSetAutoMode(sessionId, msg, ws) {
    const session = sessions.get(sessionId)
    if (!session) return
    const nextAutoMode = msg.autoMode || null
    session.autoMode = nextAutoMode
    broadcastToSession(session, { type: 'auto_mode', autoMode: session.autoMode || null })

    if (nextAutoMode !== 'bypass' || session.tool !== 'claude') return

    if (!session.nativeSessionId) {
      sendToBrowser(ws, {
        type: 'auto_mode_notice',
        autoMode: 'bypass',
        immediate: false,
        reason: 'native_session_missing',
        message: '当前 Claude 会话尚未拿到原生 session id，全托管将仅对后续启动/恢复的会话生效。',
      })
      return
    }

    broadcastToSession(session, { type: 'auto_mode_switching', target: 'bypass' })
    const todoSnapshot = db.getTodo(session.todoId)
    session.replacedBySessionId = '__pending__'
    let restarted
    try {
      restarted = spawnSession({
        todoId: session.todoId,
        prompt: session.prompt || '',
        tool: session.tool,
        cwd: session.cwd || undefined,
        resumeNativeId: session.nativeSessionId,
        permissionMode: 'bypass',
        label: 'runtime:bypass',
        skipTelegram: true,
        ignoreExistingNativeSessionId: true,
      })
    } catch (e) {
      delete session.replacedBySessionId
      restoreSessionAsCurrent(session, todoSnapshot)
      sendToBrowser(ws, {
        type: 'auto_mode_notice',
        autoMode: 'bypass',
        immediate: false,
        reason: 'restart_failed',
        message: `切换全托管失败：${e.message}`,
      })
      return
    }

    broadcastToSession(session, {
      type: 'session_restarted',
      oldSessionId: sessionId,
      newSessionId: restarted.sessionId,
      autoMode: 'bypass',
    })
    if (restarted.sessionId !== sessionId) {
      session.replacedBySessionId = restarted.sessionId
      pty.stop(sessionId)
    } else {
      delete session.replacedBySessionId
    }
  }

  function handleBrowserMessage(sessionId, msg, ws) {
    if (msg.type === 'input') {
      const session = sessions.get(sessionId)
      // 只有"决定性"按键才视为对 confirm 提示的真实回应：Enter / Ctrl+C / Ctrl+D。
      // 普通可见字符（'a'、'y' 等）不会让 Claude TUI 推进，提示原样保留 —— 若此时清掉
      // pending 状态，紧跟的回显输出会再次匹配 confirm 关键词，把状态翻回 pending_confirm。
      // 浏览器侧每次按键都收到 pending_cleared → pending_confirm 一对消息，导致前端 border
      // 在 1px ↔ 2px 之间反复，肉眼上就是"打字时终端布局抖动"。
      if (isPendingClearingInput(msg.data)) markSessionRunningAfterInput(session)
      // 同 REST /input：running 中遇到打断键 → 排 idle 兜底检查，给前端 1.5s 后翻状态
      if (session?.status === 'running' && isInterruptInput(msg.data)) scheduleInterruptIdleCheck(session)
      // 同 REST /input：只在真正的"提交"键才翻 false，避免普通字符 / 焦点序列 / 粘贴
      // 中间态把 awaitingReply 推回 false，导致 dispatcher 把 IM 消息死锁在队列里
      // 直到下一次 Stop。
      pty.write(sessionId, msg.data)
    } else if (msg.type === 'init') {
      const cols = Number(msg.cols)
      const rows = Number(msg.rows)
      const session = sessions.get(sessionId)
      if (!session) return
      if (!isValidResizeSize(cols, rows)) return
      if (!session.spawned) {
        if (session.spawnFallbackTimer) {
          clearTimeout(session.spawnFallbackTimer)
          session.spawnFallbackTimer = null
        }
        session.spawned = true
        pty.startWithSize(sessionId, clampPtyCols(cols), rows).then(() => {
          session.lastAppliedCols = clampPtyCols(cols)
          session.lastAppliedRows = rows
          if (ws && session.browsers.has(ws)) {
            ws.__quadtodoSize = { cols, rows }
            applyAggregatedResize(session)
          }
        }).catch((e) => {
          console.warn(`[ai-terminal] startWithSize failed for ${sessionId}: ${e.message}`)
          session.spawned = false
        })
        return
      }
      // Register this WS's size into the aggregation map either way (covers
      // both the spawned-by-this-init case and the spawned-earlier reconnect case).
      if (ws && session.browsers.has(ws)) {
        ws.__quadtodoSize = { cols, rows }
        applyAggregatedResize(session)
      }
    } else if (msg.type === 'resize') {
      const cols = Number(msg.cols)
      const rows = Number(msg.rows)
      const session = sessions.get(sessionId)
      if (!canResizeSession(session)) return
      if (ws && session.browsers.has(ws)) {
        if (!isValidResizeSize(cols, rows)) {
          delete ws.__quadtodoSize
          applyAggregatedResize(session)
          return
        }
        ws.__quadtodoSize = { cols, rows }
        applyAggregatedResize(session)
      } else {
        if (!isValidResizeSize(cols, rows)) return
        // 没拿到 ws 兜底走老路径，保留对非 WS 调用方的兼容
        const clampedCols = clampPtyCols(cols)
        if (session.lastAppliedCols === clampedCols && session.lastAppliedRows === rows) return
        session.lastAppliedCols = clampedCols
        session.lastAppliedRows = rows
        pty.resize(sessionId, clampedCols, rows)
      }
    } else if (msg.type === 'set_auto_mode') {
      handleSetAutoMode(sessionId, msg, ws)
    } else if (msg.type === 'clear_history') {
      // 用户主动清空旧 scrollback：用于摆脱"老 session 在窄 cols 时写下的硬折行"
      // 污染新窗口显示的场景。只清缓冲，不动 PTY 状态——Claude 会在下次输出时自动重绘。
      const session = sessions.get(sessionId)
      if (!session) return
      session.outputHistory = []
      session.outputSize = 0
    }
  }

  // ─── Cleanup of stale finished sessions (30 min) ───

  const cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - CLEANUP_MS
    for (const [id, s] of sessions) {
      if (!LIVE_AI_STATUSES.has(s.status)
          && s.completedAt && s.completedAt < cutoff
          && s.browsers.size === 0) {
        sessions.delete(id)
        if (todoSessionMap.get(s.todoId) === id) todoSessionMap.delete(s.todoId)
        if (s.nativeSessionId) {
          const nativeKey = `${s.tool}:${s.nativeSessionId}`
          if (nativeSessionMap.get(nativeKey) === id) nativeSessionMap.delete(nativeKey)
        }
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
    // 启动期一次性读 config：恢复一条没记 permissionMode 的老 session 时回退到全局默认。
    // 用户在设置里选了"完全托管"但 DB 里没存 → 这里把意图重新接上，否则 claude --resume
    // 会用交互式默认（= UI 上显示"手动"）。
    let startupDefaultPermissionMode = null
    try {
      startupDefaultPermissionMode = loadConfig({ rootDir }).defaultPermissionMode || null
    } catch (e) {
      console.warn('[ai-terminal] recover: loadConfig failed:', e.message)
    }
    const todos = db.listTodos()
      .filter(todo => ['ai_running', 'ai_pending'].includes(todo.status))
    for (const todo of todos) {
      let recoverable = (todo.aiSessions || []).find(item => item?.nativeSessionId && (item.status === 'running' || item.status === 'idle' || item.status === 'pending_confirm'))
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
      // DB 里记的优先（尊重用户在该 session 上的显式选择，包括运行中切到 bypass 的那条）；
      // 没记 → 回退到 config 全局默认；都没有 → null（即 'default'，原始行为）。
      const recoveredPermissionMode = recoverable.permissionMode || startupDefaultPermissionMode || null
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
        permissionMode: recoveredPermissionMode || 'default',
        autoMode: recoveredPermissionMode && recoveredPermissionMode !== 'default' ? recoveredPermissionMode : null,
        lastOutputAt: null,
        lastTurnDoneAt: null,
        outputBytesTotal: 0,
        completedAt: null,
        awaitingReply: false,
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
          permissionMode: recoveredPermissionMode || recoverable.permissionMode || null,
        }),
      })
      try {
        pty.start({
          sessionId,
          tool: recoverable.tool,
          prompt: null,
          cwd,
          resumeNativeId: recoverable.nativeSessionId,
          permissionMode: recoveredPermissionMode || undefined,
          extraEnv: {
            QUADTODO_SESSION_ID: sessionId,
            QUADTODO_TODO_ID: String(todo.id),
            QUADTODO_TODO_TITLE: String(todo.title || ''),
            QUADTODO_URL: 'http://127.0.0.1:5677',
          },
        }).catch((e) => {
          console.warn('[ai-terminal] auto-recover start failed:', e.message)
          sessions.delete(sessionId)
          todoSessionMap.delete(todo.id)
          const nativeKey = `${recoverable.tool}:${recoverable.nativeSessionId}`
          if (nativeSessionMap.get(nativeKey) === sessionId) nativeSessionMap.delete(nativeKey)
          db.updateTodo(todo.id, { status: 'todo' })
        })
      } catch (e) {
        console.warn('[ai-terminal] auto-recover failed:', e.message)
        sessions.delete(sessionId)
        todoSessionMap.delete(todo.id)
        const nativeKey = `${recoverable.tool}:${recoverable.nativeSessionId}`
        if (nativeSessionMap.get(nativeKey) === sessionId) nativeSessionMap.delete(nativeKey)
        db.updateTodo(todo.id, { status: 'todo' })
      }
    }
  }

  // 历史回填：markPendingConfirm 加 "status==='running'" 守卫之前，任何 Notification
  // 都会把 idle session 翻成 pending_confirm，前端没有入口能清（focus 只清 unread；
  // markSessionRunningAfterInput 需要真实输入），session 会永远卡在"待确认"。这里启动时
  // 一次性把 DB 里 pending_confirm 的持久化记录翻回 idle，救掉 server 升级前留下的 stuck
  // session。新代码下 pending_confirm 只能从 running 翻入，server 重启时正常恢复路径会把
  // status 强制设回 running（见 recoverPendingTodosOnStartup），sweep 不会误清正在等
  // 真实权限的会话——那条会话的 PTY 进程已经随 server 死掉，权限请求得 resume 后重发。
  function sweepStuckPendingConfirm() {
    try {
      for (const todo of db.listTodos()) {
        const aiSessions = todo.aiSessions || []
        let mutated = false
        const next = aiSessions.map((s) => {
          if (s?.status === 'pending_confirm') {
            mutated = true
            return { ...s, status: 'idle' }
          }
          return s
        })
        if (!mutated) continue
        const patch = { aiSessions: next }
        if (todo.status === 'ai_pending') patch.status = 'ai_running'
        db.updateTodo(todo.id, patch)
        console.log(`[ai-terminal] sweep: pending_confirm → idle on todo ${todo.id}`)
      }
    } catch (e) {
      console.warn('[ai-terminal] sweepStuckPendingConfirm failed:', e.message)
    }
  }

  sweepStuckPendingConfirm()
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
    notifyTurnDone,
    spawnSession,
    markSessionAwaitingReply,
    markPendingConfirm,
    isSessionAwaitingReply,
    close,
  }

  function markSessionAwaitingReply(sessionId, value) {
    const session = sessions.get(sessionId)
    if (!session) return false
    if (!LIVE_AI_STATUSES.has(session.status)) return false
    const next = !!value
    if (!next) {
      markSessionRunningAfterInput(session)
      return true
    }
    if (session.status === 'running') {
      markSessionIdleAfterTurn(session, Date.now())
      return true
    }
    if (session.awaitingReply === next) return true
    session.awaitingReply = next
    return true
  }

  function isSessionAwaitingReply(sessionId) {
    const session = sessions.get(sessionId)
    if (!session) return false  // 不存在 → 视为 busy（保守，避免抢跑）
    if (!LIVE_AI_STATUSES.has(session.status)) return false
    return !!session.awaitingReply
  }
}
