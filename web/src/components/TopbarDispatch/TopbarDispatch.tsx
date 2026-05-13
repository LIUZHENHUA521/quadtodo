import { useState } from 'react'
import { Popover, Tooltip } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import { StatPill } from '../StatPill'
import { ThemeToggle } from '../ThemeToggle'
import { useDispatchStore } from '../../store/dispatchStore'
import { useDispatchStats } from '../../design/useDispatchStats'
import { useAiSessionStore } from '../../store/aiSessionStore'
import { useUnreadStore, isSessionUnread } from '../../store/unreadStore'
import { deriveAiState } from '../../design/aiPresentationState'
import type { UnreadSessionItem } from '../../replyHub'
import './TopbarDispatch.css'

const IDLE_TOOLTIP_LIMIT = 8

export interface TopbarDispatchProps {
  unreadItems: UnreadSessionItem[]
  onJump: (item: UnreadSessionItem) => void
}

export function TopbarDispatch({ unreadItems, onJump }: TopbarDispatchProps) {
  const { runningCount, idleCount } = useDispatchStats()
  const openDrawer = useDispatchStore((s) => s.openDrawer)
  const togglePalette = useDispatchStore((s) => s.togglePalette)
  const [pendingOpen, setPendingOpen] = useState(false)

  const sessions = useAiSessionStore((s) => s.sessions)
  const lastSeenMap = useUnreadStore((s) => s.lastSeenAt)
  const runningList: { id: string; title: string; tool: string }[] = []
  const idleList: { id: string; title: string; tool: string }[] = []
  sessions.forEach((session) => {
    const unread = isSessionUnread(session.lastTurnDoneAt, lastSeenMap.get(session.sessionId))
    const state = deriveAiState(session.status, unread)
    const entry = { id: session.sessionId, title: session.todoTitle, tool: session.tool }
    if (state === 'running') runningList.push(entry)
    else if (state === 'idle') idleList.push(entry)
  })

  const pendingCount = unreadItems.length

  const handlePickItem = (item: UnreadSessionItem) => {
    setPendingOpen(false)
    onJump(item)
  }

  const pendingPopoverContent =
    pendingCount === 0 ? (
      <div className="topbar-tooltip-empty">No pending</div>
    ) : (
      <>
        <div className="topbar-tooltip-title">待确认 ({pendingCount})</div>
        <div className="topbar-pending-list">
          {unreadItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className="topbar-tooltip-row topbar-pending-row"
              onClick={() => handlePickItem(item)}
              data-testid="topbar-pending-row"
            >
              <span
                className="topbar-tooltip-dot"
                style={{ background: 'var(--ai-pending-confirm)' }}
              />
              <span className="topbar-tooltip-name">{item.todoTitle}</span>
              <span className="topbar-tooltip-meta">{item.tool} · 未读</span>
            </button>
          ))}
        </div>
      </>
    )

  const idleListVisible = idleList.slice(0, IDLE_TOOLTIP_LIMIT)
  const idleRemainder = idleList.length - idleListVisible.length

  return (
    <div className="topbar-dispatch">
      <div className="topbar-logo">
        <div className="topbar-logo-mark">A</div>
        <span>AgentQuad</span>
      </div>

      <StatPill
        icon="pulse-dot"
        iconColor="var(--ai-running)"
        value={runningCount}
        label="running"
        data-testid="stat-running"
        tooltip={
          runningList.length === 0 ? (
            <div className="topbar-tooltip-empty">No running sessions</div>
          ) : (
            <>
              <div className="topbar-tooltip-title">Running sessions ({runningList.length})</div>
              {runningList.map((s) => (
                <div key={s.id} className="topbar-tooltip-row">
                  <span className="topbar-tooltip-dot" style={{ background: 'var(--ai-running)' }} />
                  <span className="topbar-tooltip-name">{s.title}</span>
                  <span className="topbar-tooltip-meta">{s.tool}</span>
                </div>
              ))}
            </>
          )
        }
      />

      <StatPill
        icon="pulse-dot"
        iconColor="var(--ai-idle)"
        value={idleCount}
        label="idle"
        data-testid="stat-idle"
        tooltip={
          idleList.length === 0 ? (
            <div className="topbar-tooltip-empty">No idle sessions</div>
          ) : (
            <>
              <div className="topbar-tooltip-title">Idle sessions ({idleList.length})</div>
              {idleListVisible.map((s) => (
                <div key={s.id} className="topbar-tooltip-row">
                  <span className="topbar-tooltip-dot" style={{ background: 'var(--ai-idle)' }} />
                  <span className="topbar-tooltip-name">{s.title}</span>
                  <span className="topbar-tooltip-meta">{s.tool}</span>
                </div>
              ))}
              {idleRemainder > 0 && (
                <div className="topbar-tooltip-row">
                  <span className="topbar-tooltip-meta">还有 {idleRemainder} 条</span>
                </div>
              )}
            </>
          )
        }
      />

      <Popover
        open={pendingOpen}
        onOpenChange={setPendingOpen}
        trigger="click"
        placement="bottomRight"
        overlayClassName="topbar-pending-popover"
        content={pendingPopoverContent}
      >
        <span data-testid="stat-pending-trigger">
          <StatPill
            variant={pendingCount > 0 ? 'alert' : 'default'}
            icon="pulse-dot"
            iconColor="var(--ai-pending-confirm)"
            value={pendingCount}
            label="待确认"
            data-testid="stat-pending"
            onClick={() => setPendingOpen((v) => !v)}
          />
        </span>
      </Popover>

      <div className="topbar-spacer" />

      <button className="topbar-cmdk-btn" onClick={togglePalette} data-testid="topbar-cmdk-btn">
        <span className="topbar-cmdk-prefix">⌘</span>
        <span>Search or run a command</span>
        <kbd>⌘K</kbd>
      </button>

      <Tooltip title="历史会话找回">
        <button
          className="topbar-icon-btn"
          onClick={() => useDispatchStore.getState().signal('recover')}
          aria-label="Recover session"
          data-testid="topbar-recover-btn"
        >
          <SearchOutlined />
        </button>
      </Tooltip>
      <Tooltip title="Stats &amp; Reports">
        <button className="topbar-icon-btn" onClick={() => openDrawer('statsReports')} data-testid="topbar-stats-btn">📊</button>
      </Tooltip>
      <Tooltip title="Wiki">
        <button className="topbar-icon-btn" onClick={() => openDrawer('wiki')} data-testid="topbar-wiki-btn">📖</button>
      </Tooltip>
      <Tooltip title="Settings">
        <button className="topbar-icon-btn" onClick={() => openDrawer('settings')} data-testid="topbar-settings-btn">⚙</button>
      </Tooltip>
      <ThemeToggle />
    </div>
  )
}
