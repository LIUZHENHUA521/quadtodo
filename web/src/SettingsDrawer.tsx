import { Drawer, Alert, Typography, Form, Input, InputNumber, Button, Radio, Space, Tag, Switch, Collapse, Tabs, Segmented } from 'antd'
import { useTranslation } from 'react-i18next'
import { useAppMessages } from './design/useAppMessages'
import { MinusCircleOutlined, PlusOutlined, BookOutlined } from '@ant-design/icons'
import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { markdownComponents } from './markdownComponents'
import { getConfig, updateConfig, AppConfig, pickDirectory, ToolDiagnostic, testTelegram, testLark, type ProbeHit, type DispatchChannelConfig } from './api'
import { TelegramProbeModal } from './TelegramProbeModal'
import telegramSetupMd from '../../docs/TELEGRAM-setup.md?raw'
import larkSetupMd from '../../docs/LARK.md?raw'
import { AgentIcon } from './components/AgentIcon'
import './SettingsDrawer.css'

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

type TFn = (key: any, opts?: any) => string

function telegramSourceLabel(source: 'agentquad' | 'missing' | 'input', t: TFn): string {
  if (source === 'input') return t('settings:telegram.sourceInput')
  if (source === 'agentquad') return t('settings:telegram.sourceAgentquadShort')
  return 'missing'
}

function isMaskedLarkSecret(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('lark_***')
}

function larkSourceLabel(source: 'agentquad' | 'missing' | 'input', t: TFn): string {
  if (source === 'input') return t('settings:telegram.sourceInput')
  if (source === 'agentquad') return t('settings:telegram.sourceAgentquadShort')
  return 'missing'
}

type ToolKey = 'claude' | 'codex' | 'cursor'
const TOOL_LABEL: Record<ToolKey, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
}

