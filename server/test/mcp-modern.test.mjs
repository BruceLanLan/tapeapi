// MCP revision 2026-07-28 at the remote endpoint and the signing proxy, the purely additive part: a request that
// declares the revision in `_meta` gets `resultType` (and, for tools/list, `ttlMs` 0 and `cacheScope` public); a
// request of an earlier revision gets what it got before. Nothing signed changes: the receipt, the signed envelope and
// toolsSha256 are the same in both revisions, and the proxy still talks to its upstream as before. No network.
// MCP 2026-07-28 版在远程端点与签名代理上的纯追加部分。签名的内容一概不变：回执、签名信封与 toolsSha256 在两个版本下相同，
// 代理与上游的对话方式也不变。不联网。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createProvider } from '../src/index.js'
import { createMcpEndpoint } from '../src/mcp.js'
import { createMcpProxy, MCP_PATH } from '../src/mcp-proxy.js'
import { mcp } from '@tapeapi/sdk'
import { privateKeyToAddress, recoverResponseSigner } from '../../sdk/src/sig.js'

const KEY = '0x' + '42'.repeat(32)
const SIGNER = privateKeyToAddress(KEY)
const CIRCUITS = '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414', CONTAINER = '0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8'
const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 't', version: '1' } }
const MODERN_HEADERS = (method, name) => ({ 'mcp-protocol-version': '2026-07-28', 'mcp-method': method, ...(name ? { 'mcp-name': name } : {}) })
const receiptSigner = (r) => recoverResponseSigner({ container: r.service.container, id: r.id, method: r.method, params: r.params, ok: r.ok, body: r.ok ? r.result : r.error, ts: r.ts }, r.sig)
const sameExceptTime = (a, b, msg) => {
  const strip = ({ id, ts, sig, ...rest }) => rest
  assert.deepEqual(strip(a), strip(b), msg)
}

// ---- the remote endpoint (createMcpEndpoint) / 远程端点 ----
const manifest = {
  tapeapi: '0.1', name: 'Echo', circuits: CIRCUITS, tokenId: '11', container: CONTAINER, signer: SIGNER,
  endpoints: { live: ['https://echo.example/tapeapi/v1'], async: false },
  methods: [{ name: 'echo', priceBEM: '0', params: { text: 'string' }, returns: { text: 'string' }, description: 'Says it back.' }],
}
const provider = createProvider({ manifest, signerKey: KEY, rateLimit: false, methods: { echo: async ({ text }) => ({ text }) } })
const ep = createMcpEndpoint({ provider, manifest, name: '11.1013.tape', version: '0.3.0' })
const post = (body, headers = {}) => ep.handleRequest(new Request('https://echo.example/mcp', {
  method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body),
}), { clientIp: '1.1.1.1' })

test('endpoint: tools/list of revision 2026-07-28 carries resultType, ttlMs 0 and cacheScope public; the tools are the same', async () => {
  const legacy = await (await post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })).json()
  const res = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META } }, MODERN_HEADERS('tools/list'))
  assert.equal(res.status, 200)
  const modern = await res.json()
  assert.deepEqual(modern.result, { ...legacy.result, resultType: 'complete', ttlMs: 0, cacheScope: 'public' })
  assert.deepEqual(Object.keys(legacy.result), ['tools'], 'an earlier revision gets no new field')
  assert.equal(mcp.toolsDigest(modern.result.tools), mcp.toolsDigest(legacy.result.tools))
})

test('endpoint: tools/call of revision 2026-07-28 carries resultType; the signed receipt is the same as for an earlier revision', async () => {
  const args = { text: 'hi' }
  const legacy = (await (await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: args } })).json()).result
  const modern = (await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: args, _meta: META } }, MODERN_HEADERS('tools/call', 'echo'))).json()).result
  assert.equal(modern.resultType, 'complete')
  assert.equal('resultType' in legacy, false)
  assert.equal('ttlMs' in modern, false); assert.equal('cacheScope' in modern, false)
  assert.deepEqual(Object.keys(modern).sort(), [...Object.keys(legacy), 'resultType'].sort())
  const rm = modern._meta[mcp.RECEIPT_META_KEY], rl = legacy._meta[mcp.RECEIPT_META_KEY]
  // The request's _meta never reaches the signed request: params are the tool arguments only. / 请求的 _meta 不进入签名的请求。
  assert.deepEqual(rm.params, args)
  assert.deepEqual(rm.result, { text: 'hi' }); assert.equal('resultType' in rm.result, false)
  sameExceptTime(rm, rl, 'same receipt apart from id, time and signature')
  assert.equal(receiptSigner(rm), SIGNER); assert.equal(receiptSigner(rl), SIGNER)
  assert.deepEqual(modern.structuredContent, legacy.structuredContent)
  assert.equal(modern.isError, false)
})

test('endpoint: a batch with one message of each revision answers each by its own; the preflight allows the 2026-07-28 headers', async () => {
  const out = await (await post([
    { jsonrpc: '2.0', id: 'm', method: 'tools/list', params: { _meta: META } },
    { jsonrpc: '2.0', id: 'l', method: 'tools/list' },
  ])).json()
  const by = Object.fromEntries(out.map((m) => [m.id, m.result]))
  assert.equal(by.m.resultType, 'complete'); assert.equal(by.m.ttlMs, 0); assert.equal(by.m.cacheScope, 'public')
  assert.deepEqual(Object.keys(by.l), ['tools'])
  const pre = await ep.handleRequest(new Request('https://echo.example/mcp', { method: 'OPTIONS' }))
  const allowed = pre.headers.get('access-control-allow-headers').split(',').map((s) => s.trim())
  for (const h of ['mcp-protocol-version', 'mcp-method', 'mcp-name']) assert.ok(allowed.includes(h), h)
})

