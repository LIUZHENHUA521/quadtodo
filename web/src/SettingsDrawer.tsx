import { Drawer, Descriptions, Alert, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { getStatus } from './api'

const { Paragraph, Text } = Typography

interface Props {
  open: boolean
  onClose: () => void
}

export default function SettingsDrawer({ open, onClose }: Props) {
  const [status, setStatus] = useState<{ version: string; activeSessions: number } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    getStatus()
      .then((s) => { setStatus(s); setErr(null) })
      .catch((e) => setErr(e.message))
  }, [open])

  return (
    <Drawer title="quadtodo 设置" open={open} onClose={onClose} width={520}>
      {err && <Alert type="error" message={err} style={{ marginBottom: 16 }} />}
      <Descriptions column={1} bordered size="small">
        <Descriptions.Item label="版本">{status?.version ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="活跃 AI 会话数">{status?.activeSessions ?? '-'}</Descriptions.Item>
      </Descriptions>

      <Paragraph style={{ marginTop: 24 }}>
        <Text strong>修改配置</Text>
      </Paragraph>
      <Paragraph>
        MVP 版本不支持在 UI 里改配置。请在终端使用 <Text code>quadtodo config set</Text> 后重启服务：
      </Paragraph>
      <Paragraph>
        <pre style={{ background: '#f5f5f5', padding: 12, borderRadius: 4 }}>
{`# 改端口
quadtodo config set port 6000

# 改 Claude 二进制路径
quadtodo config set tools.claude.bin /usr/local/bin/claude

# 改 Codex 二进制路径
quadtodo config set tools.codex.bin /usr/local/bin/codex

# 查看当前配置
quadtodo config list`}
        </pre>
      </Paragraph>
      <Paragraph type="secondary">
        配置文件位置：<Text code>~/.quadtodo/config.json</Text>
      </Paragraph>
    </Drawer>
  )
}
