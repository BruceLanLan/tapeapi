// Adversarial probes of the MCP 2026-07-28 support (ids MR-*). Each test is a probe: FIXED
// <id> where the code was changed, CONFIRMED <id> where it pins behaviour judged acceptable or left
// open. Spec: https://modelcontextprotocol.io/specification/2026-07-28/ (read 2026-10-22).
// No network: the Worker reads a fake chain on 127.0.0.1.
// MCP 2026-07-28 支持的对抗性探测（编号 MR-*）。每个测试是一次探测：FIXED 表示改了代码，CONFIRMED 表示钉住
// 认为可接受或留作开放问题的行为。不联网。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mcp, sig, MAINNET } from '@tapeapi/sdk'
import { createProvider } from '../src/index.js'
import { createMcpEndpoint } from '../src/mcp.js'
import { createMcpProxy, MCP_PATH } from '../src/mcp-proxy.js'

const KEY = '0x' + '42'.repeat(32)
const SIGNER = sig.privateKeyToAddress(KEY)
const CIRCUITS = '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414', CONTAINER = '0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8'
const V = '2026-07-28'
const META = (o = {}) => ({ 'io.modelcontextprotocol/protocolVersion': V, 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 't', version: '1' }, ...o })
const H = (method, name) => ({ 'mcp-protocol-version': V, 'mcp-method': method, ...(name !== undefined ? { 'mcp-name': name } : {}) })
const b64 = (s) => `=?base64?${Buffer.from(s, 'utf8').toString('base64')}?=`

// ---- targets: the endpoint and the proxy / 目标：远程端点与签名代理 ----
const manifest = {
  tapeapi: '0.1', name: 'Echo', circuits: CIRCUITS, tokenId: '11', container: CONTAINER, signer: SIGNER,
  endpoints: { live: ['https://echo.example/tapeapi/v1'], async: false },
  methods: [
    { name: 'echo', priceBEM: '0', params: { text: 'string' }, returns: { text: 'string' }, description: 'Says it back.' },
    { name: 'wipe', priceBEM: '0', params: {}, returns: { done: 'boolean' }, description: 'A tool a gateway would not let through.' },
  ],
}
const calls = []
const provider = createProvider({ manifest, signerKey: KEY, rateLimit: false, log: () => {}, methods: { echo: async ({ text }) => ({ text }), wipe: async () => { calls.push('wipe'); return { done: true } } } })
const ep = createMcpEndpoint({ provider, manifest, name: '11.1013.tape', version: '0.3.0' })

const UP = [
  { name: 'echo', description: 'Says it back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'wipe', description: 'Dangerous.', inputSchema: { type: 'object', properties: {} } },
]
const upCalls = []
const upCore = () => mcp.createMcpServer({ info: { name: 'up', version: '1' }, listTools: async () => UP, callTool: async (n, a) => { upCalls.push(n); return { content: [{ type: 'text', text: n === 'echo' ? a.text : 'wiped' }] } } })
const BASE_P = { name: 'X', circuits: '0x' + '1'.repeat(40), tokenId: '1', container: '0x' + '2'.repeat(40), delegation: null, endpoints: { live: ['https://x.example/tapeapi/v1'], async: false } }
const proxyOver = (upstream, o = {}) => createMcpProxy({ upstream, signerKey: KEY, log: () => {}, rateLimit: false, manifestBase: BASE_P, ...o })
const core = upCore()
const proxy = proxyOver({ call: (m) => core.handle(m) })
await proxy.ready

const TARGETS = [
  ['endpoint', (req) => ep.handleRequest(req, { clientIp: '1.1.1.1' }), 'https://echo.example/mcp'],
  ['proxy', (req) => proxy.handleRequest(req, { clientIp: '1.1.1.1' }), 'https://x.example/mcp'],
]
const send = async (t, body, headers = {}) => {
  const [, handle, url] = t
  const res = await handle(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }))
  const text = await res.text()
  return { status: res.status, headers: res.headers, text, json: text ? JSON.parse(text) : null }
}
const callMsg = (name, meta = META(), id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: name === 'echo' ? { text: 'hi' } : {}, ...(meta ? { _meta: meta } : {}) } })

