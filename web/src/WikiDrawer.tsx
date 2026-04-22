import { useCallback, useEffect, useMemo, useState } from 'react'
import { Drawer, Button, Checkbox, Empty, Spin, Space, Tag, Alert, message, Modal } from 'antd'
import { FolderOpenOutlined, SyncOutlined, FileTextOutlined, BookOutlined } from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import dayjs from 'dayjs'
import {
  getWikiStatus, getWikiPending, getWikiTree, getWikiFile, runWiki,
  WikiStatus, WikiFile, WikiPendingTodo,
} from './api'
import './WikiDrawer.css'

type TreeGroups = { topLevel: WikiFile[]; topics: WikiFile[]; projects: WikiFile[]; sources: WikiFile[] }

function groupTree(files: WikiFile[]): TreeGroups {
  const out: TreeGroups = { topLevel: [], topics: [], projects: [], sources: [] }
  for (const f of files) {
    if (f.type === 'dir') continue
    if (f.path.startsWith('topics/')) out.topics.push(f)
    else if (f.path.startsWith('projects/')) out.projects.push(f)
    else if (f.path.startsWith('sources/')) out.sources.push(f)
    else if (!f.path.includes('/')) out.topLevel.push(f)
  }
  const byName = (a: WikiFile, b: WikiFile) => a.path.localeCompare(b.path)
  out.topLevel.sort(byName); out.topics.sort(byName)
  out.projects.sort(byName); out.sources.sort((a, b) => b.path.localeCompare(a.path))
  return out
}

function TreeSection({
  title, files, active, onPick,
}: { title: string; files: WikiFile[]; active: string | null; onPick: (p: string) => void }) {
  if (!files.length) return null
  return (
    <div className="wiki-tree-section">
      <div className="wiki-tree-section-title">{title}</div>
      {files.map((f) => (
        <div
          key={f.path}
          className={`wiki-tree-item${active === f.path ? ' active' : ''}`}
          onClick={() => onPick(f.path)}
          title={f.path}
        >
          <FileTextOutlined style={{ marginRight: 4, fontSize: 12 }} />
          {f.path.split('/').pop()}
        </div>
      ))}
    </div>
  )
}

