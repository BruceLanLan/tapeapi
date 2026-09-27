// tapeapi-mcp (sdk/bin/tapeapi-mcp.js) over real stdio: the bin is spawned against local dev providers (in-process
// createProvider + listen, plus a proxy that alters answers after they were signed). Network-free: --dev resolves
// the manifest over http from 127.0.0.1 and reads no chain.
// tapeapi-mcp 走真实 stdio：对本地 dev provider（进程内 createProvider + listen，外加一个在签名后篡改回答的代理）启动 bin。
// 不联网：--dev 从 127.0.0.1 通过 http 读清单，不读链。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { privateKeyToAddress, recoverResponseSigner } from '../src/sig.js'
import { RECEIPT_META_KEY, fromBase64Url } from '../src/mcp.js'
import { createProvider } from '../../server/src/index.js'

const BIN = fileURLToPath(new URL('../bin/tapeapi-mcp.js', import.meta.url))
const KEY_A = '0x' + '5a'.repeat(32), KEY_B = '0x' + '5b'.repeat(32)
const CONTAINER = '0x' + '7c'.repeat(20), CONTAINER_T = '0x' + '7d'.repeat(20)
const CIRCUITS = '0x' + '7e'.repeat(20)
const dir = mkdtempSync(join(tmpdir(), 'tapeapi-mcp-'))
const servers = []

const methods = () => [
  { name: 'bnbUsd', priceBEM: '0', description: 'Price of BNB in USD', params: {}, returns: { bnbUsd: 'string' } },
  { name: 'echo', priceBEM: '0', params: { text: 'string' }, returns: { echo: 'object' } },
  { name: 'premium', priceBEM: '0.5', params: {}, returns: {} },
]
const manifestFor = (container, signerKey) => ({
  tapeapi: '0.1', name: 'Local Test', circuits: CIRCUITS, tokenId: '9', container, signer: privateKeyToAddress(signerKey),
  endpoints: { live: ['http://127.0.0.1:1/tapeapi/v1'], async: false }, methods: methods(), payment: { escrow: '0x' + '00'.repeat(20) }, dev: true,
})
async function startProvider(manifest, signerKey) {
  const provider = createProvider({
    manifest, signerKey, allowHttp: true, rateLimit: false,
    methods: { bnbUsd: async () => ({ bnbUsd: '600.5' }), echo: async (p) => { if (p.text === 'boom') { const e = new Error('no boom here'); e.code = 'BAD_REQUEST'; throw e } return { echo: p } }, premium: async () => ({}) },
    log: () => {},
  })
  const srv = await provider.listen(0)
  servers.push(provider)
  const url = `http://127.0.0.1:${srv.address().port}`
  manifest.endpoints.live = [`${url}/tapeapi/v1`]
  return { provider, url }
}
// Passes the manifest through untouched and rewrites every signed result. / 清单原样转发，每个已签名结果都被改写。
async function startTamperProxy(upstream) {
  const srv = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c)
    const r = await fetch(upstream + req.url, { method: req.method, headers: { 'content-type': 'application/json' }, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined })
    let text = await r.text()
    if (req.method === 'POST') { const env = JSON.parse(text); if (env.ok) env.result = { bnbUsd: '1.00' }; text = JSON.stringify(env) }
    res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(text)
  })
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok))
  servers.push({ close: () => new Promise((ok) => { srv.close(ok); srv.closeAllConnections() }) })
  return `http://127.0.0.1:${srv.address().port}`
}