// ---------------------------------------------------------------------------------------------------------------
// MR-1: a batch carries a 2026-07-28 message past the HTTP header checks / 批量把新版消息带过请求头校验
// ---------------------------------------------------------------------------------------------------------------
// Streamable HTTP "Sending Messages" 4: the body MUST be a single request or notification; "Server Validation": servers
// that process the body MUST reject header/body mismatches (a gateway routing on Mcp-Name relies on it).
for (const t of TARGETS) {
  test(`FIXED MR-1 (${t[0]}): a batch holding a 2026-07-28 message is refused 400 before anything runs (no header bypass)`, async () => {
    upCalls.length = 0; calls.length = 0
    // Headers say "echo"; the batched body calls "wipe". / 请求头写 echo，批量正文调用 wipe。
    const r = await send(t, [callMsg('wipe')], H('tools/call', 'echo'))
    assert.equal(r.status, 400)
    assert.equal(r.json.error.code, mcp.JSONRPC.INVALID_REQUEST)
    assert.equal(r.json.id, null)
    assert.deepEqual(upCalls, []); assert.deepEqual(calls, [], 'the tool never ran')
    // A modern message with an unsupported version or an unknown method inside a batch: the same refusal, never a 200.
    for (const m of [{ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: META({ 'io.modelcontextprotocol/protocolVersion': '2099-01-01' }) } }, { jsonrpc: '2.0', id: 3, method: 'nope/x', params: { _meta: META() } }]) {
      const s = await send(t, [{ jsonrpc: '2.0', id: 'l', method: 'tools/list' }, m])
      assert.equal(s.status, 400, JSON.stringify(m))
    }
    // A legacy batch is answered as before. / 旧版批量照旧回答。
    const l = await send(t, [{ jsonrpc: '2.0', id: 'a', method: 'tools/list' }, { jsonrpc: '2.0', id: 'b', method: 'ping' }])
    assert.equal(l.status, 200); assert.equal(l.json.length, 2)
  })

  test(`FIXED MR-1 (${t[0]}): a batch sent with a 2026-07-28 MCP-Protocol-Version header is refused 400`, async () => {
    upCalls.length = 0; calls.length = 0
    const r = await send(t, [callMsg('wipe', null)], H('tools/call', 'echo'))
    assert.equal(r.status, 400); assert.equal(r.json.error.code, mcp.JSONRPC.INVALID_REQUEST)
    assert.deepEqual(upCalls, []); assert.deepEqual(calls, [])
    // A legacy header on a legacy batch: answered as before. / 旧版头部 + 旧版批量：照旧。
    assert.equal((await send(t, [{ jsonrpc: '2.0', id: 'a', method: 'ping' }], { 'mcp-protocol-version': '2025-11-25' })).status, 200)
  })
}

// ---------------------------------------------------------------------------------------------------------------
// MR-2: headers claim 2026-07-28, the body has no _meta, the mirrored headers lie / 头部声称新版、正文无 _meta、镜像头部不符
// ---------------------------------------------------------------------------------------------------------------
for (const t of TARGETS) {
  test(`FIXED MR-2, MR-2b (${t[0]}): MCP-Protocol-Version 2026-07-28 on a body without 2026-07-28 _meta is 400: -32020 when a header contradicts it, else -32602`, async () => {
    upCalls.length = 0; calls.length = 0
    const r = await send(t, callMsg('wipe', null), H('tools/call', 'echo'))
    assert.equal(r.status, 400); assert.equal(r.json.error.code, mcp.MCP_ERRORS.HEADER_MISMATCH); assert.equal(r.json.id, 1)
    const m = await send(t, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wipe', arguments: {} } }, H('tools/list'))
    assert.equal(m.status, 400); assert.equal(m.json.error.code, mcp.MCP_ERRORS.HEADER_MISMATCH)
    // The body names a legacy revision the header contradicts. / 正文写旧版本、头部写新版本。
    const v = await send(t, callMsg('wipe', { 'io.modelcontextprotocol/protocolVersion': '2025-11-25' }), H('tools/call', 'wipe'))
    assert.equal(v.status, 400); assert.equal(v.json.error.code, mcp.MCP_ERRORS.HEADER_MISMATCH)
    assert.deepEqual(upCalls, []); assert.deepEqual(calls, [])
    // FIXED MR-2b (CHANGED: the fixture's "POST ping with MCP-Protocol-Version 2026-07-28 but no _meta"): the header alone,
    // or with matching mirrored headers, is a 2026-07-28 request missing its required _meta field: 400 -32602.
    // FIXED MR-2b：只有新版头部（或镜像头部相符）而正文无 _meta：缺必填字段的新版请求，400 -32602。
    for (const [body, headers] of [[{ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'mcp-protocol-version': V }], [callMsg('echo', null), H('tools/call', 'echo')], [{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { progressToken: 1 } } }, H('tools/list')]]) {
      const r = await send(t, body, headers)
      assert.equal(r.status, 400, body.method); assert.equal(r.json.error.code, mcp.JSONRPC.INVALID_PARAMS); assert.equal(r.json.id, 1)
    }
    // initialize keeps the legacy handshake whatever the header says; a notification is not answered. / initialize 照旧。
    const init = await send(t, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'n', version: '1' } } }, { 'mcp-protocol-version': V })
    assert.equal(init.status, 200); assert.equal(init.json.result.protocolVersion, '2025-11-25')
    assert.equal((await send(t, { jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-protocol-version': V })).status, 202)
    assert.deepEqual(upCalls, []); assert.deepEqual(calls, [])
    // Mismatching mirrored headers without a modern version header: legacy, as 2.4.0 answered. / 无新版头部：照旧。
    assert.equal((await send(t, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'mcp-method': 'tools/call', 'mcp-name': 'x' })).status, 200)
    // Only 2026-07-28 in the header counts as a claim; a legacy revision or garbage is answered as 2.4.0 did (the
    // legacy fuzz found the first draft of this fix refusing those). / 只有 2026-07-28 算声称新版；旧版本或乱写照 2.4.0 回答。
    for (const v of ['2025-11-25', '2099-01-01', 'garbage']) {
      assert.equal((await send(t, callMsg('echo', null), { 'mcp-protocol-version': v, 'mcp-method': 'tools/list', 'mcp-name': 'x' })).status, 200, v)
      assert.equal((await send(t, [{ jsonrpc: '2.0', id: 'a', method: 'ping' }], { 'mcp-protocol-version': v })).status, 200, v)
    }
  })
}

