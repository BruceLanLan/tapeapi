// WebMCP bridge: the pure manifest -> tools mapping, and an end-to-end agent call against a real signed service
// (fake chain + in-process provider, as in audit-runtime.test.mjs) through two fake modelContext shapes.
// WebMCP 桥：纯函数的清单 -> 工具映射，以及通过两种假 modelContext 形状、对真实签名服务（假链 + 进程内 provider）的端到端调用。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTapeAPI, parseUnits, MANIFEST_KEY } from '../src/index.js'
import { manifestToTools, paramToSchema, paramsToSchema, exposeTapeAPI, sanitizePrefix, TOOL_NAME_RE } from '../src/webmcp.js'
import { privateKeyToAddress, signDigest, delegationDigest } from '../src/sig.js'
import { createProvider } from '../../server/src/index.js'
import { createFakeChain, ADDR } from './helpers/fake-chain.mjs'

// ============================================================================================ pure mapping / 纯映射
const ADDR_RE = '^0x[0-9a-fA-F]{40}$'
const schemaOf = (n) => { const { schema, optional, known } = paramToSchema(n); const { description, ...rest } = schema; return { rest, optional, known, description } }

test('schema table: TAP-20 type notation -> JSON Schema, conservatively', () => {
  const table = [
    // notation,                                         expected schema (without description),                          optional, known
    ['string',                                            { type: 'string' },                                                false, true],
    ['number',                                            { type: 'number' },                                                false, true],
    ['integer',                                           { type: 'integer' },                                               false, true],
    ['boolean',                                           { type: 'boolean' },                                               false, true],
    ['bool',                                              { type: 'boolean' },                                               false, true],
    ['object',                                            { type: 'object' },                                                false, true],
    ['address',                                           { type: 'string', pattern: ADDR_RE },                              false, true],
    ['address?',                                          { type: 'string', pattern: ADDR_RE },                              true, true],
    ['hex32',                                             { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' },                false, true],
    ['bytes32',                                           { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' },                false, true],
    ['bytes65',                                           { type: 'string', pattern: '^0x[0-9a-fA-F]{130}$' },               false, true],
    ['hex',                                               { type: 'string', pattern: '^0x([0-9a-fA-F]{2})*$' },              false, true],
    ['base64',                                            { type: 'string', contentEncoding: 'base64' },                     false, true],
    ['address[]',                                         { type: 'array', items: { type: 'string', pattern: ADDR_RE } },    false, true],
    ['address[] (<=50, input order preserved)',           { type: 'array', items: { type: 'string', pattern: ADDR_RE } },    false, true],
    ['address[]?',                                        { type: 'array', items: { type: 'string', pattern: ADDR_RE } },    true, true],
    ['number? seconds, default 1800, 60..86400',          { type: 'number' },                                                true, true],
    ['number (56 only)',                                  { type: 'number' },                                                false, true],
    ['string? (default "1.05")',                          { type: 'string' },                                                true, true],
    ["number|'finalized'|'safe'|'latest'? (default finalized)", { anyOf: [{ type: 'number' }, { enum: ['finalized', 'safe', 'latest'] }] }, true, true],
    ['number|tag?',                                       { anyOf: [{ type: 'number' }, { type: 'string' }] },               true, true],
    ["'buy'|'sell'",                                      { enum: ['buy', 'sell'] },                                         false, true],
    ["'only'",                                            { const: 'only' },                                                 false, true],
    ['string|number',                                     { anyOf: [{ type: 'string' }, { type: 'number' }] },               false, true],
    ['object[] ({chainId, tokens[], block?}, <=5)',       { type: 'array', items: { type: 'object' } },                      false, true],
    // unknown -> no constraint, and the description says so / 不认识 → 不约束，并在说明里写明
    ['uint256',                                           {},                                                                false, false],
    ['decimal?',                                          {},                                                                true, false],
    ['number|widget',                                     {},                                                                false, false],
    ['',                                                  {},                                                                false, false],
  ]
  for (const [n, want, opt, known] of table) {
    const got = schemaOf(n)
    assert.deepEqual(got.rest, want, `schema of ${JSON.stringify(n)}`)
    assert.equal(got.optional, opt, `optional of ${JSON.stringify(n)}`)
    assert.equal(got.known, known, `known of ${JSON.stringify(n)}`)
    assert.ok(got.description.startsWith(n.trim()), `the notation itself is the description: ${n}`)
    if (!known) assert.match(got.description, /not recognised by the WebMCP bridge: unconstrained/)
  }
  // non-string notations (defensive): nested object and one-element array / 非字符串记法（防御性）
  assert.deepEqual(paramToSchema({ a: 'number', b: 'string?' }).schema, {
    type: 'object', required: ['a'],
    properties: { a: { type: 'number', description: 'number' }, b: { type: 'string', description: 'string?' } },
  })
  assert.deepEqual(paramToSchema(['address']).schema.items, { type: 'string', pattern: ADDR_RE, description: 'address' })
  assert.equal(paramToSchema(42).known, false)
  // long notes are cut / 过长的说明被截断
  assert.ok(paramToSchema('string ' + 'x'.repeat(500)).schema.description.length <= 200)
})

test('params map -> object schema: required list, open additionalProperties, prototype keys refused', () => {
  const s = paramsToSchema({ circuits: 'address', tokenId: 'string', block: 'number|tag?' }).schema
  assert.equal(s.type, 'object')
  assert.deepEqual(s.required, ['circuits', 'tokenId'])
  assert.equal(s.additionalProperties, undefined, 'TAP-20 types are informative: do not refuse what the provider may accept')
  assert.deepEqual(paramsToSchema({}).schema, { type: 'object', properties: {}, required: [] })
  assert.throws(() => paramsToSchema(JSON.parse('{"__proto__":"string"}')), (e) => e.code === 'MANIFEST_INVALID')
  assert.throws(() => paramsToSchema({ constructor: 'string' }), (e) => e.code === 'MANIFEST_INVALID')
})

const MANIFEST = {
  tapeapi: '0.1', name: 'TapeOut Reader', circuits: ADDR.circuits, tokenId: '4246', container: ADDR.container, signer: ADDR.treasury,
  endpoints: { live: ['https://x.example/tapeapi/v1'], async: false },
  methods: [
    { name: 'blockNumber', priceBEM: '0', params: {}, returns: { blockNumber: 'number' } },
    { name: 'circuitHolder', priceBEM: '0.0001', params: { circuits: 'address', tokenId: 'string' }, returns: { holder: 'address' } },
    { name: 'bigQuery', priceBEM: '2', params: { q: 'string' }, returns: {}, description: 'Runs a big query.' },
  ],
  payment: { escrow: ADDR.escrow, unit: 'BEM', decimals: 8 },
}

test('priced methods are hidden by default; paid exposes them up to maxPriceBEM and within paid.methods', () => {
  const def = manifestToTools(MANIFEST)
  assert.deepEqual(def.tools.map((t) => t.method), ['blockNumber'])
  assert.deepEqual(def.skipped.map((s) => [s.method, s.code]), [['circuitHolder', 'PAYMENT_REQUIRED'], ['bigQuery', 'PAYMENT_REQUIRED']])

  const capped = manifestToTools(MANIFEST, { paid: { maxPriceBEM: '0.001' } })
  assert.deepEqual(capped.tools.map((t) => [t.method, t.priceBEM, t.price, t.paid]), [['blockNumber', '0', '0', false], ['circuitHolder', '0.0001', '10000', true]])
  assert.deepEqual(capped.skipped.map((s) => [s.method, s.code]), [['bigQuery', 'PRICE_CHANGED']], 'above the per-call cap: not exposed')

  const narrowed = manifestToTools(MANIFEST, { paid: { maxPriceBEM: '10', methods: ['bigQuery'] } })
  assert.deepEqual(narrowed.tools.map((t) => t.method), ['blockNumber', 'bigQuery'])

  // a price above what the caller accepted is skipped even inside the cap / 高于已同意的价格，即使在上限内也跳过
  const risen = manifestToTools(MANIFEST, { paid: { maxPriceBEM: '10' }, accepted: { circuitHolder: parseUnits('0.00005') } })
  assert.ok(!risen.tools.some((t) => t.method === 'circuitHolder'))
  assert.equal(risen.skipped.find((s) => s.method === 'circuitHolder').code, 'PRICE_CHANGED')

  assert.throws(() => manifestToTools(MANIFEST, { paid: {} }), (e) => e.code === 'BAD_REQUEST' && /maxPriceBEM/.test(e.message))
  assert.throws(() => manifestToTools(MANIFEST, { paid: { maxPriceBEM: '1e3' } }), (e) => e.code === 'BAD_REQUEST')
  assert.throws(() => manifestToTools({}), (e) => e.code === 'MANIFEST_INVALID')
})

test('tool names: prefix sanitised to the WebMCP charset, collision-safe, always within 1..128', () => {
  assert.equal(sanitizePrefix('my svc/1!'), 'my_svc_1_')
  assert.equal(sanitizePrefix('ok.name-1_'), 'ok.name-1_')
  assert.equal(sanitizePrefix('x'.repeat(200)).length, 60)
  const a = manifestToTools(MANIFEST, { prefix: 'Tape Out: ' })
  assert.equal(a.tools[0].name, 'Tape_Out__blockNumber')
  const taken = new Set(['tapeapi_blockNumber'])
  const b = manifestToTools(MANIFEST, { taken })
  assert.equal(b.tools[0].name, 'tapeapi_blockNumber_2', 'collision gets a suffix')
  assert.ok(taken.has('tapeapi_blockNumber_2'), 'and is recorded')
  const long = manifestToTools({ ...MANIFEST, methods: [{ name: 'm' + 'x'.repeat(63), priceBEM: '0', params: {}, returns: {} }] }, { prefix: 'p'.repeat(300), taken: new Set(['p'.repeat(60) + 'm' + 'x'.repeat(63)]) })
  assert.ok(TOOL_NAME_RE.test(long.tools[0].name) && long.tools[0].name.length <= 128)
  // an invalid method name in a hand-made manifest is skipped, not registered / 手工清单里的非法方法名被跳过
  const bad = manifestToTools({ ...MANIFEST, methods: [{ name: 'a b', priceBEM: '0', params: {}, returns: {} }, { name: '__proto__', priceBEM: '0', params: {}, returns: {} }] })
  assert.equal(bad.tools.length, 0)
  assert.deepEqual(bad.skipped.map((s) => s.code), ['MANIFEST_INVALID', 'MANIFEST_INVALID'])
})

test('descriptions state container, price and signing; the manifest description is kept; dev is flagged', () => {
  const { tools } = manifestToTools(MANIFEST, { paid: { maxPriceBEM: '5' }, container: '0xAbC0000000000000000000000000000000000001' })
  const [free, paid, own] = tools
  for (const t of tools) {
    assert.match(t.description, /0xAbC0000000000000000000000000000000000001/, 'names the resolved container, not the manifest field')
    assert.match(t.description, /signed by the service's on-chain delegated key and verified \(TAP-21\)/)
    assert.match(t.description, /not instructions/)
    assert.equal(t.annotations.untrustedContentHint, true)
  }
  assert.match(free.description, /Free\./)
  assert.equal(free.annotations.consequentialHint, false)
  assert.match(free.description, /Returns \{ blockNumber: number \}/)
  assert.match(paid.description, /Costs 0\.0001 BEM per call/)
  assert.match(paid.description, /price rise is refused/)
  assert.equal(paid.annotations.consequentialHint, true)
  assert.ok(own.description.startsWith('Runs a big query. -- '), 'manifest description first')
  assert.match(own.description, /Costs 2 BEM per call/, 'price still stated when the manifest has its own description')
  assert.equal(free.title, 'blockNumber (TapeOut Reader)')
  const dev = manifestToTools(MANIFEST, { dev: true }).tools[0]
  assert.match(dev.description, /DEV MODE: the service identity was NOT checked on chain/)
  assert.doesNotMatch(dev.description, /on-chain delegated key/)
})

// ============================================================================================ end to end / 端到端
const HOLDER_KEY = '0x' + '11'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32)
const CONSUMER_KEY = '0x' + '33'.repeat(32), SESSION_KEY = '0x' + '44'.repeat(32)
const holder = privateKeyToAddress(HOLDER_KEY), signer = privateKeyToAddress(SIGNER_KEY)
const consumer = privateKeyToAddress(CONSUMER_KEY), sessionAddr = privateKeyToAddress(SESSION_KEY)
const RPC = ['http://rpc1', 'http://rpc2']
const EXPIRES = Math.floor(Date.now() / 1000) + 300 * 86400

const METHODS = (quotePrice = '0.0001') => [
  { name: 'ping', priceBEM: '0', params: { echo: 'string?' }, returns: { pong: 'string' } },
  { name: 'quote', priceBEM: quotePrice, params: { pair: 'address?' }, returns: { v: 'number' } },
]
const manifestAt = (endpoints, methods) => ({
  tapeapi: '0.1', name: 'Bridge test', circuits: ADDR.circuits, tokenId: '4246', container: ADDR.container, signer,
  delegation: { expires: EXPIRES, sig: signDigest(delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires: EXPIRES }), HOLDER_KEY) },
  endpoints: { live: endpoints, async: false }, methods,
  payment: { escrow: ADDR.escrow, unit: 'BEM', decimals: 8 },
})

// A client-side chain (manifest, holder) and a provider-side chain (escrow channel), as in audit-runtime.test.mjs.
// `tamper(json)` edits every provider answer in flight. / `tamper` 在途中改写每个 provider 回答。
async function world({ providerMethods = METHODS(), chainMethods = METHODS(), tamper = null } = {}) {
  const cc = createFakeChain()
  cc.setOwner(4246, holder); cc.setAccount(4246, ADDR.container)
  const pc = createFakeChain()
  pc.setChannel(consumer, ADDR.container, parseUnits('100'))
  pc.setSession(consumer, ADDR.container, sessionAddr, 1900000000)
  const provider = createProvider({
    minVoucherLifeS: 0, manifest: manifestAt(['http://127.0.0.1:1/tapeapi/v1'], providerMethods), signerKey: SIGNER_KEY,
    rpcUrls: RPC, quorum: 2, chainId: 56, fetch: pc.fetch, allowHttp: true, escrowCacheMs: 0, log: () => {}, rateLimit: false,
    methods: { ping: async (p) => ({ pong: p.echo ?? 'pong' }), quote: async () => ({ v: 1 }), extra: async () => ({}) },
  })
  const srv = await provider.listen(0)
  const url = `http://127.0.0.1:${srv.address().port}/tapeapi/v1`
  provider.manifest.endpoints.live = [url]
  const publish = (methods) => cc.writeFile(ADDR.container, MANIFEST_KEY, JSON.stringify(manifestAt([url], methods)))
  publish(chainMethods)
  const sent = []
  const fetchImpl = cc.fetchWith(async (u, init) => {
    try { sent.push(JSON.parse(init.body)) } catch { /* */ }
    const r = await fetch(u, init)
    if (!tamper) return r
    const j = await r.json(); tamper(j)
    return new Response(JSON.stringify(j), { status: r.status, headers: { 'content-type': 'application/json' } })
  })
  const api = createTapeAPI({ rpcUrls: RPC, quorum: 2, chainId: 56, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, factory: ADDR.factory, escrow: ADDR.escrow, allowHttp: true, fetch: fetchImpl, timeoutMs: 500 })
  const payer = api.payer({ consumer, sessionKey: SESSION_KEY })
  return { cc, api, payer, sent, publish, url, close: () => new Promise((r) => srv.close(r)) }
}

// The W3C draft shape: document.modelContext.registerTool(tool, { signal }) -> Promise, unregister by abort,
// duplicate name -> InvalidStateError, executeTool returns the JSON-serialised result.
// W3C 草案形状：返回 Promise，abort 注销，重名 InvalidStateError，executeTool 返回 JSON 字符串。
function draftContext() {
  const tools = new Map()
  return {
    tools,
    async registerTool(tool, { signal } = {}) {
      if (tools.has(tool.name)) { const e = new Error(`duplicate ${tool.name}`); e.name = 'InvalidStateError'; throw e }
      JSON.stringify(tool.inputSchema)
      tools.set(tool.name, tool)
      signal?.addEventListener('abort', () => { if (tools.get(tool.name) === tool) tools.delete(tool.name) })
    },
    async getTools() { return [...tools.values()].map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })) },
    async executeTool(name, input) {
      const t = tools.get(name); if (!t) throw new Error(`no tool ${name}`)
      return JSON.stringify(await t.execute(input, { signal: new AbortController().signal }))
    },
  }
}
// The Chrome early-preview shape: sync registerTool(tool), unregisterTool(name), input handed over as a JSON string.
// Chrome 早期预览形状：同步 registerTool，unregisterTool(name)，输入以 JSON 字符串传入。
function previewContext() {
  const tools = new Map()
  return {
    tools,
    registerTool(tool) { if (tools.has(tool.name)) throw new Error('exists'); tools.set(tool.name, tool) },
    unregisterTool(name) { if (!tools.delete(name)) throw new Error('unknown') },
    async callTool(name, input) { return tools.get(name).execute(JSON.stringify(input), {}) },
  }
}
const payloadOf = (s) => JSON.parse(JSON.parse(s).content[0].text)

