import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { spawnSync, execFile as execFileCb } from 'node:child_process'
import { readdirSync, statSync, existsSync, unlinkSync, watch as fsWatch, mkdirSync, openSync, readSync, closeSync, readFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { createCodexPromptDetector } from './codex-prompt-detector.js'

const require = createRequire(import.meta.url)

/**
 * 将托管模式映射为原生 CLI 参数：
 *   - default / null：无额外参数（交互式确认）
 *   - acceptEdits (半托管)：自动放行编辑类操作
 *   - bypass (完全托管)：跳过全部权限询问
 * claude/codex 两个 CLI 的标志不同，这里分开处理。
 */
function buildPermissionArgs(tool, mode) {
  if (!mode || mode === 'default') return []
  if (tool === 'claude') {
    if (mode === 'acceptEdits') return ['--permission-mode', 'acceptEdits']
    if (mode === 'bypass') return ['--permission-mode', 'bypassPermissions']
    return []
  }
  if (tool === 'codex') {
    if (mode === 'acceptEdits') return ['--ask-for-approval', 'on-request', '--sandbox', 'workspace-write']
    if (mode === 'bypass') return ['--dangerously-bypass-approvals-and-sandbox']
    return []
  }
  if (tool === 'cursor') {
    // cursor-agent 交互模式只接受 --force / --yolo；--trust 仅 --print/headless 可用，
    // 在 PTY 里跑会被 cursor-agent 直接拒掉（Error: --trust can only be used with --print/headless mode）。
    //   acceptEdits → --force（除非 deny 否则放行命令）
    //   bypass     → --yolo（= --force 别名，cursor 没提供更细颗粒）
    if (mode === 'acceptEdits') return ['--force']
    if (mode === 'bypass') return ['--yolo']
    return []
  }
  return []
}

// Claude Code 的 AskUserQuestion 是 TUI（ANSI 重绘 + Tab/Arrow 导航），在 PTY 里
// 推到 Telegram 既看不全也没法回复。这里源头禁掉，AI 调用会失败 → 退路到文本或
// 自家 ask_user MCP（后者在 Telegram 渲染成 inline 按钮）。
// 仅作用于 AgentQuad 启动的 claude，不写到全局 settings.json。
function buildClaudeDisallowedToolsArgs(tool) {
  if (tool !== 'claude') return []
  return ['--disallowedTools', 'AskUserQuestion']
}

function buildChildPath(toolBin, basePath = process.env.PATH || '') {
  if (!toolBin || !isAbsolute(toolBin)) return basePath
  const binDir = dirname(toolBin)
  const parts = basePath ? basePath.split(delimiter) : []
  return [binDir, ...parts.filter((part) => part !== binDir)].join(delimiter)
}

// 检测 Claude Code AskUserQuestion / 类似选择器 TUI 的 footer 特征。
// 真要兜底：禁用参数是主力，这一道用来万一参数失效（升级/改名）时仍能给 Telegram 一个提示。
const TUI_FOOTER_RE = /Tab\/Arrow keys to navigate.*Esc to cancel|Enter to select.*Tab\/Arrow/
const TUI_ALERT_COOLDOWN_MS = 30_000

const CLAUDE_SESSION_RE = /claude\s+--resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/
const CODEX_SESSION_RE = /codex\s+resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/
const CODEX_ROLLOUT_FILE_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/
const CLAUDE_JSONL_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/
const MAX_LOG_BYTES = 512 * 1024
const CODEX_SESSIONS_DIR = join(homedir(), '.codex', 'sessions')

function codexDayDir(date) {
  return join(
    CODEX_SESSIONS_DIR,
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  )
}

function codexTodayDir() {
  return codexDayDir(new Date())
}

// AgentQuad 进程时区可能跟 codex CLI 进程时区不一致（典型场景：AgentQuad 没设 TZ + LANG=zh_CN
// 让 Node 默认 CST，但 codex 用 macOS 系统 TZ 是 PDT，差 15h 直接跨日）；同时盯 today/
// yesterday/tomorrow 三个目录，把 ±24h 时区漂移吃掉。
function codexNearbyDayDirs() {
  const now = Date.now()
  return [
    codexDayDir(new Date(now - 86400_000)),
    codexDayDir(new Date(now)),
    codexDayDir(new Date(now + 86400_000)),
  ]
}

// codex 0.124.0 无 --session-id / --rollout-path 预置能力；首个可靠的 session id 来源是
// ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*-<uuid>.jsonl 文件出现的那一刻。
// fs.watch 的事件延迟通常 <50ms，远优于 400ms 轮询；fs.watch 在部分 FS 不可靠，所以
// 三路并行（fs.watch / 400ms 轮询 / stdout 正则），setNativeId 里处理去重与相互清理。
function defaultCodexWatcherFactory(_spawnTime, onHit) {
  const dirs = codexNearbyDayDirs()
  const watchers = []
  for (const dir of dirs) {
    try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
    try {
      const w = fsWatch(dir, { persistent: false }, (eventType, filename) => {
        if (!filename) return
        const m = filename.match(CODEX_ROLLOUT_FILE_RE)
        console.log(`[codex-detect] fs.watch event=${eventType} dir=${dir} file=${filename} match=${!!m}`)
        if (m) onHit(m[1])
      })
      watchers.push(w)
      console.log(`[codex-detect] fs.watch armed on ${dir}`)
    } catch (e) {
      console.warn(`[codex-detect] fs.watch FAILED on ${dir}:`, e?.message || e)
    }
  }
  if (!watchers.length) return null
  // 返回个聚合 close 函数让上层照旧 .close()
  return { close() { for (const w of watchers) { try { w.close() } catch { /* ignore */ } } } }
}

function detectCodexSessionFromFs(afterMs) {
  // 同时扫 today / yesterday / tomorrow，对抗 AgentQuad / codex 进程间的 TZ 漂移
  let newest = null
  let newestTime = 0
  for (const dayDir of codexNearbyDayDirs()) {
    if (!existsSync(dayDir)) continue
    try {
      for (const file of readdirSync(dayDir)) {
        if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue
        const st = statSync(join(dayDir, file))
        const t = st.birthtimeMs || st.ctimeMs
        if (t > afterMs && t > newestTime) {
          const uuidMatch = file.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/)
          if (uuidMatch) {
            newest = uuidMatch[1]
            newestTime = t
          }
        }
      }
    } catch { /* ignore one bad dir, keep scanning others */ }
  }
  return newest
}

