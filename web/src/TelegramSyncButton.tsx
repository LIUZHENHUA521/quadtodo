/**
 * 同步对账按钮：覆盖 telegram + lark 两条 channel。
 * 先 dry-run 预览要做的动作，让用户确认后再真做。
 *   - open_topic / open_thread: PTY 活但没绑 topic/thread → 建
 *   - close_topic / close_thread: PTY 死但还绑着 → 关 + mark done
 *   - clear_route: 孤儿路由 → 清
 */
import { useEffect, useState } from 'react'
import { Button, Modal, Tag, Tooltip } from 'antd'
import { SyncOutlined } from '@ant-design/icons'
import { syncChannels, SyncResponse, SyncActionType } from './api'
import { useAppMessages } from './design/useAppMessages'
import { useDispatchStore } from './store/dispatchStore'

const TYPE_LABEL: Record<SyncActionType, string> = {
  open_topic: '建 TG 话题',
  close_topic: '关 TG 话题 + 完成',
  open_thread: '建 Lark 线程',
  close_thread: '关 Lark 线程 + 完成',
  clear_route: '清孤儿路由',
}
const TYPE_COLOR: Record<SyncActionType, string> = {
  open_topic: 'green',
  close_topic: 'red',
  open_thread: 'cyan',
  close_thread: 'magenta',
  clear_route: 'orange',
}

export default function TelegramSyncButton() {
  const { message } = useAppMessages()
  const [loading, setLoading] = useState(false)
  const [plan, setPlan] = useState<SyncResponse | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [executing, setExecuting] = useState(false)

  // M4-T4: react to CommandPalette "Telegram sync" command via dispatchStore signal.
  const telegramSyncSignal = useDispatchStore((s) => s.signals.telegramSync === true)
  const consumeSignal = useDispatchStore((s) => s.consumeSignal)
  useEffect(() => {
    if (!telegramSyncSignal) return
    void preview()
    consumeSignal('telegramSync')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [telegramSyncSignal, consumeSignal])

  async function preview() {
    setLoading(true)
    try {
      const res = await syncChannels(true)
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
      const res = await syncChannels(false)
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
      <Tooltip title="对账 Telegram topic / Lark thread 与待办状态，预览后确认">
        <Button
          icon={<SyncOutlined spin={loading} />}
          size="small"
          loading={loading}
          onClick={preview}
        >
          同步对账
        </Button>
      </Tooltip>
      <Modal
        title="同步对账预览"
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
            <div style={{ marginBottom: 12, fontSize: 12, color: 'var(--text-secondary)' }}>
              TG 建 <b>{plan.summary.open_topic}</b> · 关 <b>{plan.summary.close_topic}</b>
              {' ｜ '}
              Lark 建 <b>{plan.summary.open_thread}</b> · 关 <b>{plan.summary.close_thread}</b>
              {' ｜ '}
              清孤儿 <b>{plan.summary.clear_route}</b>
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
                      {a.todoTitle || a.sessionId || a.rootMessageId || `thread ${a.threadId}`}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{a.reason}</div>
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
