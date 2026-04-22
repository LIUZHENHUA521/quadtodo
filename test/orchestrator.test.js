import { describe, it, expect } from 'vitest'
import { parseHandoff, matchEdge } from '../src/orchestrator.js'

describe('orchestrator.parseHandoff', () => {
  it('returns null when no handoff tag', () => {
    expect(parseHandoff('')).toBeNull()
    expect(parseHandoff('just plain text')).toBeNull()
  })

  it('parses self-closing tag with verdict + feedback', () => {
    const text = 'I reviewed the diff.\n\n<handoff to="coder" verdict="rejected" feedback="null check on line 42 is wrong" />'
    const h = parseHandoff(text)
    expect(h).toEqual({
      to: 'coder',
      verdict: 'rejected',
      feedback: 'null check on line 42 is wrong',
      summary: null,
      rationale: null,
    })
  })

  it('parses approved → __done__', () => {
    const text = '<handoff to="__done__" verdict="approved" rationale="LGTM" />'
    expect(parseHandoff(text)).toMatchObject({ to: '__done__', verdict: 'approved', rationale: 'LGTM' })
  })

  it('takes the LAST handoff when multiple present', () => {
    const text = '<handoff to="reviewer" summary="draft" />\n\nlater reconsidered\n\n<handoff to="coder" verdict="rejected" feedback="nope" />'
    expect(parseHandoff(text).to).toBe('coder')
  })

  it('handles open/close form too', () => {
    const text = '<handoff to="reviewer" summary="hi"></handoff>'
    expect(parseHandoff(text)).toMatchObject({ to: 'reviewer', summary: 'hi' })
  })
})

describe('orchestrator.matchEdge', () => {
  const edges = [
    { from: 'coder', event: 'done', to: 'reviewer' },
    { from: 'reviewer', event: 'handoff', verdict: 'approved', to: '__done__' },
    { from: 'reviewer', event: 'handoff', verdict: 'rejected', to: 'coder' },
  ]

  it('coder done → reviewer', () => {
    const r = matchEdge(edges, { from: 'coder', event: 'done' })
    expect(r?.to).toBe('reviewer')
  })
  it('reviewer approved → __done__', () => {
    const r = matchEdge(edges, { from: 'reviewer', event: 'handoff', verdict: 'approved' })
    expect(r?.to).toBe('__done__')
  })
  it('reviewer rejected → coder', () => {
    const r = matchEdge(edges, { from: 'reviewer', event: 'handoff', verdict: 'rejected' })
    expect(r?.to).toBe('coder')
  })
  it('no matching edge → null', () => {
    const r = matchEdge(edges, { from: 'mystery', event: 'done' })
    expect(r).toBeNull()
  })
  it('falls back to verdict-agnostic edge when exact verdict not matched', () => {
    const r = matchEdge(edges, { from: 'coder', event: 'done', verdict: 'approved' })
    expect(r?.to).toBe('reviewer')  // coder.done edge has no verdict constraint
  })
})