test('agent call through the draft shape returns a verified, attributed result; priced methods hidden by default', async () => {
  const w = await world()
  try {
    const mc = draftContext()
    const h = await exposeTapeAPI(w.api, ADDR.container, { modelContext: mc })
    assert.equal(h.supported, true)
    const names = (await mc.getTools()).map((t) => t.name)
    assert.deepEqual(names, ['tapeapi_60606060_ping'], 'default prefix carries the container; the priced quote is not exposed')
    assert.deepEqual(h.skipped.map((s) => [s.method, s.code]), [['quote', 'PAYMENT_REQUIRED']])
    const [tool] = await mc.getTools()
    assert.deepEqual(tool.inputSchema.properties.echo, { type: 'string', description: 'string?' })
    assert.match(tool.description, new RegExp(h.svc.container))

    const p = payloadOf(await mc.executeTool('tapeapi_60606060_ping', { echo: 'hi' }))
    assert.deepEqual(p.result, { pong: 'hi' })
    assert.equal(p.verified, true)
    assert.equal(p.signer, signer)
    assert.equal(p.holder, holder)
    assert.equal(p.container, h.svc.container)
    assert.match(p.identity, /^on-chain/)
    assert.equal(typeof p.ts, 'number'); assert.match(p.sig, /^0x[0-9a-f]{130}$/i)
    assert.equal(p.priceBEM, '0')
    assert.ok(!w.sent.some((b) => b.voucher), 'no voucher ever left the page')

    h()   // the handle is the dispose function / 句柄本身就是注销函数
    assert.equal((await mc.getTools()).length, 0, 'aborting the signal unregistered every tool')
    assert.equal(h.tools.length, 0)
  } finally { await w.close() }
})

