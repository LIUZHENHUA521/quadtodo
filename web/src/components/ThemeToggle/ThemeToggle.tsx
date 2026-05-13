import { Button, Tooltip } from 'antd'
import { Moon, Sun } from 'lucide-react'
import { useTheme } from '../../design/ThemeProvider'
import './ThemeToggle.css'

export function ThemeToggle() {
  const { mode, toggle } = useTheme()
  const isDark = mode === 'dark'
  return (
    <Tooltip title={isDark ? 'Switch to light' : 'Switch to dark'}>
      <Button
        type="text"
        size="small"
        className="theme-toggle-btn"
        onClick={toggle}
        aria-label="Toggle theme"
      >
        {isDark ? <Moon size={16} /> : <Sun size={16} />}
      </Button>
    </Tooltip>
  )
}