export default function SettingsDrawer({ open, onClose }: Props) {
  const { t } = useTranslation(['settings'])
  const { message } = useAppMessages()
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
    getConfig()
      .then((result) => {
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
      message.success(t('settings:saveOk'))
    } catch (e: any) {
      if (e?.errorFields) return
      message.error(e?.message || t('settings:saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const handlePickDefaultCwd = async () => {
    try {
      setPickingDefaultCwd(true)
      const result = await pickDirectory({
        defaultPath: form.getFieldValue('defaultCwd') || config?.defaultCwd,
        prompt: t('settings:general.pickDirPrompt'),
      })
      if (result.cancelled || !result.path) return
      form.setFieldValue('defaultCwd', result.path)
    } catch (e: any) {
      message.error(e?.message || t('settings:pickDirFailed'))
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
      message.success(t('settings:tools.redetectOk', { tool }))
    } catch (e: any) {
      message.error(e?.message || t('settings:tools.redetectFailed'))
    }
  }

  const renderToolMeta = (tool: ToolKey) => {
    const meta = toolDiagnostics?.[tool]
    if (!meta) return null
    const sourceText = meta.source === 'env'
      ? t('settings:tools.source.env')
      : meta.source === 'config'
        ? t('settings:tools.source.config')
        : meta.source === 'auto-detected'
          ? t('settings:tools.source.autoDetected')
          : t('settings:tools.source.missing')
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
          <Button size="small" onClick={() => handleRedetectTool(tool)}>{t('settings:tools.redetect')}</Button>
        </Space>
        {!meta.missing && (
          <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
            {t('settings:tools.currentCommand')}<Text code>{meta.command}</Text>
          </div>
        )}
        {!meta.missing && (
          <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
            {t('settings:tools.currentBin')}<Text code>{meta.bin}</Text>
          </div>
        )}
        {meta.missing && meta.installHint && (
          <Alert
            style={{ marginTop: 8 }}
            type="warning"
            showIcon
            message={t('settings:tools.missingHint', { tool })}
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
        extra: t('settings:tools.extra.claude'),
      },
      codex: {
        cmd: 'codex',
        bin: '/Users/liuzhenhua/.nvm/versions/node/v20.19.5/bin/codex',
        extra: t('settings:tools.extra.codex'),
      },
      cursor: {
        cmd: 'cursor-agent',
        bin: '/Users/liuzhenhua/.local/bin/cursor-agent',
        extra: t('settings:tools.extra.cursor'),
      },
    }
    const p = placeholder[tool]
    return (
      <>
        <Form.Item name={cmdField} label={t('settings:tools.cmdLabel')} extra={p.extra}>
          <Input placeholder={p.cmd} />
        </Form.Item>
        <Form.Item name={binField} label={t('settings:tools.binLabel')}>
          <Input placeholder={p.bin} />
        </Form.Item>
        {renderToolMeta(tool)}
      </>
    )
  }

  const runTab = (
    <>
      <div className="settings-section-title">{t('settings:section.startup')}</div>

      <Form.Item
        label={t('settings:general.defaultCwdLabel')}
        extra={t('settings:general.defaultCwdExtra')}
      >
        <Space.Compact block>
          <Form.Item name="defaultCwd" noStyle rules={[{ required: true, message: t('settings:general.defaultCwdRequired') }]}>
            <Input allowClear placeholder={t('settings:general.defaultCwdPlaceholder')} />
          </Form.Item>
          <Button loading={pickingDefaultCwd} onClick={handlePickDefaultCwd}>{t('settings:general.pickDir')}</Button>
        </Space.Compact>
      </Form.Item>

      <Form.Item
        label={t('settings:general.linkEditorLabel')}
        extra={t('settings:general.linkEditorExtra')}
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

      <div className="settings-section-title">{t('settings:section.service')}</div>

      <Form.Item
        name="port"
        label={t('settings:general.portLabel')}
        rules={[{ required: true, message: t('settings:general.portRequired') }]}
        extra={t('settings:general.portExtra')}
      >
        <InputNumber min={1} max={65535} style={{ width: 160 }} />
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
          <Text type="secondary" style={{ fontSize: 12 }}>{t('settings:dispatch.emptyOverride', { field })}</Text>
        )}
        {entries.map(([k, v]) => (
          <Space key={k} style={{ display: 'flex', marginBottom: 6 }}>
            <Input
              style={{ width: 200 }}
              value={k}
              disabled
              addonBefore={field === 'perUser' ? t('settings:dispatch.userIdAddon') : t('settings:dispatch.chatIdAddon')}
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
            {t('settings:dispatch.add')}
          </Button>
        </Space.Compact>
      </div>
    )
  }

  const dispatchSection = (
    <Form.Item
      label={t('settings:dispatch.label')}
      extra={t('settings:dispatch.extra')}
    >
      <Collapse
        ghost
        items={(['lark', 'telegram', 'web'] as const).map((channel) => ({
          key: channel,
          label: <span style={{ fontWeight: 500 }}>{channel}</span>,
          children: (
            <>
              <Form.Item label={t('settings:dispatch.channelDefaultLabel')} style={{ marginBottom: 8 }}>
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
                <Form.Item label={t('settings:dispatch.perUserLabel')} style={{ marginBottom: 8 }}>
                  {renderPerKeyEditor('lark', 'perUser', t('settings:dispatch.perUserPlaceholder'))}
                </Form.Item>
              )}
              {channel === 'telegram' && (
                <Form.Item label={t('settings:dispatch.perChatLabel')} style={{ marginBottom: 8 }}>
                  {renderPerKeyEditor('telegram', 'perChat', t('settings:dispatch.perChatPlaceholder'))}
                </Form.Item>
              )}
              {channel === 'web' && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('settings:dispatch.webHint')}
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
        label={t('settings:tools.defaultToolLabel')}
        extra={t('settings:tools.defaultToolExtra')}
        rules={[{ required: true, message: t('settings:tools.defaultToolRequired') }]}
      >
        <Radio.Group>
          <Radio.Button value="claude"><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><AgentIcon tool="claude" />Claude</span></Radio.Button>
          <Radio.Button value="codex"><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><AgentIcon tool="codex" />Codex</span></Radio.Button>
          <Radio.Button value="cursor"><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><AgentIcon tool="cursor" />Cursor</span></Radio.Button>
        </Radio.Group>
      </Form.Item>

      {dispatchSection}

      <Form.Item label={t('settings:tools.viewToolLabel')}>
        <Segmented
          value={viewingTool}
          onChange={(v) => setViewingTool(v as ToolKey)}
          options={TOOLS.map((tool) => ({
            value: tool,
            label: (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <AgentIcon tool={tool} />
                {TOOL_LABEL[tool]}
              </span>
            ),
          }))}
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
              {t('settings:setupGuideLabel')}
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
          label: t('settings:telegram.collapse.basic'),
          children: (
            <>
              <Form.Item name="telegramEnabled" label={t('settings:telegram.enableLabel')} valuePropName="checked">
                <Switch />
              </Form.Item>

              <Form.Item label={t('settings:telegram.tokenLabel')} required>
                <Space.Compact style={{ width: '100%' }}>
                  <Form.Item name="telegramBotToken" noStyle>
                    <Input.Password placeholder={t('settings:telegram.tokenPlaceholder')} autoComplete="new-password" />
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
                          const sourceLabel = telegramSourceLabel(r.source, t)
                          setTestResult(`✓ ${r.botUsername ? '@' + r.botUsername : `id=${r.botId}`}（${sourceLabel}）`)
                          message.success(r.source === 'input' ? t('settings:telegram.testSuccessSaveFirst') : t('settings:telegram.testSuccess'))
                        } else {
                          setTestResult(`✗ ${r.errorReason || 'unknown'}`)
                          message.error(r.errorReason || t('settings:telegram.testFailed'))
                        }
                      } catch (e: any) {
                        setTestResult(`✗ ${e.message}`)
                      } finally {
                        setTesting(false)
                      }
                    }}
                  >{t('settings:telegram.test')}</Button>
                </Space.Compact>
                <div style={{ marginTop: 4, fontSize: 12 }}>
                  <Tag color={tokenSource === 'agentquad' ? 'default' : 'error'}>
                    {tokenSource === 'agentquad' && t('settings:telegram.sourceAgentquad')}
                    {tokenSource === 'missing' && t('settings:telegram.sourceMissing')}
                  </Tag>
                  {testResult && <span style={{ marginLeft: 8 }}>{testResult}</span>}
                </div>
              </Form.Item>

              <Form.Item label={t('settings:telegram.supergroupIdLabel')}>
                <Space.Compact style={{ width: '100%' }}>
                  <Form.Item name="telegramSupergroupId" noStyle>
                    <Input placeholder={t('settings:telegram.supergroupIdPlaceholder')} />
                  </Form.Item>
                  <Button onClick={() => setProbeOpen(true)}>{t('settings:telegram.grabId')}</Button>
                </Space.Compact>
              </Form.Item>

              <Form.Item
                name="telegramAllowedChatIds"
                label={t('settings:telegram.allowedChatsLabel')}
                extra={t('settings:telegram.allowedChatsExtra')}
              >
                <Input.TextArea rows={3} placeholder={t('settings:telegram.allowedChatsPlaceholder')} />
              </Form.Item>
            </>
          ),
        },
        {
          key: 'topic',
          label: t('settings:telegram.collapse.topic'),
          children: (
            <>
              <Form.Item name="telegramUseTopics" label={t('settings:telegram.useTopicsLabel')} valuePropName="checked">
                <Switch />
              </Form.Item>
              <Form.Item name="telegramCreateTopicOnTaskStart" label={t('settings:telegram.createOnStartLabel')} valuePropName="checked">
                <Switch />
              </Form.Item>
              <Form.Item name="telegramCloseTopicOnSessionEnd" label={t('settings:telegram.closeOnEndLabel')} valuePropName="checked">
                <Switch />
              </Form.Item>
              <Form.Item name="telegramAutoCreateTopic" label={t('settings:telegram.autoCreateLabel')} valuePropName="checked">
                <Switch />
              </Form.Item>
              <Form.Item name="telegramTopicNameTemplate" label={t('settings:telegram.topicNameTemplateLabel')} extra={t('settings:telegram.topicNameTemplateExtra')}>
                <Input />
              </Form.Item>
              <Form.Item name="telegramTopicNameDoneTemplate" label={t('settings:telegram.topicNameDoneTemplateLabel')} extra={t('settings:telegram.topicNameDoneTemplateExtra')}>
                <Input />
              </Form.Item>
            </>
          ),
        },
        {
          key: 'notify',
          label: t('settings:telegram.collapse.notify'),
          children: (
            <>
              <Form.Item
                name="telegramNotificationCooldownMs"
                label={t('settings:telegram.cooldownLabel')}
                extra={t('settings:telegram.cooldownExtra')}
              >
                <InputNumber min={0} step={60_000} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="telegramSuppressNotificationEvents" label={t('settings:telegram.suppressIdleLabel')} valuePropName="checked">
                <Switch />
              </Form.Item>
              <Form.Item
                name="telegramDefaultPermissionMode"
                label={t('settings:telegram.permissionModeLabel')}
                extra={t('settings:telegram.permissionModeExtra')}
              >
                <Radio.Group>
                  <Radio.Button value="default">{t('settings:telegram.permission.default')}</Radio.Button>
                  <Radio.Button value="acceptEdits">{t('settings:telegram.permission.acceptEdits')}</Radio.Button>
                  <Radio.Button value="bypass">{t('settings:telegram.permission.bypass')}</Radio.Button>
                </Radio.Group>
              </Form.Item>
            </>
          ),
        },
        {
          key: 'security',
          label: t('settings:telegram.collapse.security'),
          children: (
            <Form.Item
              name="telegramAllowedFromUserIds"
              label={t('settings:telegram.allowedFromUsersLabel')}
              extra={t('settings:telegram.allowedFromUsersExtra')}
            >
              <Input.TextArea rows={3} />
            </Form.Item>
          ),
        },
        {
          key: 'advanced',
          label: t('settings:telegram.collapse.advanced'),
          children: (
            <>
              <Form.Item name="telegramLongPollTimeoutSec" label={t('settings:telegram.longPollLabel')}>
                <InputNumber min={5} max={120} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="telegramPollRetryDelayMs" label={t('settings:telegram.pollRetryLabel')}>
                <InputNumber min={500} step={500} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="telegramMinRenameIntervalMs" label={t('settings:telegram.renameIntervalLabel')}>
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
        message={t('settings:lark.adaptInfoTitle')}
        description={t('settings:lark.adaptInfoDesc')}
      />

      <Form.Item name="larkEnabled" label={t('settings:lark.enableLabel')} valuePropName="checked">
        <Switch />
      </Form.Item>

      <Form.Item name="larkAppId" label={t('settings:lark.appIdLabel')} extra={t('settings:lark.appIdExtra')}>
        <Input placeholder={t('settings:lark.appIdPlaceholder')} />
      </Form.Item>

      <Form.Item label={t('settings:lark.appSecretLabel')} required>
        <Space.Compact style={{ width: '100%' }}>
          <Form.Item name="larkAppSecret" noStyle>
            <Input.Password placeholder={t('settings:lark.appSecretPlaceholder')} autoComplete="new-password" />
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
                  setLarkTestResult(t('settings:lark.testSuccessSource', { source: larkSourceLabel(r.source, t) }))
                  message.success(r.source === 'input' ? t('settings:lark.testSuccessSaveFirst') : t('settings:lark.testSuccess'))
                } else {
                  setLarkTestResult(`✗ ${r.errorReason || 'unknown'}`)
                  message.error(r.errorReason || t('settings:telegram.testFailed'))
                }
              } catch (e: any) {
                setLarkTestResult(`✗ ${e.message}`)
              } finally {
                setLarkTesting(false)
              }
            }}
          >{t('settings:telegram.test')}</Button>
        </Space.Compact>
        <div style={{ marginTop: 4, fontSize: 12 }}>
          <Tag color={larkSecretSource === 'agentquad' ? 'default' : 'error'}>
            {larkSecretSource === 'agentquad' && t('settings:telegram.sourceAgentquad')}
            {larkSecretSource === 'missing' && t('settings:telegram.sourceMissing')}
          </Tag>
          {larkTestResult && <span style={{ marginLeft: 8 }}>{larkTestResult}</span>}
        </div>
      </Form.Item>

      <Form.Item
        name="larkChatId"
        label={t('settings:lark.chatIdLabel')}
        extra={t('settings:lark.chatIdExtra')}
      >
        <Input placeholder={t('settings:lark.chatIdPlaceholder')} />
      </Form.Item>

      <Form.Item
        name="larkRequireThreadGroup"
        label={t('settings:lark.requireThreadLabel')}
        valuePropName="checked"
        extra={t('settings:lark.requireThreadExtra')}
      >
        <Switch />
      </Form.Item>

      <Form.Item
        name="larkEventSubscribeEnabled"
        label={t('settings:lark.eventSubLabel')}
        valuePropName="checked"
        extra={t('settings:lark.eventSubExtra')}
      >
        <Switch />
      </Form.Item>

      <Form.Item
        name="larkAutoCreateTopic"
        label={t('settings:lark.autoCreateTopicLabel')}
        valuePropName="checked"
        extra={t('settings:lark.autoCreateTopicExtra')}
      >
        <Switch />
      </Form.Item>

      <Form.Item
        name="larkDefaultPermissionMode"
        label={t('settings:lark.permissionModeLabel')}
        extra={t('settings:lark.permissionModeExtra')}
      >
        <Radio.Group>
          <Radio.Button value="default">{t('settings:telegram.permission.default')}</Radio.Button>
          <Radio.Button value="acceptEdits">{t('settings:telegram.permission.acceptEdits')}</Radio.Button>
          <Radio.Button value="bypass">{t('settings:telegram.permission.bypass')}</Radio.Button>
        </Radio.Group>
      </Form.Item>

      <Form.Item
        name="larkNotificationCooldownMs"
        label={t('settings:lark.cooldownLabel')}
        extra={t('settings:lark.cooldownExtra')}
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
        message={t('settings:pricing.title')}
        description={
          <>
            {t('settings:pricing.descPart1')}<Text code>*</Text>{t('settings:pricing.descPart2')}<Text code>https://www.anthropic.com/pricing#api</Text>
            <br />
            {t('settings:pricing.descNote')}
          </>
        }
      />

      <Form.Item
        name="pricingShowInPush"
        label={t('settings:pricing.showInPushLabel')}
        valuePropName="checked"
        extra={t('settings:pricing.showInPushExtra')}
      >
        <Switch />
      </Form.Item>
      <Form.Item noStyle shouldUpdate={(p, n) => p.pricingShowInPush !== n.pricingShowInPush}>
        {({ getFieldValue }) => (
          <Form.Item
            name="pricingShowCnyInPush"
            label={t('settings:pricing.showCnyLabel')}
            valuePropName="checked"
            extra={t('settings:pricing.showCnyExtra')}
          >
            <Switch disabled={!getFieldValue('pricingShowInPush')} />
          </Form.Item>
        )}
      </Form.Item>

      <Form.Item
        name="pricingCnyRate"
        label={t('settings:pricing.cnyRateLabel')}
        extra={t('settings:pricing.cnyRateExtra')}
        rules={[{ required: true, message: t('settings:pricing.cnyRateRequired') }]}
      >
        <InputNumber min={0} step={0.1} style={{ width: 160 }} />
      </Form.Item>

      <Paragraph style={{ marginTop: 8, marginBottom: 8 }}>
        <Text>{t('settings:pricing.defaultRateTitle')}</Text>
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
        <Text>{t('settings:pricing.byModelTitle')}</Text>
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
                    label={t('settings:pricing.patternLabel')}
                    style={{ marginBottom: 0 }}
                  >
                    <Input placeholder={t('settings:pricing.patternPlaceholder')} style={{ width: 200 }} />
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
                    {t('settings:pricing.delete')}
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
              {t('settings:pricing.addModel')}
            </Button>
          </>
        )}
      </Form.List>
    </>
  )

  return (
    <Drawer
      title={t('settings:drawerTitle')}
      open={open}
      onClose={onClose}
      width={760}
      footer={
        <div className="settings-footer">
          <Text code className="settings-footer-path">~/.agentquad/config.json</Text>
          <Space>
            <Button onClick={onClose}>{t('settings:close')}</Button>
            <Button type="primary" loading={saving} onClick={handleSave}>{t('settings:save')}</Button>
          </Space>
        </div>
      }
    >
      {err && <Alert type="error" message={err} style={{ marginBottom: 16 }} />}

      <Form form={form} layout="vertical">
        <Tabs
          tabPosition="left"
          tabBarStyle={{ width: 132 }}
          activeKey={activeTab}
          onChange={(k) => setActiveTab(k as typeof activeTab)}
          items={[
            { key: 'run', label: t('settings:tab.general'), children: runTab },
            { key: 'tools', label: t('settings:tab.tools'), children: toolsTab },
            { key: 'telegram', label: t('settings:tab.telegram'), children: telegramTab },
            { key: 'lark', label: t('settings:tab.lark'), children: larkTab },
            { key: 'pricing', label: t('settings:tab.pricing'), children: pricingTab },
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

    </Drawer>
  )
}