// One spawned bin. request() sends a JSON-RPC request and waits for the reply with that id; every stdout line is kept.
// 一个 bin 进程。request() 发请求并等待同 id 的回复；stdout 的每一行都保留。
// Every spawned server, so a failed assertion cannot leave one running and hang the test process (or CI).
// 记下每个启动的服务器：断言失败也不会留下进程把测试进程（或 CI）挂住。
const children = new Set()
function spawnBin(args) {
  const child = spawn(process.execPath, [BIN, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
  children.add(child); child.once('exit', () => children.delete(child))
  let out = '', err = '', seq = 0
  const waiters = new Map()
  const lines = []
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', (d) => {
    out += d
    let i
    while ((i = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, i); out = out.slice(i + 1)
      lines.push(line)
      let msg; try { msg = JSON.parse(line) } catch { continue }
      const w = waiters.get(msg.id); if (w) { waiters.delete(msg.id); w(msg) }
    }
  })
  child.stderr.on('data', (d) => { err += d })
  const exited = new Promise((ok) => child.on('exit', (code) => ok(code)))
  return {
    lines, stderr: () => err, exited, kill: (sig) => child.kill(sig),
    send: (obj) => child.stdin.write((typeof obj === 'string' ? obj : JSON.stringify(obj)) + '\n'),
    request(method, params) {
      const id = ++seq
      const p = new Promise((ok, fail) => {
        const t = setTimeout(() => fail(new Error(`no reply to ${method} in 20 s; stderr:\n${err}`)), 20_000)
        waiters.set(id, (m) => { clearTimeout(t); ok(m) })
      })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n')
      return p
    },
    async close() { child.stdin.end(); return exited },
  }
}
async function session(args) {
  const s = spawnBin(args)
  const init = await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
  s.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return { ...s, init }
}
// stdout carries JSON-RPC 2.0 messages only, one per line. / stdout 上只有 JSON-RPC 2.0 消息，每行一条。
function assertPureStdout(lines) {
  assert.ok(lines.length > 0)
  for (const line of lines) {
    let m
    assert.doesNotThrow(() => { m = JSON.parse(line) }, `stdout line is not JSON: ${line.slice(0, 200)}`)
    for (const x of Array.isArray(m) ? m : [m]) {
      assert.equal(x.jsonrpc, '2.0', `not JSON-RPC: ${line.slice(0, 200)}`)
      assert.ok('result' in x || 'error' in x, 'only responses are written')
    }
  }
}
const textOf = (r) => r.result.content.map((c) => c.text).join('\n')
const pinFile = (name) => join(dir, name, 'pins.json')

let A, T, manifestA, manifestT
before(async () => {
  manifestA = manifestFor(CONTAINER, KEY_A)
  A = await startProvider(manifestA, KEY_A)
  manifestT = manifestFor(CONTAINER_T, KEY_A)
  const real = await startProvider(manifestT, KEY_A)
  const proxy = await startTamperProxy(real.url)
  manifestT.endpoints.live = [`${proxy}/tapeapi/v1`]
  T = { url: proxy }
})
after(async () => {
  for (const c of children) c.kill('SIGKILL')
  // The proxy's fetch keeps a connection to the provider alive; drop them so the test process can exit.
  // 代理的 fetch 与 provider 保持长连接；全部断开，测试进程才能退出。
  for (const s of servers) { const p = s.close(); s.server?.closeAllConnections?.(); await p }
  rmSync(dir, { recursive: true, force: true })
})

test('initialize, tools/list and a verified tools/call over stdio; pin file created on first run (0600)', async () => {
  const pins = pinFile('happy')
  const s = await session(['--dev', A.url, '--pin', pins])
  assert.equal(s.init.result.serverInfo.name, 'tapeapi-mcp')
  assert.equal(s.init.result.protocolVersion, '2025-06-18')
  assert.deepEqual(s.init.result.capabilities, { tools: { listChanged: false } })

  const list = await s.request('tools/list')
  const names = list.result.tools.map((t) => t.name).sort()
  assert.deepEqual(names, ['bnbUsd', 'echo'], 'one service: bare method names; the priced method is not exposed')
  const bnb = list.result.tools.find((t) => t.name === 'bnbUsd')
  assert.match(bnb.description, /DEV MODE/)
  assert.equal(bnb.annotations.readOnlyHint, true)

  const r = await s.request('tools/call', { name: 'bnbUsd', arguments: {} })
  assert.equal(r.result.isError, false)
  assert.deepEqual(r.result.structuredContent, { bnbUsd: '600.5' })
  const receipt = r.result._meta[RECEIPT_META_KEY]
  assert.equal(receipt.method, 'bnbUsd')
  assert.equal(receipt.ok, true)
  assert.equal(receipt.service.container.toLowerCase(), CONTAINER)
  // Anyone holding the receipt can recover the signer. / 持有回执的任何人都能恢复签名者。
  const signer = recoverResponseSigner({ container: receipt.service.container, id: receipt.id, method: receipt.method, params: receipt.params, ok: true, body: receipt.result, ts: receipt.ts }, receipt.sig)
  assert.equal(signer, privateKeyToAddress(KEY_A))
  assert.match(textOf(r), /verified against the on-chain delegation before this result was returned/)
  assert.match(textOf(r), /DEV MODE/)
  const link = /Verify: (\S+)/.exec(textOf(r))[1]
  assert.deepEqual(JSON.parse(fromBase64Url(link.split('#r=')[1])), receipt)

  const echo = await s.request('tools/call', { name: 'echo', arguments: { text: 'hi' } })
  assert.deepEqual(echo.result.structuredContent, { echo: { text: 'hi' } })
  // An unknown tool is a protocol error, as on the remote endpoint. / 未知工具是协议错误，与远程端点一致。
  const bad = await s.request('tools/call', { name: 'nope', arguments: {} })
  assert.equal(bad.error.code, -32602)
  // Garbage in: a parse error, and the server keeps going. / 垃圾输入：解析错误，服务器继续工作。
  s.send('{not json')
  const ping = await s.request('ping')
  assert.deepEqual(ping.result, {})

  assert.equal(await s.close(), 0, 'EOF on stdin exits cleanly')
  assertPureStdout(s.lines)
  assert.ok(s.lines.some((l) => JSON.parse(l).error?.code === -32700), 'parse error answered')
  assert.equal(s.lines.length, 7, 'initialize, tools/list, 2 calls, unknown tool, parse error, ping: notifications get no reply')
  assert.match(s.stderr(), /TESTING ONLY/, '--dev warns loudly on stderr')

  assert.ok(existsSync(pins))
  assert.equal(statSync(pins).mode & 0o777, 0o600)
  const saved = JSON.parse(readFileSync(pins, 'utf8'))
  const key = Object.keys(saved.pins)[0]
  assert.equal(key.toLowerCase(), `dev:${CONTAINER}`)
  assert.match(saved.pins[key].sha256, /^[0-9a-f]{64}$/)
  assert.deepEqual(saved.pins[key].material.methods.map((m) => m.name), ['bnbUsd', 'echo', 'premium'])
})

