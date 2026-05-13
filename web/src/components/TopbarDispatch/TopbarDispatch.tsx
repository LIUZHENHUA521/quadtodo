import { Tooltip } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import { StatPill } from '../StatPill'
import { ThemeToggle } from '../ThemeToggle'
import { useDispatchStore } from '../../store/dispatchStore'
import { useDispatchStats } from '../../design/useDispatchStats'
import { useAiSessionStore } from '../../store/aiSessionStore'
import './TopbarDispatch.css'

export function TopbarDispatch() {
  const { activeCount, pendingCount, tokenSumLabel } = useDispatchStats()
  const openDrawer = useDispatchStore((s) => s.openDrawer)
  const togglePalette = useDispatchStore((s) => s.togglePalette)

  // Build the active-sessions tooltip from live store data
  const sessions = useAiSessionStore((s) => s.sessions)
  const activeList: { id: string; title: string; tool: string; status: string }[] = []
  const pendingList: { id: string; title: string; tool: string }[] = []
  sessions.forEach((session) => {
    if (session.status === 'running') {
      activeList.push({
        id: session.sessionId,
        title: session.todoTitle,
        tool: session.tool,
        status: session.status,
      })
    }
    if (session.status === 'pending_confirm') {
      pendingList.push({
        id: session.sessionId,
        title: session.todoTitle,
        tool: session.tool,
      })
    }
  })

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

      <StatPill
        variant={pendingCount > 0 ? 'alert' : 'default'}
        icon="pulse-dot"
        iconColor="var(--ai-pending-confirm)"
        value={pendingCount}
        label="pending"
        data-testid="stat-pending"
        tooltip={
          pendingList.length === 0 ? (
            <div className="topbar-tooltip-empty">No pending confirmations</div>
          ) : (
            <>
              <div className="topbar-tooltip-title">Pending confirm ({pendingList.length})</div>
              {pendingList.map((s) => (
                <div key={s.id} className="topbar-tooltip-row">
                  <span className="topbar-tooltip-dot" style={{ background: 'var(--ai-pending-confirm)' }} />
                  <span className="topbar-tooltip-name">{s.title}</span>
                  <span className="topbar-tooltip-meta">{s.tool}</span>
                </div>
              ))}
            </>
          )
        }
      />

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
