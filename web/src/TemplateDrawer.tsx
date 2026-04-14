import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Drawer, Button, Space, List, Tag, Modal, Form, Input, message, Popconfirm, Empty, Tooltip, Typography,
} from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, CopyOutlined, EyeOutlined } from '@ant-design/icons'
import {
  listTemplates, createTemplate, updateTemplate, deleteTemplate,
  PromptTemplate,
} from './api'
import { renderTemplate } from './promptRender'

const { TextArea } = Input
const { Paragraph, Text } = Typography

const EXAMPLE_VARS: Record<string, string> = {
  title: '示例待办标题',
  description: '示例待办描述',
  workDir: '/Users/demo/project',
  quadrant: 'Q1（重要且紧急）',
  dueDate: '2026-04-20',
}

const VARIABLE_HINTS = [
  { key: 'title', label: '待办标题' },
  { key: 'description', label: '待办描述' },
  { key: 'workDir', label: '工作目录' },
  { key: 'quadrant', label: '象限' },
  { key: 'dueDate', label: '截止日期' },
]

interface Props {
  open: boolean
  onClose: () => void
  onChanged?: () => void
}

export default function TemplateDrawer({ open, onClose, onChanged }: Props) {
  const [list, setList] = useState<PromptTemplate[]>([])
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState<PromptTemplate | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [form] = Form.useForm()
  const [previewContent, setPreviewContent] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setList(await listTemplates())
    } catch (e: any) {
      message.error(e?.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { if (open) refresh() }, [open, refresh])

  const handleNew = () => {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({ name: '', description: '', content: '' })
    setPreviewContent('')
    setEditorOpen(true)
  }

  const handleEdit = (t: PromptTemplate) => {
    setEditing(t)
    form.setFieldsValue({ name: t.name, description: t.description, content: t.content })
    setPreviewContent(t.content)
    setEditorOpen(true)
  }

  const handleCopy = async (t: PromptTemplate) => {
    try {
      await createTemplate({
        name: `${t.name} (副本)`,
        description: t.description,
        content: t.content,
      })
      message.success('已复制为我的模板')
      refresh()
      onChanged?.()
    } catch (e: any) {
      message.error(e?.message || '复制失败')
    }
  }

  const handleDelete = async (t: PromptTemplate) => {
    try {
      await deleteTemplate(t.id)
      message.success('已删除')
      refresh()
      onChanged?.()
    } catch (e: any) {
      message.error(e?.message || '删除失败')
    }
  }

  const handleSave = async () => {
    try {
      const values = await form.validateFields()
      if (editing) {
        await updateTemplate(editing.id, values)
        message.success('已保存')
      } else {
        await createTemplate(values)
        message.success('已创建')
      }
      setEditorOpen(false)
      refresh()
      onChanged?.()
    } catch (e: any) {
      if (e?.errorFields) return
      message.error(e?.message || '保存失败')
    }
  }

  const previewRendered = useMemo(() => renderTemplate(previewContent || '', EXAMPLE_VARS), [previewContent])

  const insertVar = (key: string) => {
    const cur = form.getFieldValue('content') || ''
    form.setFieldsValue({ content: `${cur}{{${key}}}` })
    setPreviewContent(`${cur}{{${key}}}`)
  }

  return (
    <>
      <Drawer
        title="Prompt 模板库"
        open={open}
        onClose={onClose}
        width={560}
        extra={<Button type="primary" icon={<PlusOutlined />} onClick={handleNew}>新建模板</Button>}
      >
        {list.length === 0 && !loading ? (
          <Empty description="暂无模板" />
        ) : (
          <List
            loading={loading}
            dataSource={list}
            renderItem={t => (
              <List.Item
                actions={[
                  <Tooltip title="复制为我的模板" key="copy">
                    <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => handleCopy(t)} />
                  </Tooltip>,
                  <Tooltip title={t.builtin ? '内置模板不可编辑，可复制后修改' : '编辑'} key="edit">
                    <Button type="text" size="small" icon={<EditOutlined />} disabled={t.builtin} onClick={() => handleEdit(t)} />
                  </Tooltip>,
                  <Popconfirm key="del" title="确认删除？" disabled={t.builtin} onConfirm={() => handleDelete(t)}>
                    <Tooltip title={t.builtin ? '内置模板不可删除' : '删除'}>
                      <Button type="text" size="small" danger icon={<DeleteOutlined />} disabled={t.builtin} />
                    </Tooltip>
                  </Popconfirm>,
                ]}
              >
                <List.Item.Meta
                  title={
                    <Space>
                      <span>{t.name}</span>
                      {t.builtin && <Tag color="blue">内置</Tag>}
                    </Space>
                  }
                  description={
                    <Space direction="vertical" size={2} style={{ width: '100%' }}>
                      {t.description && <Text type="secondary">{t.description}</Text>}
                      <Paragraph type="secondary" ellipsis={{ rows: 2 }} style={{ margin: 0, fontSize: 12 }}>
                        {t.content}
                      </Paragraph>
                    </Space>
                  }
                />
              </List.Item>
            )}
          />
        )}
      </Drawer>

      <Modal
        title={editing ? `编辑模板：${editing.name}` : '新建模板'}
        open={editorOpen}
        onCancel={() => setEditorOpen(false)}
        onOk={handleSave}
        width={720}
        okText="保存"
        cancelText="取消"
      >
        <Form form={form} layout="vertical" size="small" onValuesChange={(_, all) => setPreviewContent(all.content || '')}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="如：Bug 修复" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input placeholder="简短说明此模板的用途（可选）" />
          </Form.Item>
          <Form.Item label="可用变量（点击插入）">
            <Space wrap>
              {VARIABLE_HINTS.map(v => (
                <Tag key={v.key} style={{ cursor: 'pointer' }} onClick={() => insertVar(v.key)}>
                  {`{{${v.key}}}`} — {v.label}
                </Tag>
              ))}
            </Space>
          </Form.Item>
          <Form.Item name="content" label="模板内容" rules={[{ required: true, message: '请输入内容' }]}>
            <TextArea rows={8} placeholder="可使用 {{title}} {{description}} {{workDir}} {{quadrant}} {{dueDate}} 占位符" />
          </Form.Item>
          <Form.Item label={<Space><EyeOutlined />预览（使用示例变量填充）</Space>}>
            <div style={{
              padding: 8, borderRadius: 4, background: '#fafafa',
              border: '1px solid #f0f0f0', whiteSpace: 'pre-wrap',
              fontSize: 12, maxHeight: 200, overflow: 'auto',
            }}>
              {previewRendered || <Text type="secondary">（空）</Text>}
            </div>
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}
