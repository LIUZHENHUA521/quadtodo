import React, { useEffect, useState } from 'react'
import { Modal, Form, Select, Slider, Switch, Input, Button, Spin } from 'antd'
import { useTranslation } from 'react-i18next'
import { useAppMessages } from './design/useAppMessages'
import { AiTool, Todo, forkAiSession } from './api'
import { AgentIcon } from './components/AgentIcon'

const toolOptionLabel = (tool: AiTool, name: string) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
    <AgentIcon tool={tool} />
    {name}
  </span>
)

interface Props {
  open: boolean
  sourceTodo: Todo | null
  sourceSessionId: string | null
  todos: Todo[]
  onCancel: () => void
  onConfirm: (result: { prompt: string; targetTodoId: string; tool: AiTool; cwd: string | null }) => void
}

export default function ForkDialog({ open, sourceTodo, sourceSessionId, todos, onCancel, onConfirm }: Props) {
  const { t } = useTranslation(['transcript', 'common'])
  const { message } = useAppMessages()
  const [tool, setTool] = useState<AiTool>('claude')
  const [targetTodoId, setTargetTodoId] = useState<string>('')
  const [keepLastTurns, setKeepLastTurns] = useState<number>(6)
  const [summarize, setSummarize] = useState<boolean>(true)
  const [newInstruction, setNewInstruction] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<string>('')

  useEffect(() => {
    if (!open) return
    if (sourceTodo) {
      setTargetTodoId(sourceTodo.id)
      const s = sourceTodo.aiSessions?.find(x => x.sessionId === sourceSessionId)
      if (s) setTool(s.tool)
    }
    setNewInstruction('')
    setPreview('')
  }, [open, sourceTodo, sourceSessionId])

  const generatePreview = async () => {
    if (!sourceTodo || !sourceSessionId) return
    setLoading(true)
    try {
      const r = await forkAiSession(sourceTodo.id, sourceSessionId, {
        targetTodoId,
        tool,
        newInstruction,
        keepLastTurns,
        summarize,
      })
      setPreview(r.prompt)
      return r
    } catch (e: any) {
      message.error(e?.message || t('transcript:forkDialog.previewFailed'))
    } finally {
      setLoading(false)
    }
  }

  const handleOk = async () => {
    if (!sourceTodo || !sourceSessionId) return
    setLoading(true)
    try {
      const r = await forkAiSession(sourceTodo.id, sourceSessionId, {
        targetTodoId,
        tool,
        newInstruction,
        keepLastTurns,
        summarize,
      })
      onConfirm({ prompt: r.prompt, targetTodoId: r.targetTodoId, tool: r.tool, cwd: r.cwd })
    } catch (e: any) {
      message.error(e?.message || t('transcript:forkDialog.forkFailed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      open={open}
      title={t('transcript:forkDialog.title')}
      onCancel={onCancel}
      onOk={handleOk}
      okText={t('transcript:forkDialog.okText')}
      confirmLoading={loading}
      width={720}
      destroyOnClose
    >
      <Spin spinning={loading}>
        <Form layout="vertical" size="small">
          <Form.Item label={t('transcript:forkDialog.toolLabel')}>
            <Select value={tool} onChange={setTool} options={[
              { value: 'claude', label: toolOptionLabel('claude', 'Claude') },
              { value: 'codex', label: toolOptionLabel('codex', 'Codex') },
              { value: 'cursor', label: toolOptionLabel('cursor', 'Cursor') },
            ]} />
          </Form.Item>
          <Form.Item label={t('transcript:forkDialog.targetTodoLabel')}>
            <Select
              value={targetTodoId}
              onChange={setTargetTodoId}
              showSearch
              optionFilterProp="label"
              options={todos.map(td => ({ value: td.id, label: t('transcript:forkDialog.todoOption', { quadrant: td.quadrant, title: td.title }) }))}
            />
          </Form.Item>
          <Form.Item label={t('transcript:forkDialog.keepLastTurnsLabel', { count: keepLastTurns })}>
            <Slider min={0} max={20} value={keepLastTurns} onChange={setKeepLastTurns} />
          </Form.Item>
          <Form.Item label={t('transcript:forkDialog.summarizeLabel')}>
            <Switch checked={summarize} onChange={setSummarize} />
          </Form.Item>
          <Form.Item label={t('transcript:forkDialog.newInstructionLabel')}>
            <Input.TextArea
              rows={3}
              value={newInstruction}
              onChange={e => setNewInstruction(e.target.value)}
              placeholder={t('transcript:forkDialog.newInstructionPlaceholder')}
            />
          </Form.Item>
          <Form.Item>
            <Button onClick={generatePreview} loading={loading}>{t('transcript:forkDialog.generatePreview')}</Button>
          </Form.Item>
          {preview && (
            <Form.Item label={t('transcript:forkDialog.previewLabel')}>
              <Input.TextArea rows={10} value={preview} readOnly style={{ fontSize: 12, fontFamily: 'ui-monospace, Menlo, monospace' }} />
            </Form.Item>
          )}
        </Form>
      </Spin>
    </Modal>
  )
}