// ---------------------------------------------------------------------------------------------------------------
// MR-3: header handling of a single modern request (expected to hold) / 单条新版请求的请求头处理
// ---------------------------------------------------------------------------------------------------------------
for (const t of TARGETS) {
  test(`CONFIRMED MR-3 (${t[0]}): header names are case-insensitive, values exact; duplicates, bad Base64 and a raw sentinel are 400 -32020`, async () => {
    const ok = (r) => { assert.equal(r.status, 200, r.text); assert.equal(r.json.result.resultType, 'complete') }
    const bad = (r, code = mcp.MCP_ERRORS.HEADER_MISMATCH) => { assert.equal(r.status, 400, r.text); assert.equal(r.json.error.code, code) }
    ok(await send(t, callMsg('echo'), { 'MCP-PROTOCOL-VERSION': V, 'MCP-METHOD': 'tools/call', 'MCP-NAME': 'echo' }))
    bad(await send(t, callMsg('echo'), { 'mcp-protocol-version': V, 'mcp-method': 'Tools/Call', 'mcp-name': 'echo' }))
    bad(await send(t, callMsg('echo'), { 'mcp-protocol-version': V, 'mcp-method': 'tools/call', 'mcp-name': 'ECHO' }))
    // Fetch Headers join duplicates with ", ". / 重复头部被合并为 "a, b"。
    const dup = new Headers({ 'content-type': 'application/json', 'mcp-protocol-version': V, 'mcp-method': 'tools/call' })
    dup.append('mcp-name', 'echo'); dup.append('mcp-name', 'echo')
    bad(await send(t, callMsg('echo'), Object.fromEntries(dup)))
    const dupV = new Headers(H('tools/call', 'echo')); dupV.append('mcp-protocol-version', V)
    bad(await send(t, callMsg('echo'), Object.fromEntries(dupV)))
    // Base64 sentinel: decoded before comparing; markers case-sensitive; invalid Base64 or UTF-8 refused.
    ok(await send(t, callMsg('echo'), H('tools/call', b64('echo'))))
    ok(await send(t, callMsg('echo'), H('tools/call', '=?base64?ZWNobw?=')))   // unpadded: forgiving Base64 / 无填充
    bad(await send(t, callMsg('echo'), H('tools/call', '=?BASE64?ZWNobw==?=')))
    bad(await send(t, callMsg('echo'), H('tools/call', '=?base64?A?=')))
    bad(await send(t, callMsg('echo'), H('tools/call', '=?base64?/w==?=')))   // 0xFF is not UTF-8 / 不是 UTF-8
    bad(await send(t, callMsg('echo'), H('tools/call', '=?base64??=')))
    // A body name that itself looks like a sentinel must be sent encoded; sent raw it does not match.
    // 正文名字本身形如哨兵时必须编码发送；原样发送则不相符。
    const lit = '=?base64?ZWNobw==?='
    bad(await send(t, callMsg(lit), H('tools/call', lit)))
    const enc = await send(t, callMsg(lit), H('tools/call', b64(lit)))
    assert.equal(enc.status, 200); assert.equal(enc.json.error.code, mcp.JSONRPC.INVALID_PARAMS, 'then the server says there is no such tool')
    // Missing headers. / 缺头部。
    bad(await send(t, callMsg('echo'), { 'mcp-method': 'tools/call', 'mcp-name': 'echo' }))
    bad(await send(t, callMsg('echo'), { 'mcp-protocol-version': V, 'mcp-name': 'echo' }))
    bad(await send(t, callMsg('echo'), H('tools/call')))
    bad(await send(t, { jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: META() } }, { 'mcp-protocol-version': V }))
    // Mcp-Name on a method that has no name is not looked at. / 没有名字的方法不看 Mcp-Name。
    ok(await send(t, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META() } }, H('tools/list', 'anything')))
    // Whitespace around a header value is HTTP's to strip (RFC 9110 5.5); Fetch does. / 头部值两端空白由 HTTP 去掉。
    ok(await send(t, callMsg('echo'), { 'mcp-protocol-version': ` ${V} `, 'mcp-method': ' tools/call', 'mcp-name': 'echo ' }))
    // The reflected header value is cut to 64 characters and JSON-escaped. / 回显的头部值截到 64 个字符。
    const long = await send(t, callMsg('echo'), { 'mcp-protocol-version': 'x'.repeat(5000), 'mcp-method': 'tools/call', 'mcp-name': 'echo' })
    bad(long); assert.ok(long.text.length < 400, long.text.length)
  })
}

test('CONFIRMED MR-3: CR / LF in a header value never reaches the handler (Fetch refuses to build the request)', () => {
  assert.throws(() => new Request('https://x.example/mcp', { method: 'POST', headers: { 'mcp-name': 'echo\r\nx-evil: 1' }, body: '{}' }))
  assert.throws(() => new Headers({ 'mcp-method': 'tools/call\nx-evil: 1' }), TypeError)
  assert.throws(() => new Headers({ 'mcp-name': 'a\u0000b' }), TypeError)
  // Leading / trailing CR LF are HTTP whitespace and are stripped, not smuggled. / 两端的 CR LF 是空白，被去掉。
  assert.equal(new Headers({ 'mcp-method': 'tools/call\r\n' }).get('mcp-method'), 'tools/call')
})