test('a tampered provider answer reaches the agent as BAD_SIGNATURE, never as a result', async () => {
  const w = await world({ tamper: (j) => { if (j.ok && j.result) j.result.pong = 'forged' } })
  try {
    const mc = draftContext()
    await exposeTapeAPI(w.api, ADDR.container, { modelContext: mc, prefix: 't_' })
    let out = null
    await assert.rejects(async () => { out = await mc.executeTool('t_ping', {}) }, (e) => e.code === 'BAD_SIGNATURE' && /^BAD_SIGNATURE: /.test(e.message))
    assert.equal(out, null, 'nothing was returned')
    // the same failure as MCP isError content when the page asks for it / 页面要求时以 isError 内容呈现
    const mc2 = draftContext()
    await exposeTapeAPI(w.api, ADDR.container, { modelContext: mc2, prefix: 't_', errors: 'content' })
    const r = JSON.parse(await mc2.executeTool('t_ping', {}))
    assert.equal(r.isError, true)
    assert.equal(JSON.parse(r.content[0].text).error.code, 'BAD_SIGNATURE')
    assert.ok(!('result' in JSON.parse(r.content[0].text)))
  } finally { await w.close() }
})

test('the Chrome preview shape: string input, unregisterTool on dispose, prototype keys refused', async () => {
  const w = await world()
  try {
    const mc = previewContext()
    const h = await exposeTapeAPI(w.api, ADDR.container, { modelContext: mc, prefix: 'p_', format: 'object' })
    const r = await mc.callTool('p_ping', { echo: 'str' })
    assert.deepEqual(r.result, { pong: 'str' }); assert.equal(r.verified, true)
    await assert.rejects(mc.tools.get('p_ping').execute('{"__proto__":{"x":1}}', {}), (e) => e.code === 'BAD_REQUEST')
    await assert.rejects(mc.tools.get('p_ping').execute('[1]', {}), (e) => e.code === 'BAD_REQUEST')
    h.dispose()
    assert.equal(mc.tools.size, 0)
    await assert.rejects(h.tools.length ? Promise.resolve() : Promise.reject(Object.assign(new Error('x'), { code: 'OK' })), (e) => e.code === 'OK')
  } finally { await w.close() }
})