test('a tampered answer (altered after signing) is DISCARDED, never returned; stdout stays pure', async () => {
  const s = await session(['--dev', T.url, '--pin', pinFile('tamper')])
  const r = await s.request('tools/call', { name: 'bnbUsd', arguments: {} })
  assert.equal(r.result.isError, true)
  assert.match(textOf(r), /DISCARDED/)
  assert.match(textOf(r), /signature did not verify/)
  assert.doesNotMatch(JSON.stringify(r.result), /1\.00/, 'the altered value never reaches the model')
  assert.equal(r.result._meta, undefined, 'no receipt for a discarded answer')
  assert.equal(r.result.structuredContent, undefined)
  await s.close()
  assertPureStdout(s.lines)
})

test('a manifest changed after pinning (method added) is refused on the next run, accepted once with --allow-changed', async () => {
  const pins = pinFile('changed')
  let s = await session(['--dev', A.url, '--pin', pins])
  assert.equal((await s.request('tools/call', { name: 'bnbUsd', arguments: {} })).result.isError, false)
  await s.close()
  const before = JSON.parse(readFileSync(pins, 'utf8'))

  manifestA.methods.push({ name: 'extra', priceBEM: '0', params: {}, returns: { extra: 'boolean' } })
  try {
    s = await session(['--dev', A.url, '--pin', pins])
    const list = await s.request('tools/list')
    assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ['bnbUsd', 'echo'], 'tools/list shows the pinned view, not the new method')
    const r = await s.request('tools/call', { name: 'bnbUsd', arguments: {} })
    assert.equal(r.result.isError, true)
    assert.match(textOf(r), /REFUSED, nothing was sent/)
    assert.match(textOf(r), /changed on chain/)
    assert.match(textOf(r), /added methods: extra/)
    assert.match(textOf(r), /--allow-changed/)
    await s.close()
    assertPureStdout(s.lines)
    assert.deepEqual(JSON.parse(readFileSync(pins, 'utf8')), before, 'a refused change does not touch the pin file')

    s = await session(['--dev', A.url, '--pin', pins, '--allow-changed'])
    assert.deepEqual((await s.request('tools/list')).result.tools.map((t) => t.name).sort(), ['bnbUsd', 'echo', 'extra'])
    // (The running provider snapshots its methods at boot, so the call goes to a method it already serves.)
    // （运行中的 provider 在启动时固定方法表，所以调用它本来就提供的方法。）
    const ok = await s.request('tools/call', { name: 'bnbUsd', arguments: {} })
    assert.equal(ok.result.isError, false)
    assert.deepEqual(ok.result.structuredContent, { bnbUsd: '600.5' })
    await s.close()
    assert.match(s.stderr(), /--allow-changed: accepting changed tool definitions \(added methods: extra\)/)

    // Re-pinned: the next plain run accepts it. / 已重新钉住：下一次普通运行接受它。
    s = await session(['--dev', A.url, '--pin', pins])
    assert.equal((await s.request('tools/call', { name: 'bnbUsd', arguments: {} })).result.isError, false)
    await s.close()
  } finally { manifestA.methods.pop() }
})

