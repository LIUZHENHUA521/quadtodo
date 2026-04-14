/**
 * AiTerminalMini — 可内嵌在待办卡片中的迷你终端
 */

import React, { useEffect, useRef, useCallback, useState } from 'react'
import { Button, Tooltip, Tag, Dropdown } from 'antd'
import { FullscreenOutlined, FullscreenExitOutlined, StopOutlined, DownOutlined, CloseOutlined } from '@ant-design/icons'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { getTerminalWsUrl, startAiExec, stopAiExec, TodoStatus, ResumeSessionInput } from './api'

interface Props {
  sessionId: string
  todoId: string
  status: TodoStatus
  resumeTarget?: ResumeSessionInput | null
  onSessionRecovered?: (nextSessionId: string) => void
  onClose: () => void
  onDone?: (result: { status: string; exitCode?: number }) => void
}

const MAX_RECONNECT_DELAY = 10_000
const INITIAL_RECONNECT_DELAY = 1000
const MAX_RECONNECT_ATTEMPTS = 15
const HEARTBEAT_INTERVAL = 15_000
const RESIZE_DEBOUNCE_MS = 100

export default function AiTerminalMini({ sessionId, todoId, status, resumeTarget, onSessionRecovered, onClose, onDone }: Props) {
  void onClose
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [sessionStatus, setSessionStatus] = useState<TodoStatus>(status)
  const [wsConnected, setWsConnected] = useState(false)
  const [sessionExpired, setSessionExpired] = useState(false)
  const [height, setHeight] = useState(420)
  const [autoMode, setAutoMode] = useState<string | null>(null)
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
      theme: { background: '#1a1a2e', foreground: '#d4d4d4', cursor: '#569cd6' },
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
      return true
    })

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
              term.write(msg.data)
              break
            case 'replay':
              if (Array.isArray(msg.chunks)) {
                for (const chunk of msg.chunks) term.write(chunk)
              }
              break
            case 'pending_confirm':
              setSessionStatus('ai_pending')
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
      term.dispose()
      termRef.current = null
      wsRef.current = null
      fitRef.current = null
    }
  }, [sessionId, tryAutoRecover])

  useEffect(() => { setSessionStatus(status) }, [status])

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

  return (
    <div
      className="xterm-terminal-wrapper"
      style={fullscreen ? {
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        zIndex: 9999, background: '#1a1a2e', display: 'flex', flexDirection: 'column',
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
          flex: fullscreen ? 1 : undefined,
          height: fullscreen ? undefined : height,
          width: '100%',
          position: 'relative',
          overflow: 'hidden',
          userSelect: 'text',
          cursor: 'text',
        }}
      />
      {/* 拖拽手柄 */}
      {!fullscreen && (
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