// ---------------------------------------------------------------------------------------------------------------
// MR-4: version classification / 版本分类
// ---------------------------------------------------------------------------------------------------------------
for (const t of TARGETS) {
  test(`CONFIRMED MR-4 (${t[0]}): _meta versions that are not 2026-07-28 or a legacy revision are 400; initialize stays legacy`, async () => {
    const list = (v) => send(t, { jsonrpc: '2.0', id: 9, method: 'tools/list', params: { _meta: META({ 'io.modelcontextprotocol/protocolVersion': v }) } }, H('tools/list'))
    for (const v of ['2027-01-01', '2099-12-31', '1900-01-01', ' 2026-07-28', '2026-07-28 ', 'latest', '', '2026-7-28', 'x'.repeat(10_000)]) {
      const r = await list(v)
      assert.equal(r.status, 400, JSON.stringify(v).slice(0, 40)); assert.equal(r.json.error.code, mcp.MCP_ERRORS.UNSUPPORTED_PROTOCOL_VERSION)
      assert.deepEqual(r.json.error.data.supported, ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'])
      assert.ok(r.json.error.data.requested.length <= 64)
    }
    for (const v of [20260728, ['2026-07-28'], { v: '2026-07-28' }, null, true]) {
      const r = await list(v)
      assert.equal(r.status, 400, JSON.stringify(v)); assert.equal(r.json.error.code, mcp.JSONRPC.INVALID_PARAMS)
    }
    for (const caps of [undefined, null, [], 'all', 1]) {
      const meta = META(); if (caps === undefined) delete meta['io.modelcontextprotocol/clientCapabilities']; else meta['io.modelcontextprotocol/clientCapabilities'] = caps
      const r = await send(t, { jsonrpc: '2.0', id: 9, method: 'tools/list', params: { _meta: meta } }, H('tools/list'))
      assert.equal(r.status, 400); assert.equal(r.json.error.code, mcp.JSONRPC.INVALID_PARAMS)
    }
    // clientInfo is optional (basic/index "Per-request protocol fields"). / clientInfo 可选。
    const noInfo = META(); delete noInfo['io.modelcontextprotocol/clientInfo']
    assert.equal((await send(t, { jsonrpc: '2.0', id: 9, method: 'tools/list', params: { _meta: noInfo } }, H('tools/list'))).status, 200)
    // A legacy revision in _meta is a legacy request. / _meta 写旧版本即旧版请求。
    const l = await send(t, { jsonrpc: '2.0', id: 9, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-11-25' } } })
    assert.equal(l.status, 200); assert.deepEqual(Object.keys(l.json.result), ['tools'])
    // A new client sending initialize with modern _meta gets the legacy handshake (versioning "Backward Compatibility").
    const i = await send(t, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: V, capabilities: {}, clientInfo: { name: 'n', version: '1' }, _meta: META() } }, H('initialize'))
    assert.equal(i.status, 200); assert.equal(i.json.result.protocolVersion, '2025-11-25'); assert.equal('resultType' in i.json.result, false)
    assert.equal(i.headers.get('mcp-session-id'), null)
  })
}

// ---------------------------------------------------------------------------------------------------------------
// MR-5: server/discover, unknown methods, statelessness / server/discover、未知方法、无状态
// ---------------------------------------------------------------------------------------------------------------
for (const t of TARGETS) {
  test(`CONFIRMED MR-5 (${t[0]}): server/discover discloses nothing internal and ignores its params; an unknown method is 404 -32601; no state across requests`, async () => {
    const big = { _meta: META(), junk: 'x'.repeat(60_000), nested: { a: [1, { b: 2 }] } }
    const d = await send(t, { jsonrpc: '2.0', id: 'd', method: 'server/discover', params: big }, H('server/discover'))
    assert.equal(d.status, 200)
    assert.deepEqual(Object.keys(d.json.result).sort(), ['_meta', 'cacheScope', 'capabilities', 'instructions', 'resultType', 'supportedVersions', 'ttlMs'])
    assert.deepEqual(d.json.result.capabilities, { tools: { listChanged: false } })
    assert.equal(d.json.result.ttlMs, 0); assert.equal(d.json.result.cacheScope, 'public')
    assert.deepEqual(Object.keys(d.json.result._meta), ['io.modelcontextprotocol/serverInfo'])
    // Nothing that looks like a path, a host of the upstream, a key or an address beyond the public identity.
    // 没有路径、上游主机、密钥，也没有公开身份之外的地址。
    assert.doesNotMatch(d.text, /\/Users\/|\/home\/|file:|mcp\.internal|0x42{8}|127\.0\.0\.1|localhost|stack|Error/i)
    assert.ok(!d.text.includes(KEY.slice(2, 20)))
    const over = await send(t, { jsonrpc: '2.0', id: 'd', method: 'server/discover', params: { _meta: META(), junk: 'x'.repeat(70_000) } }, H('server/discover'))
    assert.equal(over.status, 413)
    // Unknown method: 404 with a bounded echo. / 未知方法：404，回显有界。
    const u = await send(t, { jsonrpc: '2.0', id: 'u', method: 'x'.repeat(5000), params: { _meta: META() } }, H('x'.repeat(5000)))
    assert.equal(u.status, 404); assert.equal(u.json.error.code, -32601); assert.ok(u.text.length < 400)
    for (const m of ['logging/setLevel', 'resources/subscribe', 'subscriptions/listen', 'completion/complete']) {
      const r = await send(t, { jsonrpc: '2.0', id: 'u', method: m, params: { _meta: META() } }, H(m))
      assert.equal(r.status, 404, m)
    }
    // resources/read and prompts/get need Mcp-Name first, then are unknown. / 先查 Mcp-Name，再是未知方法。
    assert.equal((await send(t, { jsonrpc: '2.0', id: 'r', method: 'resources/read', params: { uri: 'file:///etc/passwd', _meta: META() } }, H('resources/read'))).status, 400)
    assert.equal((await send(t, { jsonrpc: '2.0', id: 'r', method: 'resources/read', params: { uri: 'file:///etc/passwd', _meta: META() } }, H('resources/read', 'file:///etc/passwd'))).status, 404)
    // Two identical modern requests: no session id minted or echoed, same answer shape. / 不发、不回显会话 id。
    const a = await send(t, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META() } }, { ...H('tools/list'), 'mcp-session-id': 'attacker-chosen' })
    const b = await send(t, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META() } }, H('tools/list'))
    assert.equal(a.headers.get('mcp-session-id'), null); assert.equal(b.headers.get('mcp-session-id'), null)
    assert.equal(a.text, b.text)
    // A modern ping is still answered (lenient; the method exists here). / 新版 ping 仍有回答（宽松）。
    assert.equal((await send(t, { jsonrpc: '2.0', id: 1, method: 'ping', params: { _meta: META() } }, H('ping'))).json.result.resultType, 'complete')
  })
}

