import { Sparkles, Terminal, MousePointer2 } from 'lucide-react'
import type { AiTool } from '../../api'
import './AgentIcon.css'

export interface AgentIconProps {
  tool: AiTool
  size?: number
  className?: string
}

const ICON_BY_TOOL = {
  claude: Sparkles,
  codex: Terminal,
  cursor: MousePointer2,
} as const

export function AgentIcon({ tool, size = 12, className }: AgentIconProps) {
  const Icon = ICON_BY_TOOL[tool]
  if (!Icon) return null
  const cls = `agent-icon agent-icon-${tool}${className ? ` ${className}` : ''}`
  return <Icon size={size} className={cls} aria-hidden />
}
