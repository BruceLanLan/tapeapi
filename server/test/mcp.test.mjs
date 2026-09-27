// The remote MCP endpoint over a real provider: the MCP lifecycle, tools from the manifest, and tool results that are
// the provider's signed envelopes with receipts that verify. No network.
// 真实 provider 上的远程 MCP 端点：MCP 生命周期、来自清单的工具，以及作为 provider 签名信封、回执可以核验的工具结果。不联网。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createProvider } from '../src/index.js'
import { createMcpEndpoint } from '../src/mcp.js'
import { mcp } from '@tapeapi/sdk'
import { privateKeyToAddress, recoverResponseSigner } from '../../sdk/src/sig.js'

const KEY = '0x' + '42'.repeat(32)
const SIGNER = privateKeyToAddress(KEY)
const CIRCUITS = '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414', CONTAINER = '0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8'
const manifest = {
  tapeapi: '0.1', name: 'Echo', circuits: CIRCUITS, tokenId: '11', container: CONTAINER, signer: SIGNER,
  endpoints: { live: ['https://echo.example/tapeapi/v1'], async: false },
  methods: [
    { name: 'echo', priceBEM: '0', params: { text: 'string' }, returns: { text: 'string' }, description: 'Says it back.' },
    { name: 'fail', priceBEM: '0', params: {}, returns: {} },
  ],
}
const provider = createProvider({
  manifest, signerKey: KEY, rateLimit: { windowMs: 60_000, free: 3, paid: 3 },
  methods: { echo: async ({ text }) => ({ text }), fail: async () => { const e = new Error('nope'); e.code = 'BAD_REQUEST'; throw e } },
})
const ep = createMcpEndpoint({ provider, manifest, identity: { name: '11.1013.tape' }, version: '0.3.0' })
const post = (body, ip = '1.1.1.1', headers = {}) => ep.handle(new Request('https://echo.example/mcp', {
  method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
}), { clientIp: ip })
const rpc = async (method, params, id = 1, ip) => (await (await post({ jsonrpc: '2.0', id, method, params }, ip)).json())

test('initialize: negotiates the protocol version and declares tools only', async () => {
  const r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
  assert.equal(r.result.protocolVersion, '2025-06-18')
  assert.deepEqual(r.result.capabilities, { tools: { listChanged: false } })
  assert.equal(r.result.serverInfo.version, '0.3.0')
  assert.match(r.result.instructions, /signed/)
  const future = await rpc('initialize', { protocolVersion: '2099-01-01' })
  assert.equal(future.result.protocolVersion, mcp.MCP_PROTOCOL_VERSIONS[0], 'an unknown version gets our newest')
  const n = await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
  assert.equal(n.status, 202); assert.equal(await n.text(), '')
  assert.deepEqual((await rpc('ping', {})).result, {})
})

test('tools/list: the manifest methods with JSON Schemas and read-only hints', async () => {
  const { result } = await rpc('tools/list', {})
  assert.deepEqual(result.tools.map((t) => t.name), ['echo', 'fail'])
  const echo = result.tools[0]
  assert.equal(echo.inputSchema.type, 'object')
  assert.ok(echo.inputSchema.properties.text)
  assert.match(echo.description, /^Says it back\. -- /)
  assert.equal(echo.annotations.readOnlyHint, true)
  assert.match(echo.description, /anyone can verify it against the chain/)
  assert.doesNotMatch(echo.description, /verified \(TAP-21\) before it is returned/, 'the server does not verify for the caller')
  for (const t of result.tools) assert.deepEqual(Object.keys(t).sort().filter((k) => !['annotations', 'title'].includes(k)), ['description', 'inputSchema', 'name'])
})

