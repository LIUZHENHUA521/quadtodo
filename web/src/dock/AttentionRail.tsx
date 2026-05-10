import React from 'react'
import { Tooltip } from 'antd'
import type { AttentionItem, AttentionCounts } from '../replyHub'
import { useIsMobile } from '../hooks/useIsMobile'

interface Props {
  items: AttentionItem[]
  counts: AttentionCounts
  /** 未读会话总数：lastTurnDoneAt > 本地 lastSeenAt 的 session 数（按 sessionId 去重） */
  unreadCount: number
  hasNew: boolean
  onActivate: (item: AttentionItem) => void
  onOpenDashboard: () => void
}

export default function AttentionRail({ items, counts, unreadCount, hasNew, onActivate, onOpenDashboard }: Props) {
  const isMobile = useIsMobile()
  if (isMobile) return null
  // 收起态：未读为 0 且也没有任何待处理项时，rail 退化成 8px 细线
  if (unreadCount === 0 && counts.total === 0) {
    return <div className="attention-rail attention-rail--empty" />
  }

  return (
    <div className={`attention-rail ${hasNew || unreadCount > 0 ? 'is-alerting' : ''}`}>
      <button
        type="button"
        className="attention-rail__count"
        onClick={onOpenDashboard}
        title={`未读：${unreadCount}（待处理 ${counts.total}：${counts.interaction} 待交互 / ${counts.awaitingReply} 待回复 / ${counts.review} 待验收）`}
      >
        {unreadCount > 99 ? '99+' : unreadCount}
      </button>
      <div className="attention-rail__items">
        {items.slice(0, 12).map(item => {
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
        {items.length > 12 && (
          <Tooltip title="更多待处理" placement="right">
            <button
              type="button"
              className="attention-rail__more"
              onClick={onOpenDashboard}
            >
              +{items.length - 12}
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  )
}