test('no modelContext: a no-op with a clear answer, and nothing is resolved', async () => {
  let fetched = 0
  const api = { resolve: async () => { fetched++; throw new Error('must not resolve') } }
  const h = await exposeTapeAPI(api, ADDR.container, { modelContext: null })
  assert.equal(h.supported, false); assert.equal(h.reason, 'NO_MODEL_CONTEXT')
  assert.deepEqual(h.tools, []); assert.equal(h.spentBEM(), '0')
  h(); h.dispose()
  assert.equal(fetched, 0)
  const h2 = await exposeTapeAPI(api, ADDR.container, { modelContext: {} })
  assert.equal(h2.reason, 'NO_REGISTER_TOOL')
  // the global lookup: no document in Node / 全局查找：Node 里没有 document
  assert.equal((await exposeTapeAPI(api, ADDR.container)).reason, 'NO_MODEL_CONTEXT')
})

test('paid exposure needs payer, per-call cap and budget; the budget is enforced before any request', async () => {
  const w = await world()
  try {
    const mc = draftContext()
    await assert.rejects(exposeTapeAPI(w.api, ADDR.container, { modelContext: mc, paid: { maxPriceBEM: '1', budgetBEM: '1' } }), (e) => e.code === 'BAD_REQUEST' && /payer/.test(e.message))
    await assert.rejects(exposeTapeAPI(w.api, ADDR.container, { modelContext: mc, paid: { payer: w.payer, maxPriceBEM: '1' } }), (e) => /budgetBEM/.test(e.message))
    const events = []
    const h = await exposeTapeAPI(w.api, ADDR.container, { modelContext: mc, prefix: 'b_', paid: { payer: w.payer, maxPriceBEM: '0.001', budgetBEM: '0.00015' }, onCall: (e) => events.push(e) })
    assert.deepEqual((await mc.getTools()).map((t) => t.name), ['b_ping', 'b_quote'])
    const p = payloadOf(await mc.executeTool('b_quote', {}))
    assert.equal(p.verified, true); assert.equal(p.priceBEM, '0.0001')
    assert.equal(w.payer.cumulativeOf(h.svc), parseUnits('0.0001'))
    const before = w.sent.length
    await assert.rejects(mc.executeTool('b_quote', {}), (e) => e.code === 'BUDGET_EXCEEDED')
    assert.equal(w.sent.length, before, 'refused before any request left the page')
    assert.equal(w.payer.cumulativeOf(h.svc), parseUnits('0.0001'))
    assert.equal(h.spentBEM(), '0.0001')
    // free methods still work once the budget is gone / 预算用完后免费方法照常可用
    assert.equal(payloadOf(await mc.executeTool('b_ping', {})).verified, true)
    assert.deepEqual(events.map((e) => [e.method, e.ok, e.code ?? null]), [['quote', true, null], ['quote', false, 'BUDGET_EXCEEDED'], ['ping', true, null]])
    h()
  } finally { await w.close() }
})

