import { useState, useCallback, useEffect } from 'react'
import { listComments, addComment, deleteComment, type Comment } from '../api'

/**
 * Self-contained comments subsystem for the todo detail drawer.
 *
 * Behaviour intentionally mirrors the original inline implementation in
 * TodoManage.tsx (optimistic add/remove, no automatic refetch on mutate),
 * just relocated into a reusable hook so TodoManage shrinks.
 *
 * Errors from `submit` / `remove` are re-thrown so the caller can display
 * its own message.* toast — this keeps the hook free of UI concerns.
 */
export function useComments(todoId: string | null, opts?: { active?: boolean }) {
  const [comments, setComments] = useState<Comment[]>([])
  const [loading, setLoading] = useState(false)
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const active = opts?.active ?? true

  const refresh = useCallback(async () => {
    if (!todoId) { setComments([]); return }
    setLoading(true)
    try {
      const list = await listComments(todoId)
      setComments(list)
    } finally {
      setLoading(false)
    }
  }, [todoId])

  // When the drawer opens for a new todo, reset transient state and fetch.
  useEffect(() => {
    if (!active) return
    setText('')
    setComments([])
    if (!todoId) return
    setLoading(true)
    listComments(todoId)
      .then(setComments)
      .catch(() => { /* swallow; matches original behaviour */ })
      .finally(() => setLoading(false))
  }, [active, todoId])

  const submit = useCallback(async () => {
    if (!todoId || !text.trim()) return
    setSubmitting(true)
    try {
      const c = await addComment(todoId, text.trim())
      setComments(prev => [...prev, c])
      setText('')
    } finally {
      setSubmitting(false)
    }
  }, [todoId, text])

  const remove = useCallback(async (commentId: string) => {
    if (!todoId) return
    await deleteComment(todoId, commentId)
    setComments(prev => prev.filter(c => c.id !== commentId))
  }, [todoId])

  return { comments, loading, text, setText, submitting, refresh, submit, remove }
}
