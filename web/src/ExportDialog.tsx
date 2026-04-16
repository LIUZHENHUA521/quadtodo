import React, { useEffect, useState } from 'react'
import { Modal, Segmented, Button, Input, Space, message, Typography } from 'antd'
import { CopyOutlined, DownloadOutlined, ShareAltOutlined } from '@ant-design/icons'
import type { Todo } from './api'

type TurnsMode = 'summary' | 'full' | 'none'

interface Props {
	todo: Todo | null
	open: boolean
	onClose: () => void
}

const LARK_PROMPT_PREFIX = '请把下面的 Markdown 推送到飞书（调用 lark-doc skill，创建新文档）：\n\n'

export default function ExportDialog({ todo, open, onClose }: Props) {
	const [turns, setTurns] = useState<TurnsMode>('summary')
	const [markdown, setMarkdown] = useState('')
	const [loading, setLoading] = useState(false)

	useEffect(() => {
		if (!open || !todo) return
		let cancelled = false
		setLoading(true)
		fetch(`/api/todos/${todo.id}/export.md?turns=${turns}`)
			.then(r => r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)))
			.then(text => { if (!cancelled) setMarkdown(text) })
			.catch(e => { if (!cancelled) message.error(`加载失败：${e.message}`) })
			.finally(() => { if (!cancelled) setLoading(false) })
		return () => { cancelled = true }
	}, [open, todo, turns])

	const copy = async (text: string, hint: string) => {
		try {
			await navigator.clipboard.writeText(text)
			message.success(hint)
		} catch (e: any) {
			message.error(`复制失败：${e?.message || '未授权访问剪贴板'}`)
		}
	}

	const download = () => {
		if (!todo) return
		const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
		const url = URL.createObjectURL(blob)
		const a = document.createElement('a')
		a.href = url
		a.download = `${todo.title.replace(/[\\/:*?"<>|]/g, '_')}.md`
		document.body.appendChild(a)
		a.click()
		document.body.removeChild(a)
		URL.revokeObjectURL(url)
	}

	return (
		<Modal
			open={open}
			onCancel={onClose}
			title={todo ? `导出：${todo.title}` : '导出'}
			width={760}
			footer={null}
			destroyOnClose
		>
			<Space direction="vertical" style={{ width: '100%' }} size="middle">
				<div>
					<Typography.Text type="secondary">会话内容</Typography.Text>
					<div style={{ marginTop: 6 }}>
						<Segmented
							value={turns}
							onChange={(v) => setTurns(v as TurnsMode)}
							options={[
								{ label: '节选（折叠）', value: 'summary' },
								{ label: '完整对话', value: 'full' },
								{ label: '仅元信息', value: 'none' },
							]}
						/>
					</div>
				</div>

				<Input.TextArea
					value={markdown}
					onChange={(e) => setMarkdown(e.target.value)}
					autoSize={{ minRows: 12, maxRows: 24 }}
					style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}
					placeholder={loading ? '生成中…' : ''}
				/>

				<Space wrap>
					<Button
						icon={<CopyOutlined />}
						onClick={() => copy(markdown, '已复制 Markdown')}
						disabled={loading || !markdown}
					>复制 Markdown</Button>
					<Button
						icon={<DownloadOutlined />}
						onClick={download}
						disabled={loading || !markdown}
					>下载 .md</Button>
					<Button
						icon={<ShareAltOutlined />}
						onClick={() => copy(LARK_PROMPT_PREFIX + markdown, '已复制推送提示，粘贴到 Claude 对话即可推到飞书')}
						disabled={loading || !markdown}
						type="primary"
					>推送到飞书（复制提示）</Button>
				</Space>
				<Typography.Text type="secondary" style={{ fontSize: 12 }}>
					飞书推送：点「推送到飞书」会把 Markdown + 提示语复制到剪贴板，粘贴到 Claude Code 对话里，Claude 会调用 lark-doc skill 创建飞书文档。
				</Typography.Text>
			</Space>
		</Modal>
	)
}
