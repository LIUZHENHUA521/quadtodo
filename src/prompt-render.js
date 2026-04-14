const QUADRANT_LABEL = {
  1: '重要且紧急',
  2: '重要不紧急',
  3: '紧急不重要',
  4: '不重要不紧急',
}

export function buildVars(todo) {
  if (!todo) return {}
  const dueDate = todo.dueDate
    ? new Date(todo.dueDate).toISOString().slice(0, 10)
    : ''
  return {
    title: todo.title || '',
    description: todo.description || '',
    workDir: todo.workDir || '',
    quadrant: todo.quadrant ? `Q${todo.quadrant}（${QUADRANT_LABEL[todo.quadrant] || ''}）` : '',
    dueDate,
  }
}

export function renderTemplate(content, vars) {
  if (!content) return ''
  return String(content).replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key) => {
    const v = vars?.[key]
    return v == null ? '' : String(v)
  })
}

export function renderTemplates(templates, vars, { separator = '\n\n---\n\n' } = {}) {
  if (!Array.isArray(templates) || templates.length === 0) return ''
  return templates
    .map(t => renderTemplate(typeof t === 'string' ? t : t?.content || '', vars).trim())
    .filter(Boolean)
    .join(separator)
}
