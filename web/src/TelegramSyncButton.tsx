/**
 * Telegram 同步按钮：先 dry-run 预览要做的动作，让用户确认后再真做。
 *   - open_topic: todo 活但没绑 topic → 建
 *   - close_topic: todo 死了/没 PTY 但 topic 还在 → 关 topic + mark done
 *   - clear_route: 孤儿路由 → 清
 */
import { useState } from 'react'
import { Button, Modal, Tag, message, Tooltip } from 'antd'
import { SyncOutlined } from '@ant-design/icons'
import { telegramSync, TelegramSyncResponse, TelegramSyncAction } from './api'

const TYPE_LABEL: Record<TelegramSyncAction['type'], string> = {
  open_topic: '建话题',
  close_topic: '关话题 + 完成',
  clear_route: '清孤儿路由',
}
const TYPE_COLOR: Record<TelegramSyncAction['type'], string> = {
  open_topic: 'green',
  close_topic: 'red',
  clear_route: 'orange',
}

export default function TelegramSyncButton() {
  const [loading, setLoading] = useState(false)
  const [plan, setPlan] = useState<TelegramSyncResponse | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [executing, setExecuting] = useState(false)

  async function preview() {
    setLoading(true)
    try {
      const res = await telegramSync(true)
      setPlan(res)
      if (res.summary.total === 0) {
        message.success('一切已同步，无需动作')
      } else {
        setConfirmOpen(true)
      }
    } catch (e) {
      message.error(`预览失败: ${(e as Error).message}`)
    } finally {
      setLoading(false)
    }
  }

  async function execute() {
    setExecuting(true)
    try {
      const res = await telegramSync(false)
      const ok = res.summary.succeeded || 0
      const fail = res.summary.failed || 0
      if (fail > 0) {
        message.warning(`同步完成：成功 ${ok}，失败 ${fail}`)
      } else {
        message.success(`同步完成：${ok} 个动作全部成功`)
      }
      setPlan(res)
      setConfirmOpen(false)
    } catch (e) {
      message.error(`同步执行失败: ${(e as Error).message}`)
    } finally {
      setExecuting(false)
    }
  }

  return (
    <>
      <Tooltip title="对账 Telegram topic 与待办状态，预览后确认">
        <Button
          icon={<SyncOutlined spin={loading} />}
          size="small"
          loading={loading}
          onClick={preview}
        >
          TG 同步
        </Button>
      </Tooltip>
      <Modal
        title="Telegram 同步预览"
        open={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        onOk={execute}
        okText={`确认执行（${plan?.summary.total ?? 0} 项）`}
        cancelText="取消"
        confirmLoading={executing}
        width={680}
      >
        {plan && (
          <>
            <div style={{ marginBottom: 12, fontSize: 12, color: '#666' }}>
              建 <b>{plan.summary.open_topic}</b> ｜ 关 <b>{plan.summary.close_topic}</b> ｜ 清 <b>{plan.summary.clear_route}</b>
            </div>
            <div style={{ maxHeight: 360, overflowY: 'auto' }}>
              {plan.actions.map((a, i) => (
                <div
                  key={i}
                  style={{
                    padding: '6px 8px',
                    borderBottom: '1px solid #f0f0f0',
                    fontSize: 13,
                    display: 'flex',
                    gap: 8,
                    alignItems: 'baseline',
                  }}
                >
                  <Tag color={TYPE_COLOR[a.type]}>{TYPE_LABEL[a.type]}</Tag>
                  <div style={{ flex: 1, overflow: 'hidden' }}>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {a.todoTitle || a.sessionId || `thread ${a.threadId}`}
                    </div>
                    <div style={{ fontSize: 11, color: '#999' }}>{a.reason}</div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </Modal>
    </>
  )
}