// Claude 把 JSONL 写到 ~/.claude/projects/<cwd-hash>/<uuid>.jsonl。我们在 spawn
// 时通过 --session-id <presetClaudeId> 把 UUID 推下去，理想情况下 Claude 会用这个
// UUID 写文件，session.nativeId 直接对得上。
//
// 但部分代理 / wrapper（mira / trae 之类）会再 spawn 一次 claude、丢掉 --session-id，
// 或自家 fork 不识别这个 flag → Claude 用自己生成的 UUID 写 JSONL → session.nativeId
// 与磁盘上不一致 → loadTranscript 找不到文件 → 兜底成 PTY raw → Conversation
// 整段 banner 塌掉。
//
// 形态对齐 detectCodexSessionFromFs：扫所有 project 目录里 mtime > spawnTime 的
// <uuid>.jsonl，挑最新一个的 UUID。命中后由 _setNativeId 去重 + 覆盖。
function detectClaudeSessionFromFs(afterMs) {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return null
  let dirs
  try { dirs = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true }) } catch { return null }
  let newest = null
  let newestTime = 0
  for (const dirent of dirs) {
    if (!dirent.isDirectory()) continue
    const projDir = join(CLAUDE_PROJECTS_DIR, dirent.name)
    let files
    try { files = readdirSync(projDir) } catch { continue }
    for (const f of files) {
      const m = f.match(CLAUDE_JSONL_FILE_RE)
      if (!m) continue
      try {
        const st = statSync(join(projDir, f))
        const t = st.birthtimeMs || st.ctimeMs
        if (t > afterMs && t > newestTime) {
          newest = m[1]
          newestTime = t
        }
      } catch { /* ignore */ }
    }
  }
  return newest
}

function tryReadCwdFromSessionMeta(filePath) {
  try {
    const head = readFileSync(filePath, 'utf8').split('\n').slice(0, 2)
    for (const line of head) {
      if (!line.trim()) continue
      const j = JSON.parse(line)
      if (j?.type === 'session_meta' && j?.payload?.cwd) return j.payload.cwd
    }
  } catch {}
  return null
}

/**
 * 反向定位某个 codex nativeSessionId 对应的 rollout-*.jsonl 文件 + 起始 cwd。
 * 用途：拿到 native id 后由上层需要订阅 jsonl 增量，或恢复时校验文件是否还在。
 * 读 head 两行扫 session_meta，找不到时 cwd:null（仍返回 filePath）。
 */
export function findCodexSession(nativeSessionId, { sessionsRoot = CODEX_SESSIONS_DIR } = {}) {
  if (!nativeSessionId) return null
  if (!existsSync(sessionsRoot)) return null
  let years
  try { years = readdirSync(sessionsRoot).filter(y => /^\d{4}$/.test(y)) } catch { return null }
  for (const y of years) {
    const yDir = join(sessionsRoot, y)
    let months
    try { months = readdirSync(yDir) } catch { continue }
    for (const m of months) {
      const mDir = join(yDir, m)
      let days
      try { days = readdirSync(mDir) } catch { continue }
      for (const d of days) {
        const dDir = join(mDir, d)
        let files
        try { files = readdirSync(dDir) } catch { continue }
        for (const f of files) {
          const match = f.match(CODEX_ROLLOUT_FILE_RE)
          if (!match || match[1] !== nativeSessionId) continue
          const filePath = join(dDir, f)
          const cwd = tryReadCwdFromSessionMeta(filePath)
          return { filePath, cwd, nativeId: nativeSessionId }
        }
      }
    }
  }
  return null
}

function defaultPtyFactory() {
  const pty = require('node-pty')
  return (bin, args, opts) => pty.spawn(bin, args, opts)
}

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const CURSOR_PROJECTS_DIR = join(homedir(), '.cursor', 'projects')

/**
 * cursor-agent 的 cwd 编码：把绝对路径里的 `/` 全部换成 `-`，前导 `-` 保留。
 *   /Users/foo/bar      → Users-foo-bar
 *   /private/tmp/x      → private-tmp-x
 *   /                   → empty-window（特例，交给 cursor 自己决定，不在这里处理）
 */
function encodeCursorCwd(cwd) {
  if (!cwd) return null
  const trimmed = cwd.replace(/^\/+/, '').replace(/\/+$/, '')
  if (!trimmed) return null
  return trimmed.replace(/\//g, '-')
}

/**
 * 公开：返回某个 cwd 下某 chatId 对应的 jsonl 绝对路径（不保证存在）。
 * 失败返回 null。
 */
export function cursorTranscriptPath(cwd, chatId) {
  const encoded = encodeCursorCwd(cwd)
  if (!encoded || !chatId) return null
  return join(CURSOR_PROJECTS_DIR, encoded, 'agent-transcripts', chatId, `${chatId}.jsonl`)
}

/**
 * 异步预生成 cursor chatId：跑 `cursor-agent create-chat`，stdout 第一行就是 UUID。
 * 非阻塞，默认 6s 超时。失败/超时 resolve null（让上层走"无 nativeId"降级路径）。
 */
function createCursorChatAsync(bin, timeoutMs = 6000) {
  return new Promise((resolve) => {
    try {
      execFileCb(bin, ['create-chat'], { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout) => {
        if (err) { resolve(null); return }
        const m = String(stdout || '').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
        resolve(m ? m[0] : null)
      })
    } catch {
      resolve(null)
    }
  })
}

/**
 * Claude Code 把每段对话按 cwd 编码存到 ~/.claude/projects/<encoded>/<uuid>.jsonl，
 * --resume 在当前 cwd 对应的目录里查 uuid，找不到就 "No conversation found"。
 * 我们 DB 里的 session.cwd 可能跟 claude 当时实际的 cwd 不一致（例如默认 cwd 改过、
 * 或者起会话时传错了），导致 resume 100% 失败。
 *
 * 这里直接按 uuid 在所有 project 目录里搜一遍，找到 jsonl 后从前面几条记录里读出
 * claude 自己写下的 cwd 字段；那才是 resume 应该用的 cwd。
 *
 * 返回 { filePath, cwd } | null。读不到 cwd 字段时 cwd=null（仍返回 filePath，调用方
 * 可以决定是否兜底）。
 */
function defaultClaudeSessionLocator(nativeSessionId) {
  if (!nativeSessionId || typeof nativeSessionId !== 'string') return null
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return null
  let entries
  try { entries = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true }) } catch { return null }
  for (const dirent of entries) {
    if (!dirent.isDirectory()) continue
    const filePath = join(CLAUDE_PROJECTS_DIR, dirent.name, `${nativeSessionId}.jsonl`)
    if (!existsSync(filePath)) continue
    let cwd = null
    try {
      // jsonl 可能很大，只读前 64KB；cwd 字段一般在最早几条 message 里就出现
      const fd = openSync(filePath, 'r')
      try {
        const buf = Buffer.alloc(65536)
        const n = readSync(fd, buf, 0, buf.length, 0)
        const chunk = buf.slice(0, n).toString('utf8')
        const lines = chunk.split('\n')
        // 最后一行可能被截断，跳过
        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i].trim()
          if (!line) continue
          try {
            const obj = JSON.parse(line)
            if (typeof obj.cwd === 'string' && obj.cwd) { cwd = obj.cwd; break }
          } catch { /* 不是 JSON 或解析失败，跳过 */ }
        }
      } finally { closeSync(fd) }
    } catch { /* 读文件失败，cwd 留 null */ }
    return { filePath, cwd }
  }
  return null
}

