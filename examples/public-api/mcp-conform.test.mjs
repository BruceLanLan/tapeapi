// The public service (api.tapeapi.fun) declaring its /mcp route under TAPI-20 §3.8 (2.3, experimental), end to end on a
// local fake chain and a local Worker: the digest it would publish, `tapeapi connect` on the new manifest, tapeapi-mcp
// pinning and checking the tools and every answer, both sides refusing changed tools, and what stays the same for old
// clients. No network: the chain is sdk/test/helpers/conform-chain.mjs, the Worker and its nodes listen on 127.0.0.1.
// 公共服务按 TAPI-20 §3.8 声明它的 /mcp 路由（2.3，实验性），在本地假链与本地 Worker 上端到端：它将发布的摘要、新清单上的
// `tapeapi connect`、tapeapi-mcp 钉住并核对工具与每个回答、工具改动时两端都拒绝，以及旧客户端不变的部分。不联网。
//
// CONFIRMED MCP-CONFORM-2 (a gap, not a fix): the eight methods are bound tools (a tool of the same name), so §3.8 and the
// draft (TAPs #16 §4.2) want each method's signed result to be the tool's MCP result { content, ... }. They answer
// their own JSON ({ blockNumber }), so tapeapi-mcp verifies the signature of every answer and then refuses to show it
// as a tool result (#16 §6 step 7). Changing the methods' results would break every REST client; that is a decision
// for the holder before the manifest is published, and the test below pins today's behaviour.
// CONFIRMED MCP-CONFORM-2（是差距，不是修复）：八个方法都是绑定工具，§3.8 与草案要求每个方法的签名结果是该工具的 MCP 结果；
// 它们回答的是自己的 JSON，所以 tapeapi-mcp 核验每个回答的签名后，拒绝把它当作工具结果展示。改方法的结果会破坏所有 REST
// 客户端，由持有人决定；下面的测试钉住现状。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MAINNET, createTapeAPI, validateManifest, mcp } from '@tapeapi/sdk'
import { mcpToolsSha256 } from '@tapeapi/server/mcp'
import { manifestOf } from './worker.js'
import { MANIFEST_METHODS } from './methods.js'
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

test('the digest the holder would publish: the live tool text hashes to a253cb28…, also with mcp in the manifest; the endpoint, the SDK and the holder console agree', async () => {
  const env = envFor()
  const m = manifestOf(env)
  assert.equal(JSON.stringify(m.methods), JSON.stringify(MANIFEST_METHODS))
  // If this fails, the wording of a tool changed (methods.js, SERVICE_NAME, @tapeapi/server or the SDK): with
  // MCP_TOOLS_SHA256 set, every method would answer TOOLS_CHANGED until a new manifest is published. Revert the text,
  // or publish the new digest and update this value. / 失败说明工具措辞变了：要么改回去，要么发布新摘要并更新这里。
  assert.equal(await mcpToolsSha256(m), LIVE_TOOLS_SHA256, 'republish the manifest or revert the tool text')
  const declared = manifestOf({ ...env, MCP_TOOLS_SHA256: LIVE_TOOLS_SHA256 })
  assert.equal(await mcpToolsSha256(declared), LIVE_TOOLS_SHA256, 'not self-referential')
  assert.deepEqual(declared.mcp, { endpoint: 'https://api.tapeapi.fun/mcp', toolsSha256: LIVE_TOOLS_SHA256 })
  assert.deepEqual(Object.keys(declared), [...Object.keys(m), 'mcp'], 'mcp comes last, everything before it unchanged')
  assert.equal(JSON.stringify({ ...declared, mcp: undefined }), JSON.stringify(m))
  // The container's case is part of the tool text: the lowercase copy on chain would give another digest, so the
  // digest is taken from what /mcp serves, as the console does. / 容器地址的大小写也在工具文本里，所以摘要按 /mcp 实际提供的计算。
  assert.notEqual(await mcpToolsSha256({ ...m, container: m.container.toLowerCase() }), LIVE_TOOLS_SHA256)
})

test('without MCP_TOOLS_SHA256 the Worker is exactly what it was: the same manifest bytes, no mcp, and its calls are not held', async () => {
  const env = envFor()
  assert.equal(JSON.stringify(manifestOf(env)), JSON.stringify(manifestOf({ ...env, MCP_TOOLS_SHA256: '' })))
  assert.equal(manifestOf(env).mcp, undefined)
  const w = await startWorker()
  const served = await (await fetch(`${w.url}/.well-known/tapeapi.json`)).text()
  assert.equal(served, JSON.stringify(manifestOf(w.env)))
  const env1 = await (await post(w.url, '/tapeapi/v1/blockNumber', { id: 'old-1', params: {} })).json()
  assert.deepEqual([env1.ok, env1.result], [true, { blockNumber: 1000 }])
})

