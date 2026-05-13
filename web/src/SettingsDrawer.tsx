import { Drawer, Descriptions, Alert, Typography, Form, Input, InputNumber, Button, Radio, Space, Tag, Switch, Collapse, Tabs, Segmented } from 'antd'
import { useAppMessages } from './design/useAppMessages'
import { MinusCircleOutlined, PlusOutlined, BookOutlined } from '@ant-design/icons'
import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { markdownComponents } from './markdownComponents'
import { getStatus, getConfig, updateConfig, AppConfig, pickDirectory, ToolDiagnostic, testTelegram, testLark, type ProbeHit, type DispatchChannelConfig } from './api'
import { TelegramProbeModal } from './TelegramProbeModal'
import telegramSetupMd from '../../docs/TELEGRAM-setup.md?raw'
import larkSetupMd from '../../docs/LARK.md?raw'

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

function isMaskedToken(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('tg_***')
}

function telegramSourceLabel(source: 'agentquad' | 'missing' | 'input'): string {
  if (source === 'input') return '当前输入，保存后生效'
  if (source === 'agentquad') return 'AgentQuad'
  return 'missing'
}

function isMaskedLarkSecret(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('lark_***')
}

function larkSourceLabel(source: 'agentquad' | 'missing' | 'input'): string {
  if (source === 'input') return '当前输入，保存后生效'
  if (source === 'agentquad') return 'AgentQuad'
  return 'missing'
}

type ToolKey = 'claude' | 'codex' | 'cursor'
const TOOL_LABEL: Record<ToolKey, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
}