test('tools/call: the result is the provider\'s signed envelope, and its receipt verifies and round-trips through the link', async () => {
  const { result } = await rpc('tools/call', { name: 'echo', arguments: { text: 'héllo' } }, 7, '2.2.2.2')
  assert.equal(result.isError, false)
  assert.deepEqual(result.structuredContent, { text: 'héllo' })
  assert.equal(JSON.parse(result.content[0].text).text, 'héllo')
  assert.match(result.content[1].text, /Signed by TapeAPI service 11\.1013\.tape/)
  const receipt = result._meta[mcp.RECEIPT_META_KEY]
  assert.deepEqual(receipt.service, { circuits: CIRCUITS, tokenId: '11', container: CONTAINER, name: '11.1013.tape' })
  const who = recoverResponseSigner({ container: receipt.service.container, id: receipt.id, method: receipt.method, params: receipt.params, ok: receipt.ok, body: receipt.result, ts: receipt.ts }, receipt.sig)
  assert.equal(who.toLowerCase(), SIGNER.toLowerCase())
  const link = result.content[1].text.match(/Verify: (\S+)/)[1]
  assert.ok(link.startsWith(mcp.VERIFY_BASE + '#r='))
  assert.deepEqual(JSON.parse(mcp.fromBase64Url(link.split('#r=')[1])), receipt)
})

test('tools/call: a signed refusal is a tool error with a receipt; an unknown tool or bad arguments is a protocol error', async () => {
  const { result } = await rpc('tools/call', { name: 'fail', arguments: {} }, 8, '3.3.3.3')
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /refused/)
  assert.equal(result._meta[mcp.RECEIPT_META_KEY].ok, false)
  assert.equal((await rpc('tools/call', { name: 'nope', arguments: {} })).error.code, mcp.JSONRPC.INVALID_PARAMS)
  assert.equal((await rpc('tools/call', { name: 'echo', arguments: [1] })).error.code, mcp.JSONRPC.INVALID_PARAMS)
  assert.equal((await rpc('tools/call', { arguments: {} })).error.code, mcp.JSONRPC.INVALID_PARAMS)
})

test('the provider\'s rate limit reaches MCP callers by IP, as an unsigned tool error', async () => {
  let limited = null
  for (let i = 0; i < 8 && !limited; i++) {
    const { result } = await rpc('tools/call', { name: 'echo', arguments: { text: String(i) } }, i, '9.9.9.9')
    if (result.isError) limited = result
  }
  assert.ok(limited, 'the 3-per-window limit bit')
  assert.match(limited.content[0].text, /RATE_LIMITED/)
  assert.equal(limited._meta, undefined, 'no receipt for an unsigned answer')
  const other = await rpc('tools/call', { name: 'echo', arguments: { text: 'x' } }, 99, '8.8.8.8')
  assert.equal(other.result.isError, false, 'another IP is not affected')
})

test('transport: GET is 405, OPTIONS is CORS, bad JSON is a parse error, batches are answered, bodies are capped', async () => {
  const g = await ep.handle(new Request('https://echo.example/mcp'))
  assert.equal(g.status, 405); assert.equal(g.headers.get('allow'), 'POST, OPTIONS')
  const o = await ep.handle(new Request('https://echo.example/mcp', { method: 'OPTIONS' }))
  assert.equal(o.status, 204); assert.equal(o.headers.get('access-control-allow-origin'), '*')
  const bad = await post('{nope')
  assert.equal(bad.status, 400); assert.equal((await bad.json()).error.code, mcp.JSONRPC.PARSE)
  const batch = await (await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'nope/x' }])).json()
  assert.deepEqual(batch.map((m) => m.id), [1, 2]); assert.equal(batch[1].error.code, mcp.JSONRPC.METHOD_NOT_FOUND)
  assert.equal((await post([])).status, 400)
  assert.equal((await post('x'.repeat(70 * 1024))).status, 413)
  assert.equal((await post({ id: 1, method: 'ping' })).status, 200)
  assert.equal((await (await post({ id: 1, method: 'ping' })).json()).error.code, mcp.JSONRPC.INVALID_REQUEST, 'jsonrpc: "2.0" is required')
})

test('a manifest with no free method cannot become an MCP endpoint', () => {
  assert.throws(() => createMcpEndpoint({ provider, manifest: { ...manifest, methods: [{ name: 'p', priceBEM: '1', params: {}, returns: {} }] } }), /no tool/)
})
