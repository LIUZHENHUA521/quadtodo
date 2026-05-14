// Dump the last 4KB of raw PTY bytes for a session, as JSON-escaped string.
// Useful for capturing a regression fixture.
import WebSocket from 'ws'

const sid = process.argv[2]
const url = `ws://localhost:5677/ws/terminal/${sid}`
const ws = new WebSocket(url)

ws.on('open', () => ws.send(JSON.stringify({ type: 'init', cols: 120, rows: 40 })))

ws.on('message', (raw) => {
  try {
    const msg = JSON.parse(raw.toString())
    if (msg.type === 'replay' && Array.isArray(msg.chunks)) {
      const buf = msg.chunks.join('')
      const last4k = buf.slice(-4000)
      // Print as JSON-escaped string
      process.stdout.write(JSON.stringify(last4k))
      ws.close()
    } else if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }))
    }
  } catch { /* ignore */ }
})

setTimeout(() => { try { ws.close() } catch {}; process.exit(0) }, 3000)