// Review E-5: a MCP_TOOLS_SHA256 copied in capitals or with a trailing space is the same digest; any other shape keeps the
// service in setup mode, as before, but the problem now names the variable and the form it needs.
// 审查 E-5：照抄成大写或带尾随空白的 MCP_TOOLS_SHA256 是同一个摘要；其它形状仍让服务停在设置模式，但 problem 现在点名该变量与所需格式。
test('MCP_TOOLS_SHA256: capitals and surrounding spaces are taken lowercased; 0x or a wrong length is setup mode with a problem naming MCP_TOOLS_SHA256', async () => {
  const published = await mcpToolsSha256(manifestOf(envFor()))
  for (const v of [published.toUpperCase(), `${published} `, ` ${published.toUpperCase()}\n`]) {
    assert.deepEqual(manifestOf(envFor({ MCP_TOOLS_SHA256: v })).mcp, { endpoint: 'https://api.tapeapi.fun/mcp', toolsSha256: published }, JSON.stringify(v))
  }
  // through the Worker: served lowercased, and the calls are held to the lowercased value (so they are served)
  // 经 Worker：以小写提供，调用按小写值约束（所以照常服务）
  for (const v of [published.toUpperCase(), `${published.toUpperCase()}  \n`]) {
    const w = await startWorker({ MCP_TOOLS_SHA256: v })
    const served = JSON.parse(await (await fetch(`${w.url}/.well-known/tapeapi.json`)).text())
    assert.equal(served.mcp.toolsSha256, published, JSON.stringify(v))
    const res = await post(w.url, '/tapeapi/v1/blockNumber', { id: 'case-1', params: {} })
    assert.equal(res.status, 200, JSON.stringify(v))
    assert.deepEqual((await res.json()).result, { blockNumber: 1000 })
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
  }
})

test('tapeapi connect on the new manifest (fake chain): usable, an MCP tool service, endpoint and toolsSha256 from the manifest, the tools are the eight methods', async () => {
  const holderKey = randomPrivateKey()
  const chain = createConformChain()
  const now = Math.floor(Date.now() / 1000)
  chain.state.headTime = now
  const c = chain.circuit(42, { holder: privateKeyToAddress(holderKey) })
  chain.setAccount('42', c.container); chain.setCode(c.container)
  const env = envFor({ container: c.container, circuits: c.circuits, tokenId: '42', holderKey })
  const digest = await mcpToolsSha256(manifestOf(env))
  const manifest = manifestOf({ ...env, MCP_TOOLS_SHA256: digest })
  // The holder console publishes exactly this text from what it read and the service reports. / 控制台照此发布。
  const s = { circuits: c.circuits, tokenId: '42', container: c.container, signer: SIGNER, expires: manifest.delegation.expires, sig: manifest.delegation.sig, endpoint: manifest.endpoints.live[0] }
  const text = C.manifestText({ ...s, name: manifest.name, methods: manifest.methods, mcp: manifest.mcp })
  assert.equal(text, JSON.stringify(manifest))
  chain.writeFile(c.container, '.well-known/tapeapi.json', text)
  let out = ''
  const r = await runConnect(['42.7.tape', '--rpc', 'http://rpc1,http://rpc2,http://rpc3', '--lang', 'zh'], {
    cmd: 'tapeapi', version: '0.0.0-test', verifyBin: '/x/tapeapi-verify.js', mcpBin: '/x/tapeapi-mcp.js', env: {}, isTTY: false,
    apiOptions: { clock: () => now, quiet: true, onWarning: () => {}, fetch: (u, init) => chain.fetch(String(u), init) },
    stdout: (x) => { out += x }, stderr: () => {}, runChild: async () => ({ code: 0, signal: null }),
  })
  assert.equal(r.exitCode, 0, out)
  assert.match(out, /^状态 +可用：MCP 工具服务（实验性）$/m)
  assert.ok(out.includes('https://api.tapeapi.fun/mcp'), out)
  assert.ok(out.includes(`8 (清单里的免费方法)   toolsSha256 ${digest.slice(0, 8)}…`), out)
  let json = ''
  await runConnect(['42.7.tape', '--rpc', 'http://rpc1,http://rpc2,http://rpc3', '--json'], {
    cmd: 'tapeapi', version: '0.0.0-test', verifyBin: '/x/tapeapi-verify.js', mcpBin: '/x/tapeapi-mcp.js', env: {}, isTTY: false,
    apiOptions: { clock: () => now, quiet: true, onWarning: () => {}, fetch: (u, init) => chain.fetch(String(u), init) },
    stdout: (x) => { json += x }, stderr: () => {}, runChild: async () => ({ code: 0, signal: null }),
  })
  const o = JSON.parse(json)
  assert.deepEqual([o.kind, o.status], ['mcp', 'ok'])
  assert.deepEqual(o.service.mcp, { endpoint: 'https://api.tapeapi.fun/mcp', toolsSha256: digest })
  assert.deepEqual(o.service.tools, MANIFEST_METHODS.map((x) => x.name))
})