export class PtyManager extends EventEmitter {
  constructor({ tools, ptyFactory, promptDelayMs = 2000, codexWatcherFactory, claudeSessionLocator, codexSessionLocator, sidecar = null, eventEmitterFactory = null, codexPromptDetectorFactory = null } = {}) {
    super()
    if (!tools) throw new Error('PtyManager: tools required')
    this.tools = tools
    this.ptyFactory = ptyFactory || defaultPtyFactory()
    this.codexWatcherFactory = codexWatcherFactory || defaultCodexWatcherFactory
    this.claudeSessionLocator = claudeSessionLocator || defaultClaudeSessionLocator
    this.codexSessionLocator = codexSessionLocator || ((id) => findCodexSession(id))
    this.promptDelayMs = promptDelayMs
    this.sidecar = sidecar
    this.eventEmitterFactory = eventEmitterFactory
    this.codexPromptDetectorFactory = codexPromptDetectorFactory || createCodexPromptDetector
    this.sessions = new Map()
  }

  /**
   * 公开的 claude resume 文件定位接口。返回 { filePath, cwd } | null。
   * 上层（ai-terminal 启动恢复）用它来：
   *   - 判断 nativeSessionId 是否还在硬盘上（不在就别 spawn 一个注定失败的 --resume）
   *   - 拿到真实 cwd 修正 DB 里漂移的记录
   */
  findClaudeSession(nativeSessionId) {
    try { return this.claudeSessionLocator(nativeSessionId) } catch { return null }
  }

  // 任何一条探测路径命中 id，统一走这里：去重 + 清理其余两路 + emit。
  _setNativeId(session, nativeId) {
    if (!nativeId || session.nativeId === nativeId) return false
    session.nativeId = nativeId
    if (session.detectTimer) { clearInterval(session.detectTimer); session.detectTimer = null }
    if (session.fsWatcher) { try { session.fsWatcher.close() } catch { /* ignore */ } session.fsWatcher = null }
    this.emit('native-session', { sessionId: session.sessionId, nativeId })
    // codex 专属：拿到 native id 后落 sidecar + 启动 jsonl 增量 emitter，给 IM 推送链路用。
    if (session.tool === 'codex') {
      console.log(`[codex-detect] _setNativeId session=${session.sessionId} nativeId=${nativeId}`)
      if (this.sidecar) {
        try {
          const p = this.sidecar.write({
            nativeId,
            quadtodoSessionId: session.sessionId,
            todoId: session.todoId || null,
            cwd: session.cwd || null,
          })
          if (p && typeof p.catch === 'function') p.catch(() => {})
          console.log(`[codex-detect] sidecar.write OK nativeId=${nativeId}`)
        } catch (e) {
          console.warn(`[codex-detect] sidecar.write FAILED:`, e?.message || e)
        }
      } else {
        console.warn(`[codex-detect] this.sidecar is null — server.js didn't wire it`)
      }
      if (this.eventEmitterFactory && !session.eventEmitter) {
        try {
          const loc = this.codexSessionLocator(nativeId)
          if (loc?.filePath) {
            session.eventEmitter = this.eventEmitterFactory({ filePath: loc.filePath, nativeId })
            session.eventEmitter.start?.()
            console.log(`[codex-detect] emitter started filePath=${loc.filePath}`)
          } else {
            console.warn(`[codex-detect] codexSessionLocator returned null for nativeId=${nativeId} — emitter NOT started (will retry below)`)
            // jsonl 文件这一刻可能还没 flush 到 fs；500ms / 1500ms 各重试一次。
            const retry = (delay) => setTimeout(() => {
              if (session.eventEmitter || session.stopped) return
              const loc2 = this.codexSessionLocator(nativeId)
              if (loc2?.filePath && this.eventEmitterFactory) {
                session.eventEmitter = this.eventEmitterFactory({ filePath: loc2.filePath, nativeId })
                session.eventEmitter.start?.()
                console.log(`[codex-detect] emitter started on retry+${delay}ms filePath=${loc2.filePath}`)
              } else if (delay < 1500) {
                console.warn(`[codex-detect] retry+${delay}ms still no jsonl file for ${nativeId}`)
              }
            }, delay)
            retry(500).unref?.()
            retry(1500).unref?.()
          }
        } catch (e) {
          console.warn(`[codex-detect] emitter start FAILED:`, e?.message || e)
        }
      } else if (!this.eventEmitterFactory) {
        console.warn(`[codex-detect] this.eventEmitterFactory is null — server.js didn't wire it`)
      }
    }
    return true
  }

  has(sessionId) {
    return this.sessions.has(sessionId)
  }

  list() {
    return [...this.sessions.keys()]
  }

  /** 返回 session 已知的 native id（claude 预置 / resume 沿用）；codex 新会话探测前为 null。 */
  getNativeId(sessionId) {
    return this.sessions.get(sessionId)?.nativeId || null
  }

  /** 返回当前所有活跃 PTY 的 { sessionId, pid, tool }，供 pidusage 采样用 */
  /** Watcher 写在 PtyManager 自己的 session 上的 usage 副本。route 的 sessions Map
   *  和这里不是同一份对象，必须显式 cross-read。返回 null 表示还没解析到。 */
  getUsage(sessionId) {
    const s = this.sessions.get(sessionId)
    return s?.usage || null
  }

  getPids() {
    const out = []
    for (const [sessionId, s] of this.sessions) {
      const pid = s.proc?.pid
      if (pid) out.push({ sessionId, pid, tool: s.tool })
    }
    return out
  }

  /**
   * 测试 / Phase A 友好入口：传 { tool, sessionId, cwd, todoId, prompt?, ... }，返回一个
   * 可 .kill() 的 handle。内部仍走 start() 的全部生命周期，方便 sidecar / emitter 接线
   * 测试不必走 onExit 链路。
   */
  spawn({ tool, sessionId, cwd, todoId, prompt = null, resumeNativeId = null, permissionMode = null, extraEnv = null } = {}) {
    this.start({ sessionId, tool, prompt, cwd, resumeNativeId, permissionMode, extraEnv })
    const session = this.sessions.get(sessionId)
    if (session) {
      session.todoId = todoId || null
      session.cwd = cwd || null
    }
    return {
      sessionId,
      get nativeId() { return session?.nativeId || null },
      kill: () => this.stop(sessionId),
    }
  }