test('concurrent paid calls cannot overrun the budget together', async () => {
  const w = await world()
  try {
    const mc = draftContext()
    await exposeTapeAPI(w.api, ADDR.container, { modelContext: mc, prefix: 'c_', paid: { payer: w.payer, maxPriceBEM: '0.001', budgetBEM: '0.0002' } })
    const rs = await Promise.allSettled(Array.from({ length: 5 }, () => mc.executeTool('c_quote', {})))
    assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 2)
    assert.ok(rs.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'BUDGET_EXCEEDED'))
  } finally { await w.close() }
})

test('with a budget, a price rise is refused (PRICE_CHANGED), not paid; the human re-consents with acceptPrice + refresh', async () => {
  const w = await world({ providerMethods: METHODS('0.0005') })
  try {
    const mc = draftContext()
    const h = await exposeTapeAPI(w.api, ADDR.container, { modelContext: mc, prefix: 'r_', paid: { payer: w.payer, maxPriceBEM: '10', budgetBEM: '10' } })
    w.publish(METHODS('0.0005'))            // the holder republishes at 5x / 持有人以 5 倍价格重新发布
    h.svc.fetchedAt = 0                     // stale: the SDK re-reads before spending / 过期：SDK 付款前重读
    await assert.rejects(mc.executeTool('r_quote', {}), (e) => e.code === 'PRICE_CHANGED' && e.data.price === parseUnits('0.0005').toString())
    assert.equal(w.payer.cumulativeOf(h.svc), 0n, 'nothing was paid, although the cap (10 BEM) and budget would cover it')
    assert.ok(!w.sent.some((b) => b.voucher), 'no voucher left the page')
    assert.equal(h.spentBEM(), '0')
    // A second try is refused too: by our own gate, or because the background sync already withdrew the tool.
    // Either way nothing is paid. / 再试一次同样被拒：要么是自己的闸门，要么后台同步已撤下该工具；无论哪种都不付钱。
    await assert.rejects(mc.executeTool('r_quote', {}), (e) => e.code === 'PRICE_CHANGED' || /no tool r_quote/.test(e.message))
    assert.equal(w.payer.cumulativeOf(h.svc), 0n)
    // the tool list follows the refreshed manifest: the risen method is withdrawn / 工具列表跟随刷新：涨价的方法被撤下
    await h.refresh()
    assert.deepEqual((await mc.getTools()).map((t) => t.name), ['r_ping'])
    assert.equal(h.skipped.find((s) => s.method === 'quote').code, 'PRICE_CHANGED')
    // explicit human consent / 人明确同意
    w.api.acceptPrice(h.svc, 'quote'); await h.refresh()
    assert.deepEqual((await mc.getTools()).map((t) => t.name), ['r_ping', 'r_quote'])
    assert.match((await mc.getTools())[1].description, /Costs 0\.0005 BEM/)
    assert.equal(payloadOf(await mc.executeTool('r_quote', {})).priceBEM, '0.0005')
    assert.equal(w.payer.cumulativeOf(h.svc), parseUnits('0.0005'))
  } finally { await w.close() }
})

