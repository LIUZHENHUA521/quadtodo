/**
 * AiTerminalMini — 可内嵌在待办卡片中的迷你终端
 */

import React, { useEffect, useRef, useCallback, useState } from 'react'
import { Button, Tooltip, Tag, Dropdown, Popover, ColorPicker } from 'antd'
import { FullscreenOutlined, FullscreenExitOutlined, StopOutlined, DownOutlined, CloseOutlined, VerticalAlignBottomOutlined, LockOutlined, UnlockOutlined, BgColorsOutlined } from '@ant-design/icons'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { getTerminalWsUrl, startAiExec, stopAiExec, openTraeCN, TodoStatus, ResumeSessionInput, EditorKind } from './api'
import { useTerminalTheme } from './hooks/useTerminalTheme'
import { PRESET_LABELS, PRESET_ORDER, TerminalPresetName, TERMINAL_PRESETS } from './terminalThemes'

// 匹配 xterm 一行中的文件路径（相对或绝对，可带 :line 或 :line:col）
// 规避回溯：只匹配不含空格/冒号/斜杠的 path segment + 已知扩展名
const FILE_LINK_RE = /(?:[./]|\b)[\w.@-]+(?:\/[\w.@-]+)+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|scss|less|html|vue|py|go|rs|java|kt|swift|sh|yml|yaml|toml|lock|env|txt|sql|prisma|xml|c|cc|cpp|h|hpp|rb|php|proto)(?::\d+(?::\d+)?)?/g
const MAX_LINKS_PER_LINE = 8

interface Props {
  sessionId: string
  todoId: string
  status: TodoStatus
  cwd?: string | null
  resumeTarget?: ResumeSessionInput | null
  onSessionRecovered?: (nextSessionId: string) => void
  onClose: () => void
  onDone?: (result: { status: string; exitCode?: number }) => void
  fillHeight?: boolean
}

const MAX_RECONNECT_DELAY = 10_000
const INITIAL_RECONNECT_DELAY = 1000
const MAX_RECONNECT_ATTEMPTS = 15
const HEARTBEAT_INTERVAL = 15_000
const RESIZE_DEBOUNCE_MS = 100

