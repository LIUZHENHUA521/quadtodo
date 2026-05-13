import { useState } from 'react'
import { Popover, Tooltip } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import { StatPill } from '../StatPill'
import { ThemeToggle } from '../ThemeToggle'
import { useDispatchStore } from '../../store/dispatchStore'
import { useDispatchStats } from '../../design/useDispatchStats'
import { useAiSessionStore } from '../../store/aiSessionStore'
import type { UnreadSessionItem } from '../../replyHub'
import './TopbarDispatch.css'

export interface TopbarDispatchProps {
  unreadItems: UnreadSessionItem[]
  onJump: (item: UnreadSessionItem) => void
}

export function TopbarDispatch({ unreadItems, onJump }: TopbarDispatchProps) {
  const { activeCount, tokenSumLabel } = useDispatchStats()
  const openDrawer = useDispatchStore((s) => s.openDrawer)
  const togglePalette = useDispatchStore((s) => s.togglePalette)
  const [pendingOpen, setPendingOpen] = useState(false)

  const sessions = useAiSessionStore((s) => s.sessions)
  const activeList: { id: string; title: string; tool: string; status: string }[] = []
  sessions.forEach((session) => {
    if (session.status === 'running') {
      activeList.push({
        id: session.sessionId,
        title: session.todoTitle,
        tool: session.tool,
        status: session.status,
      })
    }
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
        <div className="topbar-tooltip-title">待处理 ({pendingCount})</div>
        <div className="topbar-pending-list">
          {unreadItems.map((item) => {
            const isPending = item.reason === 'pending_confirm'
            return (
              <button
                key={item.id}
                type="button"
                className="topbar-tooltip-row topbar-pending-row"
                onClick={() => handlePickItem(item)}
                data-testid="topbar-pending-row"
              >
                <span
                  className="topbar-tooltip-dot"
                  style={{ background: isPending ? 'var(--ai-pending-confirm)' : 'var(--ai-error)' }}
                />
                <span className="topbar-tooltip-name">{item.todoTitle}</span>
                <span className="topbar-tooltip-meta">
                  {item.tool} · {isPending ? '待批准' : '未读'}
                </span>
              </button>
            )
          })}
        </div>
      </>
    )

  return (
    <div className="topbar-dispatch">
      <div className="topbar-logo">
        <div className="topbar-logo-mark">A</div>
        <span>AgentQuad</span>
      </div>

      <StatPill
        icon="pulse-dot"
        iconColor="var(--ai-running)"
        value={activeCount}
        label="active"
        data-testid="stat-active"
        tooltip={
          activeList.length === 0 ? (
            <div className="topbar-tooltip-empty">No active sessions</div>
          ) : (
            <>
              <div className="topbar-tooltip-title">Active sessions ({activeList.length})</div>
              {activeList.map((s) => (
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
        icon="arrow"
        value={tokenSumLabel}
        label="tok"
        data-testid="stat-tokens"
        tooltip={
          <>
            <div className="topbar-tooltip-title">Token usage</div>
            <div className="topbar-tooltip-row">
              <span className="topbar-tooltip-name">Total across active sessions</span>
              <span className="topbar-tooltip-meta">{tokenSumLabel}</span>
            </div>
          </>
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
            label="pending"
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