test('a free method that becomes priced is refused for a free-only page, with no payer ever passed', async () => {
  const w = await world({ providerMethods: [METHODS()[0], { ...METHODS()[1], priceBEM: '0' }], chainMethods: [METHODS()[0], { ...METHODS()[1], priceBEM: '0' }] })
  try {
    const mc = draftContext()
    const h = await exposeTapeAPI(w.api, ADDR.container, { modelContext: mc, prefix: 'f_' })
    assert.deepEqual((await mc.getTools()).map((t) => t.name), ['f_ping', 'f_quote'])
    w.publish(METHODS('0.0001')); h.svc.fetchedAt = 0
    await assert.rejects(mc.executeTool('f_quote', {}), (e) => e.code === 'PRICE_CHANGED')
    assert.equal(w.payer.cumulativeOf(h.svc), 0n)
    await new Promise((r) => setTimeout(r, 20))   // background tool sync after the SDK's re-read / SDK 重读后的后台同步
    assert.deepEqual((await mc.getTools()).map((t) => t.name), ['f_ping'], 'withdrawn from the agent')
  } finally { await w.close() }
})

test('confirm hook: the human can decline a paid call; nothing is paid or counted', async () => {
  const w = await world()
  try {
    const mc = draftContext(); const asked = []
    const h = await exposeTapeAPI(w.api, ADDR.container, { modelContext: mc, prefix: 'k_', paid: { payer: w.payer, maxPriceBEM: '1', budgetBEM: '1', confirm: (q) => { asked.push(q); return false } } })
    await assert.rejects(mc.executeTool('k_quote', { pair: ADDR.escrow }), (e) => e.code === 'USER_DECLINED')
    assert.deepEqual(asked, [{ tool: 'k_quote', method: 'quote', priceBEM: '0.0001', params: { pair: ADDR.escrow } }])
    assert.equal(h.spentBEM(), '0'); assert.equal(w.payer.cumulativeOf(h.svc), 0n)
    assert.equal(payloadOf(await mc.executeTool('k_ping', {})).verified, true, 'free calls are not asked about')
    assert.equal(asked.length, 1)
  } finally { await w.close() }
})

