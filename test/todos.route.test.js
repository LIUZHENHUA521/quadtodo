import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { openDb } from '../src/db.js'
import { createTodosRouter } from '../src/routes/todos.js'

function makeApp() {
  const db = openDb(':memory:')
  const app = express()
  app.use(express.json())
  app.use('/api/todos', createTodosRouter({ db }))
  return { app, db }
}

describe('routes/todos', () => {
  let app, db
  beforeEach(() => { ({ app, db } = makeApp()) })

  it('GET /api/todos returns empty list', async () => {
    const res = await request(app).get('/api/todos')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, list: [] })
  })

  it('POST /api/todos creates a todo', async () => {
    const res = await request(app)
      .post('/api/todos')
      .send({ title: 'New task', quadrant: 1 })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.todo.title).toBe('New task')
    expect(res.body.todo.quadrant).toBe(1)
    expect(res.body.todo.id).toBeTruthy()
  })

  it('POST /api/todos rejects missing title', async () => {
    const res = await request(app).post('/api/todos').send({ quadrant: 1 })
    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)
  })

  it('PUT /api/todos/:id updates fields', async () => {
    const { body: create } = await request(app).post('/api/todos').send({ title: 'A', quadrant: 1 })
    const id = create.todo.id
    const res = await request(app).put(`/api/todos/${id}`).send({ title: 'A2', quadrant: 2, sortOrder: 500 })
    expect(res.status).toBe(200)
    expect(res.body.todo.title).toBe('A2')
    expect(res.body.todo.quadrant).toBe(2)
    expect(res.body.todo.sortOrder).toBe(500)
  })

  it('PUT /api/todos/:id returns 404 for unknown id', async () => {
    const res = await request(app).put('/api/todos/nope').send({ title: 'x' })
    expect(res.status).toBe(404)
  })

  it('DELETE /api/todos/:id removes the row', async () => {
    const { body: create } = await request(app).post('/api/todos').send({ title: 'A', quadrant: 1 })
    const del = await request(app).delete(`/api/todos/${create.todo.id}`)
    expect(del.status).toBe(200)
    const list = await request(app).get('/api/todos')
    expect(list.body.list).toHaveLength(0)
  })

  it('GET /api/todos?status=todo excludes done', async () => {
    const a = await request(app).post('/api/todos').send({ title: 'A', quadrant: 1 })
    await request(app).put(`/api/todos/${a.body.todo.id}`).send({ status: 'done' })
    await request(app).post('/api/todos').send({ title: 'B', quadrant: 1 })
    const res = await request(app).get('/api/todos?status=todo')
    expect(res.body.list).toHaveLength(1)
    expect(res.body.list[0].title).toBe('B')
  })

  it('GET /api/todos?keyword= matches title', async () => {
    await request(app).post('/api/todos').send({ title: 'Fix login', quadrant: 1 })
    await request(app).post('/api/todos').send({ title: 'Write docs', quadrant: 2 })
    const res = await request(app).get('/api/todos?keyword=login')
    expect(res.body.list).toHaveLength(1)
  })
})