test('a new signing key for the same container is refused as a change', async () => {
  const pins = pinFile('signer')
  let s = await session(['--dev', A.url, '--pin', pins])
  await s.request('tools/list'); await s.close()
  const manifestB = manifestFor(CONTAINER, KEY_B)
  const B = await startProvider(manifestB, KEY_B)
  s = await session(['--dev', B.url, '--pin', pins])
  const r = await s.request('tools/call', { name: 'bnbUsd', arguments: {} })
  assert.equal(r.result.isError, true)
  assert.match(textOf(r), new RegExp(`signing key: ${privateKeyToAddress(KEY_A).toLowerCase()} -> ${privateKeyToAddress(KEY_B).toLowerCase()}`))
  await s.close()
})

test('a change the SDK picks up during the session (re-read after a bad signature) refuses further calls', async () => {
  const s = await session(['--dev', T.url, '--pin', pinFile('insession')])
  assert.deepEqual((await s.request('tools/list')).result.tools.map((t) => t.name).sort(), ['bnbUsd', 'echo'])
  manifestT.methods.push({ name: 'extra', priceBEM: '0', params: {}, returns: {} })
  try {
    const first = await s.request('tools/call', { name: 'bnbUsd', arguments: {} })
    assert.match(textOf(first), /DISCARDED/)
    assert.match(textOf(first), /changed on chain meanwhile: added methods: extra/)
    const second = await s.request('tools/call', { name: 'echo', arguments: { text: 'x' } })
    assert.equal(second.result.isError, true)
    assert.match(textOf(second), /REFUSED, nothing was sent.*added methods: extra/s)
  } finally { manifestT.methods.pop() }
  await s.close()
  assertPureStdout(s.lines)
})

test('several services: prefixed tool names; --no-pin writes nothing', async () => {
  const pins = pinFile('multi')
  const s = await session(['--dev', A.url, '--dev', T.url, '--pin', pins, '--no-pin'])
  const names = (await s.request('tools/list')).result.tools.map((t) => t.name).sort()
  assert.deepEqual(names, ['dev1_bnbUsd', 'dev1_echo', 'dev2_bnbUsd', 'dev2_echo'])
  const r = await s.request('tools/call', { name: 'dev1_bnbUsd', arguments: {} })
  assert.equal(r.result.isError, false)
  assert.match(textOf(await s.request('tools/call', { name: 'dev2_bnbUsd', arguments: {} })), /DISCARDED/)
  await s.close()
  assert.equal(existsSync(pins), false)
})

test('SIGTERM exits cleanly', async () => {
  const s = await session(['--dev', A.url, '--no-pin'])
  await s.request('tools/list')
  s.kill('SIGTERM')
  assert.equal(await s.exited, 0)
  assertPureStdout(s.lines)
})

test('a damaged pin file stops the server instead of silently trusting again', async () => {
  const pins = pinFile('happy')
  const saved = JSON.parse(readFileSync(pins, 'utf8'))
  const key = Object.keys(saved.pins)[0]
  saved.pins[key].material.methods[0].description = 'edited'
  const damaged = join(dir, 'damaged.json')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(damaged, JSON.stringify(saved))
  const s = spawnBin(['--dev', A.url, '--pin', damaged])
  assert.equal(await s.exited, 1)
  assert.match(s.stderr(), /does not match its own sha256/)
  assert.equal(s.lines.length, 0)
})

test('a signed refusal comes back as a tool error WITH a receipt whose signature verifies', async () => {
  const s = await session(['--dev', A.url, '--no-pin'])
  const r = await s.request('tools/call', { name: 'echo', arguments: { text: 'boom' } })
  assert.equal(r.result.isError, true)
  assert.match(textOf(r), /refused: BAD_REQUEST: no boom here/)
  const receipt = r.result._meta[RECEIPT_META_KEY]
  assert.equal(receipt.ok, false)
  assert.equal(receipt.error.code, 'BAD_REQUEST')
  const who = recoverResponseSigner({ container: receipt.service.container, id: receipt.id, method: 'echo', params: { text: 'boom' }, ok: false, body: receipt.error, ts: receipt.ts }, receipt.sig)
  assert.equal(who, privateKeyToAddress(KEY_A))
  await s.close()
  assertPureStdout(s.lines)
})
