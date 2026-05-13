import { useState, useCallback } from 'react'
import { Popover, Tooltip, message } from 'antd'
import { CloseOutlined } from '@ant-design/icons'
import { Plus, Search, BarChart3, BookOpen, FileText, Settings, Zap, Pause, MessageCircleWarning } from 'lucide-react'
import { StatPill } from '../StatPill'
import { ThemeToggle } from '../ThemeToggle'
import { useDispatchStore } from '../../store/dispatchStore'
import { useDispatchStats } from '../../design/useDispatchStats'
import { useAiSessionStore } from '../../store/aiSessionStore'
import { useUnreadStore, isSessionUnread } from '../../store/unreadStore'
import { useTodoSnapshotStore } from '../../store/todoSnapshotStore'
import { deriveAiState, isClosedAiStatus } from '../../design/aiPresentationState'
import type { UnreadSessionItem } from '../../replyHub'
import './TopbarDispatch.css'

const IDLE_TOOLTIP_LIMIT = 8

interface SessionRowEntry {
  id: string
  todoId: string
  title: string
  tool: string
}

export interface TopbarDispatchProps {
  unreadItems: UnreadSessionItem[]
  onJump: (item: UnreadSessionItem) => void
  onFocusSession: (todoId: string, sessionId: string) => void
  onStopSession: (sessionId: string) => Promise<void> | void
}