test('refresh follows the manifest: new methods registered, removed ones withdrawn; name collisions are reported', async () => {
  const w = await world({ providerMethods: [...METHODS(), { name: 'extra', priceBEM: '0', params: {}, returns: {} }] })
  try {
    const mc = draftContext()
    await mc.registerTool({ name: 'z_extra', description: 'someone else', execute: async () => 1 })
    const h = await exposeTapeAPI(w.api, ADDR.container, { modelContext: mc, prefix: 'z_' })
    w.publish([METHODS()[0], { name: 'extra', priceBEM: '0', params: {}, returns: {} }])
    await h.refresh()
    const own = [...mc.tools.values()].filter((t) => t.description !== 'someone else').map((t) => t.name)
    assert.deepEqual(own, ['z_ping'])
    assert.deepEqual(h.skipped.map((s) => [s.method, s.code]), [['extra', 'NAME_TAKEN']], 'the other script keeps its tool')
    assert.equal(mc.tools.get('z_extra').description, 'someone else')
    w.publish([{ name: 'extra', priceBEM: '0', params: {}, returns: {} }])
    await h.refresh()
    assert.ok(!mc.tools.has('z_ping'), 'removed from the manifest -> unregistered')
    h()
    assert.deepEqual([...mc.tools.keys()], ['z_extra'], 'dispose leaves other scripts\' tools alone')
    await assert.rejects(h.refresh(), (e) => e.code === 'BAD_REQUEST')
  } finally { await w.close() }
})

test('an already-resolved service can be exposed directly, and a stale tool reference is refused after dispose', async () => {
  const w = await world()
  try {
    const svc = await w.api.resolve(ADDR.container)
    const mc = previewContext()
    const h = await exposeTapeAPI(w.api, svc, { modelContext: mc, prefix: 's_', format: 'object' })
    assert.equal(h.svc, svc)
    const exec = mc.tools.get('s_ping').execute
    h()
    await assert.rejects(exec({}, {}), (e) => e.code === 'BAD_REQUEST' && /unregistered/.test(e.message))
  } finally { await w.close() }
})
