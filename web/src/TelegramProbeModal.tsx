import { useEffect, useState, useRef } from 'react'
import { Modal, Table, Tag, Empty, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import { useAppMessages } from './design/useAppMessages'
import { startProbeChatId, stopProbeChatId, subscribeProbeChatId, type ProbeHit } from './api'

const { Text } = Typography

interface Props {
  open: boolean
  onClose: () => void
  onPick: (hit: ProbeHit) => void
}

export function TelegramProbeModal({ open, onClose, onPick }: Props) {
  const { t } = useTranslation(['settings'])
  const { message } = useAppMessages()
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
      title={t('settings:telegramProbe.title')}
      open={open}
      onCancel={onClose}
      footer={null}
      width={680}
    >
      <div style={{ marginBottom: 12 }}>
        <Text type="secondary">{t('settings:telegramProbe.hint')}</Text>
      </div>

      {error ? (
        <div style={{ color: 'var(--ai-error)' }}>{t('settings:telegramProbe.startFailed', { msg: error })}</div>
      ) : (
        <>
          <div style={{ marginBottom: 8 }}>
            {expiresAt ? (
              <Tag color="processing">{t('settings:telegramProbe.watchingLeft', { seconds: secondsLeft })}</Tag>
            ) : (
              <Tag color="default">{t('settings:telegramProbe.ended')}</Tag>
            )}
            <Text type="secondary" style={{ marginLeft: 8 }}>{t('settings:telegramProbe.receivedHits', { count: dedupedHits.length })}</Text>
          </div>

          <Table<ProbeHit>
            size="small"
            rowKey="chatId"
            dataSource={dedupedHits}
            pagination={false}
            scroll={{ y: 320 }}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('settings:telegramProbe.emptyText')} /> }}
            columns={[
              { title: 'chatId', dataIndex: 'chatId', width: 160 },
              { title: t('settings:telegramProbe.col.type'), dataIndex: 'chatType', width: 90 },
              { title: t('settings:telegramProbe.col.chatTitle'), dataIndex: 'chatTitle', width: 140, render: (v: string | null) => v || '—' },
              { title: t('settings:telegramProbe.col.from'), dataIndex: 'fromUsername', width: 120, render: (v: string | null, row: ProbeHit) => v ? `@${v}` : (row.fromUserId || '—') },
              { title: t('settings:telegramProbe.col.preview'), dataIndex: 'textPreview', render: (v: string | null) => v || '—' },
            ]}
            onRow={(record) => ({
              onClick: () => {
                onPick(record)
                message.success(t('settings:telegramProbe.picked', { chatId: record.chatId }))
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
