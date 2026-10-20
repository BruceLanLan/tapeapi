// The public service (api.tapeapi.fun) declaring MCP tools under TAPI-20 §3.8 (2.4, experimental), end to end on a
// local fake chain and a local Worker. With MCP_TOOLS_SHA256 set, eight tool methods (tool_block_number, ...) whose
// signed results are MCP tool results are added after the eight REST methods, served as the tools of /mcp/pinned, and
// declared as `mcp`; /mcp and the REST methods stay exactly as they were. Covered: the digest it would publish,
// `tapeapi connect` on the new manifest, tapeapi-mcp pinning and checking the tools and every answer and showing it,
// both sides refusing changed tools while REST keeps answering, and what stays the same for old clients. No network:
// the chain is sdk/test/helpers/conform-chain.mjs, the Worker and its nodes listen on 127.0.0.1.
// 公共服务按 TAPI-20 §3.8 声明 MCP 工具（2.4，实验性），在本地假链与本地 Worker 上端到端。设置 MCP_TOOLS_SHA256 后，在八个 REST
// 方法之后加上八个签名结果就是 MCP 工具结果的工具方法（tool_block_number 等），作为 /mcp/pinned 的工具提供并以 `mcp` 声明；
// /mcp 与 REST 方法完全不变。覆盖：将发布的摘要、新清单上的 `tapeapi connect`、tapeapi-mcp 钉住并核对工具与每个回答且真正展示、
// 工具改动时两端拒绝而 REST 照常回答，以及旧客户端不变的部分。不联网。
//
// FIXED MCP-CONFORM-2 (2.3: the eight REST methods were the bound tools and answered their own JSON, so tapeapi-mcp
// refused to show every answer): the declared endpoint lists only the tool methods, so only they are bound, and each
// answers an MCP tool result. / 2.3 时八个 REST 方法是绑定工具、回答自己的 JSON，tapeapi-mcp 拒绝展示每个回答；现在声明的端点
// 只列工具方法，只有它们被绑定，且每个都回答 MCP 工具结果。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MAINNET, createTapeAPI, validateManifest, mcp } from '@tapeapi/sdk'
import { mcpToolsSha256, listedMcpTools } from '@tapeapi/server/mcp'
import { manifestOf, mcpToolsManifestOf, MCP_PINNED_PATH } from './worker.js'
import { MANIFEST_METHODS, TOOL_MANIFEST_METHODS } from './methods.js'
import * as C from '../../site/console/lib.js'
import { privateKeyToAddress, signDigest, delegationDigest, recoverResponseSigner, randomPrivateKey } from '../../sdk/src/sig.js'
import { createConformChain } from '../../sdk/test/helpers/conform-chain.mjs'
import { runConnect } from '../../sdk/src/connect-cli.js'

const MCP_BIN = fileURLToPath(new URL('../../sdk/bin/tapeapi-mcp.js', import.meta.url))
const TMP = mkdtempSync(join(tmpdir(), 'tapeapi-mcp-conform-'))
const closers = []
test.after(async () => { for (const c of closers.reverse()) await c(); rmSync(TMP, { recursive: true, force: true }) })

// The live service, as its Worker serves it (examples/public-api/wrangler.toml and the dashboard variables, read
// 2026-10-16 from https://api.tapeapi.fun/.well-known/tapeapi.json): the tools of /mcp come from these.
// 线上服务（Worker 提供的样子，2026-10-16 读取）：/mcp 的工具由它们生成。
const LIVE = {
  SERVICE_NAME: 'TapeAPI Public', PUBLIC_URL: 'https://api.tapeapi.fun', TOKEN_ID: '11',
  CIRCUITS: '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414', CONTAINER: '0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8',
}
const LIVE_TOOLS_SHA256 = 'a253cb284df03ef3ac4f201745a785819f5f17878678e5dd7b0a427ea26f9027'
// What the live service would publish for /mcp/pinned (2.4). / 线上服务为 /mcp/pinned 将发布的值（2.4）。
const PINNED_TOOLS_SHA256 = '2554a2901eb9b137d5606bdaad6d953e7f623f213cd3a69af44569bab9764548'
const TOOL_NAMES = TOOL_MANIFEST_METHODS.map((x) => x.name)

const SIGNER_KEY = '0x' + '22'.repeat(32), HOLDER_KEY = '0x' + '11'.repeat(32)
const SIGNER = privateKeyToAddress(SIGNER_KEY)
const envFor = ({ container = LIVE.CONTAINER, circuits = LIVE.CIRCUITS, tokenId = LIVE.TOKEN_ID, publicUrl = LIVE.PUBLIC_URL, holderKey = HOLDER_KEY, ...rest } = {}) => {
  const expires = Math.floor(Date.now() / 1000) + 90 * 86_400
  return {
    SIGNER_KEY, CIRCUITS: circuits, TOKEN_ID: tokenId, CONTAINER: container, DELEGATION_EXPIRES: String(expires),
    DELEGATION_SIG: signDigest(delegationDigest(56, MAINNET.hub, { container, signer: SIGNER, expires }), holderKey),
    PUBLIC_URL: publicUrl, SERVICE_NAME: LIVE.SERVICE_NAME, TAPE_NAME: '11.1013.tape', ...rest,
  }
}

