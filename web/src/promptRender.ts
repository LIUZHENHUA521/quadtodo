import type { Todo, PromptTemplate } from './api'

const QUADRANT_LABEL: Record<number, string> = {
  1: '重要且紧急',
  2: '重要不紧急',
  3: '紧急不重要',
  4: '不重要不紧急',
}

export function buildVars(todo: Todo): Record<string, string> {
  const dueDate = todo.dueDate ? new Date(todo.dueDate).toISOString().slice(0, 10) : ''
  return {
    title: todo.title || '',
    description: todo.description || '',
    workDir: todo.workDir || '',
    quadrant: todo.quadrant ? `Q${todo.quadrant}（${QUADRANT_LABEL[todo.quadrant] || ''}）` : '',
    dueDate,
  }
}

export function renderTemplate(content: string, vars: Record<string, string>): string {
  if (!content) return ''
  return content.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key) => {
    const v = vars?.[key]
    return v == null ? '' : String(v)
  })
}

export function renderAppliedTemplates(
  todo: Todo,
  allTemplates: PromptTemplate[],
): string {
  const ids = todo.appliedTemplateIds || []
  if (!ids.length || !allTemplates?.length) return ''
  const vars = buildVars(todo)
  const byId = new Map(allTemplates.map(t => [t.id, t]))
  return ids
    .map(id => byId.get(id))
    .filter((t): t is PromptTemplate => !!t)
    .map(t => renderTemplate(t.content, vars).trim())
    .filter(Boolean)
    .join('\n\n---\n\n')
}
