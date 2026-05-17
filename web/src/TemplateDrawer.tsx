import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Drawer, Button, Space, List, Tag, Modal, Form, Input, Popconfirm, Empty, Tooltip, Typography,
} from 'antd'
import { useTranslation } from 'react-i18next'
import { useAppMessages } from './design/useAppMessages'
import { PlusOutlined, EditOutlined, DeleteOutlined, CopyOutlined, EyeOutlined } from '@ant-design/icons'
import {
  listTemplates, createTemplate, updateTemplate, deleteTemplate,
  PromptTemplate,
} from './api'
import { renderTemplate } from './promptRender'

const { TextArea } = Input
const { Paragraph, Text } = Typography

interface Props {
  open: boolean
  onClose: () => void
  onChanged?: () => void
}

export default function TemplateDrawer({ open, onClose, onChanged }: Props) {
  const { t } = useTranslation(['settings'])
  const { message } = useAppMessages()

  const EXAMPLE_VARS: Record<string, string> = {
    title: t('settings:template.example.title'),
    description: t('settings:template.example.description'),
    workDir: '/Users/demo/project',
    // quadrant 已退役：不再作为可用变量；老 agent prompt 里残留的 {{quadrant}}
    // 会渲染成空串（prompt-render 端兼容处理）。
    dueDate: '2026-04-20',
  }

  const VARIABLE_HINTS = [
    { key: 'title', label: t('settings:template.variable.title') },
    { key: 'description', label: t('settings:template.variable.description') },
    { key: 'workDir', label: t('settings:template.variable.workDir') },
    { key: 'dueDate', label: t('settings:template.variable.dueDate') },
  ]
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
      message.error(e?.message || t('settings:template.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [t])

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

  const handleCopy = async (tpl: PromptTemplate) => {
    try {
      await createTemplate({
        name: t('settings:template.copySuffix', { name: tpl.name }),
        description: tpl.description,
        content: tpl.content,
      })
      message.success(t('settings:template.copiedOk'))
      refresh()
      onChanged?.()
    } catch (e: any) {
      message.error(e?.message || t('settings:template.copyFailed'))
    }
  }

  const handleDelete = async (tpl: PromptTemplate) => {
    try {
      await deleteTemplate(tpl.id)
      message.success(t('settings:template.deletedOk'))
      refresh()
      onChanged?.()
    } catch (e: any) {
      message.error(e?.message || t('settings:template.deleteFailed'))
    }
  }

  const handleSave = async () => {
    try {
      const values = await form.validateFields()
      if (editing) {
        await updateTemplate(editing.id, values)
        message.success(t('settings:template.savedOk'))
      } else {
        await createTemplate(values)
        message.success(t('settings:template.createdOk'))
      }
      setEditorOpen(false)
      refresh()
      onChanged?.()
    } catch (e: any) {
      if (e?.errorFields) return
      message.error(e?.message || t('settings:template.saveFailed'))
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
        title={t('settings:template.drawerTitle')}
        open={open}
        onClose={onClose}
        width={560}
        extra={<Button type="primary" icon={<PlusOutlined />} onClick={handleNew}>{t('settings:template.newTemplate')}</Button>}
      >
        {list.length === 0 && !loading ? (
          <Empty description={t('settings:template.emptyList')} />
        ) : (
          <List
            loading={loading}
            dataSource={list}
            renderItem={tpl => (
              <List.Item
                actions={[
                  <Tooltip title={t('settings:template.copyForMe')} key="copy">
                    <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => handleCopy(tpl)} />
                  </Tooltip>,
                  <Tooltip title={t('settings:template.editTooltip')} key="edit">
                    <Button type="text" size="small" icon={<EditOutlined />} onClick={() => handleEdit(tpl)} />
                  </Tooltip>,
                  <Popconfirm key="del" title={t('settings:template.deleteConfirm')} disabled={tpl.builtin} onConfirm={() => handleDelete(tpl)}>
                    <Tooltip title={tpl.builtin ? t('settings:template.builtinTooltipDelete') : t('settings:template.deleteTooltip')}>
                      <Button type="text" size="small" danger icon={<DeleteOutlined />} disabled={tpl.builtin} />
                    </Tooltip>
                  </Popconfirm>,
                ]}
              >
                <List.Item.Meta
                  title={
                    <Space>
                      <span>{tpl.name}</span>
                      {tpl.builtin && <Tag color="blue">{t('settings:template.builtinTag')}</Tag>}
                    </Space>
                  }
                  description={
                    <Space direction="vertical" size={2} style={{ width: '100%' }}>
                      {tpl.description && <Text type="secondary">{tpl.description}</Text>}
                      <Paragraph type="secondary" ellipsis={{ rows: 2 }} style={{ margin: 0, fontSize: 12 }}>
                        {tpl.content}
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
        title={editing ? t('settings:template.editTitle', { name: editing.name }) : t('settings:template.newTitle')}
        open={editorOpen}
        onCancel={() => setEditorOpen(false)}
        onOk={handleSave}
        width={720}
        okText={t('settings:template.okText')}
        cancelText={t('settings:template.cancelText')}
      >
        <Form form={form} layout="vertical" size="small" onValuesChange={(_, all) => setPreviewContent(all.content || '')}>
          <Form.Item name="name" label={t('settings:template.nameLabel')} rules={[{ required: true, message: t('settings:template.nameRequired') }]}>
            <Input placeholder={t('settings:template.namePlaceholder')} />
          </Form.Item>
          <Form.Item name="description" label={t('settings:template.descLabel')}>
            <Input placeholder={t('settings:template.descPlaceholder')} />
          </Form.Item>
          <Form.Item label={t('settings:template.variablesLabel')}>
            <Space wrap>
              {VARIABLE_HINTS.map(v => (
                <Tag key={v.key} style={{ cursor: 'pointer' }} onClick={() => insertVar(v.key)}>
                  {`{{${v.key}}}`} — {v.label}
                </Tag>
              ))}
            </Space>
          </Form.Item>
          <Form.Item name="content" label={t('settings:template.contentLabel')} rules={[{ required: true, message: t('settings:template.contentRequired') }]}>
            <TextArea rows={8} placeholder={t('settings:template.contentPlaceholder', { t: '{{title}}', d: '{{description}}', w: '{{workDir}}', u: '{{dueDate}}' })} />
          </Form.Item>
          <Form.Item label={<Space><EyeOutlined />{t('settings:template.previewLabel')}</Space>}>
            <div style={{
              padding: 8, borderRadius: 4,
              background: 'var(--surface-2)',
              border: '1px solid var(--border-default)',
              color: 'var(--text-primary)',
              whiteSpace: 'pre-wrap',
              fontSize: 12, maxHeight: 200, overflow: 'auto',
            }}>
              {previewRendered || <Text type="secondary">{t('settings:template.previewEmpty')}</Text>}
            </div>
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}