// A JSON-RPC node answering the head and one block, on two host names so the two count as two operators.
// 一个回答链头与区块的 JSON-RPC 节点，用两个主机名，算两家运营方。
async function fakeNodes() {
  const block = { number: '0x3e8', hash: '0x' + 'cd'.repeat(32), timestamp: '0x6a000000' }
  const srv = http.createServer(async (req, res) => {
    const parts = []; for await (const c of req) parts.push(c)
    const one = (m) => ({ jsonrpc: '2.0', id: m.id, ...(m.method === 'eth_blockNumber' ? { result: block.number } : m.method === 'eth_chainId' ? { result: '0x38' } : m.method === 'eth_getBlockByNumber' ? { result: block } : { error: { code: -32601, message: 'no' } }) })
    const msg = JSON.parse(Buffer.concat(parts).toString('utf8'))
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(Array.isArray(msg) ? msg.map(one) : one(msg)))
  })
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok))
  closers.push(() => new Promise((ok) => { srv.closeAllConnections(); srv.close(ok) }))
  const p = srv.address().port
  return `http://127.0.0.1:${p},http://localhost:${p}`
}

// The Worker on a real port. Each call imports a fresh copy of worker.js: it keeps one provider per module.
// 真实端口上的 Worker。每次导入一份新的 worker.js：它每个模块只保留一个 provider。
let copies = 0
async function startWorker(extra = {}) {
  const { default: worker } = await import(`./worker.js?copy=${++copies}`)
  let env = null
  const srv = http.createServer(async (req, res) => {
    const parts = []; for await (const c of req) parts.push(c)
    const r = await worker.fetch(new Request(new URL(req.url, env.PUBLIC_URL), { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(parts) }), env)
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(r.body ? Buffer.from(await r.arrayBuffer()) : undefined)
  })
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok))
  closers.push(() => new Promise((ok) => { srv.closeAllConnections(); srv.close(ok) }))
  const url = `http://127.0.0.1:${srv.address().port}`
  env = envFor({ publicUrl: url, RPC_URLS: await fakeNodes(), ...extra })
  return { url, env }
}
const post = (url, path, body) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) })

