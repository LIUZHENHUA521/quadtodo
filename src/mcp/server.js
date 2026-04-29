import express from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { registerReadTools } from './tools/read/index.js'
import { registerWriteTools } from './tools/write/index.js'
import { registerDestructiveTools } from './tools/destructive/index.js'
import { registerOpenClawTools } from './tools/openclaw/index.js'
import { createAuditLog } from './audit.js'
import { createTranscriptScanner } from '../search/transcripts.js'

const SERVER_NAME = 'quadtodo'

/**
 * 创建一个挂在 Express 下的 MCP Streamable HTTP 路由。
 *
 * 工作方式：一个全局 McpServer + 一个全局 StreamableHTTPServerTransport，stateless 模式。
 * 每个 HTTP 请求都由 transport.handleRequest 完整处理。
 *
 * 依赖：
 *   - db：openDb(...) 返回的句柄
 *   - searchService：createSearchService 返回
 *   - wikiDir：wiki .md 文件所在目录（用于 read_wiki）
 *   - getVersion()：可选，注入当前 quadtodo 版本
 *   - aiTerminal：可选，{ spawnSession }，用于 start_ai_session
 *   - openclaw：可选，OpenClaw bridge 句柄
 *   - pending：可选，pending-question coordinator 句柄
 *   - getConfig：可选，() => 当前配置快照
 */
export function createMcpRouter({
  db, searchService, wikiDir, rootDir, logDir, getVersion,
  aiTerminal = null, openclaw = null, pending = null, getConfig = null,
} = {}) {
  if (!db) throw new Error('db_required')
  if (!searchService) throw new Error('searchService_required')

  const server = new McpServer({
    name: SERVER_NAME,
    version: (typeof getVersion === 'function' && getVersion()) || '0.1.0',
  })

  const audit = rootDir ? createAuditLog({ rootDir }) : null
  const transcriptScanner = logDir ? createTranscriptScanner({ db, logDir }) : null

  registerReadTools(server, { db, searchService, wikiDir, transcriptScanner })
  registerWriteTools(server, { db })
  registerDestructiveTools(server, { db, audit })
  if (pending) {
    registerOpenClawTools(server, { db, aiTerminal, openclaw, pending, getConfig })
  }

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  // 异步 connect；路由处理器会等这个 promise resolve 之后再调 handleRequest。
  const ready = server.connect(transport)

  const router = express.Router()
  // MCP Streamable HTTP 约定：客户端用 POST /mcp 下发 JSON-RPC；
  // 对于 SSE 变体或重连，GET 会触发会话初始化。
  // 我们是 stateless mode，所以两种方法都交给 transport.handleRequest。
  const handle = async (req, res) => {
    try {
      await ready
      await transport.handleRequest(req, res, req.body)
    } catch (e) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: e?.message || 'internal_error' },
          id: null,
        })
      }
    }
  }
  router.post('/', handle)
  router.get('/', handle)
  router.delete('/', handle)

  // 健康检查（MCP 客户端一般不走这个，但方便 `quadtodo mcp status` 和运维）
  router.get('/health', (_req, res) => {
    res.json({ ok: true, server: SERVER_NAME, tools: server._registeredTools ? Object.keys(server._registeredTools).length : undefined })
  })

  return { router, server, transport }
}
