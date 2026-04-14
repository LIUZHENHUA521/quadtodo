import React, { useState } from 'react'
import { Drawer, Tabs } from 'antd'
import LiveGlanceTab from './LiveGlanceTab'
import HistoryStatsTab from './HistoryStatsTab'
import ResourceTab from './ResourceTab'

export default function DashboardDrawer({
  open,
  onClose,
  onOpenTerminal,
  onStop,
}: {
  open: boolean
  onClose: () => void
  onOpenTerminal?: (sessionId: string, todoId: string) => void
  onStop?: (sessionId: string) => void
}) {
  const [tab, setTab] = useState('live')

  return (
    <Drawer
      title="AI 工作面板"
      placement="right"
      width={420}
      open={open}
      onClose={onClose}
      destroyOnClose={false}
      styles={{ body: { padding: 12 } }}
    >
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'live',
            label: '实时一瞥',
            children: <LiveGlanceTab onOpenTerminal={onOpenTerminal} onStop={onStop} />,
          },
          {
            key: 'stats',
            label: '历史统计',
            children: <HistoryStatsTab />,
          },
          {
            key: 'resource',
            label: '资源占用',
            children: <ResourceTab active={open && tab === 'resource'} />,
          },
        ]}
      />
    </Drawer>
  )
}
