import { useState } from 'react'
import { Tooltip, Button, Dropdown, Tag, Spin, message } from 'antd'
import { Code } from 'lucide-react'
import { DownOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { SessionMeta } from '../../store/aiSessionStore'
import { useAiSessionStore } from '../../store/aiSessionStore'
import { useDispatchStore } from '../../store/dispatchStore'
import { useAppConfigStore } from '../../store/appConfigStore'
import type { AiStatus, AiTool, EditorKind } from '../../api'
import { startAiExec, openTraeCN, ApiError } from '../../api'
import { deriveAiState, AI_STATE_PILL_LABEL_KEY, isClosedAiStatus } from '../../design/aiPresentationState'
import { useUnreadStore, isSessionUnread } from '../../store/unreadStore'
import type { AutoModeController } from '../../AiTerminalMini'

interface Props {
  todoId: string
  sessionId: string | null
  session?: SessionMeta
  /** live session 还没出现时用 todo.aiSession.status 兜底，避免首启动闪 idle */
  fallbackStatus?: AiStatus
  /** 进程已死时，用 todo 快照填上标题/工具/cwd/nativeSessionId */
  fallbackTitle?: string
  fallbackTool?: AiTool
  fallbackNativeSessionId?: string | null
  fallbackCwd?: string | null
  /** True 表示 live SessionMeta 缺失但快照里有 AiSession——这是 Resume 按钮的显示前提 */
  liveMissing?: boolean
  /** 由 AiTerminalMini 通过 SessionViewer.onAutoModeReady 推上来的 permission mode 控制器。 */
  autoModeController?: AutoModeController | null
  /** Resume 成功（拿到新 sessionId）后通知父组件做 focus 切换 */
  onResumed?: (nextSessionId: string) => void
  onClose: () => void
}

export function FocusSubbar({
  todoId,
  session,
  fallbackStatus,
  fallbackTitle,
  fallbackTool,
  fallbackNativeSessionId,
  fallbackCwd,
  liveMissing,
  autoModeController,
  onResumed,
  onClose,
}: Props) {
  const { t } = useTranslation(['session', 'todo', 'errors'])
  const title = session?.todoTitle ?? fallbackTitle ?? t('session:focusSubbar.untitled')
  const tool = session?.tool ?? fallbackTool ?? 'ai'
  const fullSessionId = session?.sessionId ?? null
  const sessionShortId = fullSessionId ? fullSessionId.slice(0, 8) : '—'
  const quadrant = session?.quadrant ?? 0

  const lastSeen = useUnreadStore((s) =>
    session?.sessionId ? s.lastSeenAt.get(session.sessionId) : undefined,
  )
  const markSeen = useUnreadStore((s) => s.markSeen)
  const unread = isSessionUnread(session?.lastTurnDoneAt, lastSeen)
  // PTY 已死的会话（done/failed/stopped）在 deriveAiState 里就会归 'idle'，这里独立检测
  // 一次，是为了把 pill 文案换成"进程已结束"，避免显示成误导的"空闲"。触发场景：用户点
  // 完成自动 stop、/stop 命令、AgentQuad 重启批量 stop 等。
  const effectiveStatus = session?.effectiveStatus ?? session?.status ?? fallbackStatus
  const sessionClosed = isClosedAiStatus(effectiveStatus)
  const state = deriveAiState(effectiveStatus, unread, session?.awaitingReply ?? false)
  const statusLabel = sessionClosed ? t('session:focusSubbar.processEnded') : t(AI_STATE_PILL_LABEL_KEY[state])

  const quadColor =
    quadrant >= 1 && quadrant <= 4 ? `var(--q${quadrant})` : 'var(--text-tertiary)'
  const canConfirm = !!session?.sessionId && state === 'pending'
  const handleConfirm = () => {
    if (!session?.sessionId) return
    markSeen(session.sessionId, session.lastTurnDoneAt || Date.now())
  }

  const editorCwd = session?.cwd ?? fallbackCwd ?? ''
  const handleOpenEditor = async (editor: EditorKind) => {
    try { localStorage.setItem('quadtodo.editor', editor) } catch {}
    const label = editor === 'trae-cn' ? 'Trae CN' : editor === 'trae' ? 'Trae' : 'Cursor'
    try {
      await openTraeCN(editorCwd, editor)
      message.success(t('todo:message.openedEditor', { label }))
    } catch (e: any) {
      message.error(e?.message || t('errors:openEditorFailed', { label }))
    }
  }

  const [resuming, setResuming] = useState(false)
  // live session 缺失（已被回收）或 PTY 已死（done/failed/stopped 但 30 分钟 cleanup 未到）
  // 都应该让用户能 Resume。后者覆盖"点完成→自动 stop→恢复待办"这种触发路径。
  const canShowResume = Boolean(liveMissing) || sessionClosed
  // resume native id 优先用持久化快照里的 fallback（liveMissing 时唯一来源），其次取 live session
  // 自身的 nativeSessionId（stopped 但 live 还在的场景）。
  const resumeNativeId = fallbackNativeSessionId ?? session?.nativeSessionId ?? null
  const resumeCwd = session?.cwd ?? fallbackCwd ?? null
  // pty.js 对 claude / codex / cursor 三家都已实现 resume CLI 调用；前端只看是否有 nativeSessionId。
  // tool === 'ai' 是 fallback 缺省（live session 不应出现），也走"无原生 id"分支保底。
  const resumeDisabledReason: string | null = !canShowResume
    ? null
    : tool === 'ai' || !resumeNativeId
      ? t('session:focusSubbar.resumeDisabledNoNative')
      : null
  const resumeEnabled = canShowResume && !resumeDisabledReason && !resuming
  const handleResume = async () => {
    if (!resumeEnabled || !resumeNativeId || tool === 'ai') return
    setResuming(true)
    try {
      // 与 TodoManage.handleAiExec 对齐：localStorage 浏览器覆盖 > 设置全局默认。
      // 不传的话恢复出来的 PTY 会用后端默认 'default'，让"完全托管"失效。
      let permissionMode: string | null = null
      try { permissionMode = localStorage.getItem('quadtodo.autoMode') } catch { /* ignore */ }
      if (!permissionMode) permissionMode = useAppConfigStore.getState().defaultPermissionMode
      const { sessionId: nextSessionId } = await startAiExec({
        todoId,
        prompt: '',
        tool,
        cwd: resumeCwd || undefined,
        resumeNativeId,
        permissionMode: permissionMode || undefined,
      })
      // Optimistic upsert：后端 poll（每 3s）追上之前，先在 aiSessionStore 占位，
      // 避免 SessionFocus 出现"focusedSessionId 变了但 live session 还没到"的空窗 flash。
      const optimistic: SessionMeta = {
        sessionId: nextSessionId,
        todoId,
        todoTitle: fallbackTitle ?? title,
        quadrant: (session?.quadrant ?? 0) as SessionMeta['quadrant'],
        tool,
        status: 'running',
        autoMode: null,
        nativeSessionId: resumeNativeId,
        cwd: resumeCwd,
        startedAt: Date.now(),
        completedAt: null,
        lastOutputAt: null,
        outputBytesTotal: 0,
      }
      useAiSessionStore.getState().upsertSession(optimistic)
      // 刷新 todo 列表，新 recover 出来的 session 才会同步进 todo.aiSessions / todo.aiSession，
      // 否则关掉 focus 再从 todo card 点回来会沿用旧 sessionId，进的是已死的历史会话。
      useDispatchStore.getState().signal('refreshTodos')
      message.success(t('session:focusSubbar.resumeOk'))
      onResumed?.(nextSessionId)
    } catch (err: any) {
      const reason = err instanceof ApiError
        ? (err.body?.message || err.body?.code || err.message)
        : (err?.message || 'unknown')
      message.error(t('session:focusSubbar.resumeFailed', { reason }))
    } finally {
      setResuming(false)
    }
  }

  return (
    <div className="focus-subbar">
      <button className="focus-back" onClick={onClose} aria-label={t('session:focusSubbar.backToGrid')}>
        <span>←</span>
        <span>{t('session:focusSubbar.grid')}</span>
      </button>
      <div className="focus-task-title">
        <span
          className="quad-dot"
          style={{ background: quadColor, boxShadow: `0 0 8px ${quadColor}` }}
        />
        <Tooltip title={title} placement="bottomLeft" mouseEnterDelay={0.4}>
          <span className="focus-task-title__text">{title}</span>
        </Tooltip>
        <span className="focus-task-id">#{sessionShortId}</span>
      </div>
      <div className="focus-actions">
        <Dropdown
          menu={{
            items: [
              { key: 'trae-cn', label: 'Trae CN' },
              { key: 'trae', label: 'Trae' },
              { key: 'cursor', label: 'Cursor' },
            ],
            onClick: ({ key }) => handleOpenEditor(key as EditorKind),
          }}
          trigger={['click']}
        >
          <Tooltip title={t('todo:card.openEditorTooltip')}>
            <Button size="small" icon={<Code size={13} />} style={{ height: 28 }}>
              {t('todo:card.openEditorLabel')}
            </Button>
          </Tooltip>
        </Dropdown>
        {autoModeController?.available && (
          <Dropdown
            menu={{
              items: [
                { key: 'default', label: t('session:terminal.toolbar.autoMode.default') },
                { key: 'acceptEdits', label: t('session:terminal.toolbar.autoMode.acceptEdits') },
                { key: 'bypass', label: t('session:terminal.toolbar.autoMode.bypass') },
              ],
              selectedKeys: [autoModeController.autoMode || 'default'],
              onClick: ({ key }) => autoModeController.setAutoMode(key === 'default' ? null : key),
            }}
            trigger={['click']}
            disabled={autoModeController.switching}
          >
            <Tag
              color={
                autoModeController.autoMode === 'bypass' ? 'orange'
                : autoModeController.autoMode === 'acceptEdits' ? 'blue'
                : 'default'
              }
              style={{
                fontSize: 11, lineHeight: 1, margin: 0, padding: '0 9px',
                height: 28, display: 'inline-flex', alignItems: 'center', gap: 4,
                cursor: autoModeController.switching ? 'wait' : 'pointer',
                userSelect: 'none',
                opacity: autoModeController.switching ? 0.6 : 1,
              }}
            >
              {autoModeController.switching ? (
                <>
                  <Spin size="small" />
                  {t('session:terminal.toolbar.switching')}
                </>
              ) : (
                <>
                  <span>
                    {autoModeController.autoMode === 'bypass'
                      ? t('session:terminal.toolbar.autoMode.tagBypass')
                      : autoModeController.autoMode === 'acceptEdits'
                        ? t('session:terminal.toolbar.autoMode.tagAcceptEdits')
                        : t('session:terminal.toolbar.autoMode.tagDefault')}
                  </span>
                  <DownOutlined style={{ fontSize: 8 }} />
                </>
              )}
            </Tag>
          </Dropdown>
        )}
        <span className={`pill-select ${sessionClosed ? 'idle' : state === 'pending' ? 'pending' : state === 'running' ? 'green' : 'idle'}`}>
          {tool} · {statusLabel}
        </span>
        {canConfirm && (
          <button className="focus-confirm-btn" onClick={handleConfirm}>
            {t('session:focusSubbar.confirm')}
          </button>
        )}
        {canShowResume && (
          <Tooltip title={resumeDisabledReason || t('session:focusSubbar.resumeTooltip')}>
            {/* span 包一层让 disabled button 的 tooltip 仍能触发 */}
            <span>
              <Button
                size="small"
                type="primary"
                ghost
                loading={resuming}
                disabled={!resumeEnabled}
                onClick={handleResume}
                style={{ height: 28, paddingInline: 10 }}
              >
                {t('session:focusSubbar.resume')}
              </Button>
            </span>
          </Tooltip>
        )}
        <Tooltip title={t('session:focusSubbar.closeEsc')}>
          <button className="focus-icon-btn" onClick={onClose} aria-label={t('session:focusSubbar.close')}>✕</button>
        </Tooltip>
      </div>
    </div>
  )
}
