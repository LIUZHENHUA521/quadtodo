import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider, App as AntdApp } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import './design/tokens.css'
import '@xterm/xterm/css/xterm.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/700.css'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import './TodoManage.css'
import './mobile.css'
import TodoManage from './TodoManage'
import { ThemeProvider, useTheme } from './design/ThemeProvider'
import { getAntdTheme } from './design/antd-theme'
import { useGlobalShortcuts } from './design/useGlobalShortcuts'
import { CommandPalette } from './components/CommandPalette'
import { SessionFocus } from './components/SessionFocus'

dayjs.locale('zh-cn')

function ThemedApp() {
  const { mode } = useTheme()
  useGlobalShortcuts()
  return (
    <ConfigProvider locale={zhCN} theme={getAntdTheme(mode)}>
      <AntdApp message={{ maxCount: 3 }}>
        <TodoManage />
        <CommandPalette />
        <SessionFocus />
      </AntdApp>
    </ConfigProvider>
  )
}

const root = document.getElementById('root')!
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ThemeProvider>
      <ThemedApp />
    </ThemeProvider>
  </React.StrictMode>,
)