// tapeapi-mcp over stdio. / stdio 上的 tapeapi-mcp。
function spawnMcp(args) {
  const child = spawn(process.execPath, [MCP_BIN, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
  closers.push(() => new Promise((ok) => { if (child.exitCode !== null || child.signalCode !== null) return ok(); child.once('exit', ok); child.kill('SIGKILL') }))
  let out = '', err = '', seq = 0
  const waiters = new Map()
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', (d) => {
    out += d
    let i
    while ((i = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, i); out = out.slice(i + 1)
      let m; try { m = JSON.parse(line) } catch { continue }
      const w = waiters.get(m.id); if (w) { waiters.delete(m.id); w(m) }
    }
  })
  child.stderr.on('data', (d) => { err += d })
  const exited = new Promise((ok) => child.on('exit', ok))
  const request = (method, params) => {
    const id = ++seq
    const p = new Promise((ok, fail) => {
      const t = setTimeout(() => fail(new Error(`no reply to ${method}; stderr:\n${err}`)), 20_000)
      waiters.set(id, (m) => { clearTimeout(t); ok(m) })
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n')
    return p
  }
  return { request, stderr: () => err, close: () => { child.stdin.end(); return exited } }
}
async function mcpSession(args) {
  const s = spawnMcp(args)
  await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
  return s
}
const textOf = (r) => r.result.content.map((c) => c.text).join('\n')

test('the digest the holder would publish: /mcp/pinned lists the eight tool methods and hashes to 2554a290…; /mcp still hashes to a253cb28…, also with mcp declared; the endpoint, the SDK and the holder console agree', async () => {
  const env = envFor()
  const m = manifestOf(env)
  assert.equal(JSON.stringify(m.methods), JSON.stringify(MANIFEST_METHODS), 'without the variable: the REST methods only')
  const view = mcpToolsManifestOf(env)
  assert.deepEqual(view.methods.map((x) => x.name), TOOL_NAMES)
  // If this fails, the wording of a tool changed (methods.js, SERVICE_NAME, @tapeapi/server or the SDK): with
  // MCP_TOOLS_SHA256 set, every tool method would answer TOOLS_CHANGED until a new manifest is published. Revert the
  // text, or publish the new digest and update this value. / 失败说明工具措辞变了：要么改回去，要么发布新摘要并更新这里。
  assert.equal(await mcpToolsSha256(view), PINNED_TOOLS_SHA256, 'republish the manifest or revert the tool text')
  assert.equal(await mcpToolsSha256(m), LIVE_TOOLS_SHA256, '/mcp: the 2.3 tools')
  const declared = manifestOf({ ...env, MCP_TOOLS_SHA256: PINNED_TOOLS_SHA256 })
  assert.deepEqual(declared.methods.map((x) => x.name), [...MANIFEST_METHODS.map((x) => x.name), ...TOOL_NAMES])
  assert.deepEqual(declared.mcp, { endpoint: 'https://api.tapeapi.fun/mcp/pinned', toolsSha256: PINNED_TOOLS_SHA256 })
  assert.deepEqual(Object.keys(declared), [...Object.keys(m), 'mcp'], 'mcp comes last')
  assert.equal(JSON.stringify(mcpToolsManifestOf({ ...env, MCP_TOOLS_SHA256: PINNED_TOOLS_SHA256 })), JSON.stringify(view), 'not self-referential')
  // Every tool method passes the console's method rules, and no tool text hides characters (TAPs #16 §3.4).
  // 每个工具方法都通过控制台的方法规则，工具文本不含隐藏字符。
  assert.deepEqual(C.methodsProblems(declared.methods), [])
  assert.deepEqual(mcp.invisibleProblems(await listedMcpTools(view)), [])
  // The names are TAP-11 method names and MCP tool names, and none is a REST method. / 名字既是方法名也是 MCP 工具名，且不与 REST 方法重名。
  for (const n of TOOL_NAMES) { assert.match(n, /^[A-Za-z_][A-Za-z0-9_]{0,63}$/); assert.match(n, /^[A-Za-z0-9_.-]{1,128}$/) }
  assert.equal(new Set([...MANIFEST_METHODS.map((x) => x.name), ...TOOL_NAMES]).size, 16)
  // The live Worker serves exactly these tools, and the console hashes them the same way. / Worker 提供的正是这些工具，控制台同样计算。
  const w = await startWorker({ MCP_TOOLS_SHA256: PINNED_TOOLS_SHA256 })
  const listed = (await (await post(w.url, MCP_PINNED_PATH, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()).result.tools
  assert.deepEqual(listed.map((t) => t.name), TOOL_NAMES)
  const own = await mcpToolsSha256(mcpToolsManifestOf(w.env))
  assert.equal(own, PINNED_TOOLS_SHA256, 'the URL is not in the tool text')
  assert.equal(mcp.toolsDigest(listed), own)
  assert.equal(await C.toolsDigest(listed), own)
  const legacy = (await (await post(w.url, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()).result.tools
  assert.deepEqual(legacy.map((t) => t.name), MANIFEST_METHODS.map((x) => x.name), '/mcp lists the REST methods, as before')
  assert.equal(mcp.toolsDigest(legacy), LIVE_TOOLS_SHA256, '/mcp is unchanged with the variable set')
  assert.deepEqual(await C.mcpToolsProblems({ mcp: { endpoint: `${w.url}${MCP_PINNED_PATH}`, toolsSha256: own }, methods: manifestOf({ ...w.env, MCP_TOOLS_SHA256: own }).methods, tools: listed }), [], 'the console accepts plain REST methods beside the tools')
})

test('without MCP_TOOLS_SHA256 the Worker is exactly what it was: the same manifest bytes, no mcp, no tool methods, no /mcp/pinned, and its calls are not held', async () => {
  const env = envFor()
  assert.equal(JSON.stringify(manifestOf(env)), JSON.stringify(manifestOf({ ...env, MCP_TOOLS_SHA256: '' })))
  assert.equal(manifestOf(env).mcp, undefined)
  const w = await startWorker()
  const served = await (await fetch(`${w.url}/.well-known/tapeapi.json`)).text()
  assert.equal(served, JSON.stringify(manifestOf(w.env)))
  const env1 = await (await post(w.url, '/tapeapi/v1/blockNumber', { id: 'old-1', params: {} })).json()
  assert.deepEqual([env1.ok, env1.result], [true, { blockNumber: 1000 }])
  const tool = await post(w.url, '/tapeapi/v1/tool_block_number', { id: 'old-2', params: {} })
  assert.equal((await tool.json()).error.code, 'METHOD_NOT_FOUND')
  const pinned = await post(w.url, MCP_PINNED_PATH, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
  assert.notEqual(pinned.status, 200, 'no /mcp/pinned without the variable')
  const legacy = (await (await post(w.url, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()).result.tools
  assert.equal(mcp.toolsDigest(legacy), await mcpToolsSha256(manifestOf(w.env)))
})

// Review E-5: a MCP_TOOLS_SHA256 copied in capitals or with a trailing space is the same digest; any other shape keeps the
// service in setup mode, as before, but the problem now names the variable and the form it needs. In 2.4 the same holds
// for what the variable switches on: the tool methods, held to the lowercased value, and /mcp/pinned.
// 审查 E-5：照抄成大写或带尾随空白的 MCP_TOOLS_SHA256 是同一个摘要；其它形状仍让服务停在设置模式，但 problem 现在点名该变量与所需格式。
// 2.4 里这同样适用于该变量打开的部分：工具方法（按小写值约束）与 /mcp/pinned。
test('MCP_TOOLS_SHA256: capitals and surrounding spaces are taken lowercased, also for the tool methods and /mcp/pinned; 0x or a wrong length is setup mode with a problem naming MCP_TOOLS_SHA256', async () => {
  const published = await mcpToolsSha256(mcpToolsManifestOf(envFor()))
  for (const v of [published.toUpperCase(), `${published} `, ` ${published.toUpperCase()}\n`]) {
    const m = manifestOf(envFor({ MCP_TOOLS_SHA256: v }))
    assert.deepEqual(m.mcp, { endpoint: 'https://api.tapeapi.fun/mcp/pinned', toolsSha256: published }, JSON.stringify(v))
    assert.deepEqual(m.methods.map((x) => x.name), [...MANIFEST_METHODS.map((x) => x.name), ...TOOL_NAMES], JSON.stringify(v))
  }
  // through the Worker: served lowercased, and the tool methods are held to the lowercased value (so they are served,
  // over REST and on /mcp/pinned) / 经 Worker：以小写提供，工具方法按小写值约束（所以在 REST 与 /mcp/pinned 上照常服务）
  for (const v of [published.toUpperCase(), `${published.toUpperCase()}  \n`]) {
    const w = await startWorker({ MCP_TOOLS_SHA256: v })
    const served = JSON.parse(await (await fetch(`${w.url}/.well-known/tapeapi.json`)).text())
    assert.deepEqual(served.mcp, { endpoint: `${w.url}${MCP_PINNED_PATH}`, toolsSha256: published }, JSON.stringify(v))
    const res = await post(w.url, '/tapeapi/v1/blockNumber', { id: 'case-1', params: {} })
    assert.equal(res.status, 200, JSON.stringify(v))
    assert.deepEqual((await res.json()).result, { blockNumber: 1000 })
    const tool = await post(w.url, '/tapeapi/v1/tool_block_number', { id: 'case-2', params: {} })
    assert.equal(tool.status, 200, JSON.stringify(v))
    assert.deepEqual((await tool.json()).result, { content: [{ type: 'text', text: '{"blockNumber":1000}' }], structuredContent: { blockNumber: 1000 } })
    const listed = await post(w.url, MCP_PINNED_PATH, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    assert.equal(listed.status, 200, JSON.stringify(v))
    assert.equal(mcp.toolsDigest((await listed.json()).result.tools), published)
    const called = (await (await post(w.url, MCP_PINNED_PATH, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_block_number', arguments: {} } })).json()).result
    assert.deepEqual([called.isError, called.structuredContent], [false, { blockNumber: 1000 }], JSON.stringify(v))
  }
  // 0x, a wrong length, other characters: setup mode, the problem naming the variable / 0x、长度不对、别的字符：设置模式，点名变量
  for (const [v, got] of [[`0x${published}`, '66 characters starting with 0x'], [`0X${published.toUpperCase()}`, '66 characters starting with 0x'], [published.slice(1), '63 characters'], [`${published}0`, '65 characters'], [`${published.slice(0, 63)}g`, '64 characters']]) {
    assert.throws(() => manifestOf(envFor({ MCP_TOOLS_SHA256: v })), (e) => e.message === `MCP_TOOLS_SHA256 must be the toolsSha256 the holder published: 64 hex digits, without 0x (got ${got})`, v)
    const w = await startWorker({ MCP_TOOLS_SHA256: v })
    const health = await (await fetch(`${w.url}/tapeapi/v1/health`)).json()
    assert.equal(health.setup, true, v)
    assert.deepEqual(health.missing, [], v)
    assert.match(health.problem, /^MCP_TOOLS_SHA256 must be the toolsSha256 the holder published: 64 hex digits, without 0x/, v)
    const res = await post(w.url, '/tapeapi/v1/blockNumber', { id: 'bad-1', params: {} })
    assert.equal(res.status, 503)
    const body = await res.json()
    assert.equal(body.error.code, 'DELEGATION_INVALID')
    assert.match(body.error.message, /MCP_TOOLS_SHA256 must be/)
    assert.equal((await fetch(`${w.url}/.well-known/tapeapi.json`)).status, 503)
    const tool = await post(w.url, '/tapeapi/v1/tool_block_number', { id: 'bad-2', params: {} })
    assert.deepEqual([tool.status, (await tool.json()).error.code], [503, 'DELEGATION_INVALID'], v)
    const pinned = await post(w.url, MCP_PINNED_PATH, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    assert.equal(pinned.status, 503, v)
    assert.match(JSON.stringify(await pinned.json()), /MCP_TOOLS_SHA256 must be/, v)
  }
})

test('REST clients and /mcp clients are unchanged with MCP_TOOLS_SHA256 set: the same REST answers, the same /mcp tools and result shape; the tool methods answer MCP tool results, signed', async () => {
  const plain = await startWorker()
  const w = await startWorker({ MCP_TOOLS_SHA256: await mcpToolsSha256(mcpToolsManifestOf(plain.env)) })
  for (const u of [plain.url, w.url]) {
    const e = await (await post(u, '/tapeapi/v1/blockNumber', { id: 'same', params: {} })).json()
    assert.deepEqual([e.ok, e.result], [true, { blockNumber: 1000 }])
    const bad = await post(u, '/tapeapi/v1/balance', { id: 'bad', params: { address: 'nope' } })
    assert.deepEqual([bad.status, (await bad.json()).error.code], [400, 'BAD_REQUEST'])
  }
  const tools = async (u) => (await (await post(u, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()).result.tools
  assert.deepEqual(await tools(w.url), await tools(plain.url), '/mcp lists the same tools')
  const viaMcp = (await (await post(w.url, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'blockNumber', arguments: {} } })).json()).result
  assert.deepEqual([viaMcp.isError, viaMcp.content[0].text, viaMcp.structuredContent], [false, '{"blockNumber":1000}', { blockNumber: 1000 }], '/mcp answers as in 2.3: JSON text, then the provenance line')
  assert.match(viaMcp.content[1].text, /^Signed by TapeAPI service/)
  // The tool method over REST: the signed result is exactly { content, structuredContent }. / REST 上的工具方法：签名结果恰为 { content, structuredContent }。
  const t = await post(w.url, '/tapeapi/v1/tool_block_number', { id: 'tool-1', params: {} })
  assert.equal(t.status, 200)
  const te = await t.json()
  assert.deepEqual(te.result, { content: [{ type: 'text', text: '{"blockNumber":1000}' }], structuredContent: { blockNumber: 1000 } })
  assert.equal(recoverResponseSigner({ container: w.env.CONTAINER, id: 'tool-1', method: 'tool_block_number', params: {}, ok: true, body: te.result, ts: te.ts }, te.sig), SIGNER)
  // A bad argument is a signed BAD_REQUEST, as #16 §4.2 maps an MCP -32602. / 参数错误是签名的 BAD_REQUEST。
  const tb = await post(w.url, '/tapeapi/v1/tool_balance', { id: 'tool-2', params: { address: 'nope' } })
  const tbe = await tb.json()
  assert.deepEqual([tb.status, tbe.ok, tbe.error.code], [400, false, 'BAD_REQUEST'])
  assert.equal(recoverResponseSigner({ container: w.env.CONTAINER, id: 'tool-2', method: 'tool_balance', params: { address: 'nope' }, ok: false, body: tbe.error, ts: tbe.ts }, tbe.sig), SIGNER)
  // /mcp/pinned passes the tool result on: the provenance line first, then its content, its structuredContent, the receipt.
  // /mcp/pinned 原样交出工具结果：先来源说明行，再是它的 content、structuredContent 与回执。
  const r = (await (await post(w.url, MCP_PINNED_PATH, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tool_block_number', arguments: {} } })).json()).result
  assert.match(r.content[0].text, /^Signed by TapeAPI service/)
  assert.deepEqual(r.content.slice(1), [{ type: 'text', text: '{"blockNumber":1000}' }])
  assert.deepEqual([r.isError, r.structuredContent], [false, { blockNumber: 1000 }])
  assert.deepEqual(r._meta[mcp.RECEIPT_META_KEY].result, te.result)
  const rb = (await (await post(w.url, MCP_PINNED_PATH, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'tool_balance', arguments: { address: 'nope' } } })).json()).result
  assert.equal(rb.isError, true)
  assert.match(rb.content[0].text, /^Signed by TapeAPI service/)
  assert.match(rb.content[1].text, /^The service refused: BAD_REQUEST: /)
  const pinnedNames = (await (await post(w.url, MCP_PINNED_PATH, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'blockNumber', arguments: {} } })).json())
  assert.equal(pinnedNames.error.code, -32602, 'a REST method is not a tool of /mcp/pinned')
})

test('tapeapi connect on the new manifest (fake chain): usable, an MCP tool service, endpoint /mcp/pinned and toolsSha256 from the manifest', async () => {
  const holderKey = randomPrivateKey()
  const chain = createConformChain()
  const now = Math.floor(Date.now() / 1000)
  chain.state.headTime = now
  const c = chain.circuit(42, { holder: privateKeyToAddress(holderKey) })
  chain.setAccount('42', c.container); chain.setCode(c.container)
  const env = envFor({ container: c.container, circuits: c.circuits, tokenId: '42', holderKey })
  const digest = await mcpToolsSha256(mcpToolsManifestOf(env))
  const manifest = manifestOf({ ...env, MCP_TOOLS_SHA256: digest })
  // The holder console publishes exactly this text from what it read and the service reports. / 控制台照此发布。
  const s = { circuits: c.circuits, tokenId: '42', container: c.container, signer: SIGNER, expires: manifest.delegation.expires, sig: manifest.delegation.sig, endpoint: manifest.endpoints.live[0] }
  const text = C.manifestText({ ...s, name: manifest.name, methods: manifest.methods, mcp: manifest.mcp })
  assert.equal(text, JSON.stringify(manifest))
  chain.writeFile(c.container, '.well-known/tapeapi.json', text)
  const opts = (sink) => ({
    cmd: 'tapeapi', version: '0.0.0-test', verifyBin: '/x/tapeapi-verify.js', mcpBin: '/x/tapeapi-mcp.js', env: {}, isTTY: false,
    apiOptions: { clock: () => now, quiet: true, onWarning: () => {}, fetch: (u, init) => chain.fetch(String(u), init) },
    stdout: sink, stderr: () => {}, runChild: async () => ({ code: 0, signal: null }),
  })
  let out = ''
  const r = await runConnect(['42.7.tape', '--rpc', 'http://rpc1,http://rpc2,http://rpc3', '--lang', 'zh'], opts((x) => { out += x }))
  assert.equal(r.exitCode, 0, out)
  assert.match(out, /^状态 +可用：MCP 工具服务（实验性）$/m)
  assert.ok(out.includes('https://api.tapeapi.fun/mcp/pinned'), out)
  // connect does not contact the endpoint: its row lists the manifest's free methods as methods, the ones tapeapi-mcp
  // can offer (review R-3), 16 here since the tool methods are free too, and does not call them tools: the eight tools
  // are what tools/list at /mcp/pinned says, and tapeapi-mcp shows only those (2.4: the card agrees with the endpoint by
  // not counting tools at all). / connect 不访问端点：那一行把清单里的免费方法列为“方法”（审查 R-3；工具方法也免费，所以是 16），
  // 不称之为工具：8 个工具由 /mcp/pinned 的 tools/list 决定，tapeapi-mcp 只展示它们（2.4：卡片不数工具，因而与端点不矛盾）。
  assert.ok(out.includes(`16 (清单里的免费方法；工具是其中 tools/list 列出的)   toolsSha256 ${digest.slice(0, 8)}…`), out)
  assert.match(out, /^方法 +16 /m)
  assert.doesNotMatch(out, /^工具 +\d/m)
  assert.ok(out.includes('所以不说是哪些、有几个'), out)
  // and the endpoint it points at serves exactly the eight tool methods, all of which are in that row
  // 它指向的端点恰好提供那 8 个工具方法，且都在那一行列出的方法里
  // (a Worker with the same identity and variable; the URL is not in the tool text) and hashes to the card's toolsSha256
  // （同一身份与变量的 Worker；URL 不在工具文本里），其摘要等于卡片上的 toolsSha256
  const w = await startWorker({ container: c.container, circuits: c.circuits, tokenId: '42', holderKey, MCP_TOOLS_SHA256: digest })
  const pinned = (await (await post(w.url, MCP_PINNED_PATH, { jsonrpc: '2.0', id: 9, method: 'tools/list' })).json()).result.tools
  assert.deepEqual(pinned.map((t) => t.name).sort(), [...TOOL_NAMES].sort())
  assert.equal(mcp.toolsDigest(pinned), digest)
  let json = ''
  await runConnect(['42.7.tape', '--rpc', 'http://rpc1,http://rpc2,http://rpc3', '--json'], opts((x) => { json += x }))
  const o = JSON.parse(json)
  assert.deepEqual([o.kind, o.status], ['mcp', 'ok'])
  assert.deepEqual(o.service.mcp, { endpoint: 'https://api.tapeapi.fun/mcp/pinned', toolsSha256: digest })
  assert.deepEqual(o.service.tools, [...MANIFEST_METHODS.map((x) => x.name), ...TOOL_NAMES])
})

test('FIXED MCP-CONFORM-2: tapeapi-mcp pins the declared service, checks its tools against toolsSha256, exposes only the eight tool methods, verifies the signature of every answer and shows it', async () => {
  const plain = await startWorker()
  const digest = await mcpToolsSha256(mcpToolsManifestOf(plain.env))
  const w = await startWorker({ MCP_TOOLS_SHA256: digest })
  const served = JSON.parse(await (await fetch(`${w.url}/.well-known/tapeapi.json`)).text())
  assert.deepEqual(served.mcp, { endpoint: `${w.url}${MCP_PINNED_PATH}`, toolsSha256: digest })
  const pins = join(TMP, 'conform', 'pins.json')
  const s = await mcpSession(['--dev', w.url, '--pin', pins])
  const tools = (await s.request('tools/list')).result.tools
  assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort(), 'the REST methods are not tools of the declared endpoint')
  assert.match(tools[0].description, /pins \(mcp\.toolsSha256 [0-9a-f]{16}\.\.\.\)/)
  const r = await s.request('tools/call', { name: 'tool_block_number', arguments: {} })
  assert.equal(r.result.isError, false, textOf(r))
  assert.match(r.result.content[0].text, /^Signed by TapeAPI service .*The signature was verified against the on-chain delegation before this result was returned\./)
  assert.deepEqual(r.result.content.slice(1, 2), [{ type: 'text', text: '{"blockNumber":1000}' }])
  assert.deepEqual(r.result.structuredContent, { blockNumber: 1000 })
  assert.doesNotMatch(textOf(r), /not an MCP tool result/)
  const receipt = r.result._meta[mcp.RECEIPT_META_KEY]
  assert.equal(recoverResponseSigner({ container: receipt.service.container, id: receipt.id, method: 'tool_block_number', params: {}, ok: true, body: receipt.result, ts: receipt.ts }, receipt.sig), SIGNER)
  // A bad argument: the signed BAD_REQUEST, verified, shown as a tool error. / 参数错误：签名的 BAD_REQUEST，核验后作为工具错误展示。
  const bad = await s.request('tools/call', { name: 'tool_balance', arguments: { address: 'nope' } })
  assert.equal(bad.result.isError, true)
  assert.match(textOf(bad), /BAD_REQUEST/)
  // A REST method is not offered. / 不提供 REST 方法。
  assert.equal((await s.request('tools/call', { name: 'blockNumber', arguments: {} })).error.code, -32602)
  await s.close()
  assert.match(s.stderr(), /MCP tools verified: 8 tool\(s\) from http:\/\/127\.0\.0\.1:\d+\/mcp\/pinned hash to the manifest's mcp\.toolsSha256/)
  assert.match(s.stderr(), /not exposed: blockNumber: the MCP tool set has no tool of that name/)
  assert.doesNotMatch(s.stderr(), /not an MCP tool result/)
  const entry = Object.values(JSON.parse(readFileSync(pins, 'utf8')).pins)[0]
  assert.equal(entry.material.toolsSha256, digest, 'toolsSha256 is pinned')
})

test('changed tools: the Worker refuses the tool methods with a signed TOOLS_CHANGED on /tapeapi/v1 and /mcp/pinned while the REST methods answer, and tapeapi-mcp refuses the tools before sending anything', async () => {
  const published = await mcpToolsSha256(mcpToolsManifestOf(envFor()))
  // A deploy whose tool text differs from what was published (here: the display name in every title).
  // 部署后的工具文本与已发布的不同（这里：每个标题里的显示名称）。
  const w = await startWorker({ MCP_TOOLS_SHA256: published, SERVICE_NAME: 'TapeAPI Public (renamed)' })
  const current = await mcpToolsSha256(mcpToolsManifestOf(w.env))
  assert.notEqual(current, published)
  const res = await post(w.url, '/tapeapi/v1/tool_block_number', { id: 'tc-1', params: {} })
  assert.equal(res.status, 409)
  const env = await res.json()
  assert.deepEqual([env.ok, env.error.code, env.error.data], [false, 'TOOLS_CHANGED', { published, current }])
  assert.equal(recoverResponseSigner({ container: w.env.CONTAINER, id: 'tc-1', method: 'tool_block_number', params: {}, ok: false, body: env.error, ts: env.ts }, env.sig), SIGNER)
  const restRes = await post(w.url, '/tapeapi/v1/blockNumber', { id: 'tc-2', params: {} })
  assert.equal(restRes.status, 200, 'the REST methods are not bound and keep answering')
  assert.deepEqual((await restRes.json()).result, { blockNumber: 1000 })
  const viaPinned = (await (await post(w.url, MCP_PINNED_PATH, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_bnb_usd', arguments: {} } })).json()).result
  assert.equal(viaPinned.isError, true)
  assert.match(viaPinned.content[1].text, /^The service refused: TOOLS_CHANGED: /)
  const s = await mcpSession(['--dev', w.url, '--no-pin'])
  const r = await s.request('tools/call', { name: 'tool_block_number', arguments: {} })
  assert.equal(r.result.isError, true)
  assert.match(textOf(r), /REFUSED, nothing was sent/)
  assert.match(textOf(r), new RegExp(`hash to ${current}`))
  await s.close()
})

// Review S-1 on the tool methods: a tool list that cannot be built is not remembered. Meanwhile the tool methods answer
// TOOLS_CHANGED with current null, and the next call reads the list again; the REST methods are not handed to
// holdToToolsSha256 and keep answering. (A tool method's description that cannot be read stands in for any failure.)
// 审查 S-1 用于工具方法：建不出来的工具列表不被记住。期间工具方法回答 TOOLS_CHANGED（current 为 null），下一次调用重新读取；REST
// 方法没有交给 holdToToolsSha256，照常回答。（以读不出的工具方法说明代表任何失败。）
test('S-1 on the tool methods: while their tool list cannot be built they answer TOOLS_CHANGED with current null and the REST methods answer; the next call reads the list again', async () => {
  const published = await mcpToolsSha256(mcpToolsManifestOf(envFor()))
  const w = await startWorker({ MCP_TOOLS_SHA256: published })
  assert.equal((await fetch(`${w.url}/tapeapi/v1/health`)).status, 200)
  const m = TOOL_MANIFEST_METHODS[0]
  const description = m.description
  let fail = true
  Object.defineProperty(m, 'description', { get() { if (fail) throw new Error('unreadable'); return description }, enumerable: true, configurable: true })
  try {
    for (const id of ['s1-1', 's1-2']) {
      const res = await post(w.url, '/tapeapi/v1/tool_block_number', { id, params: {} })
      assert.equal(res.status, 409, id)
      const env = await res.json()
      assert.deepEqual([env.ok, env.error.code, env.error.data], [false, 'TOOLS_CHANGED', { published, current: null }], id)
      assert.equal(recoverResponseSigner({ container: w.env.CONTAINER, id, method: 'tool_block_number', params: {}, ok: false, body: env.error, ts: env.ts }, env.sig), SIGNER)
    }
    const restRes = await post(w.url, '/tapeapi/v1/blockNumber', { id: 's1-3', params: {} })
    assert.equal(restRes.status, 200, 'the REST methods are never held')
    assert.deepEqual((await restRes.json()).result, { blockNumber: 1000 })
    fail = false
    const again = await post(w.url, '/tapeapi/v1/tool_block_number', { id: 's1-4', params: {} })
    assert.equal(again.status, 200, 'read again: served')
    assert.deepEqual((await again.json()).result.structuredContent, { blockNumber: 1000 })
  } finally {
    Object.defineProperty(m, 'description', { value: description, writable: true, enumerable: true, configurable: true })
  }
})

// S-1 without a stand-in: a real deploy value whose tool list cannot be hashed. Nothing on the tool list's path does I/O
// (it is built in process from the static tool methods, SERVICE_NAME and CONTAINER), so no outside dependency can fail
// it; what can is the text a deploy feeds it. A SERVICE_NAME of 63 characters and then an emoji is a well-formed name, but
// a tool title takes its first 64 UTF-16 units and so ends in half of the emoji: RFC 8785 refuses that, the digest cannot
// be computed, and the holder could not have published one. The real Worker, unpatched: the tool methods answer a signed
// TOOLS_CHANGED with current null, the REST methods, the manifest and /mcp keep answering.
// S-1 不用替身：部署里一个真实的值让工具列表算不出摘要。工具列表的生成路径不做任何 I/O（在进程内由静态的工具方法、SERVICE_NAME 与
// CONTAINER 生成），所以没有外部依赖能让它失败；能让它失败的是部署喂给它的文本。63 个字符加一个 emoji 的 SERVICE_NAME 是合法名字，
// 但工具标题取前 64 个 UTF-16 单元，正好切掉 emoji 的后一半：RFC 8785 拒绝它，摘要算不出，持有人也不可能发布过它。未打补丁的真实
// Worker：工具方法回答签名的 TOOLS_CHANGED（current 为 null），REST 方法、清单与 /mcp 照常回答。
// What this does not cover: here the list is built and only its digest fails, so the tool names are known and
// holdToToolsSha256 would pass the REST methods even if it were handed all sixteen (checked by mutation, 2026-10-19).
// The branch where no list is built at all, and every method handed over is held, has no real trigger in this Worker
// (manifestToTools throws only for a manifest without a methods array); the test above reaches it with a stand-in.
// 这一项不覆盖的：这里列表建出来了、只是摘要失败，工具名已知，所以即使把 16 个方法都交给 holdToToolsSha256，REST 也会放行（2026-10-19
// 以变异核对过）。完全建不出列表、交进去的每个方法都被拒的分支，在这个 Worker 里没有真实触发方式（manifestToTools 只在清单没有
// methods 数组时抛错）；上一项测试用替身走到它。
test('S-1 with a real deploy value: a SERVICE_NAME that makes the tool list unhashable holds only the tool methods (TOOLS_CHANGED, current null); REST, the manifest and /mcp answer', async () => {
  const name = 'A'.repeat(63) + '\u{1F642}'
  assert.equal(name.length, 65)
  const probe = envFor({ SERVICE_NAME: name })
  await assert.rejects(mcpToolsSha256(mcpToolsManifestOf(probe)), (e) => e.code === 'CANON_INVALID', 'no digest exists for this text')
  // Any well-formed value the holder might have set: the one for the live name. / 持有人可能设置的任意合法值：线上名字对应的那个。
  const published = PINNED_TOOLS_SHA256
  const w = await startWorker({ SERVICE_NAME: name, MCP_TOOLS_SHA256: published })
  const health = await (await fetch(`${w.url}/tapeapi/v1/health`)).json()
  assert.notEqual(health.setup, true, 'not setup mode')
  const m = await (await fetch(`${w.url}/.well-known/tapeapi.json`)).json()
  assert.equal(m.name, name)
  assert.deepEqual(m.mcp, { endpoint: `${w.url}${MCP_PINNED_PATH}`, toolsSha256: published })
  for (const [i, tool] of TOOL_NAMES.entries()) {
    const id = `s1r-${i}`
    const res = await post(w.url, `/tapeapi/v1/${tool}`, { id, params: tool === 'tool_block_number' || tool === 'tool_bnb_usd' ? {} : { x: 1 } })
    assert.equal(res.status, 409, tool)
    const env = await res.json()
    assert.deepEqual([env.ok, env.error.code, env.error.data], [false, 'TOOLS_CHANGED', { published, current: null }], tool)
  }
  const sigd = await (await post(w.url, '/tapeapi/v1/tool_block_number', { id: 's1r-sig', params: {} })).json()
  assert.equal(recoverResponseSigner({ container: w.env.CONTAINER, id: 's1r-sig', method: 'tool_block_number', params: {}, ok: false, body: sigd.error, ts: sigd.ts }, sigd.sig), SIGNER)
  const rest = await post(w.url, '/tapeapi/v1/blockNumber', { id: 's1r-rest', params: {} })
  assert.equal(rest.status, 200, 'the REST methods are never held')
  assert.deepEqual((await rest.json()).result, { blockNumber: 1000 })
  const legacy = await (await post(w.url, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'blockNumber', arguments: {} } })).json()
  assert.equal(legacy.result.isError, false, '/mcp keeps answering')
  const pinned = await (await post(w.url, MCP_PINNED_PATH, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_block_number', arguments: {} } })).json()
  assert.equal(pinned.result.isError, true)
  assert.match(JSON.stringify(pinned.result.content), /TOOLS_CHANGED/)
})

test('old clients: an SDK client ignores the new member and calls as before; CONFIRMED MCP-CONFORM-3: a tapeapi-mcp that pinned the service before sees a changed service and refuses it until --allow-changed, then shows the tool answers', async () => {
  const before = await startWorker()
  const digest = await mcpToolsSha256(mcpToolsManifestOf(before.env))
  const after = await startWorker({ MCP_TOOLS_SHA256: digest })
  const m = await (await fetch(`${after.url}/.well-known/tapeapi.json`)).json()
  assert.doesNotThrow(() => validateManifest(m, { requireDelegation: true, allowHttp: true }))
  const api = createTapeAPI({ dev: true, quiet: true, allowHttp: true, onWarning: () => {} })
  const svc = await api.resolve({ dev: after.url })
  const r = await api.call(svc, 'blockNumber', {})
  assert.equal(r.verified, true)
  assert.deepEqual(r.result, { blockNumber: 1000 })
  // The pins of a tapeapi-mcp session made before the declaration (same container, same signer).
  // 声明之前的 tapeapi-mcp 会话留下的钉子（同一容器、同一签名者）。
  const pins = join(TMP, 'old', 'pins.json')
  let s = await mcpSession(['--dev', before.url, '--pin', pins])
  assert.equal((await s.request('tools/call', { name: 'blockNumber', arguments: {} })).result.isError, false)
  await s.close()
  s = await mcpSession(['--dev', after.url, '--pin', pins])
  // It still lists the tools it pinned (the REST methods) and refuses to call them. / 仍列出钉住的工具（REST 方法），并拒绝调用。
  assert.deepEqual((await s.request('tools/list')).result.tools.map((t) => t.name).sort(), MANIFEST_METHODS.map((x) => x.name).sort())
  const refused = await s.request('tools/call', { name: 'blockNumber', arguments: {} })
  assert.equal(refused.result.isError, true)
  assert.match(textOf(refused), /changed on chain since they were pinned/)
  await s.close()
  assert.match(s.stderr(), /MCP tool set \(mcp\.toolsSha256\): none -> [0-9a-f]{64}/)
  s = await mcpSession(['--dev', after.url, '--pin', pins, '--allow-changed'])
  const ok = await s.request('tools/call', { name: 'tool_block_number', arguments: {} })
  assert.equal(ok.result?.isError, false, JSON.stringify(ok) + s.stderr())
  assert.deepEqual(ok.result.structuredContent, { blockNumber: 1000 })
  await s.close()
})
