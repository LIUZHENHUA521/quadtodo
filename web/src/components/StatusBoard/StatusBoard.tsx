import React, { type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import type { Todo, AiSession } from '../../api'
import { STATUS_COLUMNS, type StatusColumnId, type SessionEntry } from './statusConfig'
import { SessionCard } from '../SessionCard'
import './StatusBoard.css'

export interface StatusBoardProps {
  /** Backlog 列要渲染的内容（外部用 TodoCard / SortableTodoCard）。
   * 通过 children-as-function 把 todo 数组交回去，避免 StatusBoard 知道 TodoCard 细节 */
  backlogTodos: Todo[]
  renderBacklogItem: (t: Todo) => ReactNode
  /** Backlog 列的 dnd 配置 —— 复用现有 todoDndId */
  backlogDndIds?: string[]
  sessions: Record<StatusColumnId, SessionEntry[]>
  liveSessionMap?: Record<string, { status?: string } | undefined>
  onOpenSession: (s: AiSession, parent: Todo) => void
  onOpenParent: (parent: Todo) => void
  onCancelSession: (s: AiSession, parent: Todo) => void
  onConfirmSession: (s: AiSession, parent: Todo) => void
  onCloseIdle: (s: AiSession, parent: Todo) => void
  onReopenIdle: (s: AiSession, parent: Todo) => void
}

export function StatusBoard(props: StatusBoardProps) {
  const { t } = useTranslation(['todo'])
  const {
    backlogTodos, renderBacklogItem, backlogDndIds,
    sessions,
    onOpenSession, onOpenParent, onCancelSession, onConfirmSession,
    onCloseIdle, onReopenIdle,
  } = props

  return (
    <div className="status-board">
      {STATUS_COLUMNS.map((col) => {
        const cellStyle = { ['--col-accent' as any]: `var(${col.accentVar})` } as React.CSSProperties
        const count = col.id === 'backlog' ? backlogTodos.length : sessions[col.id]?.length || 0
        return (
          <Column
            key={col.id}
            id={col.id}
            label={t(col.labelKey, { defaultValue: col.fallbackLabel })}
            tag={col.id}
            style={cellStyle}
            count={count}
          >
            {col.id === 'backlog' ? (
              <BacklogColumnBody
                todos={backlogTodos}
                dndIds={backlogDndIds || []}
                renderItem={renderBacklogItem}
              />
            ) : (
              <SessionColumnBody
                entries={sessions[col.id] || []}
                columnStatus={col.id === 'in_progress' ? 'running' : col.id === 'needs_input' ? 'pending_confirm' : 'idle'}
                onOpenSession={onOpenSession}
                onOpenParent={onOpenParent}
                onCancelSession={onCancelSession}
                onConfirmSession={onConfirmSession}
                onCloseIdle={onCloseIdle}
                onReopenIdle={onReopenIdle}
              />
            )}
          </Column>
        )
      })}
    </div>
  )
}

interface ColumnProps {
  id: StatusColumnId
  label: string
  tag: string
  count: number
  style: React.CSSProperties
  children: ReactNode
}

function Column({ id, label, tag, count, style, children }: ColumnProps) {
  return (
    <section className={`status-board-col status-board-col-${id}`} style={style}>
      <header className="status-board-col-head">
        <div className="status-board-col-label">
          <span className="status-board-col-tag">{tag.replace('_', ' ')}</span>
          <span className="status-board-col-name">{label}</span>
        </div>
        <span className="status-board-col-count">{String(count).padStart(2, '0')}</span>
      </header>
      {children}
    </section>
  )
}

function BacklogColumnBody({
  todos, dndIds, renderItem,
}: {
  todos: Todo[]
  dndIds: string[]
  renderItem: (t: Todo) => ReactNode
}) {
  const { t: ti18n } = useTranslation(['todo'])
  const { setNodeRef, isOver } = useDroppable({ id: 'status-col-backlog' })
  return (
    <div
      ref={setNodeRef}
      className={`status-board-col-body ${isOver ? 'is-drag-over' : ''}`}
    >
      <SortableContext items={dndIds} strategy={verticalListSortingStrategy}>
        {todos.length === 0 ? (
          <div className="status-board-empty">
            {ti18n('todo:column.backlogEmpty', { defaultValue: '暂无待办，新建一个吧' })}
          </div>
        ) : todos.map((t) => (
          <React.Fragment key={t.id}>{renderItem(t)}</React.Fragment>
        ))}
      </SortableContext>
    </div>
  )
}

function SessionColumnBody({
  entries, columnStatus,
  onOpenSession, onOpenParent, onCancelSession, onConfirmSession, onCloseIdle, onReopenIdle,
}: {
  entries: SessionEntry[]
  columnStatus: 'running' | 'pending_confirm' | 'idle'
  onOpenSession: (s: AiSession, parent: Todo) => void
  onOpenParent: (parent: Todo) => void
  onCancelSession: (s: AiSession, parent: Todo) => void
  onConfirmSession: (s: AiSession, parent: Todo) => void
  onCloseIdle: (s: AiSession, parent: Todo) => void
  onReopenIdle: (s: AiSession, parent: Todo) => void
}) {
  const { t: ti18n } = useTranslation(['todo'])
  const emptyKey =
    columnStatus === 'running'  ? 'todo:column.runningEmpty' :
    columnStatus === 'pending_confirm' ? 'todo:column.needsInputEmpty' :
    'todo:column.idleEmpty'
  const emptyFallback =
    columnStatus === 'running'  ? '当前没有运行中的会话' :
    columnStatus === 'pending_confirm' ? '没有等你拍板的会话' :
    '没有空闲的会话'

  return (
    <div className="status-board-col-body">
      {entries.length === 0 ? (
        <div className="status-board-empty">
          {ti18n(emptyKey, { defaultValue: emptyFallback })}
        </div>
      ) : entries.map(({ session, todo }) => (
        <SessionCard
          key={session.sessionId}
          session={session}
          parent={todo}
          columnStatus={columnStatus}
          onOpen={onOpenSession}
          onOpenParent={onOpenParent}
          onCancel={onCancelSession}
          onConfirm={onConfirmSession}
          onClose={onCloseIdle}
          onReopen={onReopenIdle}
        />
      ))}
    </div>
  )
}
