import React from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import type { Todo, AiTool } from '../../api'
import { todoDndId } from '../../TodoManage'
import { SortableTodoCard } from '../TodoCard'
import { QUADRANT_CONFIG } from './quadrantConfig'

export interface QuadrantZoneProps {
  config: typeof QUADRANT_CONFIG[0]
  todos: Todo[]
  childrenByParentId: Record<string, Todo[]>
  childHitIdsByParentId: Record<string, Set<string>>
  onCreateSubtodo: (todo: Todo) => void
  onCardClick: (t: Todo) => void
  onToggleDone: (t: Todo) => void
  onAiExec: (todo: Todo, tool: AiTool, session?: Todo['aiSessions'][number]) => void
  onDeleteAiSession: (todo: Todo, session: Todo['aiSessions'][number], currentSessionId?: string | null) => void
  onUpdateSessionLabel: (todo: Todo, session: Todo['aiSessions'][number], label: string) => void
  onDelete: (t: Todo) => void
  onOpenTrae: (todo: Todo, editor?: 'trae-cn' | 'trae' | 'cursor') => void
  onOpenTerminal: (todo: Todo) => void
  onOpenNativeResume: (todo: Todo, session: Todo['aiSessions'][number]) => void
  onCopyPrompt: (todo: Todo) => void
  onExport: (todo: Todo) => void
  style?: React.CSSProperties
  isNarrow: boolean
  onRequestFork: (todo: Todo, sessionId: string) => void
  onRefresh: () => void
  highlightTodoId?: string | null
}

export function QuadrantZone({ config, todos, childrenByParentId, childHitIdsByParentId, onCreateSubtodo, onCardClick, onToggleDone, onAiExec, onDeleteAiSession, onUpdateSessionLabel, onDelete, onOpenTrae, onOpenTerminal, onOpenNativeResume, onCopyPrompt, onExport, style, isNarrow, onRequestFork, onRefresh, highlightTodoId }: QuadrantZoneProps) {
  const { setNodeRef, isOver } = useDroppable({ id: `quadrant-${config.q}` })

  const header = (
    <div className="todo-quadrant-header">
      <span className={`priority-tag priority-tag-${config.priority}`}>{config.priority}</span>
      <span className="quadrant-title">{config.label}</span>
      <span className={`count-badge ${config.bgBadge}`}>{todos.length}</span>
    </div>
  )

  const content = (
    <SortableContext items={todos.map(t => todoDndId(t))} strategy={verticalListSortingStrategy}>
      <div ref={setNodeRef} className="todo-quadrant-list" style={{ minHeight: 60 }}>
        {todos.map((t) => (
          <SortableTodoCard
            key={t.id}
            todo={t}
            children={childrenByParentId[t.id] || []}
            childHitIds={childHitIdsByParentId[t.id]}
            onCreateSubtodo={onCreateSubtodo}
            onClick={onCardClick}
            onToggleDone={onToggleDone}
            onAiExec={onAiExec}
            onRequestFork={onRequestFork}
            onDeleteAiSession={onDeleteAiSession}
            onUpdateSessionLabel={onUpdateSessionLabel}
            onDelete={onDelete}
            onOpenTrae={onOpenTrae}
            onOpenTerminal={onOpenTerminal}
            onOpenNativeResume={onOpenNativeResume}
            onCopyPrompt={onCopyPrompt}
            onExport={onExport}
            isNarrow={isNarrow}
            onRefresh={onRefresh}
            highlightTodoId={highlightTodoId}
          />
        ))}
        {todos.length === 0 && (
          <div className="todo-drop-placeholder">拖拽任务到此处</div>
        )}
      </div>
    </SortableContext>
  )

  return (
    <div className={`todo-quadrant ${isOver ? 'drag-over' : ''}`} style={style}>
      {header}
      {content}
    </div>
  )
}
