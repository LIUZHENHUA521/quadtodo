import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { openDb } from '../src/db.js'

const { summarizeTurns, loadTranscript } = vi.hoisted(() => ({
  summarizeTurns: vi.fn(),
  loadTranscript: vi.fn(),
}))

vi.mock('../src/summarize.js', () => ({
  summarizeTurns,
}))

vi.mock('../src/transcript.js', () => ({
  loadTranscript,
}))

import { createTodosRouter } from '../src/routes/todos.js'

function makeApp() {
  const db = openDb(':memory:')
  const app = express()
  app.use(express.json())
  app.use('/api/todos', createTodosRouter({
    db,
    getTools: () => ({
      claude: {
        command: 'claude-w',
        bin: '/Users/test/.local/bin/claude-w',
        args: ['--model', 'gpt-5.4'],
      },
    }),
  }))
  return { app, db }
}

describe('routes/todos fork', () => {
  let app, db

  beforeEach(() => {
    summarizeTurns.mockReset()
    loadTranscript.mockReset()
    ;({ app, db } = makeApp())
  })

  it('passes configured tool command info into summarizeTurns', async () => {
    const todo = db.createTodo({
      title: 'Continue task',
      quadrant: 1,
      aiSessions: [
        {
          sessionId: 's1',
          tool: 'claude',
          nativeSessionId: 'n1',
          status: 'done',
          startedAt: 1,
          completedAt: 2,
          prompt: 'first prompt',
        },
      ],
    })

    loadTranscript.mockReturnValue({
      turns: [
        { role: 'user', content: 'turn 1' },
        { role: 'assistant', content: 'turn 2' },
        { role: 'user', content: 'turn 3' },
      ],
    })
    summarizeTurns.mockResolvedValue('summary text')

    const res = await request(app)
      .post(`/api/todos/${todo.id}/ai-sessions/s1/fork`)
      .send({ summarize: true, keepLastTurns: 1, tool: 'claude' })

    expect(res.status).toBe(200)
    expect(summarizeTurns).toHaveBeenCalledTimes(1)
    expect(summarizeTurns).toHaveBeenCalledWith(
      [
        { role: 'user', content: 'turn 1' },
        { role: 'assistant', content: 'turn 2' },
      ],
      expect.objectContaining({
        tool: 'claude',
        tools: expect.objectContaining({
          claude: expect.objectContaining({
            bin: '/Users/test/.local/bin/claude-w',
            args: ['--model', 'gpt-5.4'],
          }),
        }),
      }),
    )
  })
})
