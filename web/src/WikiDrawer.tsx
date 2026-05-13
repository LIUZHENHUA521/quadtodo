import { useCallback, useEffect, useMemo, useState } from 'react'
import { Drawer, Button, Checkbox, Empty, Spin, Space, Tag, Alert } from 'antd'
import { useTranslation } from 'react-i18next'
import { useAppMessages } from './design/useAppMessages'
import { FolderOpenOutlined, SyncOutlined, FileTextOutlined, BookOutlined } from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { markdownComponents } from './markdownComponents'
import dayjs from 'dayjs'
import {
  getWikiStatus, getWikiPending, getWikiTree, getWikiFile, runWiki, openWikiDir,
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
  const { t } = useTranslation(['wiki'])
  const { message, modal } = useAppMessages()
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
      message.error(t('wiki:loadFailed', { msg: e.message }))
    } finally { setLoadingTree(false) }
  }, [])

  useEffect(() => { if (open) refresh() }, [open, refresh])

  useEffect(() => {
    if (!activePath) { setContent(''); return }
    let cancelled = false
    setLoadingContent(true)
    getWikiFile(activePath)
      .then((c) => { if (!cancelled) setContent(c) })
      .catch((e) => { if (!cancelled) { message.error(t('wiki:readFileFailed', { msg: e.message })); setContent('') } })
      .finally(() => { if (!cancelled) setLoadingContent(false) })
    return () => { cancelled = true }
  }, [activePath])

  const handleRun = async (dryRun: boolean) => {
    if (selected.size === 0) {
      message.warning(t('wiki:needPick'))
      return
    }
    const ids = [...selected]
    const label = dryRun ? t('wiki:labelRunDry') : t('wiki:labelRunFull')
    setRunning(true)
    try {
      const res = await runWiki({ todoIds: ids, dryRun })
      message.success(t('wiki:runOk', { label, written: res.sourcesWritten, exit: res.exitCode }))
      setSelected(new Set())
      await refresh()
    } catch (e: any) {
      message.error(t('wiki:runFail', { label, msg: e.message }))
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

  const openInFinder = async () => {
    try {
      await openWikiDir()
    } catch (e: any) {
      message.error(t('wiki:openDirFailed', { msg: e.message }))
    }
  }

  const lastRunStatusText = status?.lastRun
    ? (status.lastRun.error
      ? ` · ${t('wiki:lastRunStatus.failed')}`
      : status.lastRun.dry_run
        ? ` · ${t('wiki:lastRunStatus.dryRun')}`
        : ` · ${t('wiki:lastRunStatus.success')}`)
    : ''
  const lastRunLabel = status?.lastRun
    ? t('wiki:lastRun', { time: `${dayjs(status.lastRun.started_at).format('MM-DD HH:mm')}${lastRunStatusText}` })
    : t('wiki:lastRunNever')

  return (
    <Drawer
      title={<span><BookOutlined style={{ marginRight: 6 }} />{t('wiki:drawerTitle')}</span>}
      open={open}
      onClose={onClose}
      width={1100}
      extra={
        <Space>
          <Tag>{lastRunLabel}</Tag>
          <Button icon={<SyncOutlined />} onClick={refresh} loading={loadingTree}>{t('wiki:refresh')}</Button>
          <Button icon={<FolderOpenOutlined />} onClick={openInFinder}>{t('wiki:openDir')}</Button>
        </Space>
      }
    >
      {status?.initState === 'exists-not-git' && (
        <Alert
          style={{ marginBottom: 12 }}
          type="error" showIcon
          message={t('wiki:alertNotGitTitle')}
          description={t('wiki:alertNotGitDesc', { dir: status.wikiDir })}
        />
      )}
      {status?.initState === 'git-failed' && (
        <Alert style={{ marginBottom: 12 }} type="warning" showIcon message={t('wiki:alertGitFailedTitle')} description={t('wiki:alertGitFailedDesc')} />
      )}

      <div className="wiki-pending-section">
        <div className="wiki-pending-title">
          {t('wiki:pendingTitle', { count: pending.length })}
          {pending.length > 0 && (
            <Button size="small" type="link" onClick={toggleAll}>
              {selected.size === pending.length ? t('wiki:clearAll') : t('wiki:selectAll')}
            </Button>
          )}
        </div>
        {pending.length === 0 ? (
          <Empty description={t('wiki:emptyPending')} imageStyle={{ height: 40 }} />
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
            {t('wiki:runSelected', { count: selected.size })}
          </Button>
          <Button disabled={selected.size === 0} loading={running} onClick={() => {
            modal.confirm({
              title: t('wiki:dryRunConfirmTitle'),
              content: t('wiki:dryRunConfirmContent'),
              onOk: () => handleRun(true),
            })
          }}>{t('wiki:runDryOnly')}</Button>
        </Space>
      </div>

      <div className="wiki-drawer-body">
        <div className="wiki-tree-pane">
          {loadingTree ? <Spin /> : (
            <>
              <TreeSection title={t('wiki:treeSection.topLevel')} files={groups.topLevel} active={activePath} onPick={setActivePath} />
              <TreeSection title={t('wiki:treeSection.topics')} files={groups.topics} active={activePath} onPick={setActivePath} />
              <TreeSection title={t('wiki:treeSection.projects')} files={groups.projects} active={activePath} onPick={setActivePath} />
              <TreeSection title={t('wiki:treeSection.sources')} files={groups.sources} active={activePath} onPick={setActivePath} />
            </>
          )}
        </div>
        <div className="wiki-content-pane">
          {!activePath ? (
            <div className="wiki-content-empty">{t('wiki:contentEmpty')}</div>
          ) : loadingContent ? (
            <Spin />
          ) : (
            <div className="wiki-content-md">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{content}</ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </Drawer>
  )
}
