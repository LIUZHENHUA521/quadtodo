import { useState, useCallback } from 'react'
import { Popover, Tooltip, message } from 'antd'
import { CloseOutlined } from '@ant-design/icons'
import { Plus, Search, BarChart3, BookOpen, FileText, Settings, Zap, Pause, MessageCircleWarning } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { StatPill } from '../StatPill'
import { BoardFilterPill } from '../BoardFilterPill'
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
  startedAt: number
}

// 同一个 todoId 可能在 sessions Map 中并存多条 running session（服务端 done 事件丢失、
// bypass replaceSessionId 中间态、或同 todo 同时跑多工具等）。展示层折叠成一条，保留
// startedAt 更新的那条，避免顶栏弹层出现完全相同的标题。
function dedupByTodoId(entries: SessionRowEntry[]): SessionRowEntry[] {
  const byTodo = new Map<string, SessionRowEntry>()
  for (const entry of entries) {
    const prev = byTodo.get(entry.todoId)
    if (!prev || entry.startedAt > prev.startedAt) byTodo.set(entry.todoId, entry)
  }
  return Array.from(byTodo.values())
}

export interface TopbarDispatchProps {
  unreadItems: UnreadSessionItem[]
  onJump: (item: UnreadSessionItem) => void
  onFocusSession: (todoId: string, sessionId: string) => void
  onStopSession: (sessionId: string) => Promise<void> | void
}

