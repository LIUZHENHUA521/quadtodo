import React from 'react'
import { Modal, Button } from 'antd'
import { EditOutlined, RobotOutlined, CheckCircleOutlined } from '@ant-design/icons'
import './onboarding.css'

interface WelcomeModalProps {
  open: boolean
  onClose: () => void
}

export function WelcomeModal({ open, onClose }: WelcomeModalProps) {
  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      centered
      width={520}
      closable
      maskClosable
      keyboard
      className="welcome-modal"
      rootClassName="welcome-modal-root"
      destroyOnClose
    >
      <div className="welcome-modal__body">
        <h2 className="welcome-modal__title">欢迎使用 AgentQuad</h2>
        <p className="welcome-modal__subtitle">
          按状态分列的 AI 调度台 —— 每个待办都能派 agent 干活，本地跑 Claude / Codex / Cursor
        </p>
        <ol className="welcome-modal__steps">
          <li>
            <span className="welcome-modal__step-icon"><EditOutlined /></span>
            <span className="welcome-modal__step-label">新建待办</span>
            <span className="welcome-modal__step-desc">标题写你想做的事</span>
          </li>
          <li>
            <span className="welcome-modal__step-icon"><RobotOutlined /></span>
            <span className="welcome-modal__step-label">派活给 Agent</span>
            <span className="welcome-modal__step-desc">在卡片上点「派活」选员工</span>
          </li>
          <li>
            <span className="welcome-modal__step-icon"><CheckCircleOutlined /></span>
            <span className="welcome-modal__step-label">按状态跟进</span>
            <span className="welcome-modal__step-desc">看板自动分到 运行中 / 需确认 / 已空闲</span>
          </li>
        </ol>
        <Button
          type="primary"
          size="large"
          onClick={onClose}
          className="welcome-modal__cta"
        >
          开始使用
        </Button>
      </div>
    </Modal>
  )
}

export default WelcomeModal
