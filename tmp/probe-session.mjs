import WebSocket from 'ws'

const sid = process.argv[2] || 'ai-1778736714375-ya7i'
const url = `ws://localhost:5677/ws/terminal/${sid}`
const ws = new WebSocket(url)

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'init', cols: 120, rows: 40 }))
})

const PATTERNS = [
  /Press Enter to confirm/i,
  /Do you want to proceed/i,
  /Do you want to /i,
  /Continue\?/i,
  /Proceed\?/i,
  /\(y\/n\)/i,
  /\[Y\/n\]/i,
  /\[yes\/no\]/i,
  /确认/i,
  /是否继续/i,
  /按回车确认/i,
]

function compactTerminalText(text = '') {
  return String(text)
    .replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

let buf = ''
let analyzed = false

ws.on('message', (raw) => {
  try {
    const msg = JSON.parse(raw.toString())
    if (msg.type === 'replay' && Array.isArray(msg.chunks)) {
      buf = msg.chunks.join('')
      if (!analyzed) { analyzed = true; analyze(); ws.close() }
    } else if (msg.type === 'output' && typeof msg.data === 'string') {
      buf += msg.data
    } else if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }))
    }
  } catch { /* ignore */ }
})

function analyze() {
  console.log(`session: ${sid}`)
  console.log(`Total raw bytes seen: ${buf.length}`)
  const last4k = buf.slice(-4000)
  console.log(`Last 4KB raw bytes length: ${last4k.length}`)
  const compacted = compactTerminalText(last4k)
  console.log(`Compacted text length: ${compacted.length}`)
  console.log('--- Compacted (last 1500 chars) ---')
  console.log(compacted.slice(-1500))
  console.log('--- Compacted (first 800 chars) ---')
  console.log(compacted.slice(0, 800))
  console.log('--- Pattern match results ---')
  for (const p of PATTERNS) {
    console.log(`  ${p.source} -> ${p.test(compacted) ? 'MATCH' : 'NO MATCH'}`)
  }

  // Also look at full compacted text (whole 5MB) for any "Do you want to"
  const compactedFull = compactTerminalText(buf)
  const idx = compactedFull.lastIndexOf('Do you want to')
  console.log(`\n"Do you want to" lastIndexOf in full compacted (len=${compactedFull.length}): ${idx}`)
  if (idx >= 0) {
    console.log('Context:', compactedFull.slice(Math.max(0, idx - 50), idx + 100))
  }
}

setTimeout(() => { try { ws.close() } catch {} ; process.exit(0) }, 4000)