// ---------------------------------------------------------------------------------------------------------------
// MR-6: the proxy as a client of its upstream (upstreamNegotiation: 'auto') / 代理作为上游的客户端
// ---------------------------------------------------------------------------------------------------------------
const signedCall = async (p, name = 'echo', params = { text: 'hi' }) => (await (await p.handleRequest(new Request(`https://x.example/tapeapi/v1/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'r-1', params }) }), { clientIp: '3.3.3.3' })).json())
// An upstream scripted per method; `seen` keeps what it was sent. / 按方法编排回答的上游。
function scripted(script) {
  const seen = [], c = upCore()
  return { seen, call: async (m) => { seen.push(m); if (m.id === undefined) return null; const s = script[m.method]; return s ? s(m, c) : c.handle(m) } }
}
const err = (m, code, data) => ({ jsonrpc: '2.0', id: m.id, error: { code, message: 'no', ...(data ? { data } : {}) } })

test('CONFIRMED MR-6a: an upstream that claims 2026-07-28 in discover but answers legacy-shaped results is served (absent resultType is "complete")', async () => {
  const up = scripted({ 'server/discover': (m) => ({ jsonrpc: '2.0', id: m.id, result: { supportedVersions: [V], capabilities: {} } }), 'tools/list': (m) => ({ jsonrpc: '2.0', id: m.id, result: { tools: UP } }) })
  const p = proxyOver({ call: up.call }, { upstreamNegotiation: 'auto' })
  const man = await p.ready
  assert.equal(p.stats().upstreamEra, 'modern')
  assert.equal(man.mcp.toolsSha256, mcp.toolsDigest(UP))
  assert.equal((await signedCall(p)).ok, true)
})

test('CONFIRMED MR-6b: an upstream that claims 2026-07-28 and then refuses modern requests leaves the proxy unstarted (503), never half-modern', async () => {
  const up = scripted({ 'server/discover': (m) => ({ jsonrpc: '2.0', id: m.id, result: { supportedVersions: [V] } }), 'tools/list': (m) => err(m, -32600, undefined) })
  const p = proxyOver({ call: up.call }, { upstreamNegotiation: 'auto' })
  await assert.rejects(p.ready, /could not read the upstream tools/)
  const r = await p.handleRequest(new Request('https://x.example/mcp', { method: 'POST', body: '{}' }))
  assert.equal(r.status, 503)
  assert.ok(up.seen.every((m) => m.method !== 'initialize'), 'no fallback once modern was decided')
})

test('CONFIRMED MR-6c: -32022 listing a legacy revision falls back to initialize; a crafted supported list without one refuses to start', async () => {
  const fallback = scripted({ 'server/discover': (m) => err(m, -32022, { supported: ['2025-11-25'], requested: V }) })
  const p = proxyOver({ call: fallback.call }, { upstreamNegotiation: 'auto' })
  await p.ready
  assert.equal(p.stats().upstreamEra, 'legacy'); assert.ok(fallback.seen.some((m) => m.method === 'initialize'))
  for (const supported of [[], ['2099-01-01'], [{ toString: null }], '2025-11-25', null, Array.from({ length: 10_000 }, () => '9999-99-99')]) {
    const up = scripted({ 'server/discover': (m) => err(m, -32022, { supported, requested: V }) })
    const q = proxyOver({ call: up.call }, { upstreamNegotiation: 'auto' })
    await assert.rejects(q.ready, /refused revision|could not read/, JSON.stringify(supported).slice(0, 40))
    assert.ok(up.seen.every((m) => m.method !== 'initialize'), 'no downgrade to initialize')
  }
  // A forged error code outside -32020..-32022 is "not modern": initialize. / 其它错误码：退回 initialize。
  const other = scripted({ 'server/discover': (m) => err(m, -32601) })
  const o = proxyOver({ call: other.call }, { upstreamNegotiation: 'auto' })
  await o.ready; assert.equal(o.stats().upstreamEra, 'legacy')
})

test('CONFIRMED MR-6d: a probe that times out decides "legacy" for the life of the process (a dual-era upstream keeps working)', async () => {
  let slow = true
  const up = scripted({ 'server/discover': async (m, c) => { if (slow) await new Promise((ok) => setTimeout(ok, 300)); return c.handle(m) } })
  const p = proxyOver({ call: up.call }, { upstreamNegotiation: 'auto', upstreamTimeoutMs: 100 })
  await p.ready
  slow = false
  assert.equal(p.stats().upstreamEra, 'legacy')
  assert.equal((await signedCall(p)).ok, true)
})

test('CONFIRMED MR-6e: nothing of the caller\'s request (_meta, io.modelcontextprotocol keys, headers) reaches the upstream', async () => {
  const up = scripted({})
  const p = proxyOver({ call: up.call }, { upstreamNegotiation: 'auto' })
  await p.ready
  const forged = META({ progressToken: 'p', 'io.modelcontextprotocol/clientCapabilities': { sampling: {} }, 'io.modelcontextprotocol/clientInfo': { name: 'evil', version: '6' } })
  const r = await p.handleRequest(new Request('https://x.example/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...H('tools/call', 'echo'), authorization: 'Bearer secret' }, body: JSON.stringify(callMsg('echo', forged)) }), { clientIp: '4.4.4.4' })
  assert.equal(r.status, 200)
  const sent = up.seen.filter((m) => m.method === 'tools/call')
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].params.arguments, { text: 'hi' })
  assert.deepEqual(sent[0].params._meta['io.modelcontextprotocol/clientCapabilities'], {})
  assert.equal(sent[0].params._meta['io.modelcontextprotocol/clientInfo'].name, 'tapeapi-mcp-proxy')
  assert.equal('progressToken' in sent[0].params._meta, false)
  assert.ok(!JSON.stringify(up.seen).includes('secret'))
})

test('CONFIRMED MR-6f: input_required (or any non-complete resultType) from a modern upstream is a signed INTERNAL refusal; nothing of it is signed', async () => {
  for (const resultType of ['input_required', 'Complete', null, 7, 'x'.repeat(100)]) {
    const up = scripted({ 'tools/call': (m) => ({ jsonrpc: '2.0', id: m.id, result: { resultType, content: [{ type: 'text', text: 'LEAKED' }], inputRequests: { a: { method: 'elicitation/create', params: {} } } } }) })
    const p = proxyOver({ call: up.call }, { upstreamNegotiation: 'auto' })
    await p.ready
    const env = await signedCall(p)
    assert.equal(env.ok, false, String(resultType)); assert.equal(env.error.code, 'INTERNAL')
    assert.equal(typeof env.sig, 'string')
    assert.ok(!JSON.stringify(env).includes('LEAKED'))
    assert.equal(sig.recoverResponseSigner({ container: env.container, id: env.id, method: 'echo', params: { text: 'hi' }, ok: false, body: env.error, ts: env.ts }, env.sig), SIGNER)
    // Through /mcp: a tool result with isError and the provenance line, nothing of the upstream content.
    const r = await (await p.handleRequest(new Request('https://x.example/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...H('tools/call', 'echo') }, body: JSON.stringify(callMsg('echo')) }))).json()
    assert.equal(r.result.isError, true); assert.equal(r.result.resultType, 'complete')
    assert.ok(!JSON.stringify(r).includes('LEAKED'))
  }
})

test('CONFIRMED MR-6g: the era decided at boot is never probed again; an upstream that drops 2026-07-28 later fails every call until restart (availability, operator-owned)', async () => {
  let modern = true
  const c = upCore()
  const call = async (m) => {
    if (m.id === undefined) return null
    if (!modern && mcp.requestEra(m.method, m.params).era === 'modern') return err(m, -32601)
    return c.handle(m)
  }
  const p = proxyOver({ call }, { upstreamNegotiation: 'auto' })
  await p.ready
  modern = false
  const env = await signedCall(p)
  assert.equal(env.ok, false); assert.equal(env.error.code, 'INTERNAL')
  assert.equal(p.stats().upstreamEra, 'modern')
})

// ---------------------------------------------------------------------------------------------------------------
// MR-7: the public Worker: /mcp/pinned when MCP_TOOLS_SHA256 is unset or wrong / 公共 Worker 的 /mcp/pinned
// ---------------------------------------------------------------------------------------------------------------
async function fakeNodes() {
  const block = { number: '0x3e8', hash: '0x' + 'cd'.repeat(32), timestamp: '0x6a000000' }
  const srv = http.createServer(async (req, res) => {
    const parts = []; for await (const ch of req) parts.push(ch)
    const one = (m) => ({ jsonrpc: '2.0', id: m.id, ...(m.method === 'eth_blockNumber' ? { result: block.number } : m.method === 'eth_chainId' ? { result: '0x38' } : m.method === 'eth_getBlockByNumber' ? { result: block } : { error: { code: -32601, message: 'no' } }) })
    const msg = JSON.parse(Buffer.concat(parts).toString('utf8'))
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(Array.isArray(msg) ? msg.map(one) : one(msg)))
  })
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok))
  const port = srv.address().port
  return { urls: `http://127.0.0.1:${port},http://localhost:${port}`, close: () => new Promise((ok) => { srv.closeAllConnections(); srv.close(ok) }) }
}
// A fresh module per env: the Worker keeps its provider at module level. / 每个 env 一个新模块实例。
let fresh = 0
async function workerWith(extra) {
  const nodes = await fakeNodes()
  const { default: worker } = await import(`../../examples/public-api/worker.js?review=${++fresh}`)
  const expires = Math.floor(Date.now() / 1000) + 90 * 86_400
  const WKEY = '0x' + '22'.repeat(32)
  const env = {
    SIGNER_KEY: WKEY, CIRCUITS, TOKEN_ID: '11', CONTAINER, DELEGATION_EXPIRES: String(expires),
    DELEGATION_SIG: sig.signDigest(sig.delegationDigest(56, MAINNET.hub, { container: CONTAINER, signer: sig.privateKeyToAddress(WKEY), expires }), '0x' + '11'.repeat(32)),
    PUBLIC_URL: 'https://api.tapeapi.fun', SERVICE_NAME: 'TapeAPI Public', TAPE_NAME: '11.1013.tape', RPC_URLS: nodes.urls, ...extra,
  }
  const log = console.log
  const fetch = async (path, init) => { console.log = () => {}; try { const r = await worker.fetch(new Request(`https://api.tapeapi.fun${path}`, init), env); await new Promise((ok) => setTimeout(ok, 0)); return r } finally { console.log = log } }
  return { fetch, close: nodes.close }
}
const post = (body, headers = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

test('CONFIRMED MR-7a: without MCP_TOOLS_SHA256 no path reveals or serves the tool methods', async () => {
  const w = await workerWith({})
  try {
    for (const path of ['/mcp/pinned', '/mcp/pinned/', '/MCP/pinned', '/mcp/pinned/x', '/mcp//pinned']) {
      for (const body of [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META() } }]) {
        const r = await w.fetch(path, post(body, H('tools/list')))
        const text = await r.text()
        assert.notEqual(r.status, 200, `${path}: ${text.slice(0, 120)}`)
        assert.doesNotMatch(text, /tool_[a-z_]+/, path)
      }
    }
    const list = await (await w.fetch('/mcp', post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META() } }, H('tools/list')))).json()
    assert.ok(list.result.tools.length > 0)
    assert.ok(list.result.tools.every((t) => !t.name.startsWith('tool_')))
    const manifestText = await (await w.fetch('/.well-known/tapeapi.json', { method: 'GET' })).text()
    assert.doesNotMatch(manifestText, /tool_|mcp\/pinned/)
    const call = await w.fetch('/tapeapi/v1/tool_block_number', post({ id: 'x', params: {} }))
    assert.doesNotMatch(await call.text(), /"ok":true/)
    const viaMcp = await (await w.fetch('/mcp', post(callMsg('tool_block_number'), H('tools/call', 'tool_block_number')))).json()
    assert.equal(viaMcp.error.code, mcp.JSONRPC.INVALID_PARAMS)
  } finally { await w.close() }
})