export function TopbarDispatch({ unreadItems, onJump, onFocusSession, onStopSession }: TopbarDispatchProps) {
  const { t } = useTranslation(['topbar', 'errors'])
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
  const runningRaw: SessionRowEntry[] = []
  const idleRaw: SessionRowEntry[] = []
  sessions.forEach((session) => {
    const unread = isSessionUnread(session.lastTurnDoneAt, lastSeenMap.get(session.sessionId))
    const state = deriveAiState(session.effectiveStatus ?? session.status, unread, session.awaitingReply ?? false)
    const entry: SessionRowEntry = {
      id: session.sessionId,
      todoId: session.todoId,
      title: session.todoTitle,
      tool: session.tool,
      startedAt: session.startedAt,
    }
    if (state === 'running') runningRaw.push(entry)
    else if (state === 'idle' && !isClosedAiStatus(session.status)) idleRaw.push(entry)
  })
  // Fallback: 把 todos 里有 active aiSession 但 live store 还没收到的，按 todo.aiSession.status
  // 也归并进来，避免首启 3s 内 running pill 计数为 0、点开 popover 看不到这条新会话。
  for (const todo of todos) {
    const sid = todo.aiSession?.sessionId
    if (!sid || sessions.has(sid)) continue
    const status = todo.aiSession?.status
    const unread = isSessionUnread(todo.aiSession?.lastTurnDoneAt ?? null, lastSeenMap.get(sid))
    const state = deriveAiState(status, unread)
    const entry: SessionRowEntry = {
      id: sid,
      todoId: todo.id,
      title: todo.title,
      tool: todo.aiSession?.tool ?? 'ai',
      startedAt: todo.aiSession?.startedAt ?? 0,
    }
    if (state === 'running') runningRaw.push(entry)
    else if (state === 'idle' && !isClosedAiStatus(status)) idleRaw.push(entry)
  }
  const runningList = dedupByTodoId(runningRaw)
  const runningTodoIds = new Set(runningList.map((entry) => entry.todoId))
  // 同 todo 已经在 running 列表的，不再出现在 idle 列表（与 useDispatchStats 计数一致）。
  const idleList = dedupByTodoId(idleRaw).filter((entry) => !runningTodoIds.has(entry.todoId))

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
        message.error(t('errors:stopFailed', { msg }))
      } finally {
        setStoppingId((cur) => (cur === entry.id ? null : cur))
      }
    },
    [onStopSession, stoppingId, t],
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
            <Tooltip title={t('topbar:tooltip.stopSession')}>
              <button
                type="button"
                className="topbar-row-close-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  void handleStopRow(entry)
                }}
                disabled={stopping}
                aria-label={t('topbar:aria.stopSession')}
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
          <span className="topbar-tooltip-meta">{t('topbar:popover.moreCount', { count: options.remainder })}</span>
        </div>
      ) : null}
    </div>
  )

  const pendingPopoverContent =
    pendingCount === 0 ? (
      <div className="topbar-tooltip-empty">{t('topbar:popover.noPending')}</div>
    ) : (
      <>
        <div className="topbar-tooltip-title">{t('topbar:popover.pendingTitle', { count: pendingCount })}</div>
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
              <span className="topbar-tooltip-meta">{t('topbar:popover.unreadWithTool', { tool: item.tool })}</span>
            </button>
          ))}
        </div>
      </>
    )

  const runningPopoverContent =
    runningList.length === 0 ? (
      <div className="topbar-tooltip-empty">{t('topbar:popover.noRunningSessions')}</div>
    ) : (
      <>
        <div className="topbar-tooltip-title">{t('topbar:popover.runningSessionsTitle', { count: runningList.length })}</div>
        {renderSessionList(runningList, 'var(--ai-running)', () => setRunningOpen(false))}
      </>
    )

  const idleListVisible = idleList.slice(0, IDLE_TOOLTIP_LIMIT)
  const idleRemainder = idleList.length - idleListVisible.length
  const idlePopoverContent =
    idleList.length === 0 ? (
      <div className="topbar-tooltip-empty">{t('topbar:popover.noIdleSessions')}</div>
    ) : (
      <>
        <div className="topbar-tooltip-title">{t('topbar:popover.idleSessionsTitle', { count: idleList.length })}</div>
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
            label={t('topbar:statLabel.running')}
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
            label={t('topbar:statLabel.idle')}
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
            label={t('topbar:pendingLabel')}
            data-testid="stat-pending"
            onClick={() => setPendingOpen((v) => !v)}
          />
        </span>
      </Popover>

      <BoardFilterPill />

      <div className="topbar-spacer" />

      <button className="topbar-cmdk-btn" onClick={togglePalette} data-testid="topbar-cmdk-btn">
        <span className="topbar-cmdk-prefix">⌘</span>
        <span>{t('topbar:searchHint')}</span>
        <kbd>⌘K</kbd>
      </button>

      <Tooltip title={t('topbar:tooltip.newTodo')}>
        <button
          className="topbar-icon-btn"
          onClick={() => useDispatchStore.getState().signal('newTodo')}
          aria-label={t('topbar:aria.newTodo')}
          data-testid="topbar-new-btn"
        >
          <Plus size={16} />
        </button>
      </Tooltip>
      <Tooltip title={t('topbar:tooltip.promptTemplate')}>
        <button
          className="topbar-icon-btn"
          onClick={() => openDrawer('template')}
          aria-label={t('topbar:aria.templates')}
          data-testid="topbar-template-btn"
        >
          <FileText size={16} />
        </button>
      </Tooltip>
      <Tooltip title={t('topbar:tooltip.transcriptRescue')}>
        <button
          className="topbar-icon-btn"
          onClick={() => useDispatchStore.getState().signal('recover')}
          aria-label={t('topbar:aria.recoverSession')}
          data-testid="topbar-recover-btn"
        >
          <Search size={16} />
        </button>
      </Tooltip>
      <Tooltip title={t('topbar:tooltip.statsReports')}>
        <button className="topbar-icon-btn" onClick={() => openDrawer('statsReports')} data-testid="topbar-stats-btn"><BarChart3 size={16} /></button>
      </Tooltip>
      {/* 记忆 wiki 入口暂时隐藏，待重新设计后再开放（参考 docs/superpowers/specs/2026-05-14-memory-wiki-v2-design.md）
      <Tooltip title={t('topbar:tooltip.wiki')}>
        <button className="topbar-icon-btn" onClick={() => openDrawer('wiki')} data-testid="topbar-wiki-btn"><BookOpen size={16} /></button>
      </Tooltip>
      */}
      <Tooltip title={t('topbar:tooltip.settings')}>
        <button className="topbar-icon-btn" onClick={() => openDrawer('settings')} data-testid="topbar-settings-btn"><Settings size={16} /></button>
      </Tooltip>
      <ThemeToggle />
    </div>
  )
}