export default function SettingsDrawer({ open, onClose }: Props) {
  const { message } = useAppMessages()
  const [status, setStatus] = useState<{ version: string; activeSessions: number } | null>(null)
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [toolDiagnostics, setToolDiagnostics] = useState<Record<ToolKey, ToolDiagnostic> | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [pickingDefaultCwd, setPickingDefaultCwd] = useState(false)
  const [linkEditor, setLinkEditor] = useState<'trae-cn' | 'trae' | 'cursor'>(() => {
    try {
      // rebrand: localStorage key kept for backward compatibility
      const v = localStorage.getItem('quadtodo.editor')
      return v === 'trae' || v === 'cursor' ? v : 'trae-cn'
    } catch { return 'trae-cn' }
  })
  const [probeOpen, setProbeOpen] = useState(false)
  const [tokenSource, setTokenSource] = useState<'agentquad' | 'missing'>('missing')
  const [tokenMasked, setTokenMasked] = useState<string>('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [larkSecretSource, setLarkSecretSource] = useState<'agentquad' | 'missing'>('missing')
  const [larkTesting, setLarkTesting] = useState(false)
  const [larkTestResult, setLarkTestResult] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'run' | 'tools' | 'telegram' | 'lark' | 'pricing'>('run')
  const [viewingTool, setViewingTool] = useState<ToolKey>('claude')
  const [dispatchDraft, setDispatchDraft] = useState<{
    lark: DispatchChannelConfig
    telegram: DispatchChannelConfig
    web: DispatchChannelConfig
  }>({
    lark: { default: 'claude', perUser: {}, perChat: {} },
    telegram: { default: 'claude', perUser: {}, perChat: {} },
    web: { default: 'claude', perUser: {}, perChat: {} },
  })
  const [form] = Form.useForm()

  const buildToolPatch = (tool: ToolKey, nextCommandValue: string, nextBinValue: string) => {
    const meta = toolDiagnostics?.[tool]
    const parsedCommand = splitCommandLine(nextCommandValue.trim())
    const baseCommand = parsedCommand[0] || ''
    // 区分两种"args 看起来空"的语义：
    //   1) 用户把整个字段清空（baseCommand=''）→ 保留旧 args，否则一次空表单提交会
    //      把曾经设过的参数全部蒸发掉
    //   2) 用户敲了完整命令但不带参数（baseCommand='claude'）→ 用户明确想要 args=[]，
    //      旧 args 不能再回填，否则永远删不掉历史参数
    const nextArgs = baseCommand
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
          cursorCommand: joinCommandLine(result.config.tools.cursor.command, result.config.tools.cursor.args),
          cursorBin: result.config.tools.cursor.bin,
          telegramEnabled: result.config.telegram?.enabled ?? false,
          telegramBotToken: result.config.telegram?.botTokenMasked || '',
          telegramSupergroupId: result.config.telegram?.supergroupId || '',
          telegramAllowedChatIds: (result.config.telegram?.allowedChatIds || []).join('\n'),
          telegramAllowedFromUserIds: (result.config.telegram?.allowedFromUserIds || []).join('\n'),
          telegramUseTopics: result.config.telegram?.useTopics !== false,
          telegramCreateTopicOnTaskStart: result.config.telegram?.createTopicOnTaskStart !== false,
          telegramCloseTopicOnSessionEnd: result.config.telegram?.closeTopicOnSessionEnd !== false,
          telegramTopicNameTemplate: result.config.telegram?.topicNameTemplate || '#t{shortCode} {title}',
          telegramTopicNameDoneTemplate: result.config.telegram?.topicNameDoneTemplate || '✅ {originalName}',
          telegramAutoCreateTopic: result.config.telegram?.autoCreateTopic !== false,
          telegramNotificationCooldownMs:
            (result.config.telegram?.notificationCooldownMs as number | undefined) ?? 600000,
          telegramSuppressNotificationEvents: result.config.telegram?.suppressNotificationEvents !== false,
          telegramDefaultPermissionMode: result.config.telegram?.defaultPermissionMode || 'bypass',
          telegramLongPollTimeoutSec: result.config.telegram?.longPollTimeoutSec ?? 30,
          telegramPollRetryDelayMs: result.config.telegram?.pollRetryDelayMs ?? 5000,
          telegramMinRenameIntervalMs: result.config.telegram?.minRenameIntervalMs ?? 30000,
          larkEnabled: result.config.lark?.enabled ?? false,
          larkAppId: result.config.lark?.appId || '',
          larkAppSecret: result.config.lark?.appSecretMasked || '',
          larkChatId: result.config.lark?.chatId || '',
          larkRequireThreadGroup: result.config.lark?.requireThreadGroup !== false,
          larkEventSubscribeEnabled: result.config.lark?.eventSubscribeEnabled !== false,
          larkAutoCreateTopic: result.config.lark?.autoCreateTopic !== false,
          larkDefaultPermissionMode: result.config.lark?.defaultPermissionMode || 'bypass',
          larkNotificationCooldownMs: result.config.lark?.notificationCooldownMs ?? 600000,
          pricingCnyRate: result.config.pricing.cnyRate,
          pricingShowInPush: result.config.pricing.showInPush === true,
          pricingShowCnyInPush: result.config.pricing.showCnyInPush !== false,
          pricingDefault: { ...result.config.pricing.default },
          pricingModels: Object.entries(result.config.pricing.models).map(([pattern, rate]) => ({
            pattern,
            ...rate,
          })),
        })
        setTokenSource((result.config.telegram?.botTokenSource as 'agentquad' | 'missing' | undefined) || 'missing')
        setTokenMasked(result.config.telegram?.botTokenMasked || '')
        setLarkSecretSource((result.config.lark?.appSecretSource as 'agentquad' | 'missing' | undefined) || 'missing')
        setViewingTool((result.config.defaultTool as ToolKey) || 'claude')
        const d = result.config.dispatch || {}
        setDispatchDraft({
          lark: {
            default: (d.lark?.default === 'codex' ? 'codex' : 'claude'),
            perUser: { ...(d.lark?.perUser || {}) },
            perChat: { ...(d.lark?.perChat || {}) },
          },
          telegram: {
            default: (d.telegram?.default === 'codex' ? 'codex' : 'claude'),
            perUser: { ...(d.telegram?.perUser || {}) },
            perChat: { ...(d.telegram?.perChat || {}) },
          },
          web: {
            default: (d.web?.default === 'codex' ? 'codex' : 'claude'),
            perUser: { ...(d.web?.perUser || {}) },
            perChat: { ...(d.web?.perChat || {}) },
          },
        })
        setErr(null)
      })
      .catch((e) => setErr(e.message))
  }, [open, form])

  const handleSave = async () => {
    try {
      await form.validateFields()
      // Tabs unmount inactive panels, so validateFields() only returns values
      // for the active tab's fields. Reading the full store keeps Telegram
      // values intact when saving from the Lark tab (and vice versa).
      const values = form.getFieldsValue(true)
      setSaving(true)
      const result = await updateConfig({
        port: Number(values.port),
        defaultTool: values.defaultTool,
        defaultCwd: values.defaultCwd,
        tools: {
          claude: buildToolPatch('claude', values.claudeCommand || '', values.claudeBin || ''),
          codex: buildToolPatch('codex', values.codexCommand || '', values.codexBin || ''),
          cursor: buildToolPatch('cursor', values.cursorCommand || '', values.cursorBin || ''),
        },
        telegram: {
          enabled: Boolean(values.telegramEnabled),
          botToken: values.telegramBotToken || '',     // 后端 isMaskedToken 检测会跳过
          supergroupId: values.telegramSupergroupId || '',
          allowedChatIds: String(values.telegramAllowedChatIds || '').split('\n').map((s: string) => s.trim()).filter(Boolean),
          allowedFromUserIds: String(values.telegramAllowedFromUserIds || '').split('\n').map((s: string) => s.trim()).filter(Boolean),
          useTopics: values.telegramUseTopics !== false,
          createTopicOnTaskStart: values.telegramCreateTopicOnTaskStart !== false,
          closeTopicOnSessionEnd: values.telegramCloseTopicOnSessionEnd !== false,
          topicNameTemplate: values.telegramTopicNameTemplate || '#t{shortCode} {title}',
          topicNameDoneTemplate: values.telegramTopicNameDoneTemplate || '✅ {originalName}',
          autoCreateTopic: values.telegramAutoCreateTopic !== false,
          notificationCooldownMs: Number(values.telegramNotificationCooldownMs) || 0,
          suppressNotificationEvents: values.telegramSuppressNotificationEvents !== false,
          defaultPermissionMode: values.telegramDefaultPermissionMode || 'bypass',
          longPollTimeoutSec: Number(values.telegramLongPollTimeoutSec) || 30,
          pollRetryDelayMs: Number(values.telegramPollRetryDelayMs) || 5000,
          minRenameIntervalMs: Number(values.telegramMinRenameIntervalMs) || 30000,
        },
        lark: {
          enabled: Boolean(values.larkEnabled),
          appId: String(values.larkAppId || '').trim(),
          appSecret: values.larkAppSecret || '',
          chatId: String(values.larkChatId || '').trim(),
          requireThreadGroup: values.larkRequireThreadGroup !== false,
          eventSubscribeEnabled: values.larkEventSubscribeEnabled !== false,
          autoCreateTopic: values.larkAutoCreateTopic !== false,
          defaultPermissionMode: values.larkDefaultPermissionMode || 'bypass',
          notificationCooldownMs: Number(values.larkNotificationCooldownMs) || 0,
        },
        pricing: {
          cnyRate: Number(values.pricingCnyRate) || 7.2,
          showInPush: values.pricingShowInPush === true,
          showCnyInPush: values.pricingShowCnyInPush !== false,
          default: {
            input: Number(values.pricingDefault?.input) || 0,
            output: Number(values.pricingDefault?.output) || 0,
            cacheRead: Number(values.pricingDefault?.cacheRead) || 0,
            cacheWrite: Number(values.pricingDefault?.cacheWrite) || 0,
          },
          models: (values.pricingModels || []).reduce((acc: Record<string, any>, row: any) => {
            const pattern = String(row?.pattern || '').trim()
            if (!pattern) return acc
            acc[pattern] = {
              input: Number(row.input) || 0,
              output: Number(row.output) || 0,
              cacheRead: Number(row.cacheRead) || 0,
              cacheWrite: Number(row.cacheWrite) || 0,
            }
            return acc
          }, {}),
        },
        dispatch: {
          lark: {
            default: dispatchDraft.lark.default || 'claude',
            perUser: { ...(dispatchDraft.lark.perUser || {}) },
            perChat: { ...(dispatchDraft.lark.perChat || {}) },
          },
          telegram: {
            default: dispatchDraft.telegram.default || 'claude',
            perUser: { ...(dispatchDraft.telegram.perUser || {}) },
            perChat: { ...(dispatchDraft.telegram.perChat || {}) },
          },
          web: {
            default: dispatchDraft.web.default || 'claude',
            perUser: { ...(dispatchDraft.web.perUser || {}) },
            perChat: { ...(dispatchDraft.web.perChat || {}) },
          },
        },
      })
      setConfig(result.config)
      setToolDiagnostics(result.toolDiagnostics)
      setTokenSource((result.config.telegram?.botTokenSource as 'agentquad' | 'missing' | undefined) || 'missing')
      setTokenMasked(result.config.telegram?.botTokenMasked || '')
      setLarkSecretSource((result.config.lark?.appSecretSource as 'agentquad' | 'missing' | undefined) || 'missing')
      form.setFieldsValue({
        claudeCommand: joinCommandLine(result.config.tools.claude.command, result.config.tools.claude.args),
        claudeBin: result.config.tools.claude.bin,
        codexCommand: joinCommandLine(result.config.tools.codex.command, result.config.tools.codex.args),
        codexBin: result.config.tools.codex.bin,
        cursorCommand: joinCommandLine(result.config.tools.cursor.command, result.config.tools.cursor.args),
        cursorBin: result.config.tools.cursor.bin,
        // normalizeConfig 会把默认 models 合回来（即使 UI 里被删也会复活），
        // 用保存后的 config 重置 pricingModels 保证和服务端一致
        pricingCnyRate: result.config.pricing.cnyRate,
        pricingShowInPush: result.config.pricing.showInPush === true,
        pricingShowCnyInPush: result.config.pricing.showCnyInPush !== false,
        pricingDefault: { ...result.config.pricing.default },
        pricingModels: Object.entries(result.config.pricing.models).map(([pattern, rate]) => ({
          pattern,
          ...rate,
        })),
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

  const TOOLS: ToolKey[] = ['claude', 'codex', 'cursor']

  const handleRedetectTool = async (tool: ToolKey) => {
    if (!config) return
    try {
      const toolsPatch: any = {}
      for (const t of TOOLS) {
        if (t === tool) {
          // 让后端按 command 重新探测 bin（清空 bin 字段）
          toolsPatch[t] = {
            command: config.tools[t].command || t,
            bin: '',
            args: config.tools[t].args || [],
          }
        } else {
          const cmdField = `${t}Command`
          const binField = `${t}Bin`
          toolsPatch[t] = buildToolPatch(
            t,
            form.getFieldValue(cmdField) || config.tools[t].command || t,
            form.getFieldValue(binField) || config.tools[t].bin || '',
          )
        }
      }
      const result = await updateConfig({ tools: toolsPatch })
      setConfig(result.config)
      setToolDiagnostics(result.toolDiagnostics)
      form.setFieldValue(`${tool}Command`, joinCommandLine(result.config.tools[tool].command, result.config.tools[tool].args))
      form.setFieldValue(`${tool}Bin`, result.config.tools[tool].bin)
      message.success(`${tool} 已重新检测`)
    } catch (e: any) {
      message.error(e?.message || '重新检测失败')
    }
  }

  const renderToolMeta = (tool: ToolKey) => {
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
          <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
            当前启动命令：<Text code>{meta.command}</Text>
          </div>
        )}
        {!meta.missing && (
          <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
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

  const renderToolFields = (tool: ToolKey) => {
    const cmdField = `${tool}Command`
    const binField = `${tool}Bin`
    const placeholder: Record<ToolKey, { cmd: string; bin: string; extra: string }> = {
      claude: {
        cmd: 'claude',
        bin: '/Users/liuzhenhua/.nvm/versions/node/v20.19.5/bin/claude',
        extra: '默认是 claude，如果公司内封装成 claude-w，可以在这里修改。',
      },
      codex: {
        cmd: 'codex',
        bin: '/Users/liuzhenhua/.nvm/versions/node/v20.19.5/bin/codex',
        extra: '默认是 codex，如果公司内封装成 codex-w，可以在这里修改。',
      },
      cursor: {
        cmd: 'cursor-agent',
        bin: '/Users/liuzhenhua/.local/bin/cursor-agent',
        extra: '默认是 cursor-agent；新会话会先跑 `cursor-agent create-chat` 拿 chatId 再用 --resume 进入交互。',
      },
    }
    const p = placeholder[tool]
    return (
      <>
        <Form.Item name={cmdField} label="启动命令" extra={p.extra}>
          <Input placeholder={p.cmd} />
        </Form.Item>
        <Form.Item name={binField} label="二进制路径">
          <Input placeholder={p.bin} />
        </Form.Item>
        {renderToolMeta(tool)}
      </>
    )
  }

  const runTab = (
    <>
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
        label="终端链接打开编辑器"
        extra="终端中的文件路径点击时会使用该编辑器打开；也是卡片「代码」按钮的默认项。"
      >
        <Radio.Group
          value={linkEditor}
          onChange={(e) => {
            const v = e.target.value as 'trae-cn' | 'trae' | 'cursor'
            setLinkEditor(v)
            // rebrand: localStorage key kept for backward compatibility
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
        extra="端口会保存到配置文件，重启 AgentQuad 后生效。"
      >
        <Input type="number" min={1} max={65535} />
      </Form.Item>
    </>
  )

  // ── Dispatch sub-section: per-channel default tool + perUser/perChat overrides ──
  const renderPerKeyEditor = (
    channel: 'lark' | 'telegram' | 'web',
    field: 'perUser' | 'perChat',
    placeholder: string,
  ) => {
    const map = (dispatchDraft[channel]?.[field] as Record<string, ToolKey>) || {}
    const entries = Object.entries(map)
    return (
      <div style={{ marginTop: 8 }}>
        {entries.length === 0 && (
          <Text type="secondary" style={{ fontSize: 12 }}>（暂无 {field} 覆盖）</Text>
        )}
        {entries.map(([k, v]) => (
          <Space key={k} style={{ display: 'flex', marginBottom: 6 }}>
            <Input
              style={{ width: 200 }}
              value={k}
              disabled
              addonBefore={field === 'perUser' ? '用户 id' : '会话 id'}
            />
            <Radio.Group
              size="small"
              value={v}
              onChange={(e) => {
                const next = { ...(dispatchDraft[channel][field] || {}) }
                next[k] = e.target.value
                setDispatchDraft({
                  ...dispatchDraft,
                  [channel]: { ...dispatchDraft[channel], [field]: next },
                })
              }}
            >
              <Radio.Button value="claude">claude</Radio.Button>
              <Radio.Button value="codex">codex</Radio.Button>
              <Radio.Button value="cursor">cursor</Radio.Button>
            </Radio.Group>
            <Button
              type="text"
              danger
              icon={<MinusCircleOutlined />}
              onClick={() => {
                const next = { ...(dispatchDraft[channel][field] || {}) }
                delete next[k]
                setDispatchDraft({
                  ...dispatchDraft,
                  [channel]: { ...dispatchDraft[channel], [field]: next },
                })
              }}
            />
          </Space>
        ))}
        <Space.Compact style={{ marginTop: 4 }}>
          <Input
            placeholder={placeholder}
            style={{ width: 240 }}
            id={`dispatch-${channel}-${field}-new`}
            onPressEnter={(e) => {
              const input = e.currentTarget as HTMLInputElement
              const k = String(input.value || '').trim()
              if (!k) return
              const next = { ...(dispatchDraft[channel][field] || {}) }
              if (next[k]) return
              next[k] = 'codex'
              setDispatchDraft({
                ...dispatchDraft,
                [channel]: { ...dispatchDraft[channel], [field]: next },
              })
              input.value = ''
            }}
          />
          <Button
            icon={<PlusOutlined />}
            onClick={() => {
              const input = document.getElementById(`dispatch-${channel}-${field}-new`) as HTMLInputElement | null
              const k = String(input?.value || '').trim()
              if (!k) return
              const next = { ...(dispatchDraft[channel][field] || {}) }
              if (next[k]) return
              next[k] = 'codex'
              setDispatchDraft({
                ...dispatchDraft,
                [channel]: { ...dispatchDraft[channel], [field]: next },
              })
              if (input) input.value = ''
            }}
          >
            添加
          </Button>
        </Space.Compact>
      </div>
    )
  }

  const dispatchSection = (
    <Form.Item
      label="按渠道分发工具"
      extra="可针对 Lark / Telegram / Web 分别设默认工具，并对特定用户 / 会话覆盖。优先级：override > perUser > perChat > 渠道默认 > 全局 defaultTool。"
    >
      <Collapse
        ghost
        items={(['lark', 'telegram', 'web'] as const).map((channel) => ({
          key: channel,
          label: <span style={{ fontWeight: 500 }}>{channel}</span>,
          children: (
            <>
              <Form.Item label="渠道默认工具" style={{ marginBottom: 8 }}>
                <Radio.Group
                  value={dispatchDraft[channel]?.default || 'claude'}
                  onChange={(e) => {
                    setDispatchDraft({
                      ...dispatchDraft,
                      [channel]: {
                        ...dispatchDraft[channel],
                        default: e.target.value,
                      },
                    })
                  }}
                >
                  <Radio.Button value="claude">claude</Radio.Button>
                  <Radio.Button value="codex">codex</Radio.Button>
                  <Radio.Button value="cursor">cursor</Radio.Button>
                </Radio.Group>
              </Form.Item>
              {channel === 'lark' && (
                <Form.Item label="按用户覆盖（perUser，open_id → 工具）" style={{ marginBottom: 8 }}>
                  {renderPerKeyEditor('lark', 'perUser', '输入 open_id 后回车 / 添加')}
                </Form.Item>
              )}
              {channel === 'telegram' && (
                <Form.Item label="按会话覆盖（perChat，chat_id → 工具）" style={{ marginBottom: 8 }}>
                  {renderPerKeyEditor('telegram', 'perChat', '输入 chat_id 后回车 / 添加')}
                </Form.Item>
              )}
              {channel === 'web' && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Web 端可在创建会话时显式传 tool 字段覆盖；如未传则取 web 渠道默认。
                </Text>
              )}
            </>
          ),
        }))}
      />
    </Form.Item>
  )

  const toolsTab = (
    <>
      <Form.Item
        name="defaultTool"
        label="默认工具"
        extra="新开会话时默认启动的 AI 工具。"
        rules={[{ required: true, message: '请选择默认工具' }]}
      >
        <Radio.Group>
          <Radio.Button value="claude">Claude</Radio.Button>
          <Radio.Button value="codex">Codex</Radio.Button>
          <Radio.Button value="cursor">Cursor</Radio.Button>
        </Radio.Group>
      </Form.Item>

      {dispatchSection}

      <Form.Item label="查看工具配置">
        <Segmented
          value={viewingTool}
          onChange={(v) => setViewingTool(v as ToolKey)}
          options={TOOLS.map((t) => ({ label: TOOL_LABEL[t], value: t }))}
        />
      </Form.Item>

      {/* 同时挂载三组 Form.Item，未选中的隐藏。这样所有字段都被 Form 管理，切换不丢值。 */}
      <div style={{ display: viewingTool === 'claude' ? 'block' : 'none' }}>{renderToolFields('claude')}</div>
      <div style={{ display: viewingTool === 'codex' ? 'block' : 'none' }}>{renderToolFields('codex')}</div>
      <div style={{ display: viewingTool === 'cursor' ? 'block' : 'none' }}>{renderToolFields('cursor')}</div>
    </>
  )

  const setupGuide = (markdown: string) => (
    <Collapse
      ghost
      style={{ marginBottom: 12 }}
      items={[
        {
          key: 'guide',
          label: (
            <span style={{ fontWeight: 500 }}>
              <BookOutlined style={{ marginRight: 6 }} />
              配置教程（不熟悉的话点开看）
            </span>
          ),
          children: (
            <div
              className="agentquad-setup-guide"
              style={{
                maxHeight: 460,
                overflow: 'auto',
                padding: '10px 14px',
                background: '#fcfaf5',
                border: '1px solid #ece7dd',
                borderRadius: 6,
                fontSize: 13,
                lineHeight: 1.65,
              }}
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{markdown}</ReactMarkdown>
            </div>
          ),
        },
      ]}
    />
  )

  const telegramTab = (
    <>
    {setupGuide(telegramSetupMd)}
    <Collapse
      defaultActiveKey={['basic', 'topic', 'notify', 'security']}
      items={[
        {
          key: 'basic',
          label: '基础',
          children: (
            <>
              <Form.Item name="telegramEnabled" label="启用 Telegram" valuePropName="checked">
                <Switch />
              </Form.Item>

              <Form.Item label="Bot Token" required>
                <Space.Compact style={{ width: '100%' }}>
                  <Form.Item name="telegramBotToken" noStyle>
                    <Input.Password placeholder="paste token here，留空 = 不启用 Telegram" autoComplete="new-password" />
                  </Form.Item>
                  <Button
                    loading={testing}
                    onClick={async () => {
                      setTesting(true)
                      try {
                        const rawToken = String(form.getFieldValue('telegramBotToken') || '').trim()
                        const input = rawToken && !isMaskedToken(rawToken) ? { botToken: rawToken } : {}
                        const r = await testTelegram(input)
                        if (r.ok) {
                          const sourceLabel = telegramSourceLabel(r.source)
                          setTestResult(`✓ ${r.botUsername ? '@' + r.botUsername : `id=${r.botId}`}（来源：${sourceLabel}）`)
                          message.success(r.source === 'input' ? 'Telegram 连通，保存后生效' : 'Telegram 连通')
                        } else {
                          setTestResult(`✗ ${r.errorReason || 'unknown'}`)
                          message.error(r.errorReason || '测试失败')
                        }
                      } catch (e: any) {
                        setTestResult(`✗ ${e.message}`)
                      } finally {
                        setTesting(false)
                      }
                    }}
                  >测试</Button>
                </Space.Compact>
                <div style={{ marginTop: 4, fontSize: 12 }}>
                  <Tag color={tokenSource === 'agentquad' ? 'default' : 'error'}>
                    {tokenSource === 'agentquad' && '来自 AgentQuad 配置'}
                    {tokenSource === 'missing' && '未配置'}
                  </Tag>
                  {testResult && <span style={{ marginLeft: 8 }}>{testResult}</span>}
                </div>
              </Form.Item>

              <Form.Item label="Supergroup ID">
                <Space.Compact style={{ width: '100%' }}>
                  <Form.Item name="telegramSupergroupId" noStyle>
                    <Input placeholder="-1001234567890" />
                  </Form.Item>
                  <Button onClick={() => setProbeOpen(true)}>抓 ID</Button>
                </Space.Compact>
              </Form.Item>

              <Form.Item
                name="telegramAllowedChatIds"
                label="白名单 chatIds"
                extra="一行一个 chat_id；空 = 拒绝所有（强制白名单）"
              >
                <Input.TextArea rows={3} placeholder="-1001234567890" />
              </Form.Item>
            </>
          ),
        },
        {
          key: 'topic',
          label: 'Topic 行为',
          children: (
            <>
              <Form.Item name="telegramUseTopics" label="启用 Topics" valuePropName="checked">
                <Switch />
              </Form.Item>
              <Form.Item name="telegramCreateTopicOnTaskStart" label="任务启动时建 Topic" valuePropName="checked">
                <Switch />
              </Form.Item>
              <Form.Item name="telegramCloseTopicOnSessionEnd" label="Session 结束关 Topic" valuePropName="checked">
                <Switch />
              </Form.Item>
              <Form.Item name="telegramAutoCreateTopic" label="非 wizard 起的 PTY 自动镜像" valuePropName="checked">
                <Switch />
              </Form.Item>
              <Form.Item name="telegramTopicNameTemplate" label="Topic 名模板" extra="占位符：{shortCode} {title}">
                <Input />
              </Form.Item>
              <Form.Item name="telegramTopicNameDoneTemplate" label="完成模板" extra="占位符：{originalName}">
                <Input />
              </Form.Item>
            </>
          ),
        },
        {
          key: 'notify',
          label: '通知行为',
          children: (
            <>
              <Form.Item
                name="telegramNotificationCooldownMs"
                label="同 session idle 提醒最小间隔 (ms)"
                extra="0 = 关闭去重，每次都推。默认 600000（10 分钟）。"
              >
                <InputNumber min={0} step={60_000} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="telegramSuppressNotificationEvents" label="丢弃 idle Notification 事件" valuePropName="checked">
                <Switch />
              </Form.Item>
              <Form.Item
                name="telegramDefaultPermissionMode"
                label="Telegram 默认权限模式"
                extra="新建/恢复 Telegram 任务时使用。非 bypass 模式下，等待授权时会发 Telegram 按钮提醒。"
              >
                <Radio.Group>
                  <Radio.Button value="default">默认（需确认）</Radio.Button>
                  <Radio.Button value="acceptEdits">半托管</Radio.Button>
                  <Radio.Button value="bypass">完全托管</Radio.Button>
                </Radio.Group>
              </Form.Item>
            </>
          ),
        },
        {
          key: 'security',
          label: '安全',
          children: (
            <Form.Item
              name="telegramAllowedFromUserIds"
              label="白名单 fromUserIds"
              extra="一行一个 user_id；空 = 不限"
            >
              <Input.TextArea rows={3} />
            </Form.Item>
          ),
        },
        {
          key: 'advanced',
          label: '高级（不动也行）',
          children: (
            <>
              <Form.Item name="telegramLongPollTimeoutSec" label="长轮询超时 (秒)">
                <InputNumber min={5} max={120} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="telegramPollRetryDelayMs" label="拉取失败退避起点 (ms)">
                <InputNumber min={500} step={500} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="telegramMinRenameIntervalMs" label="Topic 重命名最小间隔 (ms)">
                <InputNumber min={1000} step={1000} style={{ width: '100%' }} />
              </Form.Item>
            </>
          ),
        },
      ]}
    />
    </>
  )

  const larkTab = (
    <>
      {setupGuide(larkSetupMd)}
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="Lark 话题群适配说明"
        description="Lark 的话题由话题群中的主消息/thread 承载，不是 Telegram Forum Topic 那种原生 topic 对象。"
      />

      <Form.Item name="larkEnabled" label="启用 Lark / 飞书通知" valuePropName="checked">
        <Switch />
      </Form.Item>

      <Form.Item name="larkAppId" label="App ID" extra="飞书/Lark 自建应用的 App ID，例如 cli_xxx。">
        <Input placeholder="cli_xxx" />
      </Form.Item>

      <Form.Item label="App Secret" required>
        <Space.Compact style={{ width: '100%' }}>
          <Form.Item name="larkAppSecret" noStyle>
            <Input.Password placeholder="paste app secret here，留空/遮罩 = 保留现有值" autoComplete="new-password" />
          </Form.Item>
          <Button
            loading={larkTesting}
            onClick={async () => {
              setLarkTesting(true)
              try {
                const rawAppId = String(form.getFieldValue('larkAppId') || '').trim()
                const rawSecret = String(form.getFieldValue('larkAppSecret') || '').trim()
                const input = {
                  appId: rawAppId,
                  appSecret: rawSecret && !isMaskedLarkSecret(rawSecret) ? rawSecret : undefined,
                }
                const r = await testLark(input)
                if (r.ok) {
                  setLarkTestResult(`✓ 来源：${larkSourceLabel(r.source)}`)
                  message.success(r.source === 'input' ? 'Lark 连通，保存后生效' : 'Lark 连通')
                } else {
                  setLarkTestResult(`✗ ${r.errorReason || 'unknown'}`)
                  message.error(r.errorReason || '测试失败')
                }
              } catch (e: any) {
                setLarkTestResult(`✗ ${e.message}`)
              } finally {
                setLarkTesting(false)
              }
            }}
          >测试</Button>
        </Space.Compact>
        <div style={{ marginTop: 4, fontSize: 12 }}>
          <Tag color={larkSecretSource === 'agentquad' ? 'default' : 'error'}>
            {larkSecretSource === 'agentquad' && '来自 AgentQuad 配置'}
            {larkSecretSource === 'missing' && '未配置'}
          </Tag>
          {larkTestResult && <span style={{ marginLeft: 8 }}>{larkTestResult}</span>}
        </div>
      </Form.Item>

      <Form.Item
        name="larkChatId"
        label="话题群 Chat ID"
        extra="目标群需要是话题群/thread group；机器人需要在群内并具备发消息权限。"
      >
        <Input placeholder="oc_xxxxxxxxxxxxxxxxx" />
      </Form.Item>

      <Form.Item
        name="larkRequireThreadGroup"
        label="要求目标群为话题群 / thread group"
        valuePropName="checked"
        extra="保持开启可避免误把普通群当作话题群使用。"
      >
        <Switch />
      </Form.Item>

      <Form.Item
        name="larkEventSubscribeEnabled"
        label="启用事件订阅，用于双向消息"
        valuePropName="checked"
        extra="关闭后只能从 AgentQuad 推送到 Lark，Lark 里的回复不会回到本地会话。"
      >
        <Switch />
      </Form.Item>

      <Form.Item
        name="larkAutoCreateTopic"
        label="Web/CLI 起 session 自动镜像到 Lark thread"
        valuePropName="checked"
        extra="开启后：在 Web 起 AI session 时自动在话题群里发一条根消息作为 thread anchor，PTY 输出回复到该 thread。关闭则只能从飞书 @bot 起 session。"
      >
        <Switch />
      </Form.Item>

      <Form.Item
        name="larkDefaultPermissionMode"
        label="Lark 默认权限模式"
        extra="新建/恢复 Lark 任务时使用。默认 = 每次写操作都要授权；半托管 = 自动批文件编辑；完全托管（bypass）= 全自动跑。Lark 远程驱动时建议 bypass，否则等待授权时只能干等。"
      >
        <Radio.Group>
          <Radio.Button value="default">默认（需确认）</Radio.Button>
          <Radio.Button value="acceptEdits">半托管</Radio.Button>
          <Radio.Button value="bypass">完全托管</Radio.Button>
        </Radio.Group>
      </Form.Item>

      <Form.Item
        name="larkNotificationCooldownMs"
        label="同 session idle 提醒最小间隔 (ms)"
        extra="0 = 关闭去重，每次都推。默认 600000（10 分钟）。"
      >
        <InputNumber min={0} step={60_000} style={{ width: '100%' }} />
      </Form.Item>
    </>
  )

  const pricingTab = (
    <>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="估算成本用的单价表，单位 $/1M tokens。保存后下次打开统计面板即生效，无需重启。"
        description={
          <>
            模型匹配使用 glob（<Text code>*</Text> 匹配任意字符），按定义顺序逐条匹配，找不到时落到"默认费率"。
            官方价目对照：<Text code>https://www.anthropic.com/pricing#api</Text>。
            <br />
            注意：删除 Opus / Sonnet / Haiku 等默认模型行后，下次打开此面板会自动恢复（系统始终保证默认项存在）。
          </>
        }
      />

      <Form.Item
        name="pricingShowInPush"
        label="在 Telegram / 飞书推送末尾显示每轮费用"
        valuePropName="checked"
        extra="打开后，每条 Stop / SessionEnd 推送会附 turn token 用量 + USD 估算的 footer。默认关。"
      >
        <Switch />
      </Form.Item>
      <Form.Item noStyle shouldUpdate={(p, n) => p.pricingShowInPush !== n.pricingShowInPush}>
        {({ getFieldValue }) => (
          <Form.Item
            name="pricingShowCnyInPush"
            label="同时显示人民币（¥）"
            valuePropName="checked"
            extra="footer 显示时同时带 ¥ 估算；只有上面开关打开时才有意义。"
          >
            <Switch disabled={!getFieldValue('pricingShowInPush')} />
          </Form.Item>
        )}
      </Form.Item>

      <Form.Item
        name="pricingCnyRate"
        label="CNY 汇率"
        extra="USD → CNY 换算用；不会自动跟随实时汇率，自行维护。"
        rules={[{ required: true, message: '请输入 CNY 汇率' }]}
      >
        <InputNumber min={0} step={0.1} style={{ width: 160 }} />
      </Form.Item>

      <Paragraph style={{ marginTop: 8, marginBottom: 8 }}>
        <Text>默认费率（fallback）</Text>
      </Paragraph>
      <Space wrap size={[12, 8]} style={{ marginBottom: 12 }}>
        <Form.Item name={['pricingDefault', 'input']} label="input" style={{ marginBottom: 0 }}>
          <InputNumber min={0} step={0.01} style={{ width: 110 }} />
        </Form.Item>
        <Form.Item name={['pricingDefault', 'output']} label="output" style={{ marginBottom: 0 }}>
          <InputNumber min={0} step={0.01} style={{ width: 110 }} />
        </Form.Item>
        <Form.Item name={['pricingDefault', 'cacheRead']} label="cacheRead" style={{ marginBottom: 0 }}>
          <InputNumber min={0} step={0.01} style={{ width: 110 }} />
        </Form.Item>
        <Form.Item name={['pricingDefault', 'cacheWrite']} label="cacheWrite" style={{ marginBottom: 0 }}>
          <InputNumber min={0} step={0.01} style={{ width: 110 }} />
        </Form.Item>
      </Space>

      <Paragraph style={{ marginTop: 8, marginBottom: 8 }}>
        <Text>按模型匹配</Text>
      </Paragraph>
      <Form.List name="pricingModels">
        {(fields, { add, remove }) => (
          <>
            {fields.map(({ key, name, ...rest }) => (
              <div
                key={key}
                style={{
                  padding: 10,
                  border: '1px solid #ece7dd',
                  borderRadius: 6,
                  marginBottom: 8,
                  background: '#fcfaf5',
                }}
              >
                <Space wrap size={[12, 4]} style={{ width: '100%' }}>
                  <Form.Item
                    {...rest}
                    name={[name, 'pattern']}
                    label="模型匹配"
                    style={{ marginBottom: 0 }}
                  >
                    <Input placeholder="claude-opus-4-*" style={{ width: 200 }} />
                  </Form.Item>
                  <Form.Item {...rest} name={[name, 'input']} label="input" style={{ marginBottom: 0 }}>
                    <InputNumber min={0} step={0.01} style={{ width: 100 }} />
                  </Form.Item>
                  <Form.Item {...rest} name={[name, 'output']} label="output" style={{ marginBottom: 0 }}>
                    <InputNumber min={0} step={0.01} style={{ width: 100 }} />
                  </Form.Item>
                  <Form.Item {...rest} name={[name, 'cacheRead']} label="cacheRead" style={{ marginBottom: 0 }}>
                    <InputNumber min={0} step={0.01} style={{ width: 100 }} />
                  </Form.Item>
                  <Form.Item {...rest} name={[name, 'cacheWrite']} label="cacheWrite" style={{ marginBottom: 0 }}>
                    <InputNumber min={0} step={0.01} style={{ width: 100 }} />
                  </Form.Item>
                  <Button
                    type="text"
                    danger
                    icon={<MinusCircleOutlined />}
                    onClick={() => remove(name)}
                  >
                    删除
                  </Button>
                </Space>
              </div>
            ))}
            <Button
              type="dashed"
              onClick={() =>
                add({ pattern: '', input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
              }
              icon={<PlusOutlined />}
              block
            >
              添加模型
            </Button>
          </>
        )}
      </Form.List>
    </>
  )

  return (
    <Drawer
      title="AgentQuad 设置"
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

      <Descriptions column={1} bordered size="small" style={{ marginBottom: 16 }}>
        <Descriptions.Item label="版本">{status?.version ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="活跃 AI 会话数">{status?.activeSessions ?? '-'}</Descriptions.Item>
      </Descriptions>

      <Form form={form} layout="vertical">
        <Tabs
          activeKey={activeTab}
          onChange={(k) => setActiveTab(k as typeof activeTab)}
          items={[
            { key: 'run', label: '运行', children: runTab },
            { key: 'tools', label: 'AI 工具', children: toolsTab },
            { key: 'telegram', label: 'Telegram', children: telegramTab },
            { key: 'lark', label: 'Lark / 飞书', children: larkTab },
            { key: 'pricing', label: '价目表', children: pricingTab },
          ]}
        />
      </Form>

      <TelegramProbeModal
        open={probeOpen}
        onClose={() => setProbeOpen(false)}
        onPick={(hit: ProbeHit) => {
          form.setFieldValue('telegramSupergroupId', hit.chatId)
          const cur = String(form.getFieldValue('telegramAllowedChatIds') || '')
          if (!cur.split('\n').includes(hit.chatId)) {
            form.setFieldValue('telegramAllowedChatIds', hit.chatId + (cur ? '\n' + cur : ''))
          }
        }}
      />

      <Paragraph type="secondary" style={{ marginTop: 16 }}>
        配置文件位置：<Text code>~/.agentquad/config.json</Text>
      </Paragraph>
    </Drawer>
  )
}