test('FIXED MR-7b: /mcp/pinned with a published digest that does not match refuses tools/list as the proxy does (TOOLS_CHANGED), and every call is a signed TOOLS_CHANGED', async () => {
  const wrong = 'ab'.repeat(32)
  const w = await workerWith({ MCP_TOOLS_SHA256: wrong })
  try {
    for (const [body, headers] of [[{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META() } }, H('tools/list')], [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }, {}]]) {
      const r = await w.fetch('/mcp/pinned', post(body, headers))
      assert.equal(r.status, 200)
      const list = await r.json()
      assert.equal('result' in list, false, 'no tool list is served')
      assert.equal(list.error.code, mcp.JSONRPC.INTERNAL)
      assert.equal(list.error.data.code, 'TOOLS_CHANGED'); assert.equal(list.error.data.published, wrong)
      assert.match(list.error.data.current, /^[0-9a-f]{64}$/); assert.notEqual(list.error.data.current, wrong)
    }
    // In a batch too. / 批量里也一样。
    const batch = await (await w.fetch('/mcp/pinned', post([{ jsonrpc: '2.0', id: 'a', method: 'tools/list' }, { jsonrpc: '2.0', id: 'b', method: 'ping' }]))).json()
    assert.equal(batch[0].error.data.code, 'TOOLS_CHANGED'); assert.deepEqual(batch[1].result, {})
    const call = await (await w.fetch('/mcp/pinned', post(callMsg('tool_block_number'), H('tools/call', 'tool_block_number')))).json()
    assert.equal(call.result.isError, true)
    assert.equal(call.result._meta[mcp.RECEIPT_META_KEY].error.code, 'TOOLS_CHANGED')
    assert.equal(call.result._meta[mcp.RECEIPT_META_KEY].error.data.published, wrong)
    // /mcp (not pinned) keeps listing its tools. / /mcp 照常列出工具。
    assert.ok((await (await w.fetch('/mcp', post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))).json()).result.tools.length > 0)
  } finally { await w.close() }
})

