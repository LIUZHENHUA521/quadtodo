import { useEffect, useState, useRef } from 'react'
import { Modal, Table, Tag, message, Empty, Typography } from 'antd'
import { startProbeChatId, stopProbeChatId, subscribeProbeChatId, type ProbeHit } from './api'

const { Text } = Typography

interface Props {
  open: boolean
  onClose: () => void
  onPick: (hit: ProbeHit) => void
}

export function TelegramProbeModal({ open, onClose, onPick }: Props) {
  const [hits, setHits] = useState<ProbeHit[]>([])
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const closerRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setHits([])
    setError(null)
    setExpiresAt(null)
    ;(async () => {
      const r = await startProbeChatId(60)
      if (cancelled) return
      if (!r.ok) {
        setError(r.reason || 'unknown')
        return
      }
      setExpiresAt(r.expiresAt || null)
      const close = subscribeProbeChatId({
        onHit: (hit) => setHits((prev) => [...prev, hit]),
        onDone: () => setExpiresAt(null),
        onError: () => { /* SSE 重连由浏览器处理 */ },
      })
      closerRef.current = close
    })()
    return () => {
      cancelled = true
      closerRef.current?.()
      stopProbeChatId().catch(() => { })
    }
  }, [open])

  useEffect(() => {
    if (!expiresAt) {
      setSecondsLeft(0)
      return
    }
    const t = setInterval(() => {
      const left = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
      setSecondsLeft(left)
      if (left <= 0) clearInterval(t)
    }, 500)
    return () => clearInterval(t)
  }, [expiresAt])

  const dedupedHits = Array.from(new Map(hits.map((h) => [h.chatId, h])).values())

  return (
    <Modal
      title="抓 supergroup ID"
      open={open}
      onCancel={onClose}
      footer={null}
      width={680}
    >
      <div style={{ marginBottom: 12 }}>
        <Text type="secondary">
          请到目标 Telegram 群里发条任意消息（@bot 或随便发都行）。
          收到的所有 chat 都会列在下面，点选你要的那一行 → 自动填回 supergroupId。
        </Text>
      </div>

      {error ? (
        <div style={{ color: '#cf1322' }}>启动失败：{error}</div>
      ) : (
        <>
          <div style={{ marginBottom: 8 }}>
            {expiresAt ? (
              <Tag color="processing">监听中… 还有 {secondsLeft}s</Tag>
            ) : (
              <Tag color="default">已结束</Tag>
            )}
            <Text type="secondary" style={{ marginLeft: 8 }}>已收到 {dedupedHits.length} 个 chat</Text>
          </div>

          <Table<ProbeHit>
            size="small"
            rowKey="chatId"
            dataSource={dedupedHits}
            pagination={false}
            scroll={{ y: 320 }}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没收到消息，到群里 @bot 发一条试试" /> }}
            columns={[
              { title: 'chatId', dataIndex: 'chatId', width: 160 },
              { title: '类型', dataIndex: 'chatType', width: 90 },
              { title: '群名/用户', dataIndex: 'chatTitle', width: 140, render: (v: string | null) => v || '—' },
              { title: '发送人', dataIndex: 'fromUsername', width: 120, render: (v: string | null, row: ProbeHit) => v ? `@${v}` : (row.fromUserId || '—') },
              { title: '消息预览', dataIndex: 'textPreview', render: (v: string | null) => v || '—' },
            ]}
            onRow={(record) => ({
              onClick: () => {
                onPick(record)
                message.success(`已选择 ${record.chatId}`)
                onClose()
              },
              style: { cursor: 'pointer' },
            })}
          />
        </>
      )}
    </Modal>
  )
}
