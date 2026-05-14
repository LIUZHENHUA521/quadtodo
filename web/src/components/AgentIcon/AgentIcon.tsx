import type { AiTool } from '../../api'
import claudeIcon from '../../assets/agent-icons/claude.png'
import codexIcon from '../../assets/agent-icons/codex.png'
import cursorIcon from '../../assets/agent-icons/cursor.jpeg'
import './AgentIcon.css'

export interface AgentIconProps {
  tool: AiTool
  size?: number
  className?: string
}

const ICON_BY_TOOL: Record<AiTool, string> = {
  claude: claudeIcon,
  codex: codexIcon,
  cursor: cursorIcon,
}

const LABEL_BY_TOOL: Record<AiTool, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
}

export function AgentIcon({ tool, size = 12, className }: AgentIconProps) {
  const src = ICON_BY_TOOL[tool]
  if (!src) return null
  const cls = `agent-icon agent-icon-${tool}${className ? ` ${className}` : ''}`
  return (
    <img
      src={src}
      alt={LABEL_BY_TOOL[tool]}
      width={size}
      height={size}
      className={cls}
      draggable={false}
    />
  )
}
