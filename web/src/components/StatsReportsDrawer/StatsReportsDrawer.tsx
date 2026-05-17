import { useEffect, useState } from 'react'
import { Drawer, Tabs, Grid, Modal } from 'antd'
import { LineChartOutlined, TrophyOutlined } from '@ant-design/icons'
import { useDispatchStore } from '../../store/dispatchStore'
import { useDrawerStack } from '../../hooks/useDrawerStack'
import { StatsPanel } from './StatsPanel'
import { ReportPanel } from './ReportPanel'

const { useBreakpoint } = Grid

type TabKey = 'stats' | 'reports'

/**
 * StatsReportsDrawer — single drawer that hosts both the AI usage stats panel
 * and the completion report panel under AntD <Tabs>.
 *
 * Driven by the unified `statsReports` flag in dispatchStore. For backwards
 * compat we also open when legacy `stats` / `report` flags are set (M2 callers).
 */
export function StatsReportsDrawer() {
  const open = useDispatchStore(
    (s) => s.statsReports || s.stats || s.report,
  )
  const closeDrawer = useDispatchStore((s) => s.closeDrawer)
  const screens = useBreakpoint()
  const isMobile = !screens.md

  const [activeTab, setActiveTab] = useState<TabKey>('stats')

  // When the drawer opens via the legacy `report` flag (e.g. topbar 📊 button)
  // default to the Reports tab; otherwise default to Stats.
  useEffect(() => {
    if (!open) return
    const s = useDispatchStore.getState()
    if (s.report && !s.stats && !s.statsReports) setActiveTab('reports')
    else setActiveTab('stats')
    // We only want this on the open transition; not on each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useDrawerStack('statsReports', open, () => handleClose())

  function handleClose() {
    // Clear every flag that could have opened this drawer.
    closeDrawer('statsReports')
    closeDrawer('stats')
    closeDrawer('report')
  }

  const title = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 600 }}>
      {activeTab === 'stats'
        ? <LineChartOutlined />
        : <TrophyOutlined style={{ color: 'var(--heat-base)' }} />}
      数据 & 报告
    </span>
  )

  const body = (
    <Tabs
      activeKey={activeTab}
      onChange={(k) => setActiveTab(k as TabKey)}
      items={[
        {
          key: 'stats',
          label: <span><LineChartOutlined style={{ marginRight: 4 }} />AI 统计</span>,
          children: <StatsPanel active={open && activeTab === 'stats'} />,
        },
        {
          key: 'reports',
          label: <span><TrophyOutlined style={{ marginRight: 4 }} />完成报表</span>,
          children: <ReportPanel active={open && activeTab === 'reports'} />,
        },
      ]}
    />
  )

  if (isMobile) {
    return (
      <Modal
        open={open}
        onCancel={handleClose}
        title={title}
        footer={null}
        width="100%"
        style={{ top: 0, maxWidth: '100vw', margin: 0, paddingBottom: 0 }}
        styles={{ body: { maxHeight: 'calc(100vh - 60px)', overflowY: 'auto', padding: 12 } }}
      >
        {body}
      </Modal>
    )
  }

  return (
    <Drawer
      open={open}
      onClose={handleClose}
      width="min(720px, 100vw)"
      title={title}
      styles={{ body: { overflowX: 'hidden', paddingTop: 8 } }}
    >
      {body}
    </Drawer>
  )
}
