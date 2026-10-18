// TAPI-20 §3.8 for the provider's own MCP endpoint (2.3, experimental): the toolsSha256 it publishes is the SDK's digest
// of exactly what its tools/list serves, the shared vectors of the MCP tools draft (TapeOutProtocol/TAPs #16) agree on
// all three implementations, and holdToToolsSha256 refuses bound methods with a signed TOOLS_CHANGED once the tools
// differ from the published digest, passing everything else through. No network.
// 提供者自己的 MCP 端点的 TAPI-20 §3.8（2.3，实验性）：它发布的 toolsSha256 就是 SDK 对其 tools/list 内容的摘要；MCP 工具草案
// （TAPs #16）的共享向量在三份实现上一致；工具与已发布摘要不符时，holdToToolsSha256 以签名的 TOOLS_CHANGED 拒绝绑定的方法，
// 其余原样通过。不联网。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createProvider } from '../src/index.js'
import { createMcpEndpoint, listedMcpTools, mcpToolsSha256, holdToToolsSha256 } from '../src/mcp.js'
import { mcp } from '@tapeapi/sdk'
import { safeParseJSON } from '../../sdk/src/canon.js'
import * as C from '../../site/console/lib.js'
import { privateKeyToAddress, recoverResponseSigner } from '../../sdk/src/sig.js'

