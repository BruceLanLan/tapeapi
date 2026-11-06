// MCP revision 2026-07-28, the purely additive part: `resultType` on results and `ttlMs` / `cacheScope` on list
// results, given only to a request that declares that revision in `_meta`. A request of an earlier revision (no such
// key) gets byte-for-byte the answer it got before. Spec checked on 2026-10-14 (and again on 2026-10-21 for 2.5, which
// adds serverInfo in a modern result's _meta, server/discover and the refusals; see server/test/mcp-2026-07-28-compat):
//   https://modelcontextprotocol.io/specification/2026-07-28/basic/index (resultType)
//   https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching (ttlMs, cacheScope)
// MCP 2026-07-28 版中纯追加的部分：结果带 resultType，列表结果带 ttlMs / cacheScope，只给在 _meta 里声明该版本的请求。
// 更早版本的请求（没有这个键）得到与以前逐字节相同的回答。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createMcpServer, toolsDigest } from '../src/mcp.js'

const SI = { 'io.modelcontextprotocol/serverInfo': { name: 'core', version: '1' } }

const TOOLS = [
  { name: 'echo', description: 'Says it back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'add', title: 'Add', description: 'Adds.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
]
const server = createMcpServer({
  info: { name: 'core', version: '1' },
  instructions: 'Test server.',
  listTools: async () => TOOLS,
  callTool: async (name, args) => ({ content: [{ type: 'text', text: JSON.stringify({ name, args }) }], isError: false, _meta: { 'fun.tapeapi/receipt': { v: 1 } } }),
})
const META = (v = '2026-07-28') => ({ 'io.modelcontextprotocol/protocolVersion': v, 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 't', version: '1' } })
const ask = (method, params, id = 1) => server.handle({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
const LISTS = [['tools/list', 'tools'], ['resources/list', 'resources'], ['resources/templates/list', 'resourceTemplates'], ['prompts/list', 'prompts']]

test('MCP 2026-07-28: a request that declares the revision gets resultType, and a list result ttlMs 0 and cacheScope public', async () => {
  for (const [method, key] of LISTS) {
    const legacy = (await ask(method, {})).result
    const modern = (await ask(method, { _meta: META() })).result
    assert.deepEqual(modern, { ...legacy, resultType: 'complete', ttlMs: 0, cacheScope: 'public', _meta: SI }, method)
    assert.ok(Array.isArray(modern[key]), method)
  }
  const call = (await ask('tools/call', { name: 'echo', arguments: { text: 'hi' }, _meta: META() })).result
  const before = (await ask('tools/call', { name: 'echo', arguments: { text: 'hi' } })).result
  assert.deepEqual(call, { ...before, resultType: 'complete', _meta: { ...before._meta, ...SI } }, 'tools/call: resultType and serverInfo, no cache hints')
  assert.equal('ttlMs' in call, false); assert.equal('cacheScope' in call, false)
  assert.deepEqual(call._meta['fun.tapeapi/receipt'], before._meta['fun.tapeapi/receipt'], 'the receipt in _meta is untouched')
  // CHANGED 2.5: a later dated revision is not served as 2026-07-28 any more; it is refused with -32022, which lists the
  // versions this server has. / 2.5 起，更晚日期的版本不再按 2026-07-28 回答，而以 -32022 拒绝并列出支持的版本。
  const later = await ask('tools/list', { _meta: META('2027-01-01') })
  assert.equal(later.error.code, -32022); assert.deepEqual(later.error.data, { supported: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'], requested: '2027-01-01' })
})

test('MCP 2026-07-28: requests of earlier revisions get exactly the old answers (absent, not null or undefined)', async () => {
  const exact = async (method, params, expected) => assert.equal(JSON.stringify(await ask(method, params)), JSON.stringify(expected), `${method} ${JSON.stringify(params)}`)
  const tools = { jsonrpc: '2.0', id: 1, result: { tools: TOOLS.map((t) => (t.annotations ? { name: t.name, description: t.description, inputSchema: t.inputSchema, title: t.title, annotations: { readOnlyHint: true, openWorldHint: true } } : { name: t.name, description: t.description, inputSchema: t.inputSchema })) } }
  for (const params of [undefined, {}, { cursor: 'x' }, { _meta: {} }, { _meta: { progressToken: 1 } },
    { _meta: META('2025-11-25') }, { _meta: META('2025-06-18') }, { _meta: META('2025-03-26') },
    { _meta: 'not an object' }, { _meta: ['2026-07-28'] }]) {
    await exact('tools/list', params, tools)
  }
  // CHANGED 2.5: values of the key that are not a revision were answered as legacy; no client of 2025-11-25 or earlier
  // sends the key, and 2026-07-28 asks for a refusal: -32022 for an unknown string, -32602 for a value not a string.
  // 2.5 起：不是任何版本的键值以前按旧版回答；旧版客户端不发这个键，2026-07-28 要求拒绝。
  for (const [v, code] of [['latest', -32022], ['2026-7-28', -32022], [20260728, -32602]]) {
    assert.equal((await ask('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': v } })).error.code, code, String(v))
  }
  await exact('resources/list', {}, { jsonrpc: '2.0', id: 1, result: { resources: [] } })
  await exact('ping', undefined, { jsonrpc: '2.0', id: 1, result: {} })
  const legacyCall = await ask('tools/call', { name: 'echo', arguments: { text: 'hi' } })
  assert.deepEqual(Object.keys(legacyCall.result), ['content', 'isError', '_meta'])
})

test('MCP 2026-07-28: initialize and errors are never changed; the gate is per message', async () => {
  const init = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } }
  assert.deepEqual(await ask('initialize', { ...init, _meta: META() }), await ask('initialize', init), 'initialize selects the earlier revisions; it gets no resultType')
  // CHANGED 2.5: server/discover answers a modern request; a legacy one still gets "not supported".
  // 2.5 起：server/discover 回答新版请求；旧版请求仍得到 "not supported"。
  const discover = await ask('server/discover', { _meta: META() })
  assert.equal(discover.result.resultType, 'complete'); assert.deepEqual(discover.result._meta, SI)
  assert.deepEqual(await ask('server/discover', {}), { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method server/discover is not supported' } })
  const badTool = await ask('tools/call', { name: 7, _meta: META() })
  assert.equal(badTool.error.code, -32602); assert.equal('result' in badTool, false)
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized', params: { _meta: META() } }), null)
  // Two messages, one of each revision, answered independently (stateless). / 两条消息各按自己的版本回答（无状态）。
  const [a, b] = await Promise.all([ask('tools/list', { _meta: META() }, 1), ask('tools/list', {}, 2)])
  assert.equal(a.result.resultType, 'complete'); assert.equal('resultType' in b.result, false)
})

test('MCP 2026-07-28: the tools listed and their digest are the same in both revisions', async () => {
  const legacy = (await ask('tools/list', {})).result.tools
  const modern = (await ask('tools/list', { _meta: META() })).result.tools
  assert.deepEqual(modern, legacy)
  assert.equal(toolsDigest(modern), toolsDigest(legacy))
  // The digest is over the tools, never the list result: the added fields cannot enter it. / 摘要只覆盖工具，不覆盖列表结果。
  assert.throws(() => toolsDigest({ tools: legacy, resultType: 'complete', ttlMs: 0, cacheScope: 'public' }), /array/)
})
