// web/src/dock/TerminalDock.tsx
import React, { useCallback, useEffect, useRef } from 'react'
import { Button, Tooltip } from 'antd'
import { CloseOutlined, MenuFoldOutlined } from '@ant-design/icons'
import { useTerminalDockStore, DOCK_LIMITS } from '../store/terminalDockStore'
import TerminalDockTab from './TerminalDockTab'
import './dock.css'

export default function TerminalDock() {
  const { widthPx, isCollapsed, openTabs, activeTabId, toggleCollapsed, setWidth } = useTerminalDockStore()
  const dragStartRef = useRef<{ x: number; w: number } | null>(null)
  const moveHandlerRef = useRef<((ev: MouseEvent) => void) | null>(null)
  const upHandlerRef = useRef<(() => void) | null>(null)

  const onMouseDownDivider = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragStartRef.current = { x: e.clientX, w: widthPx }

    const onMove = (ev: MouseEvent) => {
      const start = dragStartRef.current
      if (!start) return
      // dragging the divider left -> width grows
      setWidth(start.w + (start.x - ev.clientX))
    }
    const onUp = () => {
      dragStartRef.current = null
      if (moveHandlerRef.current) document.removeEventListener('mousemove', moveHandlerRef.current)
      if (upHandlerRef.current) document.removeEventListener('mouseup', upHandlerRef.current)
      moveHandlerRef.current = null
      upHandlerRef.current = null
    }
    moveHandlerRef.current = onMove
    upHandlerRef.current = onUp
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [widthPx, setWidth])

  useEffect(() => {
    // Clean up any leftover drag listeners on unmount
    return () => {
      if (moveHandlerRef.current) document.removeEventListener('mousemove', moveHandlerRef.current)
      if (upHandlerRef.current) document.removeEventListener('mouseup', upHandlerRef.current)
      dragStartRef.current = null
      moveHandlerRef.current = null
      upHandlerRef.current = null
    }
  }, [])

  if (isCollapsed) {
    return (
      <div className="terminal-dock terminal-dock--collapsed">
        <Tooltip title="展开 AI 终端 Dock">
          <Button
            type="text"
            icon={<MenuFoldOutlined style={{ transform: 'scaleX(-1)' }} />}
            onClick={toggleCollapsed}
            className="terminal-dock__expand-btn"
          />
        </Tooltip>
      </div>
    )
  }

  return (
    <div
      className="terminal-dock"
      style={{ width: widthPx, minWidth: DOCK_LIMITS.MIN_W, maxWidth: DOCK_LIMITS.MAX_W }}
    >
      <div className="terminal-dock__divider" onMouseDown={onMouseDownDivider} />
      <div className="terminal-dock__head">
        <span className="terminal-dock__title">AI 终端 Dock</span>
        <span className="terminal-dock__count">{openTabs.length} 个会话</span>
        <Tooltip title="折叠">
          <Button type="text" size="small" icon={<CloseOutlined />} onClick={toggleCollapsed} />
        </Tooltip>
      </div>
      <div className="terminal-dock__body">
        {openTabs.length === 0 ? (
          <div className="terminal-dock__empty">没有打开的会话</div>
        ) : (
          openTabs.map(tab => (
            <TerminalDockTab
              key={tab.id}
              tab={tab}
              cwd={null}
              visible={tab.id === activeTabId}
            />
          ))
        )}
      </div>
    </div>
  )
}