const KEY = '0x' + '42'.repeat(32)
const SIGNER = privateKeyToAddress(KEY)
const CIRCUITS = '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414', CONTAINER = '0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8'
const manifestOf = ({ name = 'Echo', echoText = 'Says it back.', mcpField } = {}) => ({
  tapeapi: '0.1', name, circuits: CIRCUITS, tokenId: '11', container: CONTAINER, signer: SIGNER,
  endpoints: { live: ['https://echo.example/tapeapi/v1'], async: false },
  methods: [
    { name: 'echo', priceBEM: '0', params: { text: 'string' }, returns: { text: 'string' }, description: echoText },
    { name: 'premium', priceBEM: '0.5', params: {}, returns: { ok: 'boolean' } },
  ],
  payment: { escrow: '0x' + '0e'.repeat(20) },
  ...(mcpField ? { mcp: mcpField } : {}),
})
const handlers = () => ({ echo: async ({ text }) => ({ text }), premium: async () => ({ ok: true }) })
const call = (provider, method, params, id = `t-${method}`) => provider.handleRequest(new Request(`https://echo.example/tapeapi/v1/${method}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, params }),
}), { clientIp: '1.1.1.1' })

// The vectors of the MCP tools draft (TapeOutProtocol/TAPs pull request #16, head 648dd6a, assets/tap-draft-mcp-tools/
// tools-digest.json), copied byte for byte. / MCP 工具草案的向量，逐字节复制。
const VECTORS = JSON.parse(readFileSync(new URL('./fixtures/tap-draft-mcp-tools-digest.json', import.meta.url), 'utf8'))

test('shared vectors (TAPs #16 tools-digest.json): the SDK, the holder console and the provider endpoint give every digest, and refuse every list that has none', async () => {
  assert.equal(VECTORS.positive.length, 9)
  for (const v of VECTORS.positive) {
    const tools = safeParseJSON(v.toolsJson)
    assert.equal(mcp.toolsDigest(tools), v.toolsSha256, `SDK: ${v.name}`)
    assert.equal(await C.toolsDigest(tools), v.toolsSha256, `console: ${v.name}`)
    // An MCP server that lists exactly these tools: the digest over its tools/list answer is the same.
    // 正好列出这些工具的 MCP 服务器：对它的 tools/list 回答算出的摘要相同。
    const server = mcp.createMcpServer({ info: { name: 'v', version: '0' }, listTools: async () => tools.map((t) => ({ mcpPublic: t })), callTool: async () => ({ content: [] }) })
    const listed = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools
    assert.equal(mcp.toolsDigest(listed), v.toolsSha256, `served: ${v.name}`)
    assert.equal(mcp.toolsDigest(listed), mcp.toolsDigest(JSON.parse(JSON.stringify(listed))), `round trip: ${v.name}`)
  }
  assert.ok(VECTORS.negative.length >= 14)
  for (const v of VECTORS.negative) {
    assert.throws(() => mcp.toolsDigest(safeParseJSON(v.toolsJson)), undefined, `SDK has no digest: ${v.name}`)
  }
})

test('createMcpEndpoint().toolsSha256() is the digest of its own tools/list answer, equals mcpToolsSha256(manifest), and does not depend on the mcp member', async () => {
  const manifest = manifestOf()
  const provider = createProvider({ manifest, signerKey: KEY, rateLimit: false, methods: handlers(), log: () => {} })
  const ep = createMcpEndpoint({ provider, manifest, name: '11.1013.tape', version: '9.9.9' })
  const r = await ep.handleRequest(new Request('https://echo.example/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }))
  const wire = (await r.json()).result.tools
  const d = await ep.toolsSha256()
  assert.match(d, /^[0-9a-f]{64}$/)
  assert.equal(d, mcp.toolsDigest(wire), 'what a client computes over the wire')
  assert.equal(d, await C.toolsDigest(wire), 'what the holder console computes before publishing')
  assert.equal(d, await mcpToolsSha256(manifest))
  assert.deepEqual(await listedMcpTools(manifest), wire)
  assert.equal(await ep.toolsSha256(), d, 'memoised, the same value')
  assert.deepEqual(wire.map((t) => t.name), ['echo'], 'a priced method is not a tool')
  // Publishing the digest does not change it: the tools come from name, container and methods only.
  // 发布摘要不会改变它：工具只来自 name、container 与 methods。
  assert.equal(await mcpToolsSha256(manifestOf({ mcpField: { endpoint: 'https://echo.example/mcp', toolsSha256: d } })), d)
  assert.notEqual(await mcpToolsSha256(manifestOf({ name: 'Echo 2' })), d, 'the display name is in every title')
  assert.notEqual(await mcpToolsSha256(manifestOf({ echoText: 'Says it back!' })), d, 'a method description is in its tool')
  assert.deepEqual(mcp.invisibleProblems(wire), [])
})

test('holdToToolsSha256: while the tools match the published digest every call is answered byte for byte as without it', async (t) => {
  const manifest = manifestOf()
  const published = await mcpToolsSha256(manifest)
  // One fixed clock for both providers, so the signed envelopes can be compared as bytes. / 固定时钟，签名信封可逐字节比较。
  const realNow = Date.now
  Date.now = () => 1_790_000_000_000
  t.after(() => { Date.now = realNow })
  const plain = createProvider({ manifest, signerKey: KEY, rateLimit: false, methods: handlers(), log: () => {} })
  const held = createProvider({ manifest, signerKey: KEY, rateLimit: false, methods: holdToToolsSha256(handlers(), { manifest, published }), log: () => {} })
  for (const [m, p] of [['echo', { text: 'hi' }], ['echo', {}], ['premium', {}], ['nope', {}]]) {
    const a = await call(plain, m, p), b = await call(held, m, p)
    assert.equal(b.status, a.status, `${m}: status`)
    assert.equal(await b.text(), await a.text(), `${m} ${JSON.stringify(p)}: the same bytes`)
  }
})

test('CONFIRMED MCP-CONFORM-1: holdToToolsSha256 refuses a bound method with a signed TOOLS_CHANGED (409, data exactly { published, current }) once the tools differ; a method that is not a tool passes through', async () => {
  const published = await mcpToolsSha256(manifestOf())
  // A deploy that rewords a method description: the tools now hash to something else. / 改了方法说明的部署：工具摘要变了。
  const changed = manifestOf({ echoText: 'Says it back, louder.', mcpField: { endpoint: 'https://echo.example/mcp', toolsSha256: published } })
  const current = await mcpToolsSha256(changed)
  assert.notEqual(current, published)
  const seen = []
  const methods = holdToToolsSha256({ ...handlers(), echo: async (p) => { seen.push(p); return { text: p.text } } }, { manifest: changed, published })
  const provider = createProvider({ manifest: changed, signerKey: KEY, rateLimit: false, methods, log: () => {} })
  const res = await call(provider, 'echo', { text: 'hi' }, 'drift-1')
  assert.equal(res.status, 409)
  const env = await res.json()
  assert.equal(env.ok, false)
  assert.equal(env.error.code, 'TOOLS_CHANGED')
  assert.deepEqual(env.error.data, { published, current })
  assert.equal(recoverResponseSigner({ container: CONTAINER, id: 'drift-1', method: 'echo', params: { text: 'hi' }, ok: false, body: env.error, ts: env.ts }, env.sig), SIGNER, 'the refusal is signed by the manifest signer')
  assert.deepEqual(seen, [], 'the handler is never reached')
  // Through the MCP endpoint the same signed refusal is a tool error. / 经 MCP 端点，同一个签名拒绝是工具错误。
  const ep = createMcpEndpoint({ provider, manifest: changed, name: '11.1013.tape' })
  const r = await (await ep.handleRequest(new Request('https://echo.example/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } }) }))).json()
  assert.equal(r.result.isError, true)
  assert.match(r.result.content[0].text, /^The service refused: TOOLS_CHANGED: /)
  assert.equal(r.result._meta[mcp.RECEIPT_META_KEY].error.data.published, published)
  // `premium` is not a tool (priced): unchanged by the hold. It answers PAYMENT_REQUIRED as before.
  // premium 不是工具（收费）：不受约束，照旧回答 PAYMENT_REQUIRED。
  const p = await (await call(provider, 'premium', {}, 'drift-2')).json()
  assert.equal(p.error.code, 'PAYMENT_REQUIRED')
})

test('holdToToolsSha256: a published value is required and checked; the handler table keeps every own method', async () => {
  const manifest = manifestOf()
  const ok = await mcpToolsSha256(manifest)
  for (const published of [undefined, '', ok.toUpperCase(), ok.slice(1), '0x' + ok.slice(2)]) {
    assert.throws(() => holdToToolsSha256(handlers(), { manifest, published }), { code: 'INVALID_ARGUMENT' }, String(published))
  }
  assert.throws(() => holdToToolsSha256(null, { manifest, published: ok }), { code: 'INVALID_ARGUMENT' })
  assert.throws(() => holdToToolsSha256(handlers(), { published: ok }), { code: 'INVALID_ARGUMENT' })
  const held = holdToToolsSha256(handlers(), { manifest, published: ok })
  assert.deepEqual(Object.keys(held), ['echo', 'premium'])
  assert.deepEqual(await held.echo({ text: 'x' }), { text: 'x' })
  assert.deepEqual(await held.premium({}), { ok: true })
})

// Review S-1: a tool list that cannot be built is not remembered. Meanwhile no method is known to be a tool or not, so
// every method is refused (TOOLS_CHANGED, current null); the next call reads the list again. A list once read is kept
// (TAPs #16 §5.1: a failed read leaves the state as it was).
// 审查 S-1：建不出来的工具列表不被记住。期间不知道哪些方法是工具，所以每个方法都被拒绝（TOOLS_CHANGED，current 为 null）；下一次调用
// 重新读取。读到的列表一直保留（#16 §5.1：读取失败不改变状态）。
test('holdToToolsSha256: a tool list that cannot be built is not cached: every method is refused meanwhile, and the next call reads it again', async () => {
  const manifest = manifestOf()
  const published = await mcpToolsSha256(manifest)
  const held = holdToToolsSha256(handlers(), { manifest, published })
  const methods = manifest.methods
  manifest.methods = null   // the list cannot be built / 列表建不出来
  for (const [name, params] of [['echo', { text: 'x' }], ['premium', {}]]) {
    await assert.rejects(held[name](params), (e) => e.code === 'TOOLS_CHANGED' && JSON.stringify(e.data) === JSON.stringify({ published, current: null }), name)
  }
  // both calls at once while it fails: both refused, and still nothing remembered / 失败时同时到达的两个调用：都被拒绝，仍不记住
  const both = await Promise.allSettled([held.echo({ text: 'y' }), held.premium({})])
  assert.deepEqual(both.map((x) => x.reason?.code), ['TOOLS_CHANGED', 'TOOLS_CHANGED'])
  manifest.methods = methods
  assert.deepEqual(await held.echo({ text: 'x' }), { text: 'x' }, 'read again: served')
  assert.deepEqual(await held.premium({}), { ok: true })
  manifest.methods = null   // read once, kept: a later change of the object does not reach it / 读到一次就保留
  assert.deepEqual(await held.echo({ text: 'z' }), { text: 'z' })
  manifest.methods = methods
})

test('holdToToolsSha256: tools that match the published digest but carry text a person cannot see are refused with a signed INTERNAL (TAP draft #16 §3.4)', async () => {
  const hidden = manifestOf({ echoText: 'Says it back.\u200b' })
  const published = await mcpToolsSha256(hidden)
  assert.ok(mcp.invisibleProblems(await listedMcpTools(hidden)).length > 0)
  const provider = createProvider({ manifest: hidden, signerKey: KEY, rateLimit: false, methods: holdToToolsSha256(handlers(), { manifest: hidden, published }), log: () => {} })
  const env = await (await call(provider, 'echo', { text: 'hi' }, 'hidden-1')).json()
  assert.deepEqual([env.ok, env.error.code], [false, 'INTERNAL'])
  assert.equal(recoverResponseSigner({ container: CONTAINER, id: 'hidden-1', method: 'echo', params: { text: 'hi' }, ok: false, body: env.error, ts: env.ts }, env.sig), SIGNER)
  assert.equal((await (await call(provider, 'premium', {}, 'hidden-2')).json()).error.code, 'PAYMENT_REQUIRED', 'a method that is not a tool passes through')
})
