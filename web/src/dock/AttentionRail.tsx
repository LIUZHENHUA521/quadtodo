import React from 'react'
import { Tooltip } from 'antd'
import type { UnreadSessionItem } from '../replyHub'
import { useIsMobile } from '../hooks/useIsMobile'

interface Props {
  items: UnreadSessionItem[]
  onActivate: (item: UnreadSessionItem) => void
}

export default function AttentionRail({ items, onActivate }: Props) {
  const isMobile = useIsMobile()
  if (isMobile) return null
  if (items.length === 0) {
    return <div className="attention-rail attention-rail--empty" />
  }

  return (
    <div className="attention-rail is-alerting">
      <div className="attention-rail__items">
        {items.slice(0, 12).map(item => {
          const initial = (item.todoTitle || '?').charAt(0)
          return (
            <Tooltip key={item.id} title={item.todoTitle} placement="right">
              <button
                type="button"
                className="attention-rail__item kind-unread"
                onClick={() => onActivate(item)}
              >
                {initial}
              </button>
            </Tooltip>
          )
        })}
        {items.length > 12 && (
          <Tooltip title={`还有 ${items.length - 12} 条未读`} placement="right">
            <span className="attention-rail__more">+{items.length - 12}</span>
          </Tooltip>
        )}
      </div>
    </div>
  )
}