test('CONFIRMED MCP-CONFORM-2: tapeapi-mcp pins the declared service, checks its eight tools against toolsSha256 and the signature of every answer, and then refuses to show an answer that is not an MCP tool result', async () => {
  const plain = await startWorker()
  const digest = await mcpToolsSha256(manifestOf(plain.env))
  const w = await startWorker({ MCP_TOOLS_SHA256: digest })
  const served = JSON.parse(await (await fetch(`${w.url}/.well-known/tapeapi.json`)).text())
  assert.deepEqual(served.mcp, { endpoint: `${w.url}/mcp`, toolsSha256: digest })
  // The live endpoint answers exactly the published tools. / 线上端点给出的正是发布的工具。
  const listed = (await (await post(w.url, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()).result.tools
  assert.equal(mcp.toolsDigest(listed), digest)
  const pins = join(TMP, 'conform', 'pins.json')
  const s = await mcpSession(['--dev', w.url, '--pin', pins])
  const tools = (await s.request('tools/list')).result.tools
  assert.deepEqual(tools.map((t) => t.name).sort(), MANIFEST_METHODS.map((x) => x.name).sort())
  assert.match(tools[0].description, /pins \(mcp\.toolsSha256 [0-9a-f]{16}\.\.\.\)/)
  const r = await s.request('tools/call', { name: 'blockNumber', arguments: {} })
  assert.equal(r.result.isError, true)
  assert.match(textOf(r), /answered blockNumber with a signed value that is not an MCP tool result/)
  // The answer was verified before it was refused: its receipt is there and recovers to the manifest signer.
  // 回答在被拒绝之前已核验：回执在，且恢复出清单的签名者。
  const receipt = r.result._meta[mcp.RECEIPT_META_KEY]
  assert.deepEqual([receipt.ok, receipt.result], [true, { blockNumber: 1000 }])
  assert.equal(recoverResponseSigner({ container: receipt.service.container, id: receipt.id, method: 'blockNumber', params: {}, ok: true, body: receipt.result, ts: receipt.ts }, receipt.sig), SIGNER)
  await s.close()
  assert.match(s.stderr(), /MCP tools verified: 8 tool\(s\) from http:\/\/127\.0\.0\.1:\d+\/mcp hash to the manifest's mcp\.toolsSha256/)
  assert.match(s.stderr(), /the signed answer is not an MCP tool result/)
  const entry = Object.values(JSON.parse(readFileSync(pins, 'utf8')).pins)[0]
  assert.equal(entry.material.toolsSha256, digest, 'toolsSha256 is pinned')
})

test('changed tools: the Worker refuses every bound method with a signed TOOLS_CHANGED on /tapeapi/v1 and /mcp, and tapeapi-mcp refuses the tools before sending anything', async () => {
  const published = await mcpToolsSha256(manifestOf(envFor()))
  // A deploy whose tool text differs from what was published (here: the display name in every title).
  // 部署后的工具文本与已发布的不同（这里：每个标题里的显示名称）。
  const w = await startWorker({ MCP_TOOLS_SHA256: published, SERVICE_NAME: 'TapeAPI Public (renamed)' })
  const current = await mcpToolsSha256(manifestOf(w.env))
  assert.notEqual(current, published)
  const res = await post(w.url, '/tapeapi/v1/blockNumber', { id: 'tc-1', params: {} })
  assert.equal(res.status, 409)
  const env = await res.json()
  assert.deepEqual([env.ok, env.error.code, env.error.data], [false, 'TOOLS_CHANGED', { published, current }])
  assert.equal(recoverResponseSigner({ container: w.env.CONTAINER, id: 'tc-1', method: 'blockNumber', params: {}, ok: false, body: env.error, ts: env.ts }, env.sig), SIGNER)
  const viaMcp = (await (await post(w.url, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bnbUsd', arguments: {} } })).json()).result
  assert.equal(viaMcp.isError, true)
  assert.match(viaMcp.content[0].text, /^The service refused: TOOLS_CHANGED: /)
  const s = await mcpSession(['--dev', w.url, '--no-pin'])
  const r = await s.request('tools/call', { name: 'blockNumber', arguments: {} })
  assert.equal(r.result.isError, true)
  assert.match(textOf(r), /REFUSED, nothing was sent/)
  assert.match(textOf(r), new RegExp(`hash to ${current}`))
  await s.close()
})

test('old clients: an SDK client ignores the new member and calls as before; CONFIRMED MCP-CONFORM-3: a tapeapi-mcp that pinned the service before sees the declaration as a changed service and refuses it until --allow-changed', async () => {
  const before = await startWorker()
  const digest = await mcpToolsSha256(manifestOf(before.env))
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
  const refused = await s.request('tools/call', { name: 'blockNumber', arguments: {} })
  assert.equal(refused.result.isError, true)
  assert.match(textOf(refused), /changed on chain since they were pinned/)
  await s.close()
  assert.match(s.stderr(), /MCP tool set \(mcp\.toolsSha256\): none -> [0-9a-f]{64}/)
})
