import { describe, it, expect, beforeEach } from 'vitest'
import { openDb } from '../src/db.js'
import {
  createPendingQuestionCoordinator,
  __test__ as internals,
} from '../src/pending-questions.js'

describe('pending-questions ticket generator', () => {
  it('generates 3-char base32 (a-z2-7)', () => {
    for (let i = 0; i < 200; i++) {
      const t = internals.generateTicket()
      expect(t).toHaveLength(3)
      expect(t).toMatch(/^[a-z2-7]{3}$/)
    }
  })
})

describe('pending-questions parseReply (pure option matching)', () => {
  const opts = ['use cookie', 'use token', 'abort']

  it('returns chosenIndex from pure digit', () => {
    expect(internals.parseReply('1', opts).chosenIndex).toBe(0)
    expect(internals.parseReply('2', opts).chosenIndex).toBe(1)
    expect(internals.parseReply('3', opts).chosenIndex).toBe(2)
  })

  it('digit out of range falls through to free text', () => {
    const r = internals.parseReply('99', opts)
    expect(r.chosenIndex).toBeNull()
    expect(r.freeText).toBe('99')
  })

  it('matches option text by startswith / contains case-insensitive', () => {
    expect(internals.parseReply('use cookie', opts).chosenIndex).toBe(0)
    expect(internals.parseReply('USE TOKEN', opts).chosenIndex).toBe(1)
    expect(internals.parseReply('use cookie please', opts).chosenIndex).toBe(0)
  })

  it('falls through to free text when nothing matches', () => {
    const r = internals.parseReply('whatever I want', opts)
    expect(r.chosenIndex).toBeNull()
    expect(r.freeText).toBe('whatever I want')
  })

  it('does NOT extract ticket — that is submitReply\'s job', () => {
    const r = internals.parseReply('a3f 1', opts)
    expect(r).not.toHaveProperty('ticket')
    // 'a3f' is not numeric, not an option prefix → null index, free text retained
    expect(r.chosenIndex).toBeNull()
    expect(r.freeText).toBe('a3f 1')
  })
})

describe('pending-questions extractTicketCandidate', () => {
  it('captures explicit #xxx prefix', () => {
    const r = internals.extractTicketCandidate('#a3f 1')
    expect(r.explicit).toBe('a3f')
    expect(r.candidate).toBeNull()
    expect(r.body).toBe('1')
  })

  it('captures bare 3-letter candidate', () => {
    const r = internals.extractTicketCandidate('a3f 1')
    expect(r.explicit).toBeNull()
    expect(r.candidate).toBe('a3f')
    expect(r.body).toBe('1')
  })

  it('strips , : # separators between prefix and body', () => {
    expect(internals.extractTicketCandidate('a3f: 1').body).toBe('1')
    expect(internals.extractTicketCandidate('a3f, 1').body).toBe('1')
    expect(internals.extractTicketCandidate('#a3f #1').body).toBe('1')
  })

  it('returns no candidate when leading 3 chars are not at a word boundary', () => {
    // 'hello' — hel followed by 'lo' (still letters) — no word boundary, no match
    const r = internals.extractTicketCandidate('hello 1')
    expect(r.candidate).toBeNull()
    expect(r.body).toBe('hello 1')
  })

  it('uppercase is folded to lowercase', () => {
    const r = internals.extractTicketCandidate('A3F 1')
    expect(r.candidate).toBe('a3f')
  })

  it('alphabet does NOT include digit 1, so b1f is not a valid ticket', () => {
    const r = internals.extractTicketCandidate('b1f 1')
    expect(r.candidate).toBeNull()
  })

  it('returns no ticket for short text', () => {
    const r = internals.extractTicketCandidate('1')
    expect(r.explicit).toBeNull()
    expect(r.candidate).toBeNull()
    expect(r.body).toBe('1')
  })
})

