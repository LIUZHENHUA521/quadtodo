import { create } from 'zustand'
import type { Todo } from '../api'

interface TodoSnapshotState {
  todos: Todo[]
  bySessionId: Map<string, Todo>
  setTodos: (list: Todo[]) => void
}

// 兄弟组件（SessionFocus / TopbarDispatch）跟 TodoManage 平级挂在 main.tsx 上，
// 没法直接拿 todos prop。TodoManage 在 todos 变化时把快照 push 进来，
// 这些组件从这里读，只用于派生 UI 状态（不要双向写）。
export const useTodoSnapshotStore = create<TodoSnapshotState>((set) => ({
  todos: [],
  bySessionId: new Map(),
  setTodos: (list) => set(() => {
    const bySessionId = new Map<string, Todo>()
    for (const t of list) {
      if (t.aiSession?.sessionId) bySessionId.set(t.aiSession.sessionId, t)
      for (const s of t.aiSessions || []) {
        if (s.sessionId) bySessionId.set(s.sessionId, t)
      }
    }
    return { todos: list, bySessionId }
  }),
}))
