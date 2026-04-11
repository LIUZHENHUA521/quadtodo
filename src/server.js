import express from 'express'
import { createServer as createHttpServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { openDb } from './db.js'
import { PtyManager } from './pty.js'
import { createTodosRouter } from './routes/todos.js'
import { createAiTerminal } from './routes/ai-terminal.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function loadVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'))
    return pkg.version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * @param opts.dbFile   SQLite file path (or ':memory:')
 * @param opts.logDir   directory for ai session logs
 * @param opts.tools    tools config { claude: { bin, args }, codex: { ... } }
 * @param opts.pty      (optional) injected PtyManager — for tests
 * @param opts.webDist  (optional) directory with built frontend assets
 */
export function createServer(opts = {}) {
  const { dbFile = ':memory:', logDir, tools, pty: injectedPty, webDist } = opts

  const db = openDb(dbFile)
  const pty = injectedPty || new PtyManager({ tools: tools || {} })
  const ait = createAiTerminal({ db, pty, logDir })

  const app = express()
  app.use(express.json({ limit: '2mb' }))

  app.get('/api/status', (_req, res) => {
    res.json({
      ok: true,
      version: loadVersion(),
      activeSessions: ait.sessions.size,
    })
  })

  app.use('/api/todos', createTodosRouter({ db }))
  app.use('/api/ai-terminal', ait.router)

  // ─── static frontend ───
  if (webDist && existsSync(webDist)) {
    app.use(express.static(webDist))
    // SPA fallback: non-API GET falls through to index.html
    app.get(/^\/(?!api|ws).*/, (_req, res) => {
      res.sendFile(join(webDist, 'index.html'))
    })
  }

  const httpServer = createHttpServer(app)
  const wss = new WebSocketServer({ noServer: true })

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '', 'http://127.0.0.1')
    if (url.pathname.startsWith('/ws/terminal/')) {
      const sessionId = url.pathname.replace('/ws/terminal/', '')
      wss.handleUpgrade(req, socket, head, (ws) => handleBrowserWs(ws, sessionId))
    } else {
      socket.destroy()
    }
  })

  const HEARTBEAT_MS = 15_000

  function handleBrowserWs(ws, sessionId) {
    ait.addBrowser(sessionId, ws)

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'ping') {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'pong' }))
          return
        }
        if (msg.type === 'pong') return
        ait.handleBrowserMessage(sessionId, msg)
      } catch { /* ignore */ }
    })

    const pingTimer = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }))
      } else {
        clearInterval(pingTimer)
      }
    }, HEARTBEAT_MS)

    ws.on('close', () => {
      clearInterval(pingTimer)
      ait.removeBrowser(sessionId, ws)
    })
  }

  function listen(port) {
    return new Promise((resolve, reject) => {
      httpServer.once('error', reject)
      httpServer.listen(port, '127.0.0.1', () => {
        httpServer.removeListener('error', reject)
        resolve(httpServer.address())
      })
    })
  }

  function close() {
    return new Promise((resolve) => {
      ait.close()
      wss.close(() => {
        httpServer.close(() => {
          try { db.close() } catch { /* ignore */ }
          resolve()
        })
      })
    })
  }

  return { app, httpServer, wss, db, pty, ait, listen, close }
}