export default function WikiDrawer({
  open, onClose,
}: { open: boolean; onClose: () => void }) {
  const [status, setStatus] = useState<WikiStatus | null>(null)
  const [pending, setPending] = useState<WikiPendingTodo[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [tree, setTree] = useState<WikiFile[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [content, setContent] = useState<string>('')
  const [loadingTree, setLoadingTree] = useState(false)
  const [loadingContent, setLoadingContent] = useState(false)
  const [running, setRunning] = useState(false)

  const groups = useMemo(() => groupTree(tree), [tree])

  const refresh = useCallback(async () => {
    setLoadingTree(true)
    try {
      const [s, p, t] = await Promise.all([getWikiStatus(), getWikiPending(), getWikiTree()])
      setStatus(s); setPending(p); setTree(t)
    } catch (e: any) {
      message.error(`加载 wiki 失败：${e.message}`)
    } finally { setLoadingTree(false) }
  }, [])

  useEffect(() => { if (open) refresh() }, [open, refresh])

  useEffect(() => {
    if (!activePath) { setContent(''); return }
    let cancelled = false
    setLoadingContent(true)
    getWikiFile(activePath)
      .then((c) => { if (!cancelled) setContent(c) })
      .catch((e) => { if (!cancelled) { message.error(`读取文件失败：${e.message}`); setContent('') } })
      .finally(() => { if (!cancelled) setLoadingContent(false) })
    return () => { cancelled = true }
  }, [activePath])

  const handleRun = async (dryRun: boolean) => {
    if (selected.size === 0) {
      message.warning('先勾选要沉淀的 todo')
      return
    }
    const ids = [...selected]
    const label = dryRun ? '只生成 sources' : '沉淀选中'
    setRunning(true)
    try {
      const res = await runWiki({ todoIds: ids, dryRun })
      message.success(`${label} 完成：写了 ${res.sourcesWritten} 个 source，exit ${res.exitCode}`)
      setSelected(new Set())
      await refresh()
    } catch (e: any) {
      message.error(`${label} 失败：${e.message}`)
    } finally { setRunning(false) }
  }

  const toggleAll = () => {
    setSelected(selected.size === pending.length ? new Set() : new Set(pending.map(p => p.id)))
  }
  const toggleOne = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id); else next.add(id)
    setSelected(next)
  }

  const openInFinder = () => {
    if (!status?.wikiDir) return
    window.open(`file://${status.wikiDir}`)
  }

  const lastRunLabel = status?.lastRun
    ? `上次沉淀：${dayjs(status.lastRun.started_at).format('MM-DD HH:mm')}${status.lastRun.error ? ' · 失败' : status.lastRun.dry_run ? ' · dry-run' : ' · 成功'}`
    : '从未沉淀'

  return (
    <Drawer
      title={<span><BookOutlined style={{ marginRight: 6 }} />记忆（Wiki）</span>}
      open={open}
      onClose={onClose}
      width={1100}
      extra={
        <Space>
          <Tag>{lastRunLabel}</Tag>
          <Button icon={<SyncOutlined />} onClick={refresh} loading={loadingTree}>刷新</Button>
          <Button icon={<FolderOpenOutlined />} onClick={openInFinder}>打开目录</Button>
        </Space>
      }
    >
      {status?.initState === 'exists-not-git' && (
        <Alert
          style={{ marginBottom: 12 }}
          type="error" showIcon
          message="wiki 目录已存在但不是 git 仓库"
          description={`为避免覆盖现有内容，自动初始化被拒绝。请进入 ${status.wikiDir} 处理（移走或 git init）`}
        />
      )}
      {status?.initState === 'git-failed' && (
        <Alert style={{ marginBottom: 12 }} type="warning" showIcon message="git init 失败" description="wiki 可用但没有 git 保护，误删无法回滚" />
      )}

      <div className="wiki-pending-section">
        <div className="wiki-pending-title">
          未沉淀 done todo（{pending.length}）
          {pending.length > 0 && (
            <Button size="small" type="link" onClick={toggleAll}>
              {selected.size === pending.length ? '清空' : '全选'}
            </Button>
          )}
        </div>
        {pending.length === 0 ? (
          <Empty description="全部 done todo 都已沉淀" imageStyle={{ height: 40 }} />
        ) : (
          pending.map((p) => (
            <div key={p.id} className="wiki-pending-row">
              <Checkbox checked={selected.has(p.id)} onChange={() => toggleOne(p.id)}>
                {p.title}
              </Checkbox>
              <span className="wiki-pending-meta">
                {p.workDir ? p.workDir.split('/').pop() : '-'} · {dayjs(p.completedAt).format('MM-DD')}
              </span>
            </div>
          ))
        )}
        <Space style={{ marginTop: 8 }}>
          <Button type="primary" disabled={selected.size === 0} loading={running} onClick={() => handleRun(false)}>
            沉淀选中（{selected.size}）
          </Button>
          <Button disabled={selected.size === 0} loading={running} onClick={() => {
            Modal.confirm({
              title: '只生成 sources（不调 LLM）',
              content: '用于预览素材规模；不会更新 topics/projects，选中 todo 仍显示在未沉淀列表。',
              onOk: () => handleRun(true),
            })
          }}>只生成 sources（预览）</Button>
        </Space>
      </div>

      <div className="wiki-drawer-body">
        <div className="wiki-tree-pane">
          {loadingTree ? <Spin /> : (
            <>
              <TreeSection title="顶层" files={groups.topLevel} active={activePath} onPick={setActivePath} />
              <TreeSection title="topics" files={groups.topics} active={activePath} onPick={setActivePath} />
              <TreeSection title="projects" files={groups.projects} active={activePath} onPick={setActivePath} />
              <TreeSection title="sources" files={groups.sources} active={activePath} onPick={setActivePath} />
            </>
          )}
        </div>
        <div className="wiki-content-pane">
          {!activePath ? (
            <div className="wiki-content-empty">选择左侧文件查看</div>
          ) : loadingContent ? (
            <Spin />
          ) : (
            <div className="wiki-content-md">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </Drawer>
  )
}
