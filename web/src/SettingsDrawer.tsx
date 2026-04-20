import { Drawer, Descriptions, Alert, Typography, Form, Input, Button, Radio, Space, message, Tag, Switch } from 'antd'
import { useEffect, useState } from 'react'
import { getStatus, getConfig, updateConfig, AppConfig, pickDirectory, ToolDiagnostic } from './api'

const { Paragraph, Text } = Typography

interface Props {
  open: boolean
  onClose: () => void
}

function splitCommandLine(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaping = false

  for (const ch of String(input || '')) {
    if (escaping) {
      current += ch
      escaping = false
      continue
    }
    if (ch === '\\') {
      escaping = true
      continue
    }
    if (quote) {
      if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }

  if (escaping) current += '\\'
  if (current) tokens.push(current)
  return tokens
}

function joinCommandLine(command: string, args: string[] = []): string {
  const parts = [command, ...args].filter(Boolean)
  return parts
    .map((part) => (/[\s"]/u.test(part) ? `"${part.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : part))
    .join(' ')
}

export default function SettingsDrawer({ open, onClose }: Props) {
  const [status, setStatus] = useState<{ version: string; activeSessions: number } | null>(null)
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [toolDiagnostics, setToolDiagnostics] = useState<Record<'claude' | 'codex', ToolDiagnostic> | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [pickingDefaultCwd, setPickingDefaultCwd] = useState(false)
  const [linkEditor, setLinkEditor] = useState<'trae-cn' | 'trae' | 'cursor'>(() => {
    try {
      const v = localStorage.getItem('quadtodo.editor')
      return v === 'trae' || v === 'cursor' ? v : 'trae-cn'
    } catch { return 'trae-cn' }
  })
  const [form] = Form.useForm()

  const buildToolPatch = (tool: 'claude' | 'codex', nextCommandValue: string, nextBinValue: string) => {
    const meta = toolDiagnostics?.[tool]
    const parsedCommand = splitCommandLine(nextCommandValue.trim())
    const baseCommand = parsedCommand[0] || ''
    const nextArgs = parsedCommand.length > 1
      ? parsedCommand.slice(1)
      : (config?.tools[tool].args || [])
    const trimmedBin = nextBinValue.trim()
    if (!meta) {
      return {
        command: baseCommand || config?.tools[tool].command || tool,
        bin: trimmedBin,
        args: nextArgs,
      }
    }
    const nextCommand = baseCommand || tool
    const nextBin = trimmedBin === meta.bin && meta.source !== 'config'
      ? (meta.configuredBin || '')
      : trimmedBin
    return {
      command: nextCommand,
      bin: nextBin,
      args: nextArgs,
    }
  }

  useEffect(() => {
    if (!open) return
    Promise.all([getStatus(), getConfig()])
      .then(([s, result]) => {
        setStatus(s)
        setConfig(result.config)
        setToolDiagnostics(result.toolDiagnostics)
        form.setFieldsValue({
          port: result.config.port,
          defaultTool: result.config.defaultTool,
          defaultCwd: result.config.defaultCwd,
          claudeCommand: joinCommandLine(result.config.tools.claude.command, result.config.tools.claude.args),
          claudeBin: result.config.tools.claude.bin,
          codexCommand: joinCommandLine(result.config.tools.codex.command, result.config.tools.codex.args),
          codexBin: result.config.tools.codex.bin,
          webhookEnabled: result.config.webhook.enabled,
          webhookProvider: result.config.webhook.provider,
          webhookUrl: result.config.webhook.url,
          webhookKeywords: result.config.webhook.keywords.join('\n'),
          webhookCooldownMs: result.config.webhook.cooldownMs,
          notifyOnPendingConfirm: result.config.webhook.notifyOnPendingConfirm,
          notifyOnKeywordMatch: result.config.webhook.notifyOnKeywordMatch,
        })
        setErr(null)
      })
      .catch((e) => setErr(e.message))
  }, [open, form])

  const handleSave = async () => {
    try {
      const values = await form.validateFields()
      setSaving(true)
      const result = await updateConfig({
        port: Number(values.port),
        defaultTool: values.defaultTool,
        defaultCwd: values.defaultCwd,
        tools: {
          claude: buildToolPatch('claude', values.claudeCommand || '', values.claudeBin || ''),
          codex: buildToolPatch('codex', values.codexCommand || '', values.codexBin || ''),
        },
        webhook: {
          enabled: Boolean(values.webhookEnabled),
          provider: values.webhookProvider || 'wecom',
          url: values.webhookUrl || '',
          keywords: String(values.webhookKeywords || '')
            .split('\n')
            .map((item: string) => item.trim())
            .filter(Boolean),
          cooldownMs: Number(values.webhookCooldownMs) || 180000,
          notifyOnPendingConfirm: values.notifyOnPendingConfirm !== false,
          notifyOnKeywordMatch: values.notifyOnKeywordMatch !== false,
        },
      })
      setConfig(result.config)
      setToolDiagnostics(result.toolDiagnostics)
      form.setFieldsValue({
        claudeCommand: joinCommandLine(result.config.tools.claude.command, result.config.tools.claude.args),
        claudeBin: result.config.tools.claude.bin,
        codexCommand: joinCommandLine(result.config.tools.codex.command, result.config.tools.codex.args),
        codexBin: result.config.tools.codex.bin,
      })
      message.success('设置已保存。默认目录和工具对新会话立即生效，端口需重启后生效。')
    } catch (e: any) {
      if (e?.errorFields) return
      message.error(e?.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handlePickDefaultCwd = async () => {
    try {
      setPickingDefaultCwd(true)
      const result = await pickDirectory({
        defaultPath: form.getFieldValue('defaultCwd') || config?.defaultCwd,
        prompt: '选择默认启动目录',
      })
      if (result.cancelled || !result.path) return
      form.setFieldValue('defaultCwd', result.path)
    } catch (e: any) {
      message.error(e?.message || '选择目录失败')
    } finally {
      setPickingDefaultCwd(false)
    }
  }

  const handleRedetectTool = async (tool: 'claude' | 'codex') => {
    if (!config) return
    try {
      const result = await updateConfig({
        tools: {
          claude: tool === 'claude'
            ? { command: config.tools.claude.command || 'claude', bin: '', args: config.tools.claude.args || [] }
            : buildToolPatch(
              'claude',
              form.getFieldValue('claudeCommand') || config.tools.claude.command || 'claude',
              form.getFieldValue('claudeBin') || config.tools.claude.bin || '',
            ),
          [tool]: {
            command: config.tools[tool].command || tool,
            bin: '',
            args: config.tools[tool].args || [],
          },
          codex: tool === 'codex'
            ? { command: config.tools.codex.command || 'codex', bin: '', args: config.tools.codex.args || [] }
            : buildToolPatch(
              'codex',
              form.getFieldValue('codexCommand') || config.tools.codex.command || 'codex',
              form.getFieldValue('codexBin') || config.tools.codex.bin || '',
            ),
        },
      })
      setConfig(result.config)
      setToolDiagnostics(result.toolDiagnostics)
      form.setFieldValue(
        tool === 'claude' ? 'claudeCommand' : 'codexCommand',
        joinCommandLine(result.config.tools[tool].command, result.config.tools[tool].args),
      )
      form.setFieldValue(tool === 'claude' ? 'claudeBin' : 'codexBin', result.config.tools[tool].bin)
      message.success(`${tool} 已重新检测`)
    } catch (e: any) {
      message.error(e?.message || '重新检测失败')
    }
  }

  const renderToolMeta = (tool: 'claude' | 'codex') => {
    const meta = toolDiagnostics?.[tool]
    if (!meta) return null
    const sourceText = meta.source === 'env'
      ? '环境变量覆盖'
      : meta.source === 'config'
        ? '手动配置'
        : meta.source === 'auto-detected'
          ? '自动检测'
          : '未检测到'
    const sourceColor = meta.source === 'missing'
      ? 'error'
      : meta.source === 'auto-detected'
        ? 'processing'
        : meta.source === 'env'
          ? 'gold'
          : 'default'

    return (
      <div style={{ marginTop: 8 }}>
        <Space size={[8, 8]} wrap>
          <Tag color={sourceColor}>{sourceText}</Tag>
          <Button size="small" onClick={() => handleRedetectTool(tool)}>重新检测</Button>
        </Space>
        {!meta.missing && (
          <div style={{ marginTop: 6, fontSize: 12, color: '#6b6257' }}>
            当前启动命令：<Text code>{meta.command}</Text>
          </div>
        )}
        {!meta.missing && (
          <div style={{ marginTop: 6, fontSize: 12, color: '#6b6257' }}>
            当前有效路径：<Text code>{meta.bin}</Text>
          </div>
        )}
        {meta.missing && meta.installHint && (
          <Alert
            style={{ marginTop: 8 }}
            type="warning"
            showIcon
            message={`未检测到 ${tool}，可先安装：`}
            description={<Text code>{meta.installHint}</Text>}
          />
        )}
      </div>
    )
  }

  return (
    <Drawer
      title="quadtodo 设置"
      open={open}
      onClose={onClose}
      width={560}
      extra={
        <Space>
          <Button onClick={onClose}>关闭</Button>
          <Button type="primary" loading={saving} onClick={handleSave}>保存</Button>
        </Space>
      }
    >
      {err && <Alert type="error" message={err} style={{ marginBottom: 16 }} />}
      <Descriptions column={1} bordered size="small">
        <Descriptions.Item label="版本">{status?.version ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="活跃 AI 会话数">{status?.activeSessions ?? '-'}</Descriptions.Item>
      </Descriptions>

      <Paragraph style={{ marginTop: 24 }}>
        <Text strong>运行设置</Text>
      </Paragraph>
      <Form form={form} layout="vertical">
        <Form.Item
          label="默认启动目录"
          extra="新开的 AI 会话会默认在这个目录里启动。保存后立即对新会话生效。"
        >
          <Space.Compact block>
            <Form.Item name="defaultCwd" noStyle rules={[{ required: true, message: '请输入默认启动目录' }]}>
              <Input allowClear placeholder="/Users/liuzhenhua/Desktop/code/crazyCombo" />
            </Form.Item>
            <Button loading={pickingDefaultCwd} onClick={handlePickDefaultCwd}>选择目录</Button>
          </Space.Compact>
        </Form.Item>

        <Form.Item
          name="defaultTool"
          label="默认工具"
          rules={[{ required: true, message: '请选择默认工具' }]}
        >
          <Radio.Group>
            <Radio.Button value="claude">Claude</Radio.Button>
            <Radio.Button value="codex">Codex</Radio.Button>
          </Radio.Group>
        </Form.Item>

        <Form.Item
          name="claudeCommand"
          label="Claude 启动命令"
          extra="默认是 claude，如果公司内封装成 claude-w，可以在这里修改。"
        >
          <Input placeholder="claude" />
        </Form.Item>

        <Form.Item
          name="claudeBin"
          label="Claude 二进制路径"
        >
          <Input placeholder="/Users/liuzhenhua/.nvm/versions/node/v20.19.5/bin/claude" />
        </Form.Item>
        {renderToolMeta('claude')}

        <Form.Item
          name="codexCommand"
          label="Codex 启动命令"
          extra="默认是 codex，如果公司内封装成 codex-w，可以在这里修改。"
        >
          <Input placeholder="codex" />
        </Form.Item>

        <Form.Item
          name="codexBin"
          label="Codex 二进制路径"
        >
          <Input placeholder="/Users/liuzhenhua/.nvm/versions/node/v20.19.5/bin/codex" />
        </Form.Item>
        {renderToolMeta('codex')}

        <Form.Item
          label="终端链接打开编辑器"
          extra="终端中的文件路径点击时会使用该编辑器打开；也是卡片「代码」按钮的默认项。"
        >
          <Radio.Group
            value={linkEditor}
            onChange={(e) => {
              const v = e.target.value as 'trae-cn' | 'trae' | 'cursor'
              setLinkEditor(v)
              try { localStorage.setItem('quadtodo.editor', v) } catch {}
            }}
          >
            <Radio.Button value="trae-cn">Trae CN</Radio.Button>
            <Radio.Button value="trae">Trae</Radio.Button>
            <Radio.Button value="cursor">Cursor</Radio.Button>
          </Radio.Group>
        </Form.Item>

        <Form.Item
          name="port"
          label="服务端口"
          rules={[{ required: true, message: '请输入服务端口' }]}
          extra="端口会保存到配置文件，重启 quadtodo 后生效。"
        >
          <Input type="number" min={1} max={65535} />
        </Form.Item>

        <Paragraph style={{ marginTop: 24, marginBottom: 12 }}>
          <Text strong>Webhook 通知</Text>
        </Paragraph>

        <Form.Item name="webhookEnabled" label="启用机器人通知" valuePropName="checked">
          <Switch />
        </Form.Item>

        <Form.Item name="webhookProvider" label="机器人类型">
          <Radio.Group>
            <Radio.Button value="wecom">企业微信</Radio.Button>
            <Radio.Button value="feishu">飞书</Radio.Button>
          </Radio.Group>
        </Form.Item>

        <Form.Item
          name="webhookUrl"
          label="Webhook 地址"
          extra="当 AI 进入待人工确认环节时，会向这里发送提醒。"
        >
          <Input placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..." />
        </Form.Item>

        <Form.Item name="notifyOnPendingConfirm" label="pending_confirm 时通知" valuePropName="checked">
          <Switch />
        </Form.Item>

        <Form.Item name="notifyOnKeywordMatch" label="关键词命中时兜底通知" valuePropName="checked">
          <Switch />
        </Form.Item>

        <Form.Item
          name="webhookKeywords"
          label="补充关键词"
          extra="每行一个关键词或正则。内置关键词会始终生效，这里是追加兜底。"
        >
          <Input.TextArea rows={4} placeholder={'Do you want to proceed\n是否继续\n按回车确认'} />
        </Form.Item>

        <Form.Item
          name="webhookCooldownMs"
          label="通知节流毫秒数"
          extra="同一会话在这个时间窗口内不会重复推送相同原因。"
        >
          <Input type="number" min={1000} step={1000} />
        </Form.Item>
      </Form>

      <Paragraph type="secondary">
        配置文件位置：<Text code>~/.quadtodo/config.json</Text>
      </Paragraph>
    </Drawer>
  )
}