  /**
   * 两段式 spawn：create() 只构造 session 记录（不开子进程），
   * startWithSize() 才真正调 ptyFactory 把 PTY 拉起来。WS init 握手在
   * 会话建立时调 create()、收到前端真实 cols/rows 后再调 startWithSize()，
   * 这样 PTY 永远不会在默认 80×24 上 spawn 一次再 resize。
   */
  create({ sessionId, tool, prompt, cwd, resumeNativeId, permissionMode, extraEnv, mcpConfigPath = null, codexMcpUrl = null }) {
    const toolCfg = this.tools[tool]
    if (!toolCfg) throw new Error(`unknown tool: ${tool}`)
    const baseArgs = toolCfg.args || []
    // 是否通过 CLI 参数传递 prompt（仅新会话、非 resume 时可用）
    const useCliPrompt = prompt && !resumeNativeId
    // permissionMode → 原生 CLI 标志：把托管模式直接交给 claude/codex 处理，
    // 比在 PTY 输出里做正则匹配 + 自动回车 更可靠。
    const permissionArgs = buildPermissionArgs(tool, permissionMode)
    // Claude 内置 AskUserQuestion TUI 在 Telegram 不可用，源头禁掉
    const disallowedToolsArgs = buildClaudeDisallowedToolsArgs(tool)
    // Claude 支持 --session-id <uuid>：新会话时由我们预生成，避免事后靠 FS/输出扫描。
    const presetClaudeId = tool === 'claude' && !resumeNativeId ? randomUUID() : null
    const claudeSessionArgs = presetClaudeId ? ['--session-id', presetClaudeId] : []
    // AgentQuad runtime MCP config injection
    const mcpConfigArgs = (tool === 'claude' && mcpConfigPath)
      ? ['--mcp-config', mcpConfigPath]
      : []
    // Codex 用 --config key=value 直接覆写（不需要文件）
    // 注意 codex 把 value 当 TOML 表达式解析，URL 字符串要带双引号
    const codexMcpArgs = (tool === 'codex' && codexMcpUrl)
      ? [
          '-c', `mcp_servers.agentquad.url="${codexMcpUrl}"`,
          '-c', 'mcp_servers.agentquad.transport="http"',
        ]
      : []

    // cursor-agent 没有 --session-id 预置，但有 `cursor-agent create-chat` 异步建会话拿 chatId。
    // 新会话先异步跑 create-chat，拿到 chatId 后在 startWithSize() 里用 --resume 进交互模式。
    // create-chat 失败就降级（无 nativeId，直接传 prompt）。
    // bin 为空时 fallback 到 command 名，让 execFile / spawn 走 PATH 解析。
    const spawnFile = (toolCfg.bin && String(toolCfg.bin).trim()) || toolCfg.command
    let cursorChatPromise = null
    if (tool === 'cursor' && !resumeNativeId) {
      cursorChatPromise = createCursorChatAsync(spawnFile)
    }
    const cursorResumeId = tool === 'cursor' ? resumeNativeId : null

    let args
    if (resumeNativeId) {
      if (tool === 'codex') args = [...baseArgs, ...permissionArgs, ...codexMcpArgs, 'resume', resumeNativeId]
      else if (tool === 'cursor') args = [...baseArgs, ...permissionArgs, '--resume', resumeNativeId]
      else args = [...baseArgs, ...permissionArgs, ...disallowedToolsArgs, ...mcpConfigArgs, '--resume', resumeNativeId]
    } else if (tool === 'cursor' && cursorResumeId) {
      args = useCliPrompt
        ? [...baseArgs, ...permissionArgs, '--resume', cursorResumeId, prompt]
        : [...baseArgs, ...permissionArgs, '--resume', cursorResumeId]
    } else {
      // 关键：mcpConfigArgs（--mcp-config <FILE>）必须放在某个 --<flag> 之前，
      // 否则 Claude 的变长 --mcp-config 会贪婪吃后面的 prompt 当成 "另一个配置文件"
      // （Claude Code GitHub issue #5593 同一类问题）。
      // 因此把 mcpConfigArgs 放在 claudeSessionArgs (--session-id) 之前。
      args = useCliPrompt
        ? [...baseArgs, ...permissionArgs, ...disallowedToolsArgs, ...mcpConfigArgs, ...claudeSessionArgs, ...codexMcpArgs, prompt]
        : [...baseArgs, ...permissionArgs, ...disallowedToolsArgs, ...mcpConfigArgs, ...claudeSessionArgs, ...codexMcpArgs]
    }
    let effectiveCwd = cwd || process.env.HOME || process.cwd()

    // claude --resume 的 cwd 必须跟原会话的 cwd 一致，否则 claude 在错误的 projects/<encoded>
    // 目录里找不到 jsonl 就抛 "No conversation found"。这里按 uuid 反查文件位置 + 内嵌 cwd
    // 字段做一次纠正；找不到文件就只 warn，让 claude 自己抛原始错误。
    if (resumeNativeId && tool === 'claude') {
      try {
        const located = this.claudeSessionLocator(resumeNativeId)
        if (located?.cwd && located.cwd !== effectiveCwd && existsSync(located.cwd)) {
          console.log(`[pty] claude --resume ${resumeNativeId.slice(0, 8)}: cwd corrected ${effectiveCwd} → ${located.cwd}`)
          effectiveCwd = located.cwd
        } else if (!located) {
          console.warn(`[pty] claude --resume ${resumeNativeId.slice(0, 8)}: no jsonl in ~/.claude/projects/*/ — resume will likely fail`)
        }
      } catch (e) {
        console.warn(`[pty] claudeSessionLocator failed: ${e.message}`)
      }
    }

    const env = {
      ...process.env,
      TERM: 'xterm-256color',
      TZ: process.env.TZ || 'America/Los_Angeles',
      FORCE_COLOR: '1',
      // Force narrow East-Asian-Ambiguous wcwidth so PTY children agree with xterm.js's
      // Unicode rendering. Set AGENTQUAD_KEEP_CJK_LOCALE=1 to disable this override.
      ...(process.env.AGENTQUAD_KEEP_CJK_LOCALE === '1' ? {} : {
        LANG: 'en_US.UTF-8',
        LC_CTYPE: 'en_US.UTF-8',
      }),
      ...(extraEnv && typeof extraEnv === 'object' ? extraEnv : {}),
    }
    env.PATH = buildChildPath(toolCfg.bin, env.PATH || '')

    const session = {
      proc: null,
      tool,
      sessionId,
      cwd: effectiveCwd,
      todoId: null,
      fullLog: [],
      logBytes: 0,
      pendingPrompt: useCliPrompt ? null : (prompt && !resumeNativeId ? prompt : null),
      resized: false,
      promptTimer: null,
      nativeId: resumeNativeId || presetClaudeId || null,
      stopped: false,
      detectTimer: null,
      fsWatcher: null,
      eventEmitter: null,
      detector: null,
      lastTuiAlertAt: 0,
      cursorChatPromise,
      mcpConfigPath: mcpConfigPath || null,
      spawnSpec: {
        args,
        env,
        effectiveCwd,
        toolCfg,
        tool,
        spawnFile,
        resumeNativeId: resumeNativeId || null,
        _baseArgs: [...baseArgs],
        _permissionArgs: [...permissionArgs],
        _promptArg: useCliPrompt ? prompt : null,
      },
    }
    this.sessions.set(sessionId, session)
  }

