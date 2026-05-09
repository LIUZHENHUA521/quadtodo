import React, { useMemo, useState } from 'react'
import { Button, Empty, Tag, Tooltip } from 'antd'
import { CheckOutlined, ClearOutlined, RightOutlined } from '@ant-design/icons'
import type { AttentionItem, AttentionKind } from '../replyHub'
import { countAttentionItems } from '../replyHub'

const QUADRANT_LABEL: Record<number, string> = { 1: 'P0', 2: 'P1', 3: 'P2', 4: 'P3' }
const QUADRANT_COLOR: Record<number, string> = { 1: '#ef4444', 2: '#3b82f6', 3: '#f59e0b', 4: '#64748b' }

function formatAttentionTime(timestamp: number): string {
  if (!timestamp) return '刚刚'
  const diffMs = Math.max(0, Date.now() - timestamp)
  const min = Math.floor(diffMs / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  return `${Math.floor(hour / 24)} 天前`
}

function kindText(kind: AttentionKind): string {
  if (kind === 'interaction') return '待交互'
  if (kind === 'awaiting_reply') return '待回复'
  return '待验收'
}

function kindTagColor(kind: AttentionKind): string {
  if (kind === 'interaction') return 'warning'
  if (kind === 'awaiting_reply') return 'processing'
  return 'orange'
}

function toolText(tool: string): string {
  if (tool === 'claude') return 'Claude Code'
  if (tool === 'codex') return 'Codex'
  if (tool === 'cursor') return 'Cursor'
  return tool
}

export default function AttentionHub({
  items,
  onOpen,
  onMarkSeen,
  onClearReview,
}: {
  items: AttentionItem[]
  onOpen?: (item: AttentionItem) => void
  onMarkSeen?: (sessionId: string) => void
  onClearReview?: (sessionIds: string[]) => void
}) {
  const [filter, setFilter] = useState<'all' | AttentionKind>('all')
  const counts = useMemo(() => countAttentionItems(items), [items])
  const visibleItems = filter === 'all' ? items : items.filter(item => item.kind === filter)
  const reviewSessionIds = items.filter(item => item.kind === 'review').map(item => item.sessionId)

  const chips: { key: 'all' | AttentionKind; label: string; count: number }[] = [
    { key: 'all', label: '全部', count: counts.total },
    { key: 'interaction', label: '待交互', count: counts.interaction },
    { key: 'awaiting_reply', label: '待回复', count: counts.awaitingReply },
    { key: 'review', label: '待验收', count: counts.review },
  ]

  return (
    <section className="dash-attention-section">
      <div className="dash-section-head">
        <span className="dash-section-title">
          <span className="dot" style={{ background: '#f97316' }} />
          待处理 AI 会话
        </span>
        {reviewSessionIds.length > 0 && (
          <Button
            size="small"
            type="text"
            icon={<ClearOutlined />}
            onClick={() => onClearReview?.(reviewSessionIds)}
          >
            清空已完成
          </Button>
        )}
      </div>

      <div className="dash-attention-chips" role="tablist">
        {chips.map(chip => (
          <button
            key={chip.key}
            type="button"
            role="tab"
            aria-selected={filter === chip.key}
            className={`dash-attention-chip ${chip.key} ${filter === chip.key ? 'active' : ''}`}
            onClick={() => setFilter(chip.key)}
          >
            <span>{chip.label}</span>
            <em>{chip.count}</em>
          </button>
        ))}
      </div>

      {visibleItems.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无待处理 AI 会话" style={{ padding: '8px 0' }} />
      ) : (
        <div className="dash-attention-list">
          {visibleItems.map(item => {
            const qColor = QUADRANT_COLOR[item.quadrant] || QUADRANT_COLOR[4]
            return (
              <div
                key={item.id}
                className={`dash-attention-card ${item.kind}`}
                role="button"
                tabIndex={0}
                onClick={() => onOpen?.(item)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onOpen?.(item)
                  }
                }}
              >
                <span className="dash-attention-accent" style={{ background: qColor }} />
                <div className="dash-attention-main">
                  <div className="dash-attention-title-row">
                    <Tag color={kindTagColor(item.kind)} className="dash-attention-kind-tag">{kindText(item.kind)}</Tag>
                    <Tag className="dash-attention-quadrant-tag" style={{ color: qColor, borderColor: `${qColor}55`, background: `${qColor}12` }}>{QUADRANT_LABEL[item.quadrant]}</Tag>
                    <span className="dash-attention-title" title={item.todoTitle}>{item.todoTitle}</span>
                  </div>
                  <div className="dash-attention-meta">
                    <span>{toolText(item.tool)}</span>
                    {item.label && <span> · {item.label}</span>}
                    <span> · {formatAttentionTime(item.timestamp)}</span>
                  </div>
                </div>
                <div className="dash-attention-trailing" onClick={(e) => e.stopPropagation()}>
                  {item.kind === 'review' && (
                    <Tooltip title="标记已看（不改 todo 状态）">
                      <Button
                        size="small"
                        type="text"
                        icon={<CheckOutlined />}
                        onClick={() => onMarkSeen?.(item.sessionId)}
                      />
                    </Tooltip>
                  )}
                  <RightOutlined className="dash-attention-chevron" />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