describe('pending-questions coordinator', () => {
  let db
  let coord

  beforeEach(() => {
    db = openDb(':memory:')
    coord = createPendingQuestionCoordinator({ db })
  })

  it('ask creates DB row and returns ticket + promise', async () => {
    const { ticket, promise } = coord.ask({
      sessionId: 's1',
      todoId: 't1',
      question: '用方案 1 还是 2？',
      options: ['cookie', 'token'],
      timeoutMs: 60_000,
    })
    expect(ticket).toMatch(/^[a-z2-7]{3}$/)
    const row = db.getPendingQuestion(ticket)
    expect(row).toBeTruthy()
    expect(row.status).toBe('pending')
    expect(row.options).toEqual(['cookie', 'token'])
    // promise should be unresolved
    let resolved = false
    promise.then(() => { resolved = true })
    await new Promise(r => setTimeout(r, 10))
    expect(resolved).toBe(false)
  })

  it('submitReply with no ticket routes to latest pending', async () => {
    const a = coord.ask({ sessionId: 's1', question: 'q1', options: ['ya', 'na'] })
    await new Promise(r => setTimeout(r, 5))
    const b = coord.ask({ sessionId: 's2', question: 'q2', options: ['x', 'y'] })

    const result = coord.submitReply('1')
    expect(result.matched).toBe(true)
    expect(result.ticket).toBe(b.ticket) // 最新的 b
    expect(result.chosenIndex).toBe(0)
    expect(result.chosen).toBe('x')

    const resolved = await b.promise
    expect(resolved.status).toBe('answered')
    expect(resolved.chosen).toBe('x')
  })

  it('submitReply with bare ticket prefix routes when ticket exists pending', async () => {
    const a = coord.ask({ sessionId: 's1', question: 'q1', options: ['ya', 'na'] })
    await new Promise(r => setTimeout(r, 5))
    coord.ask({ sessionId: 's2', question: 'q2', options: ['x', 'y'] })

    const result = coord.submitReply(`${a.ticket} 2`)
    expect(result.matched).toBe(true)
    expect(result.ticket).toBe(a.ticket)
    expect(result.chosenIndex).toBe(1)
    expect(result.chosen).toBe('na')

    const resolved = await a.promise
    expect(resolved.chosen).toBe('na')
  })

  it('submitReply with explicit #xxx prefix forces routing', async () => {
    const a = coord.ask({ sessionId: 's1', question: 'q1', options: ['ya', 'na'] })
    await new Promise(r => setTimeout(r, 5))
    coord.ask({ sessionId: 's2', question: 'q2', options: ['x', 'y'] })

    const result = coord.submitReply(`#${a.ticket} 1`)
    expect(result.matched).toBe(true)
    expect(result.ticket).toBe(a.ticket)
    expect(result.chosen).toBe('ya')
  })

  it('explicit ticket that is not pending returns ticket_not_pending', () => {
    const r = coord.submitReply('#zzz 1')
    expect(r.matched).toBe(false)
    expect(r.reason).toBe('ticket_not_pending')
    expect(r.ticket).toBe('zzz')
  })

  it('bare 3-letter that is not a real ticket falls through to latest', async () => {
    const opt = coord.ask({ sessionId: 's1', question: 'q', options: ['use cookie', 'use token'] })
    // 'use' is in alphabet but not in DB → fall through to latest pending,
    // and full text 'use cookie' matches option 0
    const result = coord.submitReply('use cookie')
    expect(result.matched).toBe(true)
    expect(result.ticket).toBe(opt.ticket)
    expect(result.chosenIndex).toBe(0)
  })

  it('cancel resolves the waiter with cancelled status', async () => {
    const { ticket, promise } = coord.ask({ sessionId: 's1', question: 'q', options: ['a', 'b'] })
    coord.cancel(ticket, 'changed mind')
    const r = await promise
    expect(r.status).toBe('cancelled')
    expect(r.answerText).toBe('changed mind')
  })

  it('timeout resolves the waiter with timeout status', async () => {
    const { ticket, promise } = coord.ask({
      sessionId: 's1',
      question: 'q',
      options: ['a', 'b'],
      timeoutMs: 50,
    })
    const r = await promise
    expect(r.status).toBe('timeout')
    expect(r.ticket).toBe(ticket)
    expect(db.getPendingQuestion(ticket).status).toBe('timeout')
  })

  it('listPending returns all pending entries with ageSeconds', async () => {
    coord.ask({ sessionId: 's1', question: 'q1', options: ['a', 'b'] })
    coord.ask({ sessionId: 's2', question: 'q2', options: ['x', 'y'] })
    const list = coord.listPending()
    expect(list).toHaveLength(2)
    expect(list[0].ageSeconds).toBeGreaterThanOrEqual(0)
    expect(list[0].remainingSeconds).toBeGreaterThan(0)
  })

  it('submitReply with no pending at all returns no_pending', () => {
    const r = coord.submitReply('zzz hello')
    expect(r.matched).toBe(false)
    expect(r.reason).toBe('no_pending')
  })

  it('answered question is no longer the latest pending', async () => {
    const a = coord.ask({ sessionId: 's1', question: 'q1', options: ['a', 'b'] })
    await new Promise(r => setTimeout(r, 5))
    const b = coord.ask({ sessionId: 's2', question: 'q2', options: ['x', 'y'] })
    coord.submitReply(`${b.ticket} 1`)
    // Now only `a` is pending
    const r2 = coord.submitReply('2')
    expect(r2.ticket).toBe(a.ticket)
    expect(r2.chosen).toBe('b')
  })
})