export function TopbarDispatch({ unreadItems, onJump, onFocusSession, onStopSession }: TopbarDispatchProps) {
  const { runningCount, idleCount } = useDispatchStats()
  const openDrawer = useDispatchStore((s) => s.openDrawer)
  const togglePalette = useDispatchStore((s) => s.togglePalette)
  const [pendingOpen, setPendingOpen] = useState(false)
  const [runningOpen, setRunningOpen] = useState(false)
  const [idleOpen, setIdleOpen] = useState(false)
  const [stoppingId, setStoppingId] = useState<string | null>(null)

  const sessions = useAiSessionStore((s) => s.sessions)
  const lastSeenMap = useUnreadStore((s) => s.lastSeenAt)
  const todos = useTodoSnapshotStore((s) => s.todos)
  const runningList: SessionRowEntry[] = []
  const idleList: SessionRowEntry[] = []
  sessions.forEach((session) => {
    const unread = isSessionUnread(session.lastTurnDoneAt, lastSeenMap.get(session.sessionId))
    const state = deriveAiState(session.status, unread, session.awaitingReply ?? false)
    const entry: SessionRowEntry = {
      id: session.sessionId,
      todoId: session.todoId,
      title: session.todoTitle,
      tool: session.tool,
    }
    if (state === 'running') runningList.push(entry)
    else if (state === 'idle' && !isClosedAiStatus(session.status)) idleList.push(entry)
  })
  // Fallback: 把 todos 里有 active aiSession 但 live store 还没收到的，按 todo.aiSession.status
  // 也归并进来，避免首启 3s 内 running pill 计数为 0、点开 popover 看不到这条新会话。
  for (const t of todos) {
    const sid = t.aiSession?.sessionId
    if (!sid || sessions.has(sid)) continue
    const status = t.aiSession?.status
    const unread = isSessionUnread(t.aiSession?.lastTurnDoneAt ?? null, lastSeenMap.get(sid))
    const state = deriveAiState(status, unread)
    const entry: SessionRowEntry = {
      id: sid,
      todoId: t.id,
      title: t.title,
      tool: t.aiSession?.tool ?? 'ai',
    }
    if (state === 'running') runningList.push(entry)
    else if (state === 'idle' && !isClosedAiStatus(status)) idleList.push(entry)
  }

  const pendingCount = unreadItems.length

  const handlePickItem = (item: UnreadSessionItem) => {
    setPendingOpen(false)
    onJump(item)
  }

  const handleFocusRow = useCallback(
    (entry: SessionRowEntry, closePopover: () => void) => {
      closePopover()
      onFocusSession(entry.todoId, entry.id)
    },
    [onFocusSession],
  )

  const handleStopRow = useCallback(
    async (entry: SessionRowEntry) => {
      if (stoppingId === entry.id) return
      setStoppingId(entry.id)
      try {
        await onStopSession(entry.id)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        message.error(`停止失败: ${msg}`)
      } finally {
        setStoppingId((cur) => (cur === entry.id ? null : cur))
      }
    },
    [onStopSession, stoppingId],
  )

  const renderSessionList = (
    entries: SessionRowEntry[],
    dotColor: string,
    closePopover: () => void,
    options?: { remainder?: number },
  ) => (
    <div className="topbar-pending-list">
      {entries.map((entry) => {
        const stopping = stoppingId === entry.id
        return (
          <div key={entry.id} className="topbar-session-row-wrap">
            <button
              type="button"
              className="topbar-tooltip-row topbar-pending-row topbar-session-row"
              onClick={() => handleFocusRow(entry, closePopover)}
              data-testid="topbar-session-row"
            >
              <span className="topbar-tooltip-dot" style={{ background: dotColor }} />
              <span className="topbar-tooltip-name">{entry.title}</span>
              <span className="topbar-tooltip-meta">{entry.tool}</span>
            </button>
            <Tooltip title="停止该会话的 PTY 终端">
              <button
                type="button"
                className="topbar-row-close-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  void handleStopRow(entry)
                }}
                disabled={stopping}
                aria-label="Stop session"
                data-testid="topbar-session-row-close"
              >
                <CloseOutlined />
              </button>
            </Tooltip>
          </div>
        )
      })}
      {options?.remainder && options.remainder > 0 ? (
        <div className="topbar-tooltip-row topbar-session-remainder">
          <span className="topbar-tooltip-meta">还有 {options.remainder} 条</span>
        </div>
      ) : null}
    </div>
  )

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

  const runningPopoverContent =
    runningList.length === 0 ? (
      <div className="topbar-tooltip-empty">No running sessions</div>
    ) : (
      <>
        <div className="topbar-tooltip-title">Running sessions ({runningList.length})</div>
        {renderSessionList(runningList, 'var(--ai-running)', () => setRunningOpen(false))}
      </>
    )

  const idleListVisible = idleList.slice(0, IDLE_TOOLTIP_LIMIT)
  const idleRemainder = idleList.length - idleListVisible.length
  const idlePopoverContent =
    idleList.length === 0 ? (
      <div className="topbar-tooltip-empty">No idle sessions</div>
    ) : (
      <>
        <div className="topbar-tooltip-title">Idle sessions ({idleList.length})</div>
        {renderSessionList(idleListVisible, 'var(--ai-idle)', () => setIdleOpen(false), {
          remainder: idleRemainder,
        })}
      </>
    )

  return (
    <div className="topbar-dispatch">
      <div className="topbar-logo">
        <img src={new URL('../../assets/logo.png', import.meta.url).href} alt="AgentQuad" className="topbar-logo-img" />
        <span>AgentQuad</span>
      </div>

      <Popover
        open={runningOpen}
        onOpenChange={setRunningOpen}
        trigger="click"
        placement="bottomLeft"
        overlayClassName="topbar-pending-popover"
        content={runningPopoverContent}
      >
        <span data-testid="stat-running-trigger">
          <StatPill
            icon={<Zap size={13} />}
            iconColor="var(--ai-running)"
            value={runningCount}
            label="running"
            data-testid="stat-running"
            onClick={() => setRunningOpen((v) => !v)}
          />
        </span>
      </Popover>

      <Popover
        open={idleOpen}
        onOpenChange={setIdleOpen}
        trigger="click"
        placement="bottomLeft"
        overlayClassName="topbar-pending-popover"
        content={idlePopoverContent}
      >
        <span data-testid="stat-idle-trigger">
          <StatPill
            icon={<Pause size={13} />}
            iconColor="var(--ai-idle)"
            value={idleCount}
            label="idle"
            data-testid="stat-idle"
            onClick={() => setIdleOpen((v) => !v)}
          />
        </span>
      </Popover>

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
            icon={<MessageCircleWarning size={13} />}
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

      <Tooltip title="新建待办">
        <button
          className="topbar-icon-btn"
          onClick={() => useDispatchStore.getState().signal('newTodo')}
          aria-label="New todo"
          data-testid="topbar-new-btn"
        >
          <Plus size={16} />
        </button>
      </Tooltip>
      <Tooltip title="Prompt 模板">
        <button
          className="topbar-icon-btn"
          onClick={() => openDrawer('template')}
          aria-label="Templates"
          data-testid="topbar-template-btn"
        >
          <FileText size={16} />
        </button>
      </Tooltip>
      <Tooltip title="历史会话找回">
        <button
          className="topbar-icon-btn"
          onClick={() => useDispatchStore.getState().signal('recover')}
          aria-label="Recover session"
          data-testid="topbar-recover-btn"
        >
          <Search size={16} />
        </button>
      </Tooltip>
      <Tooltip title="Stats &amp; Reports">
        <button className="topbar-icon-btn" onClick={() => openDrawer('statsReports')} data-testid="topbar-stats-btn"><BarChart3 size={16} /></button>
      </Tooltip>
      <Tooltip title="Wiki">
        <button className="topbar-icon-btn" onClick={() => openDrawer('wiki')} data-testid="topbar-wiki-btn"><BookOpen size={16} /></button>
      </Tooltip>
      <Tooltip title="Settings">
        <button className="topbar-icon-btn" onClick={() => openDrawer('settings')} data-testid="topbar-settings-btn"><Settings size={16} /></button>
      </Tooltip>
      <ThemeToggle />
    </div>
  )
}
