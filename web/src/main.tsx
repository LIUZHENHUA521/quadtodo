import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import '@xterm/xterm/css/xterm.css'
import './TodoManage.css'
import TodoManage from './TodoManage'

dayjs.locale('zh-cn')

const root = document.getElementById('root')!
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN}>
      <TodoManage />
    </ConfigProvider>
  </React.StrictMode>,
)
