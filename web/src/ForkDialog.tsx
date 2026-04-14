import React, { useEffect, useState } from 'react'
import { Modal, Form, Select, Slider, Switch, Input, Button, message, Spin } from 'antd'
import { AiTool, Todo, forkAiSession } from './api'

interface Props {
  open: boolean
  sourceTodo: Todo | null
  sourceSessionId: string | null
  todos: Todo[]
  onCancel: () => void
  onConfirm: (result: { prompt: string; targetTodoId: string; tool: AiTool; cwd: string | null }) => void
}

export default function ForkDialog({ open, sourceTodo, sourceSessionId, todos, onCancel, onConfirm }: Props) {
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
      message.error(e?.message || 'Fork 预览失败')
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
      message.error(e?.message || 'Fork 失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      open={open}
      title="从当前会话 Fork 新对话"
      onCancel={onCancel}
      onOk={handleOk}
      okText="确认 Fork 并启动"
      confirmLoading={loading}
      width={720}
      destroyOnClose
    >
      <Spin spinning={loading}>
        <Form layout="vertical" size="small">
          <Form.Item label="工具">
            <Select value={tool} onChange={setTool} options={[
              { value: 'claude', label: 'Claude' },
              { value: 'codex', label: 'Codex' },
            ]} />
          </Form.Item>
          <Form.Item label="目标待办">
            <Select
              value={targetTodoId}
              onChange={setTargetTodoId}
              showSearch
              optionFilterProp="label"
              options={todos.map(t => ({ value: t.id, label: `[Q${t.quadrant}] ${t.title}` }))}
            />
          </Form.Item>
          <Form.Item label={`保留最后 ${keepLastTurns} 轮原始对话`}>
            <Slider min={0} max={20} value={keepLastTurns} onChange={setKeepLastTurns} />
          </Form.Item>
          <Form.Item label="对更早的对话自动生成摘要">
            <Switch checked={summarize} onChange={setSummarize} />
          </Form.Item>
          <Form.Item label="新指令（可选）">
            <Input.TextArea
              rows={3}
              value={newInstruction}
              onChange={e => setNewInstruction(e.target.value)}
              placeholder="继续推进的新需求 / 调整方向..."
            />
          </Form.Item>
          <Form.Item>
            <Button onClick={generatePreview} loading={loading}>生成 Prompt 预览</Button>
          </Form.Item>
          {preview && (
            <Form.Item label="Prompt 预览">
              <Input.TextArea rows={10} value={preview} readOnly style={{ fontSize: 12, fontFamily: 'ui-monospace, Menlo, monospace' }} />
            </Form.Item>
          )}
        </Form>
      </Spin>
    </Modal>
  )
}
