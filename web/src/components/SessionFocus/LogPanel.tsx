import { useEffect, useState } from 'react'
import { fetchSessionLog } from '../../api'
import { useAppMessages } from '../../design/useAppMessages'

interface Props {
  sessionId: string
  /** 仅在该 tab 被选中时才请求，避免后台拉大 log */
  active: boolean
}

export function LogPanel({ sessionId, active }: Props) {
  const [content, setContent] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [size, setSize] = useState<number>(0)
  const { message } = useAppMessages()

  useEffect(() => {
    if (!active || !sessionId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchSessionLog(sessionId)
      .then((r) => {
        if (cancelled) return
        setContent(r.content)
        setSize(r.sizeBytes)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err.message || String(err))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, active])

  if (loading) return <div className="log-panel-status">Loading log…</div>
  if (error) return <div className="log-panel-status">Error: {error}</div>
  if (!content) return <div className="log-panel-status">No log content</div>

  return (
    <div className="log-panel">
      <div className="log-panel-toolbar">
        <span className="log-panel-meta">{(size / 1024).toFixed(1)}k bytes</span>
        <button
          type="button"
          className="log-panel-copy"
          onClick={() => {
            navigator.clipboard.writeText(content).then(
              () => message.success('Log copied to clipboard'),
              () => message.error('Copy failed'),
            )
          }}
        >
          Copy
        </button>
      </div>
      <pre className="log-panel-content">{content}</pre>
    </div>
  )
}
