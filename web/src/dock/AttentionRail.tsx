import React from 'react'
import { Tooltip } from 'antd'
import type { AttentionItem, AttentionCounts } from '../replyHub'
import { useIsMobile } from '../hooks/useIsMobile'

interface Props {
  items: AttentionItem[]
  counts: AttentionCounts
  onActivate: (item: AttentionItem) => void
  onOpenDashboard: () => void
}

export default function AttentionRail({ items, counts, onActivate, onOpenDashboard }: Props) {
  const isMobile = useIsMobile()
  if (isMobile) return null
  // 收起态：没有待确认会话时，rail 退化成 8px 细线
  if (counts.interaction === 0) {
    return <div className="attention-rail attention-rail--empty" />
  }

  const interactionItems = items.filter(item => item.kind === 'interaction')
  const displayCount = counts.interaction > 99 ? '99+' : counts.interaction
  const tooltipTitle = `待确认：${counts.interaction}`

  return (
    <div className="attention-rail is-alerting">
      <button
        type="button"
        className="attention-rail__count"
        onClick={onOpenDashboard}
        title={tooltipTitle}
      >
        {displayCount}
      </button>
      <div className="attention-rail__items">
        {interactionItems.slice(0, 12).map(item => {
          const initial = (item.todoTitle || '?').charAt(0)
          return (
            <Tooltip key={item.id} title={item.todoTitle} placement="right">
              <button
                type="button"
                className={`attention-rail__item kind-${item.kind}`}
                onClick={() => onActivate(item)}
              >
                {initial}
              </button>
            </Tooltip>
          )
        })}
        {interactionItems.length > 12 && (
          <Tooltip title="更多待确认" placement="right">
            <button
              type="button"
              className="attention-rail__more"
              onClick={onOpenDashboard}
            >
              +{interactionItems.length - 12}
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  )
}