// ---- the signing proxy (createMcpProxy) over an in-process upstream built on the SDK's MCP core ----
// ---- 签名代理，上游是基于 SDK MCP 核心的进程内服务器 ----
const TOOLS = [
  { name: 'add', description: 'Adds two numbers.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
  { name: 'echo', title: 'Echo', description: 'Says it back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
]
const upCall = async (name, args) => (name === 'add'
  ? { content: [{ type: 'text', text: String(args.a + args.b) }], structuredContent: { sum: args.a + args.b } }
  : { content: [{ type: 'text', text: args.text }] })
// `modern`: the upstream answers as a 2026-07-28 server would, resultType and cache hints on every result (with an
// unknown extra key too), to show none of it reaches what the proxy signs. / 上游按 2026-07-28 服务器的样子回答，证明这些都进不了代理签名的内容。
function inProcess({ modern = false } = {}) {
  const server = mcp.createMcpServer({ info: { name: 'up', version: '1' }, listTools: async () => TOOLS, callTool: upCall })
  const calls = []
  const call = async (msg) => {
    calls.push(msg)
    const out = await server.handle(msg)
    if (modern && out?.result && msg.method !== 'initialize') out.result = { ...out.result, resultType: 'complete', ttlMs: 60_000, cacheScope: 'public', 'x-extra': 1 }
    return out
  }
  return { calls, upstream: { call } }
}
const BASE = 'https://mcp.example'
const manifestBase = () => ({ name: 'Demo MCP', circuits: CIRCUITS, tokenId: '11', container: CONTAINER, delegation: null, endpoints: { live: [`${BASE}/tapeapi/v1`], async: false } })
const make = (upstream) => createMcpProxy({ upstream, manifestBase: manifestBase(), signerKey: KEY, log: () => {} })
const rpc = async (p, method, params, headers = {}) => (await (await p.handleRequest(new Request(BASE + MCP_PATH, {
  method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) }),
}), { clientIp: '2.2.2.2' })).json())

test('proxy: /mcp gives the 2026-07-28 fields to a request of that revision only; toolsSha256 and the upstream conversation are unchanged', async () => {
  const up = inProcess()
  const p = make(up.upstream)
  const m = await p.ready
  const listed = (await mcp.createMcpServer({ info: { name: 'up', version: '1' }, listTools: async () => TOOLS, callTool: upCall }).handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools
  assert.equal(m.mcp.toolsSha256, mcp.toolsDigest(listed))
  const legacy = await rpc(p, 'tools/list', {})
  const modern = await rpc(p, 'tools/list', { _meta: META }, MODERN_HEADERS('tools/list'))
  assert.deepEqual(modern.result, { ...legacy.result, resultType: 'complete', ttlMs: 0, cacheScope: 'public' })
  assert.deepEqual(Object.keys(legacy.result), ['tools'])
  assert.equal(mcp.toolsDigest(modern.result.tools), m.mcp.toolsSha256)
  const cl = (await rpc(p, 'tools/call', { name: 'add', arguments: { a: 2, b: 3 } })).result
  const cm = (await rpc(p, 'tools/call', { name: 'add', arguments: { a: 2, b: 3 }, _meta: META }, MODERN_HEADERS('tools/call', 'add'))).result
  assert.equal(cm.resultType, 'complete'); assert.equal('resultType' in cl, false)
  const rm = cm._meta[mcp.RECEIPT_META_KEY], rl = cl._meta[mcp.RECEIPT_META_KEY]
  sameExceptTime(rm, rl)
  assert.deepEqual(rm.result, { content: [{ type: 'text', text: '5' }], structuredContent: { sum: 5 } })
  assert.equal(receiptSigner(rm), SIGNER)
  // The proxy still opens with initialize and sends the upstream no 2026-07-28 metadata. / 代理仍以 initialize 开场，不向上游发送新版元数据。
  assert.deepEqual(up.calls.slice(0, 2).map((c) => c.method), ['initialize', 'notifications/initialized'])
  for (const c of up.calls) assert.equal(c.params?._meta, undefined, c.method)
})

test('proxy: an upstream that adds resultType and cache hints changes neither toolsSha256 nor the signed result', async () => {
  const plain = make(inProcess().upstream), fancy = make(inProcess({ modern: true }).upstream)
  const [a, b] = await Promise.all([plain.ready, fancy.ready])
  assert.equal(b.mcp.toolsSha256, a.mcp.toolsSha256)
  const sign = async (p) => {
    const res = await p.handleRequest(new Request(`${BASE}/tapeapi/v1/add`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'r-1', params: { a: 2, b: 3 } }) }), { clientIp: '3.3.3.3' })
    return res.json()
  }
  const ea = await sign(plain), eb = await sign(fancy)
  assert.deepEqual(eb.result, ea.result, 'only content, structuredContent and isError are signed')
  assert.equal('resultType' in eb.result, false)
  assert.equal(recoverResponseSigner({ container: eb.container, id: eb.id, method: 'add', params: { a: 2, b: 3 }, ok: eb.ok, body: eb.result, ts: eb.ts }, eb.sig), SIGNER)
  // An earlier-revision client of the proxy still sees no new field, whatever the upstream sends. / 无论上游发什么，旧版客户端都看不到新字段。
  assert.deepEqual(Object.keys((await rpc(fancy, 'tools/list', {})).result), ['tools'])
  assert.equal('resultType' in (await rpc(fancy, 'tools/call', { name: 'add', arguments: { a: 1, b: 1 } })).result, false)
})
