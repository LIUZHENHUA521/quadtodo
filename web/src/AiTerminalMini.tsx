/**
 * AiTerminalMini — 可内嵌在待办卡片中的迷你终端
 */

import React, { useEffect, useMemo, useRef, useCallback, useState } from 'react'
import { Button, Tooltip, Tag, Dropdown, Modal, ColorPicker, Input, Divider } from 'antd'
import { useTranslation } from 'react-i18next'
import { useAppMessages } from './design/useAppMessages'
import { FullscreenOutlined, FullscreenExitOutlined, StopOutlined, DownOutlined, VerticalAlignBottomOutlined, LockOutlined, UnlockOutlined, BgColorsOutlined, DeleteOutlined, UpOutlined, LeftOutlined, RightOutlined, DragOutlined } from '@ant-design/icons'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { CanvasAddon } from '@xterm/addon-canvas'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import { getTerminalWsUrl, startAiExec, stopAiExec, openTraeCN, TodoStatus, ResumeSessionInput, EditorKind, ApiError } from './api'
import { useTerminalTheme } from './hooks/useTerminalTheme'
import { PRESET_LABELS, PRESET_ORDER, TerminalPresetName, TERMINAL_PRESETS, deriveChrome, getTokenDrivenTheme } from './terminalThemes'
import { useTheme } from './design/ThemeProvider'
import { useAiSessionStore } from './store/aiSessionStore'
import { useDispatchStore } from './store/dispatchStore'
import { useAppConfigStore } from './store/appConfigStore'
import { migrateDraft } from './composerDraft'
import { runWithBackoff } from './aiTerminalRecovery'
import { measureCharWidth } from './utils/measureCharWidth'

// 匹配 xterm 一行中的文件路径（相对或绝对，可带 :line 或 :line:col）
// 规避回溯：只匹配不含空格/冒号/斜杠的 path segment + 已知扩展名
const FILE_LINK_RE = /(?:[./]|\b)[\w.@-]+(?:\/[\w.@-]+)+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|scss|less|html|vue|py|go|rs|java|kt|swift|sh|yml|yaml|toml|lock|env|txt|sql|prisma|xml|c|cc|cpp|h|hpp|rb|php|proto)(?::\d+(?::\d+)?)?/g
const MAX_LINKS_PER_LINE = 8

/**
 * 暴露给外部（如 SessionFocus）的 autoMode 控制接口：
 * 让顶部 FocusSubbar 也能渲染 / 切换 permission mode，跨 Live & Conversation tab 可见。
 */
export interface AutoModeController {
  autoMode: string | null
  setAutoMode: (mode: string | null) => void
  switching: boolean
  available: boolean
}

interface Props {
  sessionId: string
  todoId: string
  status: TodoStatus
  cwd?: string | null
  resumeTarget?: ResumeSessionInput | null
  onSessionRecovered?: (nextSessionId: string) => void
  onSessionSwitch?: (nextSessionId: string) => void
  onClose: () => void
  onDone?: (result: { status: string; exitCode?: number }) => void
  onStatusChange?: (status: TodoStatus) => void
  fillHeight?: boolean
  /**
   * primary：本 viewer 独占 PTY 尺寸，后端忽略 secondary viewer 的 cols 贡献。
   * 用于 SessionFocus 全屏视图——避免 Dock 卡片等小尺寸 viewer 把 PTY 拉窄、
   * 引发 Claude TUI 框图按窄 cols 重排导致的乱码。
   * 不传默认 secondary（沿用历史 min 聚合行为）。
   */
  viewerRole?: 'primary' | 'secondary'
  /**
   * autoMode 控制器外发回调：mount 后把当前 controller 推给父组件，
   * 让 FocusSubbar 顶栏可以渲染同一个 permission mode 下拉。unmount 时推 null。
   */
  onAutoModeReady?: (controller: AutoModeController | null) => void
}

const MAX_RECONNECT_DELAY = 10_000
const INITIAL_RECONNECT_DELAY = 1000
const MAX_RECONNECT_ATTEMPTS = 15
const HEARTBEAT_INTERVAL = 15_000
// 失败路径自动恢复退避：1s → 3s → 8s（共 3 次）
const FAILURE_RECOVERY_BACKOFF_MS = [1000, 3000, 8000]
const RESIZE_DEBOUNCE_MS = 100
// 发给服务端 PTY 的 resize 需要稳定窗口：cols/rows 连续 200ms 不变才发。
// 防止切 tab / 折叠展开时的中间态 cols 值被发给后端（Claude 据此折行，污染 scrollback）。
const RESIZE_STABILITY_MS = 200
// fit 结果低于这两个阈值认为是布局中间态，直接跳过、等下一次触发
const MIN_CONTAINER_WIDTH = 300
const MIN_VALID_COLS = 30
const PENDING_CHUNKS_CAP = 5 * 1024 * 1024
const PROPOSED_CHAR_WIDTH_FALLBACK = 7.8
const PROPOSED_BORDER_PX = 2
const PROPOSED_XTERM_PADDING_PX = 14
const PROPOSED_TOOLBAR_PX = 60
const PROPOSED_LINE_HEIGHT_PX = 18
const MIN_PROPOSED_WIDTH = 280

export function proposeColsFromAncestor(
  container: HTMLElement,
  charWidth: number,
): { cols: number; rows: number } | null {
  let el: HTMLElement | null = container
  while (el) {
    if (el.offsetParent !== null && el.clientWidth >= MIN_CONTAINER_WIDTH) {
      const rawW = el.clientWidth - PROPOSED_BORDER_PX - PROPOSED_XTERM_PADDING_PX
      const availableW = Math.max(rawW, MIN_PROPOSED_WIDTH)
      const rawH = (el.clientHeight || window.innerHeight * 0.6) - PROPOSED_TOOLBAR_PX
      const availableH = Math.max(rawH, PROPOSED_LINE_HEIGHT_PX * 10)
      const cw = charWidth > 0 ? charWidth : PROPOSED_CHAR_WIDTH_FALLBACK
      const cols = Math.max(Math.floor(availableW / cw), MIN_VALID_COLS)
      const rows = Math.max(Math.floor(availableH / PROPOSED_LINE_HEIGHT_PX), 10)
      return { cols, rows }
    }
    el = el.parentElement
  }
  return null
}

// 后端 isValidResizeSize 把 cols < 30 视为无效 → 删除该 ws 的尺寸贡献并重算 min 聚合。
// 同 session 被多个浏览器 tab 共享时，后台 tab 用这个发"我退出尺寸聚合"。
function sendUnregisterSize(ws: WebSocket | null) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'resize', cols: 0, rows: 0 }))
  }
}

