import WebSocket from 'ws'
import { writeFileSync } from 'node:fs'
const SID = process.argv[2]
const OUT = process.argv[3] || '/tmp/edit-pty.txt'
const ws = new WebSocket(`ws://127.0.0.1:5677/ws/terminal/${SID}`)
let replayChunks = null
ws.on('open', () => { ws.send(JSON.stringify({ type: 'init', cols: 240, rows: 50, role: 'secondary' })) })
ws.on('message', (raw) => {
  try {
    const msg = JSON.parse(raw.toString())
    if (msg.type === 'replay') replayChunks = msg.chunks
  } catch {}
})
setTimeout(() => {
  const txt = (replayChunks || []).join('').slice(-12000)
  writeFileSync(OUT, txt, 'utf8')
  process.stderr.write(`wrote ${txt.length} bytes\n`)
  ws.close(); process.exit(0)
}, 2000)