export default function AiTerminalMini({ sessionId, todoId, status, cwd, resumeTarget, onSessionRecovered, onClose, onDone, fillHeight }: Props) {
  void onClose
  const { theme, preset, override, setPreset, setOverride, resetOverride } = useTerminalTheme()
  const themeRef = useRef(theme)
  useEffect(() => { themeRef.current = theme }, [theme])
  const [customPopoverOpen, setCustomPopoverOpen] = useState(false)
  const overrideSnapshotRef = useRef<typeof override>({})
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const cwdRef = useRef<string | null>(cwd ?? null)
  const linkProviderRef = useRef<{ dispose: () => void } | null>(null)
  useEffect(() => { cwdRef.current = cwd ?? null }, [cwd])
  const wsRef = useRef<WebSocket | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [sessionStatus, setSessionStatus] = useState<TodoStatus>(status)
  const [wsConnected, setWsConnected] = useState(false)
  const [sessionExpired, setSessionExpired] = useState(false)
  const [height, setHeight] = useState(420)
  const [autoMode, setAutoMode] = useState<string | null>(() => {
    try { return localStorage.getItem('quadtodo.autoMode') || null } catch { return null }
  })
  const [followTail, setFollowTail] = useState<boolean>(() => {
    try { return localStorage.getItem('quadtodo.followTail') !== '0' } catch { return true }
  })
  const followTailRef = useRef<boolean>(followTail)
  useEffect(() => { followTailRef.current = followTail }, [followTail])
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectDelayRef = useRef(INITIAL_RECONNECT_DELAY)
  const reconnectCountRef = useRef(0)
  const stopReconnectRef = useRef(false)
  const disposedRef = useRef(false)
  const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastPongRef = useRef<number>(Date.now())
  const STALE_THRESHOLD = 30_000
  const recoveringRef = useRef(false)
  const recoveryAttemptedRef = useRef(false)
  const resumeTargetRef = useRef<ResumeSessionInput | null>(resumeTarget || null)
  const onSessionRecoveredRef = useRef<typeof onSessionRecovered>(onSessionRecovered)

  useEffect(() => {
    resumeTargetRef.current = resumeTarget || null
    onSessionRecoveredRef.current = onSessionRecovered
  }, [resumeTarget, onSessionRecovered])

  const tryAutoRecover = useCallback(async () => {
    const latestResumeTarget = resumeTargetRef.current
    if (!latestResumeTarget?.nativeSessionId || recoveringRef.current || recoveryAttemptedRef.current) return false
    recoveringRef.current = true
    recoveryAttemptedRef.current = true
    try {
      termRef.current?.writeln('\r\n\x1b[33m--- 检测到服务重启，正在自动恢复会话... ---\x1b[0m\r')
      const { sessionId: nextSessionId } = await startAiExec({
        todoId: latestResumeTarget.todoId,
        tool: latestResumeTarget.tool,
        prompt: latestResumeTarget.prompt,
        cwd: latestResumeTarget.cwd,
        resumeNativeId: latestResumeTarget.nativeSessionId,
      })
      stopReconnectRef.current = true
      setSessionExpired(false)
      onSessionRecoveredRef.current?.(nextSessionId)
      return true
    } catch (error: any) {
      termRef.current?.writeln(`\r\n\x1b[31m--- 自动恢复失败：${error?.message || 'unknown error'} ---\x1b[0m\r`)
      return false
    } finally {
      recoveringRef.current = false
    }
  }, [])

  /** fit + 发送 resize（跳过尺寸未变的情况） */
  const doFit = useCallback(() => {
    const fit = fitRef.current
    const term = termRef.current
    const ws = wsRef.current
    if (!fit || !term) return
    try {
      fit.fit()
      const { cols, rows } = term
      const last = lastSentSizeRef.current
      if (last && last.cols === cols && last.rows === rows) return
      lastSentSizeRef.current = { cols, rows }
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }))
      }
    } catch (e) {
      console.warn('[AiTerminalMini] fit error:', e)
    }
  }, [])

  useEffect(() => {
    if (!containerRef.current) return
    disposedRef.current = false
    stopReconnectRef.current = false
    recoveringRef.current = false
    recoveryAttemptedRef.current = false
    reconnectDelayRef.current = INITIAL_RECONNECT_DELAY
    reconnectCountRef.current = 0
    lastSentSizeRef.current = null
    lastPongRef.current = Date.now()
    setSessionExpired(false)
    setWsConnected(false)

    const term = new Terminal({
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: themeRef.current,
      cursorBlink: true,
      convertEol: true,
      scrollback: 5000,
      disableStdin: false,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    termRef.current = term
    fitRef.current = fit

    // IME 输入法兼容：组合期间屏蔽键盘事件，防止回车选词被当作 \r 发送
    let imeComposing = false
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
        setFollowTail(true)
        try { localStorage.setItem('quadtodo.followTail', '1') } catch { /* ignore */ }
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
                  openTraeCN(base, editor, hit).catch((err) => {
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

    requestAnimationFrame(() => { try { fit.fit() } catch {} })

    function connectWs() {
      if (disposedRef.current || stopReconnectRef.current) return

      // 关闭已有连接（防止多个 WS 并存互相干扰）
      const prev = wsRef.current
      if (prev) {
        try { prev.close() } catch {}
        wsRef.current = null
      }

      const wsUrl = getTerminalWsUrl(sessionId)
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      let heartbeatTimer: ReturnType<typeof setInterval> | null = null

      ws.onopen = () => {
        // 如果已被更新的连接取代，关掉自己
        if (wsRef.current !== ws) { ws.close(); return }

        reconnectDelayRef.current = INITIAL_RECONNECT_DELAY
        reconnectCountRef.current = 0
        setWsConnected(true)
        lastPongRef.current = Date.now()
        term.writeln('\x1b[36m--- Terminal connected ---\x1b[0m\r')
        if (!resumeTargetRef.current?.nativeSessionId && status === 'ai_running') {
          term.writeln('\x1b[90m--- 正在注入任务上下文，请稍候... ---\x1b[0m\r')
        }
        requestAnimationFrame(() => {
          try {
            fit.fit()
            ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
          } catch {}
        })
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
                  term.writeln('\r\n\x1b[31m--- 会话已过期（服务端重启或已清理） ---\x1b[0m\r')
                }
              })
            }
            return
          }
          switch (msg.type) {
            case 'output':
              term.write(msg.data, () => {
                if (followTailRef.current) term.scrollToBottom()
              })
              break
            case 'replay':
              if (Array.isArray(msg.chunks)) {
                for (const chunk of msg.chunks) term.write(chunk)
                // 回放结束后强制 SGR reset，避免 TUI 在切片边界遗留 underline/颜色
                term.write('\x1b[0m')
                if (followTailRef.current) term.scrollToBottom()
              }
              break
            case 'pending_confirm':
              setSessionStatus('ai_pending')
              break
            case 'pending_cleared':
              setSessionStatus('ai_running')
              break
            case 'auto_mode':
              setAutoMode(msg.autoMode || null)
              break
            case 'turn_done':
              break
            case 'done':
              setSessionStatus(msg.status === 'done' ? 'ai_done' : 'todo')
              term.writeln(`\r\n\x1b[${msg.exitCode === 0 ? '32' : '31'}m=== ${msg.status === 'done' ? 'AI 完成，请验收' : '任务失败'} ===\x1b[0m\r`)
              onDone?.({ status: msg.status, exitCode: msg.exitCode })
              break
            case 'stopped':
              setSessionStatus('todo')
              term.writeln('\r\n\x1b[33m=== 已中止 ===\x1b[0m\r')
              break
          }
        } catch (err) {
          console.warn('[AiTerminalMini] message parse error:', err)
        }
      }

      ws.onclose = (ev) => {
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }

        // 核心：如果这个 WS 已被新连接取代，不做任何状态更新
        if (wsRef.current !== ws) return

        setWsConnected(false)
        if (disposedRef.current || stopReconnectRef.current) return

        if (ev.code === 4004) {
          void tryAutoRecover().then((recovered) => {
            if (!recovered) {
              stopReconnectRef.current = true
              setSessionExpired(true)
              term.writeln('\r\n\x1b[31m--- 会话已过期 ---\x1b[0m\r')
            }
          })
          return
        }

        if (reconnectCountRef.current >= MAX_RECONNECT_ATTEMPTS) {
          term.writeln('\r\n\x1b[31m--- 重连失败次数过多，已停止重连 ---\x1b[0m\r')
          return
        }

        term.writeln(`\r\n\x1b[33m--- 连接断开 (code ${ev.code})，正在重连 (${reconnectCountRef.current + 1}/${MAX_RECONNECT_ATTEMPTS}) ---\x1b[0m\r`)
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
      term.writeln(`\r\n\x1b[33m--- ${reason}，正在重新连接... ---\x1b[0m\r`)
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
          term.writeln('\r\n\x1b[31m⚠ 连接已断开，正在自动重连...\x1b[0m\r')
        }
        forceReconnect('检测到连接失效')
      }
    })

    // 标签页切回时：检查 WS 健康，死连接立即重连 + 重新聚焦终端
    function handleVisibilityChange() {
      if (document.visibilityState !== 'visible') return
      if (disposedRef.current || stopReconnectRef.current) return
      lastPongRef.current = Date.now()
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        forceReconnect('标签页切回，连接已断开')
      } else {
        ws.send(JSON.stringify({ type: 'ping' }))
      }
      term.focus()
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    // 终端获焦时：发 ping 探活，超时无 pong 则强制重连
    let focusProbeTimer: ReturnType<typeof setTimeout> | null = null
    function handleTermFocus() {
      if (disposedRef.current || stopReconnectRef.current) return
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        forceReconnect('聚焦时发现连接断开')
        return
      }
      const beforePing = lastPongRef.current
      ws.send(JSON.stringify({ type: 'ping' }))
      if (focusProbeTimer) clearTimeout(focusProbeTimer)
      focusProbeTimer = setTimeout(() => {
        focusProbeTimer = null
        if (lastPongRef.current === beforePing && !disposedRef.current && !stopReconnectRef.current) {
          forceReconnect('探活超时，连接可能已断开')
        }
      }, 2000)
    }
    const termTextarea = term.textarea
    termTextarea?.addEventListener('focus', handleTermFocus)

    const ro = new ResizeObserver(() => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = setTimeout(() => {
        resizeTimerRef.current = null
        requestAnimationFrame(() => doFit())
      }, RESIZE_DEBOUNCE_MS)
    })
    ro.observe(containerRef.current)

    // 浏览器窗口缩放/拖拽：ResizeObserver 可能不触发，需要额外监听
    let windowResizeTimer: ReturnType<typeof setTimeout> | null = null
    function handleWindowResize() {
      if (windowResizeTimer) clearTimeout(windowResizeTimer)
      windowResizeTimer = setTimeout(() => {
        windowResizeTimer = null
        requestAnimationFrame(() => doFit())
      }, RESIZE_DEBOUNCE_MS)
    }
    window.addEventListener('resize', handleWindowResize)

    return () => {
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
      ro.disconnect()
      const ws = wsRef.current
      if (ws) ws.close()
      try { linkProviderRef.current?.dispose() } catch {}
      linkProviderRef.current = null
      term.dispose()
      termRef.current = null
      wsRef.current = null
      fitRef.current = null
    }
  }, [sessionId, tryAutoRecover])

  useEffect(() => { setSessionStatus(status) }, [status])

  useEffect(() => {
    const term = termRef.current
    if (term) term.options.theme = theme
  }, [theme])

  useEffect(() => {
    requestAnimationFrame(doFit)
  }, [fullscreen, height, doFit])

  const handleStop = useCallback(async () => {
    await stopAiExec(sessionId)
  }, [sessionId])

  const handleManualRecover = useCallback(async () => {
    const recovered = await tryAutoRecover()
    if (!recovered) {
      termRef.current?.writeln('\r\n\x1b[31m--- 当前没有可恢复的原生会话 ID ---\x1b[0m\r')
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

  const toggleFullscreen = useCallback(() => {
    setFullscreen(prev => !prev)
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

  const scrollToBottom = useCallback(() => {
    const term = termRef.current
    if (!term) return
    term.scrollToBottom()
    setFollowTail(true)
    try { localStorage.setItem('quadtodo.followTail', '1') } catch { /* ignore */ }
    term.focus()
  }, [])

  const handleOpenCustomPopover = useCallback(() => {
    overrideSnapshotRef.current = { ...override }
    setCustomPopoverOpen(true)
  }, [override])

  const handleCancelCustom = useCallback(() => {
    const snap = overrideSnapshotRef.current
    resetOverride()
    if (snap.background || snap.foreground) {
      setOverride({
        ...(snap.background ? { background: snap.background } : {}),
        ...(snap.foreground ? { foreground: snap.foreground } : {}),
      })
    }
    setCustomPopoverOpen(false)
  }, [setOverride, resetOverride])

  const toggleFollowTail = useCallback(() => {
    setFollowTail(prev => {
      const next = !prev
      try { localStorage.setItem('quadtodo.followTail', next ? '1' : '0') } catch { /* ignore */ }
      if (next) termRef.current?.scrollToBottom()
      return next
    })
  }, [])

  return (
    <div
      className="xterm-terminal-wrapper"
      style={fullscreen ? {
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        zIndex: 9999, background: '#1a1a2e', display: 'flex', flexDirection: 'column',
      } : fillHeight ? {
        borderRadius: 10, overflow: 'hidden', background: '#1a1a2e',
        display: 'flex', flexDirection: 'column' as const, width: '100%',
        flex: 1, minHeight: 0, height: '100%',
        border: sessionStatus === 'ai_pending' ? '2px solid #ff4d4f' : '1px solid #303050',
        boxShadow: '0 10px 24px rgba(8, 13, 30, 0.16)',
      } : {
        borderRadius: 10, overflow: 'hidden', background: '#1a1a2e',
        display: 'flex', flexDirection: 'column' as const, width: '100%',
        border: sessionStatus === 'ai_pending' ? '2px solid #ff4d4f' : '1px solid #303050',
        boxShadow: '0 10px 24px rgba(8, 13, 30, 0.16)',
      }}
    >
      {/* 工具栏 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
        padding: '8px 10px', background: '#16213e', borderBottom: '1px solid #303050',
        fontSize: 11, color: '#888',
      }}>
        <span style={{ color: '#569cd6', fontWeight: 500 }}>AI</span>
        <span style={{
          width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
          background: wsConnected ? '#52c41a' : '#ff4d4f',
        }} />
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {todoId.slice(0, 40)}
        </span>
        {sessionStatus === 'ai_pending' && (
          <Tag color="error" style={{ fontSize: 10, lineHeight: '16px', margin: 0, animation: 'blink 1s infinite' }}>待确认</Tag>
        )}
        {sessionStatus === 'ai_done' && (
          <Tag color="warning" style={{ fontSize: 10, lineHeight: '16px', margin: 0 }}>请验收</Tag>
        )}
        {sessionExpired && (
          <Tag color="error" style={{ fontSize: 10, lineHeight: '16px', margin: 0 }}>
            会话已过期
          </Tag>
        )}
        {sessionExpired && resumeTargetRef.current?.nativeSessionId && (
          <Button
            size="small"
            onClick={handleManualRecover}
            style={{ height: 22, paddingInline: 8 }}
          >
            恢复会话
          </Button>
        )}
        {sessionExpired && (
          <Button
            size="small"
            onClick={onClose}
            style={{ height: 22, paddingInline: 8 }}
          >
            关闭
          </Button>
        )}
        {isActive && !sessionExpired && (
          <Dropdown
            menu={{
              items: [
                { key: 'default', label: '默认（需确认）' },
                { key: 'acceptEdits', label: '半托管（编辑自动通过）' },
                { key: 'bypass', label: '完全托管（全自动）' },
              ],
              selectedKeys: [autoMode || 'default'],
              onClick: ({ key }) => handleSetAutoMode(key === 'default' ? null : key),
            }}
            trigger={['click']}
          >
            <Tag
              color={autoMode === 'bypass' ? 'orange' : autoMode === 'acceptEdits' ? 'blue' : 'default'}
              style={{ fontSize: 10, lineHeight: '16px', margin: 0, cursor: 'pointer', userSelect: 'none' }}
            >
              {autoMode === 'bypass' ? '全托管' : autoMode === 'acceptEdits' ? '半托管' : '手动'} <DownOutlined style={{ fontSize: 7 }} />
            </Tag>
          </Dropdown>
        )}
        <Popover
          open={customPopoverOpen}
          onOpenChange={(open) => { if (!open) setCustomPopoverOpen(false) }}
          trigger={[]}
          placement="bottomRight"
          destroyTooltipOnHide
          content={
            <div style={{ width: 220 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 12 }}>背景色</span>
                <ColorPicker
                  size="small"
                  value={override.background || theme.background}
                  onChange={(c) => setOverride({ background: c.toHexString() })}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <span style={{ fontSize: 12 }}>文字色</span>
                <ColorPicker
                  size="small"
                  value={override.foreground || theme.foreground}
                  onChange={(c) => setOverride({ foreground: c.toHexString() })}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <Button size="small" onClick={() => resetOverride()}>恢复预设默认</Button>
                <Button size="small" onClick={handleCancelCustom}>取消</Button>
              </div>
            </div>
          }
        >
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
              { type: 'divider' as const },
              { key: '__custom', label: '自定义...' },
            ],
            selectedKeys: [preset],
            onClick: ({ key }) => {
              if (key === '__custom') handleOpenCustomPopover()
              else setPreset(key as TerminalPresetName)
            },
          }}
          trigger={['click']}
        >
          <Tag
            icon={<BgColorsOutlined style={{ fontSize: 9 }} />}
            style={{ fontSize: 10, lineHeight: '16px', margin: 0, cursor: 'pointer', userSelect: 'none' }}
          >
            {PRESET_LABELS[preset]}{(override.background || override.foreground) ? '*' : ''} <DownOutlined style={{ fontSize: 7 }} />
          </Tag>
        </Dropdown>
        </Popover>
        <Tooltip title={followTail ? '已跟随新输出（点击暂停）' : '已暂停跟随（点击恢复）'}>
          <Tag
            color={followTail ? 'green' : 'default'}
            onClick={toggleFollowTail}
            style={{ fontSize: 10, lineHeight: '16px', margin: 0, cursor: 'pointer', userSelect: 'none' }}
          >
            {followTail ? <LockOutlined style={{ fontSize: 9 }} /> : <UnlockOutlined style={{ fontSize: 9 }} />} 跟随
          </Tag>
        </Tooltip>
        <Tooltip title="滚动到底部（Ctrl+End）">
          <Button type="text" size="small"
            icon={<VerticalAlignBottomOutlined />}
            style={{ color: '#888', fontSize: 12, width: 20, height: 20, minWidth: 20 }}
            onClick={scrollToBottom}
          />
        </Tooltip>
        {isActive && !sessionExpired && (
          <Tooltip title="中止">
            <Button type="text" size="small" danger icon={<StopOutlined />}
              style={{ color: '#ff6b6b', fontSize: 12, width: 20, height: 20, minWidth: 20 }}
              onClick={handleStop}
            />
          </Tooltip>
        )}
        <Tooltip title={fullscreen ? '退出全屏' : '全屏'}>
          <Button type="text" size="small"
            icon={fullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
            style={{ color: '#888', fontSize: 12, width: 20, height: 20, minWidth: 20 }}
            onClick={toggleFullscreen}
          />
        </Tooltip>
        <Tooltip title="关闭终端">
          <Button type="text" size="small"
            icon={<CloseOutlined />}
            style={{ color: '#888', fontSize: 12, width: 20, height: 20, minWidth: 20 }}
            onClick={onClose}
          />
        </Tooltip>
      </div>
      {/* 终端 */}
      <div
        ref={containerRef}
        onPointerDown={(e) => { e.stopPropagation(); focusTerm() }}
        onClick={focusTerm}
        onMouseDown={focusTerm}
        style={{
          flex: (fullscreen || fillHeight) ? 1 : undefined,
          minHeight: (fullscreen || fillHeight) ? 0 : undefined,
          height: (fullscreen || fillHeight) ? undefined : height,
          width: '100%',
          position: 'relative',
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
            height: 6, cursor: 'ns-resize', background: '#16213e', flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            borderTop: '1px solid #303050',
          }}
        >
          <div style={{ width: 30, height: 2, borderRadius: 1, background: '#555' }} />
        </div>
      )}
      {fullscreen && (
        <div style={{ padding: '4px 8px', background: '#16213e', borderTop: '1px solid #303050', fontSize: 10, color: '#555', textAlign: 'center', flexShrink: 0 }}>
          按 ESC 或点击右上角退出全屏
        </div>
      )}
    </div>
  )
}