  /**
   * 用真实 cols/rows 把 PTY 拉起来；第二次及之后调用会降级为 resize()。
   * 必须先经过 create()。对 cursor 新会话会先 await create-chat 异步结果。
   */
  async startWithSize(sessionId, cols, rows) {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`no session ${sessionId}`)
    if (session.proc) {
      try { session.proc.resize(cols, rows) } catch { /* ignore */ }
      return
    }

    // cursor 新会话：等待 create-chat 异步结果，拿到 chatId 后重建 args
    if (session.cursorChatPromise) {
      const chatId = await session.cursorChatPromise
      session.cursorChatPromise = null
      if (chatId) {
        session.nativeId = chatId
        const spec = session.spawnSpec
        const parts = [...spec._baseArgs, ...spec._permissionArgs, '--resume', chatId]
        if (spec._promptArg) parts.push(spec._promptArg)
        spec.args = parts
        this.emit('native-session', { sessionId, nativeId: chatId })
      } else {
        console.warn(`[pty] cursor-agent create-chat failed; session will run without nativeId tracking`)
      }
    }

    const spec = session.spawnSpec
    if (!spec) throw new Error(`session ${sessionId} has no spawnSpec (was it created?)`)
    const { args, env, effectiveCwd, toolCfg, tool, spawnFile } = spec
    const { resumeNativeId } = spec

    console.log(`[pty] starting ${tool} spawnFile=${spawnFile} (configured bin=${toolCfg.bin || '<empty>'}) cwd=${effectiveCwd} args=${JSON.stringify(args)} cols=${cols} rows=${rows}`)