test('FIXED MR-7b: createMcpEndpoint pinnedToolsSha256: a matching digest lists as before; a malformed one is refused at construction', async () => {
  const digest = await ep.toolsSha256()
  const held = createMcpEndpoint({ provider, manifest, name: '11.1013.tape', version: '0.3.0', pinnedToolsSha256: digest })
  const t = ['held', (req) => held.handleRequest(req), 'https://echo.example/mcp']
  const a = await send(t, { jsonrpc: '2.0', id: 1, method: 'tools/list' }), b = await send(TARGETS[0], { jsonrpc: '2.0', id: 1, method: 'tools/list' })
  assert.equal(a.text, b.text)
  for (const bad of ['AB'.repeat(32), 'ab', 1, '0x' + 'ab'.repeat(32)]) assert.throws(() => createMcpEndpoint({ provider, manifest, pinnedToolsSha256: bad }), /pinnedToolsSha256/)
})

test('CONFIRMED MR-7c: a malformed MCP_TOOLS_SHA256 keeps the Worker in setup mode; /mcp/pinned serves no tool', async () => {
  const w = await workerWith({ MCP_TOOLS_SHA256: '0x' + 'ab'.repeat(32) })
  try {
    const r = await w.fetch('/mcp/pinned', post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    assert.doesNotMatch(await r.text(), /"tools":\[/)
  } finally { await w.close() }
})

// ---------------------------------------------------------------------------------------------------------------
// MR-8: Origin (pre-existing, 2.0+) / Origin（2.0 起就有）
// ---------------------------------------------------------------------------------------------------------------
for (const t of TARGETS) {
  test(`CONFIRMED MR-8 (${t[0]}): by default any Origin is answered (CORS *, no credentials, no session), as before`, async () => {
    const r = await send(t, callMsg('echo'), { ...H('tools/call', 'echo'), origin: 'https://evil.example' })
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('access-control-allow-origin'), '*')
    assert.equal(r.headers.get('access-control-allow-credentials'), null)
  })
}

// FIXED MR-8: allowedOrigins (opt-in). Streamable HTTP "Security & Endpoint" 1: an invalid Origin is 403.
const OK_ORIGIN = 'http://localhost:5173'
const epO = createMcpEndpoint({ provider, manifest, name: '11.1013.tape', version: '0.3.0', allowedOrigins: [OK_ORIGIN, 'https://app.example'] })
const proxyO = proxyOver({ call: (m) => core.handle(m) }, { allowedOrigins: [OK_ORIGIN] })
await proxyO.ready
for (const t of [['endpoint', (req) => epO.handleRequest(req, { clientIp: '1.1.1.1' }), 'https://echo.example/mcp'], ['proxy', (req) => proxyO.handleRequest(req, { clientIp: '1.1.1.1' }), 'https://x.example/mcp']]) {
  test(`FIXED MR-8 (${t[0]}): allowedOrigins: an unlisted Origin is 403 and nothing runs; a listed one is echoed; no Origin is answered`, async () => {
    upCalls.length = 0; calls.length = 0
    const bad = await send(t, callMsg('wipe'), { ...H('tools/call', 'wipe'), origin: 'https://evil.example' })
    assert.equal(bad.status, 403)
    assert.deepEqual(bad.json, { jsonrpc: '2.0', error: { code: -32600, message: 'Origin not allowed' } })
    assert.equal(bad.headers.get('access-control-allow-origin'), null)
    assert.deepEqual(upCalls, []); assert.deepEqual(calls, [])
    for (const origin of ['null', 'http://localhost:5174', 'http://LOCALHOST:5173', `${OK_ORIGIN}/`]) {
      assert.equal((await send(t, callMsg('echo'), { ...H('tools/call', 'echo'), origin })).status, 403, origin)
    }
    const pre = await t[1](new Request(t[2], { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } }))
    assert.equal(pre.status, 403)
    const okPre = await t[1](new Request(t[2], { method: 'OPTIONS', headers: { origin: OK_ORIGIN, 'access-control-request-method': 'POST' } }))
    assert.equal(okPre.status, 204); assert.equal(okPre.headers.get('access-control-allow-origin'), OK_ORIGIN); assert.match(okPre.headers.get('vary'), /origin/i)
    const ok = await send(t, callMsg('echo'), { ...H('tools/call', 'echo'), origin: OK_ORIGIN })
    assert.equal(ok.status, 200); assert.equal(ok.json.result.isError, false)
    assert.equal(ok.headers.get('access-control-allow-origin'), OK_ORIGIN)
    const none = await send(t, callMsg('echo'), H('tools/call', 'echo'))
    assert.equal(none.status, 200); assert.equal(none.headers.get('access-control-allow-origin'), null)
  })
}