// Claude / Codex TUI 在重绘 task list / 状态栏期间会高频发 DECTCEM hide/show
// (`\x1b[?25l` / `\x1b[?25h`)，xterm 聚焦态严格按指令切换 cursor 可见性，肉眼
// 看到 cursor 在多个 ANSI 定位之间快速闪烁；失焦态画静态空心轮廓不响应这些指令，
// 所以"聚焦才闪、失焦不闪"。剥掉这两个序列后 cursor 永远可见，并稳定在最新位置。
const DECTCEM_HIDE_SHOW_RE = /\x1b\[\?25[lh]/g
function stripCursorVisibility(data: string): string {
  return data.replace(DECTCEM_HIDE_SHOW_RE, '')
}

// Wait until (a) the container has settled layout and is visible, AND
// (b) the bundled JetBrains Mono font is loaded.
// Returns visibleAndReady=true when the container met (a) before timeout;
// false means we timed out — caller must take the hidden-mount path
// (proposeColsFromAncestor + defer term.open).
async function waitTerminalReady(container: HTMLDivElement): Promise<{ visibleAndReady: boolean }> {
  const start = Date.now()
  const TIMEOUT_MS = 3000

  let visibleAndReady = false
  while (Date.now() - start < TIMEOUT_MS) {
    if (container.offsetParent !== null && container.clientWidth >= MIN_CONTAINER_WIDTH) {
      visibleAndReady = true
      break
    }
    await new Promise(r => setTimeout(r, 50))
  }

  try {
    await Promise.race([
      Promise.all([
        document.fonts.ready,
        (document.fonts as any).load?.('13px "JetBrains Mono"') ?? Promise.resolve(),
      ]),
      new Promise(r => setTimeout(r, Math.max(0, TIMEOUT_MS - (Date.now() - start)))),
    ])
  } catch { /* font API can throw on older Safari; ignore */ }

  await new Promise<void>(r => requestAnimationFrame(() => r()))
  return { visibleAndReady }
}

export default function AiTerminalMini({ sessionId, todoId, status, cwd, resumeTarget, onSessionRecovered, onSessionSwitch, onClose, onDone, onStatusChange, fillHeight, viewerRole = 'secondary', onAutoModeReady }: Props) {
  void onClose
  const { t } = useTranslation(['session'])
  const { message } = useAppMessages()
  const { mode } = useTheme()
  const { theme, preset, override, customPresets, setPreset, setOverride, resetOverride, saveCustomPreset, deleteCustomPreset } = useTerminalTheme()
  const themeRef = useRef(theme)
  useEffect(() => { themeRef.current = theme }, [theme])
  const chrome = useMemo(() => deriveChrome(theme), [theme])
  const [customModalOpen, setCustomModalOpen] = useState(false)
  const [saveAsName, setSaveAsName] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const cwdRef = useRef<string | null>(cwd ?? null)
  const linkProviderRef = useRef<{ dispose: () => void } | null>(null)
  useEffect(() => { cwdRef.current = cwd ?? null }, [cwd])
  const wsRef = useRef<WebSocket | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  // 全屏 + 移动端软键盘：监听 visualViewport，让 fullscreen wrapper 仅覆盖可视区
  // 而不是整个 layout viewport，否则键盘弹出后底部会被遮一半
  const [vvSize, setVvSize] = useState<{ height: number; offsetTop: number } | null>(null)
  // 移动端方向键浮层：手机软键盘没有 ↑↓←→，TUI / 命令历史用不了
  const [dpadHidden, setDpadHidden] = useState<boolean>(() => {
    try { return localStorage.getItem('quadtodo.dpadHidden') === '1' } catch { return false }
  })
  const [sessionStatus, setSessionStatus] = useState<TodoStatus>(status)
  const sessionStatusRef = useRef<TodoStatus>(status)
  const [wsConnected, setWsConnected] = useState(false)
  const [sessionExpired, setSessionExpired] = useState(false)
  const [sessionFailed, setSessionFailed] = useState(false)
  const sessionExpiredRef = useRef(false)
  // 后端在 claude/codex 二进制缺失时返回 HTTP 424 + code:'tool_missing'，
  // 这里保存修复指引（agentquad install-tools --xxx），用一张卡片代替难懂的 ENOENT toast
  const [toolMissing, setToolMissing] = useState<null | { tool: string; bin: string; fix: string }>(null)
  const [height, setHeight] = useState(420)
  const [autoMode, setAutoMode] = useState<string | null>(() => {
    // 浏览器内手动覆盖优先；否则回退到设置里的全局默认（settings drawer → defaultPermissionMode）。
    try {
      const ls = localStorage.getItem('quadtodo.autoMode')
      if (ls) return ls
    } catch { /* ignore */ }
    return useAppConfigStore.getState().defaultPermissionMode
  })
  const [switchingMode, setSwitchingMode] = useState(false)
  const prevAutoModeRef = useRef<string | null>(autoMode)
  // 首次"容器可见 + fit 完成 + 一帧绘制"之前隐藏 xterm 元素，
  // 避免用户看到 xterm 用初始 80×24 渲染再撑大到容器尺寸的"小→大"闪动。
  // 一旦 ready，session 内不再回退（resize 期间靠 xterm 自身平滑重排）。
  const [viewportReady, setViewportReady] = useState(false)
  const viewportReadyRef = useRef(false)
  useEffect(() => { prevAutoModeRef.current = autoMode }, [autoMode])
  useEffect(() => { sessionStatusRef.current = sessionStatus }, [sessionStatus])
  useEffect(() => {
    onStatusChange?.(sessionStatus)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionStatus])
  useEffect(() => { sessionExpiredRef.current = sessionExpired }, [sessionExpired])
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectDelayRef = useRef(INITIAL_RECONNECT_DELAY)
  const reconnectCountRef = useRef(0)
  const stopReconnectRef = useRef(false)
  const disposedRef = useRef(false)
  const effectGenRef = useRef(0)
  const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null)
  // term.open 是否已经调用 —— hidden-mount 路径下推迟到 IO 可见
  const termOpenedRef = useRef<boolean>(false)
  // term 还没 open 期间，WS 收到的 output/replay chunks 暂存到这里
  // 结构：{ chunks: 累计字符串数组, totalBytes: 字节累计 }，封顶 5MB，溢出丢头部
  const pendingChunksRef = useRef<{ chunks: string[]; totalBytes: number }>({ chunks: [], totalBytes: 0 })
  // 走 proposed init 时记下当时报的 cols/rows，IO 触发 fit 后若实测不同就发一次 resize 校准
  const pendingProposedInitRef = useRef<{ cols: number; rows: number } | null>(null)
  // 让 Task 9 的 IO 回调能复用主 effect 里"真正 open term"的本地函数
  const openTermFnRef = useRef<(() => void) | null>(null)

  const bufferPendingChunk = useCallback((chunk: string) => {
    const buf = pendingChunksRef.current
    buf.chunks.push(chunk)
    buf.totalBytes += chunk.length
    if (buf.totalBytes > PENDING_CHUNKS_CAP) {
      // 溢出丢头部：把数组合并成单个字符串，截掉前面 totalBytes - CAP 字符
      const joined = buf.chunks.join('')
      const overflow = joined.length - PENDING_CHUNKS_CAP
      const trimmed = joined.slice(overflow)
      buf.chunks = [trimmed]
      buf.totalBytes = trimmed.length
      console.warn('[AiTerminalMini] pending chunks > 5MB, dropped head')
    }
  }, [])

  const flushPendingChunks = useCallback(() => {
    const term = termRef.current
    if (!term) return
    const buf = pendingChunksRef.current
    for (const chunk of buf.chunks) {
      try { term.write(chunk) } catch (e) {
        console.warn('[AiTerminalMini] flush write error:', e)
        break
      }
    }
    pendingChunksRef.current = { chunks: [], totalBytes: 0 }
  }, [])

  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refitAttemptsRef = useRef(0)
  // 稳定性去抖：只有 cols/rows 在连续 RESIZE_STABILITY_MS 内保持不变才发 WS resize
  const pendingResizeRef = useRef<{ cols: number; rows: number; timer: ReturnType<typeof setTimeout> | null } | null>(null)
  // 切到后台 tab 时置 true：阻止 ResizeObserver / window resize / IO 在后台继续 fit + 上报，
  // 避免后台 tab 的 cols 把同 session 的前台 tab 拖到窄宽（PTY 走 min 聚合）。
  const isHiddenRef = useRef<boolean>(typeof document !== 'undefined' ? document.hidden : false)
  const lastPongRef = useRef<number>(Date.now())
  const STALE_THRESHOLD = 30_000
  const recoveringRef = useRef(false)
  const recoveryAttemptedRef = useRef(false)
  const resumeTargetRef = useRef<ResumeSessionInput | null>(resumeTarget || null)
  const onSessionRecoveredRef = useRef<typeof onSessionRecovered>(onSessionRecovered)
  const onSessionSwitchRef = useRef<typeof onSessionSwitch>(onSessionSwitch)
  // tryAutoRecover useCallback 的 deps 是 []，但恢复时要把当前 sessionId 下的草稿迁到新 sessionId，
  // 必须读到最新的 sessionId（而不是 useCallback 闭包里的首屏值）
  const sessionIdRef = useRef(sessionId)
  useEffect(() => { sessionIdRef.current = sessionId }, [sessionId])
  // 上一次发往后端的 role：role 切换时需要重传 init/resize 让后端切换聚合分支。
  // 普通 resize 跑去抖路径不重发；只有"role 第一次同步"和"role 切换"才显式触发。
  const viewerRoleRef = useRef<'primary' | 'secondary'>(viewerRole)
  useEffect(() => { viewerRoleRef.current = viewerRole }, [viewerRole])

  useEffect(() => {
    resumeTargetRef.current = resumeTarget || null
    onSessionRecoveredRef.current = onSessionRecovered
    onSessionSwitchRef.current = onSessionSwitch
  }, [resumeTarget, onSessionRecovered, onSessionSwitch])

  useEffect(() => {
    setToolMissing(null)
  }, [sessionId])

  const markSessionTurnDone = useAiSessionStore(s => s.markSessionTurnDone)
  const setPermissionPrompt = useAiSessionStore(s => s.setPermissionPrompt)

  const tryAutoRecover = useCallback(async () => {
    const latestResumeTarget = resumeTargetRef.current
    if (!latestResumeTarget?.nativeSessionId || recoveringRef.current || recoveryAttemptedRef.current) return false
    recoveringRef.current = true
    try {
      termRef.current?.writeln(`\r\n\x1b[33m--- ${t('session:terminal.writeln.autoRecovering')} ---\x1b[0m\r`)
      // 与 TodoManage.handleAiExec 对齐：localStorage 浏览器覆盖 > 设置里的全局默认；
      // 不读这两层的话恢复出来的 PTY 会用后端默认 'default'，让"完全托管"失效。
      let permissionMode: string | null = null
      try { permissionMode = localStorage.getItem('quadtodo.autoMode') } catch { /* ignore */ }
      if (!permissionMode) permissionMode = useAppConfigStore.getState().defaultPermissionMode
      const { sessionId: nextSessionId } = await startAiExec({
        todoId: latestResumeTarget.todoId,
        tool: latestResumeTarget.tool,
        prompt: latestResumeTarget.prompt,
        cwd: latestResumeTarget.cwd,
        resumeNativeId: latestResumeTarget.nativeSessionId,
        permissionMode: permissionMode || undefined,
      })
      stopReconnectRef.current = true
      setSessionExpired(false)
      setToolMissing(null)
      // 把 Conversation tab 的草稿迁到新 sessionId，否则 TranscriptView 的 session-switch effect
      // 会读到空 draft 把用户的输入冲掉。必须在 onSessionRecovered 之前调用，并用 ref 读最新 sessionId。
      migrateDraft(latestResumeTarget.todoId, sessionIdRef.current, nextSessionId)
      onSessionRecoveredRef.current?.(nextSessionId)
      // 让 SessionFocus 把 focusedSessionId 切到新 session（与 session_restarted 一样的语义）；
      // 不切的话，关掉 focus 再从 todo card 点回来会沿用旧 aiSession.sessionId，进的是历史会话。
      onSessionSwitchRef.current?.(nextSessionId)
      // 刷新 todo 列表，新 recover 出来的 session 才会出现在 todo.aiSessions / todo.aiSession 中。
      useDispatchStore.getState().signal('refreshTodos')
      recoveryAttemptedRef.current = true
      return true
    } catch (error: any) {
      // 后端在 CLI 二进制缺失时回 424 tool_missing → 弹出修复卡片，不再用 ENOENT toast 把人吓跑
      if (error instanceof ApiError && error.status === 424 && error.body?.code === 'tool_missing') {
        setToolMissing({ tool: error.body.tool, bin: error.body.bin, fix: error.body.fix })
        termRef.current?.writeln(`\r\n\x1b[31m--- ${t('session:terminal.writeln.autoRecoverFailedTool', { tool: error.body.tool })} ---\x1b[0m\r`)
      } else {
        termRef.current?.writeln(`\r\n\x1b[31m--- ${t('session:terminal.writeln.autoRecoverFailedReason', { reason: error?.message || t('session:terminal.writeln.unknownError') })} ---\x1b[0m\r`)
      }
      return false
    } finally {
      recoveringRef.current = false
    }
  }, [])

  const startFailureAutoRecover = useCallback(async (exitCode: number) => {
    // 没有可 resume 的目标 → 直接显示最终失败 UI
    if (!resumeTargetRef.current?.nativeSessionId) {
      setSessionFailed(true)
      termRef.current?.writeln(`\r\n\x1b[31m=== ${t('session:terminal.writeln.aiTaskFailed')} ===\x1b[0m\r`)
      return
    }
    if (recoveringRef.current) return // 已有 4004 路径在 recover，让它跑

    const outcome = await runWithBackoff({
      backoffMs: FAILURE_RECOVERY_BACKOFF_MS,
      isCancelled: () => disposedRef.current,
      recover: async (attempt) => {
        if (disposedRef.current) return false
        termRef.current?.writeln(`\r\n\x1b[33m--- ${t('session:terminal.writeln.autoRecoverAttempt', {
          code: exitCode,
          attempt,
          max: FAILURE_RECOVERY_BACKOFF_MS.length,
        })} ---\x1b[0m\r`)
        return await tryAutoRecover()
      },
    })

    if (disposedRef.current) return

    if (outcome === 'exhausted') {
      setSessionFailed(true)
      termRef.current?.writeln(`\r\n\x1b[31m--- ${t('session:terminal.writeln.autoRecoverGiveUp', {
        max: FAILURE_RECOVERY_BACKOFF_MS.length,
      })} ---\x1b[0m\r`)
      termRef.current?.writeln(`\r\n\x1b[31m=== ${t('session:terminal.writeln.aiTaskFailed')} ===\x1b[0m\r`)
    }
    // 'recovered' / 'cancelled' → 不写额外内容（recover 内部已 setSessionExpired(false) 等）
  }, [tryAutoRecover, t])

  /** 去抖发送 resize 到服务端：cols/rows 必须稳定 RESIZE_STABILITY_MS 才真正发，
   *  防止切 tab / 展开瞬间的中间态被后端 PTY 吃掉，进而让 Claude 按窄 cols 折行污染 scrollback。 */
  const scheduleResizeSend = useCallback((cols: number, rows: number) => {
    const last = lastSentSizeRef.current
    if (last && last.cols === cols && last.rows === rows) {
      if (pendingResizeRef.current?.timer) {
        clearTimeout(pendingResizeRef.current.timer)
        pendingResizeRef.current = null
      }
      return
    }
    if (pendingResizeRef.current?.timer) clearTimeout(pendingResizeRef.current.timer)
    const timer = setTimeout(() => {
      pendingResizeRef.current = null
      const ws = wsRef.current
      // 关键：只有真的 send 成功才标记"已发送"。之前无条件更新会导致 WS 还没 OPEN
      // 时的那次 fit 把 lastSentSizeRef 占住，onopen 后的 doFit 看到"尺寸没变"直接
      // return，后端 PTY 停留在默认 80 cols，Claude 按 80 画边框污染 scrollback —— 用户
      // 手动拖一下宽度、cols 变化才会重新触发 send。
      const latestStatus = sessionStatusRef.current
      const canResize = (latestStatus === 'ai_running' || latestStatus === 'ai_pending') && !sessionExpiredRef.current
      if (canResize && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows, role: viewerRoleRef.current }))
        lastSentSizeRef.current = { cols, rows }
      }
    }, RESIZE_STABILITY_MS)
    pendingResizeRef.current = { cols, rows, timer }
  }, [])

  /** fit + 去抖发送 resize（跳过尺寸未变的情况） */
  const doFit = useCallback(() => {
    const fit = fitRef.current
    const term = termRef.current
    const container = containerRef.current
    if (!fit || !term || !container) return
    // hidden-mount 路径：term 还没 open 时 fit.fit() 不能跑（FitAddon 内部读 term.element）
    if (!termOpenedRef.current) return
    // 容器处于 display:none 或尚未布局完成时跳过，避免 fit() 把 cols 算成小值污染 xterm 状态
    if (container.offsetParent === null) return
    if (container.clientWidth < MIN_CONTAINER_WIDTH || container.clientHeight < 20) {
      // 容器还没铺开，安排指数回退重试，等待布局 settle
      if (!refitTimerRef.current && refitAttemptsRef.current < 3) {
        const delays = [50, 150, 400]
        const delay = delays[refitAttemptsRef.current] ?? 400
        refitAttemptsRef.current++
        refitTimerRef.current = setTimeout(() => {
          refitTimerRef.current = null
          doFit()
        }, delay)
      }
      return
    }
    try {
      fit.fit()
      const { cols, rows } = term
      // fit 出异常小的 cols：不送给后端，安排重试
      if (cols < MIN_VALID_COLS) {
        if (!refitTimerRef.current && refitAttemptsRef.current < 3) {
          const delays = [50, 150, 400]
          const delay = delays[refitAttemptsRef.current] ?? 400
          refitAttemptsRef.current++
          refitTimerRef.current = setTimeout(() => {
            refitTimerRef.current = null
            doFit()
          }, delay)
        }
        return
      }
      refitAttemptsRef.current = 0
      scheduleResizeSend(cols, rows)
      // 成功 fit 后揭开容器，但必须等 xterm 把 WriteBuffer 里积压的 chunks 全部解析进 buffer 后再 reveal，
      // 否则用户在 Conversation tab 停留时积压的 replay + live-output 会在揭开后继续被 xterm 渲染，
      // auto-scroll 把视口往下推，看起来就是"滚动下去"的动画。term.write('', cb) 是 xterm 文档保证的
      // "drain" 信号：cb 只在当前 WriteBuffer 完全消费后 fire。在 cb 里 scrollToBottom 再 rAF 揭开，
      // 保证 opacity:0→1 的那一帧 canvas 已经画在最底部。
      if (!viewportReadyRef.current) {
        viewportReadyRef.current = true
        const reveal = () => setViewportReady(true)
        try {
          term.write('', () => {
            try { term.scrollToBottom() } catch { /* ignore: term may be torn down */ }
            // 一帧让 canvas 把 scrollToBottom 后的状态画上去再揭开
            requestAnimationFrame(() => requestAnimationFrame(reveal))
          })
        } catch {
          // term 已 dispose 的极端情况：退回老的 rAF*3 + 16ms 兜底
          requestAnimationFrame(() =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                reveal()
                setTimeout(reveal, 16)
              })))
        }
      }
    } catch (e) {
      console.warn('[AiTerminalMini] fit error:', e)
    }
  }, [scheduleResizeSend])

  useEffect(() => {
    if (!containerRef.current) return
    disposedRef.current = false
    stopReconnectRef.current = false
    recoveringRef.current = false
    recoveryAttemptedRef.current = false
    reconnectDelayRef.current = INITIAL_RECONNECT_DELAY
    reconnectCountRef.current = 0
    lastSentSizeRef.current = null
    if (pendingResizeRef.current?.timer) clearTimeout(pendingResizeRef.current.timer)
    pendingResizeRef.current = null
    isHiddenRef.current = typeof document !== 'undefined' ? document.hidden : false
    lastPongRef.current = Date.now()
    setSessionExpired(false)
    setSessionFailed(false)
    setWsConnected(false)
    // session 切换时重置 viewport 揭开状态，给新 xterm 一次"等首次 fit 完成再显示"的机会
    viewportReadyRef.current = false
    setViewportReady(false)

    let cleanup: (() => void) | null = null

    const myGen = ++effectGenRef.current
    // IIFE so we can await container-ready + font-ready inside an effect
    // (effect callback can't be async). After the await, both disposedRef AND
    // the effect-generation token must be checked — stale IIFEs from a previous
    // sessionId can survive into the next effect run because cleanup ran before
    // they finished setup. DO NOT add new awaits below the guard without
    // re-checking both refs after each await.
    void (async () => {
      const container = containerRef.current
      if (!container) return
      const { visibleAndReady } = await waitTerminalReady(container)
      if (disposedRef.current || myGen !== effectGenRef.current) return

      // 重置每次 effect 启动时的 hidden-mount 相关状态
      termOpenedRef.current = false
      pendingChunksRef.current = { chunks: [], totalBytes: 0 }
      pendingProposedInitRef.current = null

      const term = new Terminal({
        fontSize: 13,
        fontFamily: '"JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
        theme: themeRef.current,
        // 关闭闪烁：Claude/Codex TUI 工作时每帧重绘期间会把 cursor 在多个 ANSI 位置之间挪，
        // 每个 blink-on 周期都会把中间态画出来，视觉上"上下跳得很快"。关掉 blink 后光标只在
        // 当前定位上稳定显示，重绘瞬间也不会被反复擦写。
        cursorBlink: false,
        convertEol: true,
        scrollback: 30000,
        disableStdin: false,
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      termRef.current = term
      fitRef.current = fit

      // IME 组合状态：声明在 IIFE 作用域，openTermInVisibleContainer 和
      // attachCustomKeyEventHandler 的闭包均可读写。
      let imeComposing = false

      // 当容器真正可见时执行：term.open + addons + IME + Link + initial fit。
      // visible 路径里立即调用；hidden-mount 路径里 Task 9 的 IO 触发时调用。
      const openTermInVisibleContainer = () => {
        term.open(container)
        termOpenedRef.current = true
        // Upgrade xterm width tables to Unicode 11 so East-Asian-Ambiguous chars
        // (em-dash, ellipsis, box-drawing) align with the PTY's wcwidth (paired with
        // src/pty.js LANG=en_US.UTF-8 injection — both must be set for layout to match).
        try {
          term.loadAddon(new Unicode11Addon())
          term.unicode.activeVersion = '11'
        } catch { /* old browsers can fall back to default */ }
        // Canvas 渲染器：移动端长 scrollback 滚动比默认 DOM 渲染器流畅得多。
        // 装载失败也不影响核心功能，DOM 渲染会自动兜底。
        try { term.loadAddon(new CanvasAddon()) } catch { /* 老浏览器回退 DOM */ }
        // 永久隐藏 xterm cursor：AI TUI 在 task list 重绘时会快速跨 cell 移动 cursor，
        // xterm 每个位置都画一次 block，肉眼看到"光标在 3 个位置闪跳"。Claude 自己会画
        // `>` 输入提示符，不需要 xterm 再叠一个 cursor block。配合上面 stripCursorVisibility
        // 过滤掉 incoming `\x1b[?25h`，TUI 无法再翻回 show。
        term.write('\x1b[?25l')

        // IME 输入法兼容：组合期间屏蔽键盘事件，防止回车选词被当作 \r 发送
        const textarea = term.textarea
        if (textarea) {
          textarea.addEventListener('compositionstart', () => { imeComposing = true })
          textarea.addEventListener('compositionend', () => {
            // 延迟重置：部分浏览器 compositionend 先于 keydown(Enter) 触发
            setTimeout(() => { imeComposing = false }, 80)
          })
        }
        term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
          if (imeComposing || ev.isComposing || ev.keyCode === 229) return false
          if (ev.type === 'keydown' && ev.ctrlKey && ev.key === 'End') {
            term.scrollToBottom()
            return false
          }
          return true
        })

        // 注册文件路径链接：hover 显示下划线，点击用用户选择的编辑器打开
        // 仅在有 cwd 时启用，避免相对路径无处解析
        if (cwdRef.current) {
          const linkProvider = term.registerLinkProvider({
            provideLinks(bufferLineNumber, callback) {
              try {
                const line = term.buffer.active.getLine(bufferLineNumber - 1)
                if (!line) { callback(undefined); return }
                const text = line.translateToString(true)
                // 预过滤：没有 '/' 一定不是路径
                if (!text || text.indexOf('/') < 0) { callback(undefined); return }
                const links: Array<{ range: { start: { x: number; y: number }; end: { x: number; y: number } }; text: string; activate: (_e: MouseEvent, t: string) => void }> = []
                FILE_LINK_RE.lastIndex = 0
                let m: RegExpExecArray | null
                let count = 0
                while ((m = FILE_LINK_RE.exec(text)) && count < MAX_LINKS_PER_LINE) {
                  count++
                  const start = m.index
                  const end = start + m[0].length
                  links.push({
                    text: m[0],
                    range: {
                      start: { x: start + 1, y: bufferLineNumber },
                      end: { x: end, y: bufferLineNumber },
                    },
                    activate: (_ev, hit) => {
                      const base = cwdRef.current || ''
                      if (!base) return
                      let editor: EditorKind = 'trae-cn'
                      try {
                        const saved = localStorage.getItem('quadtodo.editor') as EditorKind | null
                        if (saved === 'trae' || saved === 'trae-cn' || saved === 'cursor') editor = saved
                      } catch {}
                      openTraeCN(base, editor, hit, sessionId).catch((err) => {
                        console.warn('[AiTerminalMini] open link failed:', err)
                      })
                    },
                  })
                }
                callback(links.length ? links : undefined)
              } catch (e) {
                console.warn('[AiTerminalMini] link provider error:', e)
                callback(undefined)
              }
            },
          })
          linkProviderRef.current = linkProvider
        }

        // Synchronous fit — Task 5's waitTerminalReady already ensured the container
        // has measurable width, so we don't need rAF defensiveness anymore. Doing this
        // sync (instead of waiting for the next frame) makes `term.cols / term.rows`
        // valid before connectWs() runs — important for hidden tabs where rAF is
        // throttled and would otherwise leave term at xterm's constructor default 80×24.
        try { fit.fit() } catch (e) { console.warn('[AiTerminalMini] initial fit failed:', e) }
      }
      // 暴露给外部作用域，Task 9 的 IO 回调可通过此 ref 调用
      openTermFnRef.current = openTermInVisibleContainer

      if (visibleAndReady) {
        openTermInVisibleContainer()
      } else {
        // hidden-mount 路径：构造 Terminal 实例并用 proposeColsFromAncestor 预估尺寸，
        // 调 term.resize 把默认 80×24 替换成接近真实值的预估，让 WS init 消息携带合理列数。
        // term.open / addons / IME / Link / fit 全部推迟到 Task 9 (IO 触发时)。
        const charWidth = await measureCharWidth().catch(() => 7.8)
        if (disposedRef.current || myGen !== effectGenRef.current) return
        const proposed = proposeColsFromAncestor(container, charWidth)
        if (proposed) {
          pendingProposedInitRef.current = proposed
          try { term.resize(proposed.cols, proposed.rows) } catch {}
        }
      }

      // 只在"容器真的可见 + term 已经 open + fit 算出有效 cols"时标记 ready；
      // 否则留给后续 IO/RO 触发的 doFit 来标记，避免在 display:none 容器里就揭开
      // 导致后面切到可见时 xterm 用旧 80×24 画一帧再扩大（"小→大"闪动的根因）。
      // 揭开方式同 doFit 的 reveal 分支：等 WriteBuffer 全部消费 + scrollToBottom 后再揭，
      // 保证用户看到的第一帧就是最底部，不会出现"滚动下去"的动画。
      if (
        !viewportReadyRef.current
        && termOpenedRef.current  // hidden-mount 路径还没 open，等 Task 9 的 doFit reveal
        && container.offsetParent !== null
        && container.clientWidth >= MIN_CONTAINER_WIDTH
        && term.cols >= MIN_VALID_COLS
      ) {
        viewportReadyRef.current = true
        const reveal = () => {
          if (!disposedRef.current && myGen === effectGenRef.current) setViewportReady(true)
        }
        try {
          term.write('', () => {
            try { term.scrollToBottom() } catch { /* ignore */ }
            requestAnimationFrame(() => requestAnimationFrame(reveal))
          })
        } catch {
          requestAnimationFrame(() =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                reveal()
                setTimeout(reveal, 16)
              })))
        }
      }

      function connectWs() {
        if (disposedRef.current || stopReconnectRef.current) return

        // 关闭已有连接（防止多个 WS 并存互相干扰）
        const prev = wsRef.current
        if (prev) {
          try { prev.close() } catch {}
          wsRef.current = null
        }

        const wsUrl = getTerminalWsUrl(sessionId, viewerRoleRef.current)
        const ws = new WebSocket(wsUrl)
        wsRef.current = ws

        let heartbeatTimer: ReturnType<typeof setInterval> | null = null
        let injectingHintTimer: ReturnType<typeof setTimeout> | null = null
        let firstDataArrived = false
        const cancelInjectingHint = () => {
          firstDataArrived = true
          if (injectingHintTimer) { clearTimeout(injectingHintTimer); injectingHintTimer = null }
        }

        ws.onopen = () => {
          // 如果已被更新的连接取代，关掉自己
          if (wsRef.current !== ws) { ws.close(); return }

          reconnectDelayRef.current = INITIAL_RECONNECT_DELAY
          reconnectCountRef.current = 0
          setWsConnected(true)
          lastPongRef.current = Date.now()
          // 清掉 lastSent：visible-tab 走到下面会立刻按 {cols,rows} 再 seed，所以这次清是
          // 给 fallback / hidden-tab 分支用 —— 让后续 ResizeObserver 即便测出 cols=80
          // 之类的兜底默认值也能正常送给后端，不被去重判成"无需重发"。
          lastSentSizeRef.current = null

          // 只有"接入后 800ms 仍未收到任何 PTY 字节（replay/output）"才显示提示。
          // 这样 fresh session 仍能看到"已开始/注入中"反馈；reopen 已运行 session 会立刻
          // 收到 replay，直接跳过这条灰字，避免出现"卡在一行字 + 大片黑"的观感。
          if (!resumeTargetRef.current?.nativeSessionId && status === 'ai_running') {
            injectingHintTimer = setTimeout(() => {
              injectingHintTimer = null
              if (firstDataArrived || disposedRef.current || wsRef.current !== ws) return
              term.writeln(`\x1b[90m--- ${t('session:terminal.writeln.injectingContext')} ---\x1b[0m\r`)
            }, 800)
          }

          // ─── Size-first 握手 ───
          // 走两条路：
          // 1) visible 路径：term.cols/rows 已被 fit 算好 —— 像旧逻辑那样直接 init
          // 2) hidden-mount 路径：term 还没 open，cols/rows 来自 pendingProposedInitRef
          const proposed = pendingProposedInitRef.current
          const cols = proposed ? proposed.cols : term.cols
          const rows = proposed ? proposed.rows : term.rows

          if (isHiddenRef.current) {
            // 后台 tab 也要发 init —— 否则后端 5 秒兜底兜不到 / 等到 init 这个 tab
            // 再切回前台已经太晚（首屏 80 列 banner 已经画完了）。发完立刻补一条
            // 0/0 unregister，把这个 tab 从聚合中踢出，避免后端按它的 cols 钳制 PTY。
            if (Number.isFinite(cols) && Number.isFinite(rows) && cols >= MIN_VALID_COLS && rows > 0) {
              ws.send(JSON.stringify({ type: 'init', cols, rows, role: viewerRoleRef.current }))
            }
            sendUnregisterSize(ws)
          } else if (Number.isFinite(cols) && Number.isFinite(rows) && cols >= MIN_VALID_COLS && rows > 0) {
            ws.send(JSON.stringify({ type: 'init', cols, rows, role: viewerRoleRef.current }))
            // 给 ResizeObserver 一个 baseline，避免它立刻又发一条 cols/rows 完全相同的 resize
            lastSentSizeRef.current = { cols, rows }
          } else {
            // 极端 edge case：proposed 也没算出来（祖先链没有 layout 节点）—— 留给后端 30s fallback。
            // 不调 doFit（term 可能还没 open），避免触发未 open 的 fit.fit()。
            console.warn('[AiTerminalMini] no valid init cols at WS onopen; deferring to backend fallback')
          }

          heartbeatTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'ping' }))
            }
          }, HEARTBEAT_INTERVAL)
        }

        ws.onmessage = (e) => {
          try {
            const msg = JSON.parse(e.data)
            if (msg.type === 'pong') { lastPongRef.current = Date.now(); return }
            if (msg.type === 'ping') {
              if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'pong' }))
              return
            }
            if (msg.type === 'error') {
              if (msg.error === 'session_not_found') {
                void tryAutoRecover().then((recovered) => {
                  if (!recovered) {
                    stopReconnectRef.current = true
                    setSessionExpired(true)
                    term.writeln(`\r\n\x1b[31m--- ${t('session:terminal.writeln.sessionExpiredServerRestart')} ---\x1b[0m\r`)
                  }
                })
              }
              return
            }
            switch (msg.type) {
              case 'output':
                if (typeof msg.data === 'string' && msg.data.length > 0) {
                  cancelInjectingHint()
                  if (termOpenedRef.current) {
                    term.write(stripCursorVisibility(msg.data))
                  } else {
                    bufferPendingChunk(stripCursorVisibility(msg.data))
                  }
                }
                break
              case 'replay':
                if (Array.isArray(msg.chunks)) {
                  if (msg.chunks.length > 0) cancelInjectingHint()
                  for (const chunk of msg.chunks) {
                    const stripped = stripCursorVisibility(chunk)
                    if (termOpenedRef.current) term.write(stripped)
                    else bufferPendingChunk(stripped)
                  }
                  // 回放结束后强制 SGR reset，避免 TUI 在切片边界遗留 underline/颜色
                  if (termOpenedRef.current) term.write('\x1b[0m')
                  else bufferPendingChunk('\x1b[0m')
                }
                break
              case 'pending_confirm':
                setSessionStatus('ai_pending')
                setPermissionPrompt(sessionId, {
                  text: typeof msg.promptText === 'string' ? msg.promptText : '',
                  options: Array.isArray(msg.options) ? msg.options : [],
                  source: msg.source || 'hook',
                  createdAt: Date.now(),
                })
                break
              case 'pending_cleared':
                setSessionStatus('ai_running')
                setPermissionPrompt(sessionId, null)
                break
              case 'auto_mode':
                setAutoMode(msg.autoMode || null)
                break
              case 'auto_mode_switching':
                if (msg.target) setAutoMode(msg.target)
                setSwitchingMode(true)
                break
              case 'session_restarted':
                if (typeof msg.newSessionId === 'string' && msg.newSessionId) {
                  // 新 session 的 effect 会重跑：清掉旧 session 的 pending 状态，避免
                  // 旧 chunks/proposed init 跨 session 污染
                  pendingChunksRef.current = { chunks: [], totalBytes: 0 }
                  pendingProposedInitRef.current = null
                  // termOpenedRef 不重置 —— termRef.current 还是同一个 term 实例（dispose+重建发生在 effect cleanup），
                  // 这里只是状态信号。effect 重跑时 Task 6 的"重置每次 effect 启动时的 hidden-mount 相关状态"
                  // 会再次置 false。

                  message.info(msg.message || t('session:terminal.message.switchedToManaged'))
                  stopReconnectRef.current = true  // 旧 WS 关闭后不再自动重连
                  setSwitchingMode(false)
                  onSessionSwitchRef.current?.(msg.newSessionId)
                  // 与 tryAutoRecover / FocusSubbar.handleResume / TranscriptView.resumeSession 对齐：
                  // 后端已把 todo.aiSessions 的老 session 换成新的 bypass session，但前端 todo 快照仍是旧的。
                  // 不 refresh 的话，关掉 focus 再从 todo card 点回来会沿用旧 sessionId，进的是已被
                  // pty.stop 杀掉的历史会话，刷新浏览器才能恢复。
                  useDispatchStore.getState().signal('refreshTodos')
                }
                break
              case 'auto_mode_notice':
                if (msg.reason === 'restart_failed') {
                  setSwitchingMode(false)
                  setAutoMode(prevAutoModeRef.current)
                  try {
                    if (prevAutoModeRef.current) localStorage.setItem('quadtodo.autoMode', prevAutoModeRef.current)
                    else localStorage.removeItem('quadtodo.autoMode')
                  } catch { /* ignore */ }
                  if (msg.message) message.error(msg.message)
                } else if (msg.message) {
                  message.warning(msg.message)
                }
                break
              case 'turn_done': {
                markSessionTurnDone(sessionId, msg.status || 'idle', msg.timestamp || Date.now())
                break
              }
              case 'done':
                if (msg.status === 'done') {
                  setSessionStatus('ai_done')
                  term.writeln(`\r\n\x1b[32m=== ${t('session:terminal.writeln.aiTaskDone')} ===\x1b[0m\r`)
                  onDone?.({ status: msg.status, exitCode: msg.exitCode })
                } else if (msg.status === 'stopped') {
                  // 用户主动 stop：route 已经 broadcast 过 type:'stopped' 黄色"已中止"横幅，
                  // 这里只更状态、回调，不再追加红色"任务失败"，也不触发自动恢复。
                  setSessionStatus('todo')
                  onDone?.({ status: msg.status, exitCode: msg.exitCode })
                } else {
                  // 'failed'：先把 status 切到 todo + 回调（保持现状），然后进入自动恢复循环
                  setSessionStatus('todo')
                  onDone?.({ status: msg.status, exitCode: msg.exitCode })
                  void startFailureAutoRecover(msg.exitCode ?? 1)
                }
                break
              case 'stopped':
                setSessionStatus('todo')
                term.writeln(`\r\n\x1b[33m=== ${t('session:terminal.writeln.aborted')} ===\x1b[0m\r`)
                break
            }
          } catch (err) {
            console.warn('[AiTerminalMini] message parse error:', err)
          }
        }

        ws.onclose = (ev) => {
          if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
          if (injectingHintTimer) { clearTimeout(injectingHintTimer); injectingHintTimer = null }

          // 核心：如果这个 WS 已被新连接取代，不做任何状态更新
          if (wsRef.current !== ws) return

          setWsConnected(false)
          if (disposedRef.current || stopReconnectRef.current) return

          if (ev.code === 4004) {
            void tryAutoRecover().then((recovered) => {
              if (!recovered) {
                stopReconnectRef.current = true
                setSessionExpired(true)
                term.writeln(`\r\n\x1b[31m--- ${t('session:terminal.writeln.sessionExpired')} ---\x1b[0m\r`)
              }
            })
            return
          }

          if (reconnectCountRef.current >= MAX_RECONNECT_ATTEMPTS) {
            term.writeln(`\r\n\x1b[31m--- ${t('session:terminal.writeln.reconnectExhausted')} ---\x1b[0m\r`)
            return
          }

          term.writeln(`\r\n\x1b[33m--- ${t('session:terminal.writeln.reconnectAttempt', { code: ev.code, attempt: reconnectCountRef.current + 1, max: MAX_RECONNECT_ATTEMPTS })} ---\x1b[0m\r`)
          scheduleReconnect()
        }

        ws.onerror = () => {
          console.warn('[AiTerminalMini] WebSocket error')
        }
      }

      function scheduleReconnect() {
        if (disposedRef.current || stopReconnectRef.current) return
        if (reconnectTimerRef.current) return

        reconnectCountRef.current++
        const delay = reconnectDelayRef.current
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null
          reconnectDelayRef.current = Math.min(delay * 1.5, MAX_RECONNECT_DELAY)
          connectWs()
        }, delay)
      }

      /** 检测连接是否已失效（半死连接 / 已断开） */
      function isWsStale() {
        const ws = wsRef.current
        if (!ws || ws.readyState !== WebSocket.OPEN) return true
        return Date.now() - lastPongRef.current > STALE_THRESHOLD
      }

      /** 强制重连（connectWs 内部会关闭旧连接，不会竞态） */
      let lastForceReconnectAt = 0
      function forceReconnect(reason: string) {
        if (disposedRef.current || stopReconnectRef.current) return
        const now = Date.now()
        if (now - lastForceReconnectAt < 1000) return
        lastForceReconnectAt = now

        reconnectCountRef.current = 0
        reconnectDelayRef.current = INITIAL_RECONNECT_DELAY
        term.writeln(`\r\n\x1b[33m--- ${t('session:terminal.writeln.reconnecting', { reason })} ---\x1b[0m\r`)
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current)
          reconnectTimerRef.current = null
        }
        connectWs()
      }

      connectWs()

      // 输入通道：xterm onData → WebSocket → Agent PTY
      let warnedDisconnect = false
      term.onData((data) => {
        const ws = wsRef.current
        if (ws && ws.readyState === WebSocket.OPEN && !isWsStale()) {
          ws.send(JSON.stringify({ type: 'input', data }))
          warnedDisconnect = false
        } else {
          if (!warnedDisconnect) {
            warnedDisconnect = true
            term.writeln(`\r\n\x1b[31m${t('session:terminal.writeln.connectionLost')}\x1b[0m\r`)
          }
          forceReconnect(t('session:terminal.reconnectReason.stale'))
        }
      })

      // 标签页切回时：检查 WS 健康，死连接立即重连 + 重新聚焦终端
      function handleVisibilityChange() {
        if (disposedRef.current || stopReconnectRef.current) return
        const hidden = document.visibilityState !== 'visible'
        if (hidden) {
          // 同 session 多 tab 时，PTY 尺寸取所有连接的 min。后台 tab 不应继续约束尺寸：
          // 取消 pending fit，发 0/0 让后端 unregister 我们这一份，并屏蔽后续后台触发。
          isHiddenRef.current = true
          if (resizeTimerRef.current) {
            clearTimeout(resizeTimerRef.current)
            resizeTimerRef.current = null
          }
          if (refitTimerRef.current) {
            clearTimeout(refitTimerRef.current)
            refitTimerRef.current = null
          }
          if (pendingResizeRef.current?.timer) {
            clearTimeout(pendingResizeRef.current.timer)
          }
          pendingResizeRef.current = null
          sendUnregisterSize(wsRef.current)
          // 重置已发送记录，等可见时重新发当前真实尺寸（不会被去抖跳过）
          lastSentSizeRef.current = null
          return
        }
        // 切回前台
        isHiddenRef.current = false
        lastPongRef.current = Date.now()
        const ws = wsRef.current
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          forceReconnect(t('session:terminal.reconnectReason.visibility'))
        } else {
          ws.send(JSON.stringify({ type: 'ping' }))
        }
        // 清掉 lastSent 后立即 refit，重新把当前 cols/rows 加回聚合
        lastSentSizeRef.current = null
        requestAnimationFrame(() => {
          requestAnimationFrame(() => doFit())
        })
        term.focus()
      }
      document.addEventListener('visibilitychange', handleVisibilityChange)

      // 终端获焦时：发 ping 探活，超时无 pong 则强制重连
      let focusProbeTimer: ReturnType<typeof setTimeout> | null = null
      function handleTermFocus() {
        if (disposedRef.current || stopReconnectRef.current) return
        const ws = wsRef.current
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          forceReconnect(t('session:terminal.reconnectReason.focus'))
          return
        }
        const beforePing = lastPongRef.current
        ws.send(JSON.stringify({ type: 'ping' }))
        if (focusProbeTimer) clearTimeout(focusProbeTimer)
        focusProbeTimer = setTimeout(() => {
          focusProbeTimer = null
          if (lastPongRef.current === beforePing && !disposedRef.current && !stopReconnectRef.current) {
            forceReconnect(t('session:terminal.reconnectReason.probeTimeout'))
          }
        }, 2000)
      }
      const termTextarea = term.textarea
      termTextarea?.addEventListener('focus', handleTermFocus)

      const ro = new ResizeObserver(() => {
        if (isHiddenRef.current) return
        if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
        resizeTimerRef.current = setTimeout(() => {
          resizeTimerRef.current = null
          if (isHiddenRef.current) return
          requestAnimationFrame(() => doFit())
        }, RESIZE_DEBOUNCE_MS)
      })
      ro.observe(container)

      // 可见性监听：display:none ↔ 可见切换时 ResizeObserver 不保证触发，用 IO 兜底。
      // 关键修复：每次"从不可见 → 可见"过渡都先把容器 opacity 拨回 0（隐藏 xterm 用旧尺寸
      // 画的旧帧），等 doFit 完成 + 双 rAF 后再揭开。避免用户切回 Live tab 看见
      // "小框→撑满" 的闪动（容器在隐藏期间可能因为窗口缩放等原因尺寸变化，xterm
      // 内部 cols/rows 还停在上次的值）。
      //
      // 进一步兜底：focusStore 默认 tab 是 'conversation'，所以打开任何 todo 时 Live
      // 容器都是 display:none 起步。waitTerminalReady 3s 超时后会在隐藏容器里 term.open，
      // 首帧 fit 拿到的 cols 多半不准；用户首次切到 Live → IO 触发 doFit，但 doFit 内部
      // 的 50/150/400ms 退避只重试 3 次（refitAttemptsRef ≤ 3），如果 layout settle
      // 慢、或 xterm 渲染服务还没刷掉旧 metrics，3 次都失败就再无机会。
      // 因此 justEntered 时除了立即 doFit 外，再追加 100/300/600ms 三次外层 refit，
      // 每次都把 refitAttemptsRef 清零让内层再获得一组完整重试预算。
      let wasIntersecting = false
      const justEnteredRefitTimers = new Set<ReturnType<typeof setTimeout>>()
      // 兜底 refit：只在"实际还需要变 cols/rows"时才真去 fit，避免立即 doFit 已经把
      // 尺寸算对的情况下又走一遍 fit() 触发可见的 canvas 重排（视觉上"闪一下"）。
      // proposeDimensions 是只读计算，不会动 term；和 fit.fit() 用的是同一套测量逻辑，
      // 因此 proposed === term 当前值时可以安全跳过。
      const scheduleJustEnteredRefit = (delay: number) => {
        const timer = setTimeout(() => {
          justEnteredRefitTimers.delete(timer)
          if (disposedRef.current || isHiddenRef.current) return
          if (container.offsetParent === null) return
          const fit = fitRef.current
          const term = termRef.current
          if (!fit || !term) return
          let proposed: { cols: number; rows: number } | undefined
          try { proposed = fit.proposeDimensions() } catch { proposed = undefined }
          if (!proposed) return
          if (proposed.cols < MIN_VALID_COLS) return
          if (proposed.cols === term.cols && proposed.rows === term.rows) {
            // 立即 doFit 已经把尺寸算对了，跳过避免视觉抖动
            return
          }
          refitAttemptsRef.current = 0
          requestAnimationFrame(() => doFit())
        }, delay)
        justEnteredRefitTimers.add(timer)
      }
      const io = new IntersectionObserver((entries) => {
        if (isHiddenRef.current) return
        for (const entry of entries) {
          const nowIn = entry.isIntersecting && entry.intersectionRatio > 0
          if (nowIn) {
            const justEntered = !wasIntersecting
            wasIntersecting = true
            if (!justEntered) continue
            // 隐藏挂载补完：term 还没 open（首次从 hidden-mount 路径过来），补一波
            // open + addons + IME + Link + fit + flush，然后必要时给后端补一条 resize 校准
            if (!termOpenedRef.current) {
              const openFn = openTermFnRef.current
              if (!openFn) continue
              try {
                openFn()  // 走主 effect 里定义的 openTermInVisibleContainer：term.open + addons + fit
              } catch (e) {
                console.warn('[AiTerminalMini] open-on-visible failed:', e)
                continue
              }
              // term 现已 open + 实测 fit 跑过一次。先把暂存的 output/replay chunks 写下去
              flushPendingChunks()
              // 实测 cols/rows 与 proposed init 上报的若不同，补一条 resize 给后端校准
              const proposedInit = pendingProposedInitRef.current
              const liveTerm = termRef.current
              const ws = wsRef.current
              if (
                proposedInit
                && liveTerm
                && (liveTerm.cols !== proposedInit.cols || liveTerm.rows !== proposedInit.rows)
                && ws
                && ws.readyState === WebSocket.OPEN
                && liveTerm.cols >= MIN_VALID_COLS
              ) {
                ws.send(JSON.stringify({
                  type: 'resize',
                  cols: liveTerm.cols,
                  rows: liveTerm.rows,
                  role: viewerRoleRef.current,
                }))
                lastSentSizeRef.current = { cols: liveTerm.cols, rows: liveTerm.rows }
              }
              pendingProposedInitRef.current = null
            }

            // 切回 Live 时先用 proposeDimensions 试算一下：如果 cols/rows 跟 term 当前
            // 完全一致（窗口没缩、上次 fit 已经算对），整条 hide → fit → reveal 都跳过，
            // 仅 scrollToBottom 让用户看到最新输出。这是消除"切回 Live 闪一下"的关键路径。
            // 仅在 proposed 和当前不一致 / fit 还没成功揭开过 时，才走原本的 hide-fit-reveal。
            const fit = fitRef.current
            const term = termRef.current
            let proposed: { cols: number; rows: number } | undefined
            if (fit && term) {
              try { proposed = fit.proposeDimensions() } catch { proposed = undefined }
            }
            const dimsMatch = !!proposed
              && proposed.cols >= MIN_VALID_COLS
              && term != null
              && proposed.cols === term.cols
              && proposed.rows === term.rows
            const alreadyRevealed = viewportReadyRef.current

            if (alreadyRevealed && dimsMatch) {
              // 零闪动路径：canvas 不动，只滚到底
              requestAnimationFrame(() => {
                try { term?.scrollToBottom() } catch { /* ignore: term may be torn down */ }
              })
              continue
            }

            // 需要 refit：把可能仍可见的 canvas 先隐藏，避免出现"先按旧 cols 画一帧再撑开"
            if (alreadyRevealed) {
              viewportReadyRef.current = false
              setViewportReady(false)
            }
            refitAttemptsRef.current = 0
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                doFit()
                // 重新可见后默认回到最底部 —— 隐藏期间 PTY 可能持续输出（live-output
                // 事件刷新了 outputHistory），用户切回 Live tab 总是想看最新内容。
                // 这一步由 doFit 内的 reveal 分支统一负责：用 term.write('', cb) 等 WriteBuffer
                // 全部消费后再 scrollToBottom + 揭开容器，保证用户看到的第一帧就是最底部，
                // 不会出现 xterm 边解析边 auto-scroll 的"滚动下去"动画。
              })
            })
            scheduleJustEnteredRefit(100)
            scheduleJustEnteredRefit(300)
            scheduleJustEnteredRefit(600)
          } else {
            wasIntersecting = false
          }
        }
      })
      io.observe(container)

      // 浏览器窗口缩放/拖拽：ResizeObserver 可能不触发，需要额外监听
      let windowResizeTimer: ReturnType<typeof setTimeout> | null = null
      function handleWindowResize() {
        if (isHiddenRef.current) return
        if (windowResizeTimer) clearTimeout(windowResizeTimer)
        windowResizeTimer = setTimeout(() => {
          windowResizeTimer = null
          if (isHiddenRef.current) return
          requestAnimationFrame(() => doFit())
        }, RESIZE_DEBOUNCE_MS)
      }
      window.addEventListener('resize', handleWindowResize)

      cleanup = () => {
        disposedRef.current = true
        document.removeEventListener('visibilitychange', handleVisibilityChange)
        window.removeEventListener('resize', handleWindowResize)
        if (windowResizeTimer) clearTimeout(windowResizeTimer)
        termTextarea?.removeEventListener('focus', handleTermFocus)
        if (focusProbeTimer) clearTimeout(focusProbeTimer)
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current)
          reconnectTimerRef.current = null
        }
        if (resizeTimerRef.current) {
          clearTimeout(resizeTimerRef.current)
          resizeTimerRef.current = null
        }
        if (refitTimerRef.current) {
          clearTimeout(refitTimerRef.current)
          refitTimerRef.current = null
        }
        refitAttemptsRef.current = 0
        justEnteredRefitTimers.forEach((t) => clearTimeout(t))
        justEnteredRefitTimers.clear()
        if (pendingResizeRef.current?.timer) {
          clearTimeout(pendingResizeRef.current.timer)
        }
        pendingResizeRef.current = null
        ro.disconnect()
        io.disconnect()
        const ws = wsRef.current
        if (ws) ws.close()
        try { linkProviderRef.current?.dispose() } catch {}
        linkProviderRef.current = null
        term.dispose()
        termRef.current = null
        wsRef.current = null
        fitRef.current = null
        openTermFnRef.current = null  // 防止 cleanup 后 IO 还能拿到旧 term 的闭包
      }
    })()

    return () => {
      disposedRef.current = true
      if (cleanup) cleanup()
    }
  }, [sessionId, tryAutoRecover, markSessionTurnDone])

  useEffect(() => { setSessionStatus(status) }, [status])

  // Apply user-selected xterm preset. When the preset changes (or its colors are
  // tweaked via overrides), re-stamp the terminal theme and force a canvas repaint.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    try {
      term.options.theme = theme
      term.refresh(0, term.rows - 1)
    } catch { /* ignore: term may be torn down concurrently */ }
  }, [theme])

  // Re-apply token-driven xterm theme when design ThemeProvider mode flips
  // (light <-> dark). xterm renders to canvas/WebGL, so CSS variables don't
  // reach it — we MUST swap options.theme and force a refresh of the
  // scrollback to repaint with the new colors.
  // Guard: skip when the user has explicitly chosen a non-default preset — we
  // must not silently replace their selection on every ThemeToggle click.
  useEffect(() => {
    if (preset !== 'default') return   // user has explicit preset, don't override
    const term = termRef.current
    if (!term) return
    try {
      term.options.theme = getTokenDrivenTheme(mode)
      term.refresh(0, term.rows - 1)
    } catch { /* ignore: term may be torn down concurrently */ }
  }, [preset, mode])

  useEffect(() => {
    refitAttemptsRef.current = 0
    // 后台 tab 不应触发 fit + 上报：fullscreen / height 变化路径未走 isHiddenRef 守门的
    // observer 链，需要在这里显式跳过，否则会把真实尺寸重新塞回多 tab 聚合。
    if (isHiddenRef.current) return
    requestAnimationFrame(doFit)
  }, [fullscreen, height, doFit])

  // 仅在全屏期间监听 visualViewport：键盘弹出/收起时同步压缩 wrapper 高度，
  // 让终端可视区始终在键盘之上。非全屏不挂监听，避免无谓订阅。
  // 注意：
  //   1. 只听 'resize'，不听 'scroll' —— iOS Safari 在 xterm 内部滚动时也会 fire
  //      vv.scroll，会把 setState 高频化并被误判成键盘变化。
  //   2. 仅在 height 真的变化时才 setState（用 ref 缓存上次值），避免 React 频繁 render。
  //   3. scrollToBottom 仅在键盘"首次弹出"时调一次，不要每次 resize 都调，
  //      否则用户在键盘弹出后想往上翻历史会被打回底部。
  useEffect(() => {
    if (!fullscreen) {
      setVvSize(null)
      return
    }
    const vv = window.visualViewport
    if (!vv) return
    let lastH = -1
    const update = () => {
      const h = vv.height
      if (Math.abs(h - lastH) < 1) return
      const wasShorter = lastH > 0 && h < lastH - 50  // 高度骤降 → 键盘刚弹出
      lastH = h
      setVvSize({ height: h, offsetTop: vv.offsetTop })
      if (wasShorter) {
        const term = termRef.current
        if (term) {
          try { term.scrollToBottom() } catch { /* ignore */ }
        }
      }
    }
    update()
    vv.addEventListener('resize', update)
    return () => {
      vv.removeEventListener('resize', update)
    }
  }, [fullscreen])

  const handleStop = useCallback(async () => {
    await stopAiExec(sessionId)
  }, [sessionId])

  const handleManualRecover = useCallback(async () => {
    // 自动恢复失败 / 上一次手动恢复失败后，recoveryAttemptedRef 仍是 false（只在成功路径置位），
    // 但 4004 路径触发过一次成功 recover 后再失效时，需要让用户能再点一次：reset 它。
    recoveryAttemptedRef.current = false
    const recovered = await tryAutoRecover()
    if (recovered) {
      setSessionFailed(false)
    } else {
      termRef.current?.writeln(`\r\n\x1b[31m--- ${t('session:terminal.writeln.noNativeSessionId')} ---\x1b[0m\r`)
    }
  }, [tryAutoRecover])

  const handleSetAutoMode = useCallback((mode: string | null) => {
    setAutoMode(mode)
    try {
      if (mode) localStorage.setItem('quadtodo.autoMode', mode)
      else localStorage.removeItem('quadtodo.autoMode')
    } catch { /* ignore */ }
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set_auto_mode', autoMode: mode }))
    }
  }, [])

  // FocusSubbar 顶栏需要这套 controller 才能跨 Live/Conversation tab 渲染同一个 permission mode 下拉。
  // 用 ref 持有外发回调，避免 inline prop 触发 effect 抖动。
  const onAutoModeReadyRef = useRef(onAutoModeReady)
  useEffect(() => { onAutoModeReadyRef.current = onAutoModeReady }, [onAutoModeReady])
  const autoModeController = useMemo<AutoModeController>(() => ({
    autoMode,
    setAutoMode: handleSetAutoMode,
    switching: switchingMode,
    available: (sessionStatus === 'ai_running' || sessionStatus === 'ai_pending') && !sessionExpired,
  }), [autoMode, handleSetAutoMode, switchingMode, sessionStatus, sessionExpired])
  useEffect(() => {
    onAutoModeReadyRef.current?.(autoModeController)
  }, [autoModeController])
  useEffect(() => () => { onAutoModeReadyRef.current?.(null) }, [])

  const toggleFullscreen = useCallback(() => {
    setFullscreen(prev => !prev)
  }, [])

  // 方向键浮层：直接走和 term.onData 一样的 input 协议，发 ANSI 转义序列
  const sendKey = useCallback((seq: string) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data: seq }))
    }
  }, [])

  const toggleDpad = useCallback(() => {
    setDpadHidden(prev => {
      const next = !prev
      try { localStorage.setItem('quadtodo.dpadHidden', next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
  }, [])

  const onDragStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault()
    const startY = 'touches' in e ? e.touches[0].clientY : e.clientY
    dragRef.current = { startY, startH: height }

    const onMove = (ev: MouseEvent | TouchEvent) => {
      if (!dragRef.current) return
      const y = 'touches' in ev ? ev.touches[0].clientY : (ev as MouseEvent).clientY
      const newH = Math.max(80, Math.min(800, dragRef.current.startH + (y - dragRef.current.startY)))
      setHeight(newH)
    }
    const onUp = () => {
      dragRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend', onUp)
      requestAnimationFrame(doFit)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.addEventListener('touchmove', onMove)
    document.addEventListener('touchend', onUp)
  }, [height])

  const isActive = sessionStatus === 'ai_running' || sessionStatus === 'ai_pending'

  const focusTerm = useCallback(() => {
    termRef.current?.focus()
  }, [])

  // 清空 xterm 显示 + 通知服务端丢弃 outputHistory：旧 session 在窄 cols 下产生的
  // 硬折行 scrollback 在更宽的窗口里显示窄一截，清完后下次 Claude 输出按当前 cols 重绘。
  const handleClearHistory = useCallback(() => {
    if (!window.confirm(t('session:terminal.clearHistoryConfirm'))) return
    const term = termRef.current
    if (term) {
      try { term.clear() } catch { /* ignore */ }
      try { term.reset() } catch { /* ignore */ }
    }
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'clear_history' }))
    }
  }, [])

  const handleOpenCustomModal = useCallback(() => {
    setSaveAsName('')
    setCustomModalOpen(true)
  }, [])

  const handleCloseCustomModal = useCallback(() => {
    setCustomModalOpen(false)
  }, [])

  const handleSaveAsCustomPreset = useCallback(() => {
    const name = saveAsName.trim()
    if (!name) { message.warning(t('session:terminal.colorModal.nameRequired')); return }
    if (customPresets[name]) {
      // 简单用原生 confirm 二次确认覆盖；用户偏好此项目的轻量交互
      if (!window.confirm(t('session:terminal.colorModal.overwriteConfirm', { name }))) return
    }
    saveCustomPreset(name, { background: theme.background, foreground: theme.foreground })
    setSaveAsName('')
    message.success(t('session:terminal.colorModal.savedOk', { name }))
  }, [saveAsName, customPresets, saveCustomPreset, theme])

  return (
    <div
      className="xterm-terminal-wrapper"
      style={fullscreen ? {
        position: 'fixed',
        top: vvSize?.offsetTop ?? 0,
        left: 0, right: 0,
        // 有 visualViewport 时用其高度（键盘弹出会缩小）；否则回退到 100dvh
        height: vvSize ? vvSize.height : '100dvh',
        zIndex: 9999, background: chrome.outer, display: 'flex', flexDirection: 'column',
      } : fillHeight ? {
        overflow: 'hidden', background: chrome.outer,
        display: 'flex', flexDirection: 'column' as const, width: '100%',
        flex: 1, minHeight: 0, height: '100%',
        border: `1px solid ${chrome.border}`,
        // 用 box-shadow 表达 pending 高亮，避免改 border 宽度引起 1px 布局抖动
        boxShadow: sessionStatus === 'ai_pending'
          ? '0 0 0 1px #ff4d4f, 0 10px 24px rgba(8, 13, 30, 0.16)'
          : '0 10px 24px rgba(8, 13, 30, 0.16)',
      } : {
        overflow: 'hidden', background: chrome.outer,
        display: 'flex', flexDirection: 'column' as const, width: '100%',
        border: `1px solid ${chrome.border}`,
        boxShadow: sessionStatus === 'ai_pending'
          ? '0 0 0 1px #ff4d4f, 0 10px 24px rgba(8, 13, 30, 0.16)'
          : '0 10px 24px rgba(8, 13, 30, 0.16)',
      }}
    >
      {/* 工具栏 */}
      <div className="xterm-terminal-toolbar" style={{
        display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
        padding: '8px 10px', background: chrome.surface, borderBottom: `1px solid ${chrome.border}`,
        fontSize: 11, color: chrome.mutedText,
      }}>
        <span style={{ color: chrome.accent, fontWeight: 500 }}>AI</span>
        <span style={{
          width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
          background: wsConnected ? '#52c41a' : '#ff4d4f',
        }} />
        <span className="xterm-terminal-toolbar-title" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {todoId.slice(0, 40)}
        </span>
        {sessionStatus === 'ai_done' && (
          <Tag color="warning" style={{ fontSize: 10, lineHeight: '16px', margin: 0 }}>{t('session:terminal.toolbar.pendingAccept')}</Tag>
        )}
        {(sessionExpired || sessionFailed) && (
          <Tag color="error" style={{ fontSize: 10, lineHeight: '16px', margin: 0 }}>
            {t('session:terminal.toolbar.sessionExpired')}
          </Tag>
        )}
        {(sessionExpired || sessionFailed) && resumeTargetRef.current?.nativeSessionId && (
          <Button
            size="small"
            onClick={handleManualRecover}
            style={{ height: 22, paddingInline: 8 }}
          >
            {t('session:terminal.toolbar.recoverSession')}
          </Button>
        )}
        {(sessionExpired || sessionFailed) && (
          <Button
            size="small"
            onClick={onClose}
            style={{ height: 22, paddingInline: 8 }}
          >
            {t('session:terminal.toolbar.close')}
          </Button>
        )}
        {/* autoMode 下拉已搬至 SessionFocus 顶栏 (FocusSubbar)，让 Conversation tab 也能切换 permission mode */}
        <Dropdown
          menu={{
            items: [
              ...PRESET_ORDER.map((name) => ({
                key: name,
                label: (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{
                      display: 'inline-block', width: 14, height: 14, borderRadius: 3,
                      border: '1px solid rgba(128,128,128,0.3)',
                      background: `linear-gradient(135deg, ${TERMINAL_PRESETS[name].background} 50%, ${TERMINAL_PRESETS[name].foreground} 50%)`,
                    }} />
                    <span>{PRESET_LABELS[name]}</span>
                  </div>
                ),
              })),
              ...(Object.keys(customPresets).length > 0 ? [
                { type: 'divider' as const },
                ...Object.entries(customPresets).map(([name, themeColors]) => ({
                  key: `custom:${name}`,
                  label: (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
                      <span style={{
                        display: 'inline-block', width: 14, height: 14, borderRadius: 3,
                        border: '1px solid rgba(128,128,128,0.3)',
                        background: `linear-gradient(135deg, ${themeColors.background} 50%, ${themeColors.foreground} 50%)`,
                      }} />
                      <span style={{ flex: 1 }}>{name}</span>
                      <span
                        role="button"
                        aria-label={t('session:terminal.toolbar.themeDeleteAria')}
                        onClick={(e) => {
                          e.stopPropagation(); e.preventDefault()
                          if (window.confirm(t('session:terminal.colorModal.deleteConfirm', { name }))) deleteCustomPreset(name)
                        }}
                        style={{ color: 'var(--text-tertiary)', padding: '0 4px', cursor: 'pointer', fontSize: 11 }}
                      >
                        <DeleteOutlined />
                      </span>
                    </div>
                  ),
                })),
              ] : []),
              { type: 'divider' as const },
              { key: '__custom', label: t('session:terminal.toolbar.themeCustom') },
            ],
            selectedKeys: [preset],
            onClick: ({ key }) => {
              if (key === '__custom') handleOpenCustomModal()
              else setPreset(key)
            },
          }}
          trigger={['click']}
        >
          <Tag
            icon={<BgColorsOutlined style={{ fontSize: 9 }} />}
            style={{ fontSize: 10, lineHeight: '16px', margin: 0, cursor: 'pointer', userSelect: 'none' }}
          >
            {preset.startsWith('custom:')
              ? preset.slice(7)
              : (PRESET_LABELS as Record<string, string>)[preset] || preset}
            {(override.background || override.foreground) ? '*' : ''}
            {' '}<DownOutlined style={{ fontSize: 7 }} />
          </Tag>
        </Dropdown>
        <Modal
          open={customModalOpen}
          title={t('session:terminal.colorModal.title')}
          onCancel={handleCloseCustomModal}
          width={360}
          destroyOnClose
          footer={
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <Button onClick={() => resetOverride()}>{t('session:terminal.colorModal.resetDefault')}</Button>
              <Button type="primary" onClick={handleCloseCustomModal}>{t('session:terminal.colorModal.done')}</Button>
            </div>
          }
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <span>{t('session:terminal.colorModal.background')}</span>
            <ColorPicker
              value={override.background || theme.background}
              onChange={(c) => setOverride({ background: c.toHexString() })}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span>{t('session:terminal.colorModal.foreground')}</span>
            <ColorPicker
              value={override.foreground || theme.foreground}
              onChange={(c) => setOverride({ foreground: c.toHexString() })}
            />
          </div>
          <Divider style={{ margin: '12px 0' }} />
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 6 }}>{t('session:terminal.colorModal.saveHint')}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Input
              placeholder={t('session:terminal.colorModal.savePlaceholder')}
              value={saveAsName}
              onChange={(e) => setSaveAsName(e.target.value)}
              onPressEnter={handleSaveAsCustomPreset}
              maxLength={32}
            />
            <Button onClick={handleSaveAsCustomPreset} disabled={!saveAsName.trim()}>{t('session:terminal.colorModal.saveAs')}</Button>
          </div>
        </Modal>
      </div>
      {/* tool_missing 修复卡片：424 时弹出，告诉用户跑哪条命令装回 claude/codex */}
      {toolMissing && (
        <div style={{
          border: '1px solid #d9d9d9', borderRadius: 6, padding: 12, margin: 12,
          background: '#fffbe6',
        }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>
            {t('session:terminal.toolMissing.title', { tool: toolMissing.tool })}
          </div>
          <div style={{ marginBottom: 10, color: 'var(--text-secondary)', fontSize: 12 }}>
            {t('session:terminal.toolMissing.body', { bin: toolMissing.bin })}
          </div>
          <div style={{
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            background: '#f5f5f5', padding: 8, borderRadius: 4, marginBottom: 10,
            fontSize: 12, userSelect: 'all',
          }}>
            {toolMissing.fix}
          </div>
          <Button
            size="small"
            type="primary"
            onClick={() => {
              const fix = toolMissing.fix
              navigator.clipboard?.writeText(fix).then(
                () => message.success(t('session:terminal.toolMissing.copyOk')),
                () => message.warning(t('session:terminal.toolMissing.copyFail')),
              )
            }}
          >
            {t('session:terminal.toolMissing.copyCommand')}
          </Button>
          <Button
            size="small"
            style={{ marginLeft: 8 }}
            onClick={() => setToolMissing(null)}
          >
            {t('session:terminal.toolMissing.close')}
          </Button>
        </div>
      )}
      {/* 终端 */}
      <div
        ref={containerRef}
        onPointerDown={(e) => {
          e.stopPropagation()
          // 仅鼠标按下立即聚焦；触摸交给浏览器的 click 抑制机制：
          // 滑动滚动时浏览器不会 fire click → 不聚焦 → 不弹软键盘
          if (e.pointerType === 'mouse') focusTerm()
        }}
        onClick={focusTerm}
        onMouseDown={focusTerm}
        style={{
          flex: (fullscreen || fillHeight) ? 1 : undefined,
          minHeight: (fullscreen || fillHeight) ? 0 : undefined,
          height: (fullscreen || fillHeight) ? undefined : height,
          width: '100%',
          position: 'relative',
          pointerEvents: switchingMode ? 'none' : undefined,
          // viewportReady=false: 隐藏 xterm 直到首次 fit + 多帧绘制完成，避免"小→大"闪动
          // switchingMode 进一步压暗到 0.6 表示正在切换 auto 模式
          // 揭开时不加 transition：xterm canvas 已经画好，直接显示比 fade-in 视觉上更稳，
          // fade-in 期间用户能透过半透明看到 canvas 仍在变化，反而像"闪"
          opacity: !viewportReady ? 0 : (switchingMode ? 0.6 : 1),
          transition: switchingMode ? 'opacity 0.2s' : 'none',
          overflow: 'hidden',
          userSelect: 'text',
          cursor: 'text',
        }}
      />
      {/* 拖拽手柄 */}
      {!fullscreen && !fillHeight && (
        <div
          onMouseDown={onDragStart}
          onTouchStart={onDragStart}
          style={{
            height: 6, cursor: 'ns-resize', background: chrome.surface, flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            borderTop: `1px solid ${chrome.border}`,
          }}
        >
          <div style={{ width: 30, height: 2, borderRadius: 1, background: chrome.mutedText }} />
        </div>
      )}
      {fullscreen && (
        <div style={{ padding: '4px 8px', background: chrome.surface, borderTop: `1px solid ${chrome.border}`, fontSize: 10, color: chrome.mutedText, textAlign: 'center', flexShrink: 0 }}>
          {t('session:terminal.escHint')}
        </div>
      )}
      {/* 方向键浮层：仅移动端显示（CSS 控制），用户可通过工具栏的 DragOutlined 按钮收起 */}
      {!dpadHidden && (
        <div className="ai-term-dpad" aria-hidden="true">
          {[
            { cls: 'dpad-up', seq: '\x1b[A', label: t('session:terminal.dpad.up'), icon: <UpOutlined /> },
            { cls: 'dpad-left', seq: '\x1b[D', label: t('session:terminal.dpad.left'), icon: <LeftOutlined /> },
            { cls: 'dpad-right', seq: '\x1b[C', label: t('session:terminal.dpad.right'), icon: <RightOutlined /> },
            { cls: 'dpad-down', seq: '\x1b[B', label: t('session:terminal.dpad.down'), icon: <DownOutlined /> },
          ].map(b => (
            <button
              key={b.cls}
              type="button"
              className={`dpad-btn ${b.cls}`}
              aria-label={b.label}
              onPointerDown={(e) => {
                // preventDefault 阻止按钮抢焦点（让 xterm 保持 focus），同时立即响应不等 click
                e.preventDefault()
                e.stopPropagation()
                sendKey(b.seq)
              }}
            >
              {b.icon}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