    let proc
    try {
      proc = this.ptyFactory(spawnFile, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: effectiveCwd,
        env,
      })
    } catch (error) {
      // ptyFactory failed → session record is stranded (no proc → no onExit to clean it up).
      // Remove it explicitly so callers can retry / start a new session with the same id.
      // Task 10: 防止 ptyFactory 失败时孤立 runtime mcp config 文件
      if (session.mcpConfigPath) {
        try { if (existsSync(session.mcpConfigPath)) unlinkSync(session.mcpConfigPath) } catch { /* ignore */ }
      }
      this.sessions.delete(sessionId)
      error.message = `PTY spawn failed for ${tool} (spawnFile=${spawnFile}, cwd=${effectiveCwd}, args=${JSON.stringify(args)}): ${error.message}`
      throw error
    }
    session.proc = proc

    // Codex 专属：stdout 提示词检测器（接 [Y/n] / apply patch? 之类的兜底权限弹窗）。
    // emitter 用迟绑定 getter 包装：detector 创建在 _setNativeId 之前，eventEmitter 还是 null。
    if (tool === 'codex') {
      try {
        session.detector = this.codexPromptDetectorFactory({
          pty: proc,
          emitter: {
            getLatestAssistantContent: () => session.eventEmitter?.getLatestAssistantContent?.() || '',
          },
          onMatch: ({ promptText, matchedPattern }) => {
            this.emit('codex-prompt', {
              sessionId: session.sessionId,
              nativeId: session.nativeId,
              promptText,
              matchedPattern,
            })
          },
        })
        session.detector.start?.()
      } catch (e) {
        console.warn('[pty] codex prompt detector start failed:', e?.message || e)
        session.detector = null
      }
    }

    // 已知 nativeId 立即同步通知 —— 覆盖三种情况：
    //   1) Claude 新会话：presetClaudeId（randomUUID）
    //   2) Claude --resume：resumeNativeId（沿用 native id）
    //   3) Codex --resume：resumeNativeId
    // Codex 新会话（无 resume 也无 preset）走下面的 fs.watch / 轮询 / regex 三路探测
    if (session.nativeId) {
      this.emit('native-session', { sessionId, nativeId: session.nativeId })
    }

    // Codex 新会话：codex CLI 无 --session-id / --rollout-path 预置能力。
    // 三路并行探测 native id，首个命中即停（_setNativeId 内部去重 + 清理其余）：
    //   1) fs.watch 当日 rollout 目录 —— 首选，通常 <50ms
    //   2) 400ms 轮询 —— 兜底 fs.watch 不可靠的 FS（Docker volume / SMB 等）
    //   3) PTY stdout 正则 —— 再兜底，见下方 proc.onData
    if (!resumeNativeId && tool === 'codex') {
      const spawnTime = Date.now() - 1000

      session.fsWatcher = this.codexWatcherFactory(spawnTime, (id) => {
        this._setNativeId(session, id)
      })

      let detectAttempts = 0
      console.log(`[codex-detect] poll started session=${sessionId} spawnTime=${spawnTime}`)
      session.detectTimer = setInterval(() => {
        detectAttempts++
        if (session.nativeId) {
          clearInterval(session.detectTimer)
          session.detectTimer = null
          return
        }
        const id = detectCodexSessionFromFs(spawnTime)
        if (id) {
          console.log(`[codex-detect] poll attempt=${detectAttempts} found nativeId=${id}`)
          this._setNativeId(session, id)
        } else if (detectAttempts >= 30) {
          console.warn(`[codex-detect] poll GAVE UP after 30 attempts (12s) for session=${sessionId} — codex never wrote a rollout matching afterMs=${spawnTime}; check ~/.codex/sessions/$(date +%Y/%m/%d)/`)
          clearInterval(session.detectTimer)
          session.detectTimer = null
        } else if (detectAttempts === 1 || detectAttempts === 5 || detectAttempts === 15) {
          console.log(`[codex-detect] poll attempt=${detectAttempts} no match yet`)
        }
      }, 400)
      session.detectTimer.unref?.()
    }

    // Claude 新会话：虽然 spawn 时已经传了 --session-id <presetClaudeId> 把 UUID
    // 推下去（session.nativeId 也立刻设上），但代理/wrapper（mira / trae 等）会
    // 在转发链路里丢掉 --session-id 或自家 fork claude → Claude 写 JSONL 时用自己
    // 的 UUID → session.nativeId 对不上磁盘 → loadTranscript 兜底成 PTY raw。
    //
    // 这里加一道 FS 轮询治本：扫到 mtime > spawnTime 的真实 UUID，跟 session.nativeId
    // 比一比；如果一致说明 preset 被 honor，停掉轮询即可；不一致则 _setNativeId 覆盖。
    if (!resumeNativeId && tool === 'claude') {
      const spawnTime = Date.now() - 1000
      let detectAttempts = 0
      const presetIdShort = session.nativeId?.slice(0, 8)
      console.log(`[claude-detect] poll started session=${sessionId} preset=${presetIdShort} spawnTime=${spawnTime}`)
      session.detectTimer = setInterval(() => {
        detectAttempts++
        const id = detectClaudeSessionFromFs(spawnTime)
        if (id) {
          if (id !== session.nativeId) {
            console.log(`[claude-detect] poll attempt=${detectAttempts} OVERRIDE ${session.nativeId?.slice(0, 8)} → ${id.slice(0, 8)} (--session-id likely ignored by wrapper)`)
            this._setNativeId(session, id)
          } else {
            console.log(`[claude-detect] poll attempt=${detectAttempts} preset honored, stop`)
            clearInterval(session.detectTimer)
            session.detectTimer = null
          }
        } else if (detectAttempts >= 30) {
          console.warn(`[claude-detect] poll GAVE UP after 30 attempts (12s) for session=${sessionId} — no jsonl matching afterMs=${spawnTime} under ${CLAUDE_PROJECTS_DIR}`)
          clearInterval(session.detectTimer)
          session.detectTimer = null
        }
      }, 400)
      session.detectTimer.unref?.()
    }

    proc.onData((data) => {
      session.fullLog.push(data)
      session.logBytes += data.length
      while (session.logBytes > MAX_LOG_BYTES && session.fullLog.length > 1) {
        const removed = session.fullLog.shift()
        session.logBytes -= removed.length
      }
      const stripped = data
        .replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, '')
        .replace(/\x1b\][^\x07]*\x07/g, '')
        .replace(/\x1b[()#][A-Za-z0-9]/g, '')
        .replace(/\x1b[>=<cDEHMNOPZ78]/g, '')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
      const sessionRe = tool === 'codex' ? CODEX_SESSION_RE : CLAUDE_SESSION_RE
      const m = stripped.match(sessionRe)
      if (m) this._setNativeId(session, m[1])
      // TUI 兜底检测：只在 claude 上看，30s 内同一 session 只推一次
      if (tool === 'claude' && TUI_FOOTER_RE.test(stripped)) {
        const now = Date.now()
        if (now - session.lastTuiAlertAt > TUI_ALERT_COOLDOWN_MS) {
          session.lastTuiAlertAt = now
          this.emit('tui-detected', { sessionId, tool })
        }
      }
      this.emit('output', { sessionId, data })
    })

    // claude 专属：监听 ~/.claude/projects/<encoded>/<uuid>.jsonl 末行类型，
    // 作为 awaitingReply 的"真相源"兜底 stop hook：
    //   - 末行 type=='user' 且非 tool_result    → 真用户输入 → claude-turn-started
    //   - 末行 type=='assistant' 且 stop_reason=='end_turn' → 真轮次完成 → claude-turn-done
    //   - 中间态（tool_use / tool_result）跳过，等下一拍
    // 解决两个 bug：
    //   1) 第一轮 prompt 是后端 proc.write 直写，绕过 awaitingReply 复位路径，
    //      stop hook fire 完后 awaitingReply=true 就再也回不到 false → 假 idle
    //   2) stop hook 偶发不 fire 时，没有任何信号让前端从 running 切到 idle
    // 与 stop hook 并存，markSessionAwaitingReply 自身幂等。
    if (tool === 'claude') {
      session.claudeLastJsonlMtimeMs = 0
      session.claudeJsonlPath = null
      session.claudeLastEmittedKind = null
      session.claudeWatchTimer = setInterval(() => {
        try {
          const nativeId = session.nativeId
          if (!nativeId) return
          if (!session.claudeJsonlPath) {
            const located = this.claudeSessionLocator(nativeId)
            if (!located?.filePath) return
            session.claudeJsonlPath = located.filePath
          }
          const jsonlPath = session.claudeJsonlPath
          if (!existsSync(jsonlPath)) return
          const st = statSync(jsonlPath)
          if (st.mtimeMs <= session.claudeLastJsonlMtimeMs) return
          const content = readFileSync(jsonlPath, 'utf8')
          // 反向扫，跳过 system / attachment / last-prompt 等元数据行，
          // 找最近一条 type ∈ {user, assistant} 的有效行。
          const lines = content.split('\n')
          // 每次 mtime 推进都刷新 usage（不能等下面的 kind-变化早 return —— 同一轮
          // 内追加 assistant 消息时 kind 不变，会 return 跳过 usage 解析）。
          for (let i = lines.length - 1; i >= 0; i--) {
            const ln = (lines[i] || '').trim()
            if (!ln.startsWith('{')) continue
            let obj
            try { obj = JSON.parse(ln) } catch { continue }
            if (obj.type !== 'assistant') continue
            const u = obj.message?.usage
            if (!u) continue
            session.usage = {
              input: Number(u.input_tokens) || 0,
              output: Number(u.output_tokens) || 0,
              cacheRead: Number(u.cache_read_input_tokens) || 0,
              cacheCreation: Number(u.cache_creation_input_tokens) || 0,
              model: obj.message?.model || null,
              ts: obj.timestamp ? Date.parse(obj.timestamp) : Date.now(),
            }
            break
          }
          let kind = null  // 'turn-started' | 'turn-done' | null
          for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim()
            if (!line || !line.startsWith('{')) continue
            let obj
            try { obj = JSON.parse(line) } catch { continue }
            const t = obj.type
            if (t !== 'user' && t !== 'assistant') continue
            const content = obj.message?.content
            const blocks = Array.isArray(content) ? content : []
            if (t === 'user') {
              // 不区分 tool_result vs 真用户输入：两者都意味着 "Claude 正在/即将处理"
              // → awaitingReply=false。tool_result 是 Claude 自家 tool_use → tool_result 闭环，
              // 看到 tool_result 说明上一拍的 assistant 还会继续追加内容，没结束。
              //
              // 例外：Claude Code 在用户 Esc/Ctrl+C 打断时会写入一条 type=user 的消息，
              // 内容里带 "[Request interrupted by user" 文本（可能在 string content 里，也
              // 可能落在某个 tool_result.content 里）。这种情况 Stop hook 不会 fire，
              // stop_reason 也不会是 end_turn → 不识别就 stuck-running。这里检出 marker
              // 后把它当作"轮次已结束"看，让上层走 markSessionAwaitingReply(true) 路径。
              const contentText = typeof content === 'string'
                ? content
                : blocks.map(b => {
                    if (!b) return ''
                    if (typeof b.text === 'string') return b.text
                    if (typeof b.content === 'string') return b.content
                    return ''
                  }).join('\n')
              if (contentText.includes('[Request interrupted by user')) {
                kind = 'turn-done'
              } else {
                kind = 'turn-started'
              }
            } else {
              // assistant：仅 stop_reason==='end_turn' 才算真完成；tool_use / max_tokens / null 都是中间态
              const sr = obj.message?.stop_reason
              if (sr === 'end_turn') kind = 'turn-done'
              else continue  // 中间 assistant，继续往前找上一条 user
            }
            break
          }
          if (!kind) {
            session.claudeLastJsonlMtimeMs = st.mtimeMs
            return
          }
          if (kind === session.claudeLastEmittedKind) {
            session.claudeLastJsonlMtimeMs = st.mtimeMs
            return
          }
          session.claudeLastJsonlMtimeMs = st.mtimeMs
          session.claudeLastEmittedKind = kind
          if (kind === 'turn-started') {
            this.emit('claude-turn-started', { sessionId, nativeId })
          } else {
            this.emit('claude-turn-done', { sessionId, nativeId })
          }
        } catch { /* ignore — watcher 不能影响 PTY 主链路 */ }
      }, 2000)
      session.claudeWatchTimer.unref?.()
    }

    // codex 专属：mtime-gated 周期扫 rollout-*.jsonl，抽 latest token_count 事件的
    // total_token_usage（cumulative）给 /sessions API 用。跟 claudeWatchTimer 同步频率。
    if (tool === 'codex') {
      session.codexUsageLastMtimeMs = 0
      session.codexUsageWatchTimer = setInterval(() => {
        try {
          const nativeId = session.nativeId
          if (!nativeId) return
          if (!session.codexUsageJsonlPath) {
            const loc = this.codexSessionLocator(nativeId)
            if (!loc?.filePath) return
            session.codexUsageJsonlPath = loc.filePath
          }
          const jsonlPath = session.codexUsageJsonlPath
          if (!existsSync(jsonlPath)) return
          const st = statSync(jsonlPath)
          if (st.mtimeMs <= session.codexUsageLastMtimeMs) return
          session.codexUsageLastMtimeMs = st.mtimeMs
          const lines = readFileSync(jsonlPath, 'utf8').split('\n')
          let last = null
          let model = null
          for (let i = lines.length - 1; i >= 0; i--) {
            const ln = (lines[i] || '').trim()
            if (!ln.startsWith('{')) continue
            let obj
            try { obj = JSON.parse(ln) } catch { continue }
            if (obj.type === 'event_msg' && obj.payload?.type === 'token_count') {
              const info = obj.payload.info
              if (info?.total_token_usage && !last) last = info.total_token_usage
            }
            if (!model && obj.type === 'turn_context') {
              model = obj.payload?.model || obj.payload?.collaboration_mode?.settings?.model || null
            }
            if (!model && obj.type === 'session_meta') {
              model = obj.payload?.model || obj.payload?.model_provider?.model || null
            }
            if (last && model) break
          }
          if (!last) return
          session.usage = {
            input: Number(last.input_tokens) || 0,
            output: Number(last.output_tokens) || 0,
            cacheRead: Number(last.cached_input_tokens || last.cache_read_input_tokens) || 0,
            cacheCreation: Number(last.cache_creation_input_tokens) || 0,
            model: model || null,
            ts: Date.now(),
          }
        } catch { /* ignore */ }
      }, 2000)
      session.codexUsageWatchTimer.unref?.()
    }

    // cursor 专属：监听 chatId 的 jsonl，末行 role===assistant 且 mtime 推进
    // → 一轮回复结束。这里走轮询而不是依赖 cursor 自家 stop hook，是因为
    // 实测 cursor 的 stop hook 偶发不 fire（同一 cursor 安装，部分 session 完全
    // 收不到 stop 事件），靠 jsonl 才能做到稳定 100%。
    if (tool === 'cursor') {
      session.cursorLastSeenMtimeMs = 0
      session.cursorPendingDone = false
      session.cursorWatchTimer = setInterval(() => {
        try {
          const nativeId = session.nativeId
          if (!nativeId) return
          const jsonlPath = cursorTranscriptPath(session.cwd, nativeId)
          if (!jsonlPath || !existsSync(jsonlPath)) return
          const st = statSync(jsonlPath)

          if (st.mtimeMs === session.cursorLastSeenMtimeMs) {
            // mtime 没变 → 文件已稳定；如果之前看到了 assistant 末行，现在可以安全 emit
            if (session.cursorPendingDone) {
              session.cursorPendingDone = false
              this.emit('cursor-turn-done', { sessionId, nativeId })
            }
            return
          }

          // mtime 变了 → cursor 还在写，读文件判断当前状态但不急着 emit
          session.cursorLastSeenMtimeMs = st.mtimeMs
          const content = readFileSync(jsonlPath, 'utf8')
          const idx = content.lastIndexOf('\n', content.length - 2)
          const lastLine = (idx >= 0 ? content.slice(idx + 1) : content).trim()
          if (!lastLine) return
          let role = null
          try { role = JSON.parse(lastLine)?.role || null } catch { return }
          if (role === 'assistant') {
            session.cursorPendingDone = true
          } else {
            session.cursorPendingDone = false
          }
        } catch { /* ignore — watcher 不能影响 PTY 主链路 */ }
      }, 2000)
      session.cursorWatchTimer.unref?.()
    }

    // size-first 路径：spawn 时已经是真实尺寸，prompt 不再依赖 resize 触发，
    // 直接按 promptDelayMs（构造器默认 2000ms，可被测试 / 调用方覆盖）发送即可。
    if (session.pendingPrompt) {
      session.promptTimer = setTimeout(() => {
        if (session.pendingPrompt) {
          proc.write(session.pendingPrompt + '\r')
          session.pendingPrompt = null
        }
      }, this.promptDelayMs)
      session.resized = true // 标记 prompt 路径已被 startWithSize 接管，不再由 resize() 驱动
    }

    proc.onExit(({ exitCode }) => {
      if (session.detectTimer) clearInterval(session.detectTimer)
      if (session.promptTimer) clearTimeout(session.promptTimer)
      if (session.cursorWatchTimer) { clearInterval(session.cursorWatchTimer); session.cursorWatchTimer = null }
      if (session.claudeWatchTimer) { clearInterval(session.claudeWatchTimer); session.claudeWatchTimer = null }
      if (session.codexUsageWatchTimer) { clearInterval(session.codexUsageWatchTimer); session.codexUsageWatchTimer = null }
      if (session.fsWatcher) { try { session.fsWatcher.close() } catch { /* ignore */ } session.fsWatcher = null }
      if (session.detector) { try { session.detector.stop?.() } catch { /* ignore */ } session.detector = null }
      if (session.eventEmitter) {
        // codex 在 jsonl 里没有"会话整体结束"的事件，只有 task_complete（一轮）和
        // 进程实际退出。这里合成 SessionEnd 抛给上层，对应 IM 里的 ✅ + 全量 transcript 附件。
        if (session.tool === 'codex' && session.nativeId) {
          try {
            session.eventEmitter.emitSynthetic?.({
              event: 'SessionEnd',
              nativeId: session.nativeId,
              rawEventPayload: { exitCode: exitCode ?? 1 },
            })
          } catch { /* ignore */ }
        }
        try { session.eventEmitter.stop?.() } catch { /* ignore */ }
        session.eventEmitter = null
      }
      if (this.sidecar && session.tool === 'codex' && session.nativeId) {
        try { this.sidecar.clear(session.nativeId) } catch { /* ignore */ }
      }
      // Cleanup runtime MCP config file (Task 10)
      if (session.mcpConfigPath) {
        try { if (existsSync(session.mcpConfigPath)) unlinkSync(session.mcpConfigPath) } catch { /* ignore */ }
      }
      const fullLog = session.fullLog.join('')
      this.sessions.delete(sessionId)
      this.emit('done', {
        sessionId,
        exitCode: exitCode ?? 1,
        fullLog,
        nativeId: session.nativeId,
        stopped: session.stopped,
      })
    })

    // 释放对 args/env 等较大对象的引用（已经被 ptyFactory 闭包持有了）。
    session.spawnSpec = null
  }

  /**
   * 向后兼容入口：把老 start() 的语义维持成 create() + startWithSize(80, 24)。
   * 现有的 route / 测试 / CLI 调用不需要改，只是 PTY 会先在 80×24 上开。
   * size-first 握手路径请改用 create() + startWithSize(realCols, realRows)。
   */
  async start(opts) {
    this.create(opts)
    await this.startWithSize(opts.sessionId, 80, 24)
  }

  startShell({ sessionId, shell, cwd }) {
    const effectiveCwd = cwd || process.env.HOME || process.cwd()
    let proc
    try {
      proc = this.ptyFactory(shell, [], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: effectiveCwd,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          TZ: process.env.TZ || 'America/Los_Angeles',
          FORCE_COLOR: '1',
          ...(process.env.AGENTQUAD_KEEP_CJK_LOCALE === '1' ? {} : {
            LANG: 'en_US.UTF-8',
            LC_CTYPE: 'en_US.UTF-8',
          }),
        },
      })
    } catch (error) {
      error.message = `PTY spawn failed for shell (bin=${shell}, cwd=${effectiveCwd}): ${error.message}`
      throw error
    }

    const session = {
      proc,
      tool: 'shell',
      sessionId,
      fullLog: [],
      logBytes: 0,
      pendingPrompt: null,
      resized: false,
      promptTimer: null,
      nativeId: null,
      stopped: false,
      detectTimer: null,
    }
    this.sessions.set(sessionId, session)

    proc.onData((data) => {
      session.fullLog.push(data)
      session.logBytes += data.length
      while (session.logBytes > MAX_LOG_BYTES && session.fullLog.length > 1) {
        const removed = session.fullLog.shift()
        session.logBytes -= removed.length
      }
      this.emit('output', { sessionId, data })
    })

    proc.onExit(({ exitCode }) => {
      const fullLog = session.fullLog.join('')
      this.sessions.delete(sessionId)
      this.emit('done', {
        sessionId,
        exitCode: exitCode ?? 0,
        fullLog,
        nativeId: null,
        stopped: session.stopped,
      })
    })
  }

  write(sessionId, data) {
    const s = this.sessions.get(sessionId)
    if (s) s.proc.write(data)
  }

  resize(sessionId, cols, rows) {
    const s = this.sessions.get(sessionId)
    if (!s) return
    try { s.proc.resize(cols, rows) } catch { /* ignore */ }
    if (!s.resized && s.pendingPrompt) {
      s.resized = true
      if (s.promptTimer) { clearTimeout(s.promptTimer); s.promptTimer = null }
      setTimeout(() => {
        if (s.pendingPrompt) {
          s.proc.write(s.pendingPrompt + '\r')
          s.pendingPrompt = null
        }
      }, this.promptDelayMs)
    }
  }

  stop(sessionId) {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.stopped = true
    // Codex 侧的 sidecar/emitter 在这里同步清理 —— onExit 也会再做一次（幂等）。
    // 之所以提前清，是因为某些 PTY 实现的 kill() 不一定会准时触发 onExit（测试环境
    // 用 mock proc 完全不触发），sidecar 残留会让下次 boot 误以为会话还在。
    if (s.detector) { try { s.detector.stop?.() } catch { /* ignore */ } s.detector = null }
    if (s.eventEmitter) { try { s.eventEmitter.stop?.() } catch { /* ignore */ } s.eventEmitter = null }
    if (this.sidecar && s.tool === 'codex' && s.nativeId) {
      try { this.sidecar.clear(s.nativeId) } catch { /* ignore */ }
    }
    if (s.proc) {
      try { s.proc.kill() } catch { /* ignore */ }
      // cleanup of this.sessions entry happens in onExit (which also emits 'done')
    } else {
      // Not-yet-spawned session (create() called but startWithSize() not yet, or it failed):
      // no proc to kill, no onExit will fire — clean up timers/watchers, delete the record,
      // and emit a synthetic 'done' so route-level cleanup runs (same lifecycle event
      // a spawned-then-killed session would produce).
      if (s.promptTimer) { try { clearTimeout(s.promptTimer) } catch { /* ignore */ } s.promptTimer = null }
      if (s.detectTimer) { try { clearInterval(s.detectTimer) } catch { /* ignore */ } s.detectTimer = null }
      if (s.cursorWatchTimer) { try { clearInterval(s.cursorWatchTimer) } catch { /* ignore */ } s.cursorWatchTimer = null }
      if (s.claudeWatchTimer) { try { clearInterval(s.claudeWatchTimer) } catch { /* ignore */ } s.claudeWatchTimer = null }
      if (s.codexUsageWatchTimer) { try { clearInterval(s.codexUsageWatchTimer) } catch { /* ignore */ } s.codexUsageWatchTimer = null }
      if (s.fsWatcher) { try { s.fsWatcher.close() } catch { /* ignore */ } s.fsWatcher = null }
      // Cleanup runtime MCP config file (Task 10)
      if (s.mcpConfigPath) {
        try { if (existsSync(s.mcpConfigPath)) unlinkSync(s.mcpConfigPath) } catch { /* ignore */ }
      }
      this.sessions.delete(sessionId)
      this.emit('done', {
        sessionId,
        exitCode: 0,
        fullLog: '',
        nativeId: s.nativeId || null,
        stopped: true,
      })
    }
  }
}
