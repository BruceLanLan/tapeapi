#!/usr/bin/env node
// A tiny MCP server to put the proxy in front of: two tools, Streamable HTTP (POST /mcp, JSON answers, a session id),
// built on the SDK's transport-free MCP core. It stands for YOUR server: nothing in it knows about TapeAPI.
// 一个供代理包裹的小型 MCP 服务器：两个工具，Streamable HTTP（POST /mcp、JSON 应答、会话 id），基于 SDK 的无传输 MCP 核心。
// 它代表**你的**服务器：里面没有任何 TapeAPI 的东西。
//
//   node examples/mcp-proxy/demo-server.mjs     # http://127.0.0.1:8797/mcp
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { mcp, TapeAPIError } from '@tapeapi/sdk'

export const TOOLS = [
  {
    name: 'add', title: 'Add', description: 'Adds two numbers and returns the sum.',
    inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
  },
  {
    name: 'shout', title: 'Shout', description: 'Returns the text in capital letters, repeated `times` times (default 1, at most 5).',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, times: { type: 'integer' } }, required: ['text'] },
  },
]

async function callTool(name, args) {
  if (name === 'add') {
    if (typeof args.a !== 'number' || typeof args.b !== 'number') throw new TapeAPIError('BAD_REQUEST', 'a and b must be numbers')
    const sum = args.a + args.b
    return { content: [{ type: 'text', text: String(sum) }], structuredContent: { sum } }
  }
  if (name === 'shout') {
    if (typeof args.text !== 'string') throw new TapeAPIError('BAD_REQUEST', 'text must be a string')
    const times = args.times === undefined ? 1 : args.times
    // A tool-level failure: an MCP tool result with isError, not a protocol error. / 工具层面的失败：isError 结果，而不是协议错误。
    if (!Number.isInteger(times) || times < 1 || times > 5) return { content: [{ type: 'text', text: 'times must be an integer from 1 to 5' }], isError: true }
    return { content: [{ type: 'text', text: Array(times).fill(args.text.toUpperCase()).join(' ') }] }
  }
  throw new TapeAPIError('METHOD_NOT_FOUND', `no tool named ${String(name).slice(0, 64)}`)
}

const core = mcp.createMcpServer({ info: { name: 'demo-mcp', version: '1.0.0' }, listTools: async () => TOOLS, callTool })

/** Serve the demo on host:port (0 = any free port). Resolves with { url, close }. */
export async function startDemoServer({ port = 0, host = '127.0.0.1' } = {}) {
  const sessions = new Set()
  const server = http.createServer(async (req, res) => {
    const send = (status, body, headers = {}) => { res.writeHead(status, { ...(body == null ? {} : { 'content-type': 'application/json' }), ...headers }); res.end(body == null ? undefined : JSON.stringify(body)) }
    if (new URL(req.url, 'http://x').pathname !== '/mcp') return send(404, { error: 'not found' })
    if (req.method !== 'POST') return send(405, { error: 'use POST' }, { allow: 'POST' })
    let text = ''
    for await (const c of req) { text += c; if (text.length > 64 * 1024) return send(413, { error: 'too large' }) }
    let msg
    try { msg = JSON.parse(text) } catch { return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) }
    const sid = req.headers['mcp-session-id']
    if (msg?.method !== 'initialize' && sid && !sessions.has(sid)) return send(404, { error: 'unknown session' })
    const out = await core.handle(msg)
    const headers = {}
    if (msg?.method === 'initialize' && out?.result) { const id = randomUUID(); sessions.add(id); headers['mcp-session-id'] = id }
    return out ? send(200, out, headers) : send(202, null, headers)
  })
  await new Promise((resolve, reject) => server.once('error', reject).listen(port, host, resolve))
  const url = `http://${host}:${server.address().port}/mcp`
  return { url, close: () => new Promise((r) => server.close(() => r())) }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { url } = await startDemoServer({ port: Number(process.env.PORT || 8797), host: process.env.HOST || '127.0.0.1' })
  console.log(`[demo-mcp] MCP server listening on ${url} (tools: ${TOOLS.map((t) => t.name).join(', ')})`)
}