test('FIXED MR-8: allowedOrigins must be a non-empty list of exact origins', () => {
  for (const bad of [[], 'https://a.example', ['https://a.example/'], ['https://a.example/path'], ['a.example'], ['*'], [1]]) {
    assert.throws(() => createMcpEndpoint({ provider, manifest, allowedOrigins: bad }), /allowedOrigins/, JSON.stringify(bad))
    assert.throws(() => proxyOver({ call: (m) => core.handle(m) }, { allowedOrigins: bad }), /allowedOrigins/, JSON.stringify(bad))
  }
})

test('FIXED MR-8: the Worker takes MCP_ALLOWED_ORIGINS for /mcp and /mcp/pinned; a malformed value is setup mode', async () => {
  const w = await workerWith({ MCP_ALLOWED_ORIGINS: ` ${OK_ORIGIN}, https://app.example ` })
  try {
    assert.equal((await w.fetch('/mcp', post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { origin: 'https://evil.example' }))).status, 403)
    const ok = await w.fetch('/mcp', post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { origin: 'https://app.example' }))
    assert.equal(ok.status, 200); assert.equal(ok.headers.get('access-control-allow-origin'), 'https://app.example')
  } finally { await w.close() }
  const p = await workerWith({ MCP_ALLOWED_ORIGINS: 'https://app.example/', MCP_TOOLS_SHA256: 'ab'.repeat(32) })
  try {
    const r = await p.fetch('/mcp', post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    assert.match(await r.text(), /MCP_ALLOWED_ORIGINS/)
  } finally { await p.close() }
})
