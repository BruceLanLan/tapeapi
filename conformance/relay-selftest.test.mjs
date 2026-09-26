// Self-test of the relay conformance suite: the reference relay (examples/relay-service) must pass every MUST and
// every SHOULD, free and priced; deliberately broken relays must fail, each on the check that names its defect.
// 中继一致性套件的自测：参考中继须通过全部 MUST 与 SHOULD（免费与收费两种）；故意做坏的中继必须失败，且失败在点名其缺陷的那一项上。
//
//   node --test conformance/relay-selftest.test.mjs
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProvider } from '../server/src/index.js'
import { createFakeChain, ADDR } from '../sdk/test/helpers/fake-chain.mjs'
import { privateKeyToAddress, signDigest, delegationDigest, signResponse } from '../sdk/src/sig.js'
import { safeParseJSON } from '../sdk/src/canon.js'
import { createRelayCore, relayMethods, relayManifestMethods, sourceOf } from '../examples/relay-service/relay-core.mjs'
import { runRelaySuite, formatText } from './relay.mjs'

const RELAY = fileURLToPath(new URL('./relay.mjs', import.meta.url))
const SIGNER_KEY = '0x' + '22'.repeat(32), HOLDER_KEY = '0x' + '11'.repeat(32)
const signer = privateKeyToAddress(SIGNER_KEY)
const RPC = ['http://rpc1', 'http://rpc2']
const EXPIRES = Math.floor(Date.now() / 1000) + 300 * 86400
// The relay's long-poll cap is shortened (reference: 20 s) so the full-length poll costs 1.5 s per run; every other
// cap keeps its reference value. / 缩短长轮询上限（参考值 20 秒），使满时长轮询每轮只花 1.5 秒；其余上限保持参考值。
const CORE = { maxWaitMs: 1500 }
// Long-poll timing slack for this machine, not a relay across the internet: a loaded CI box can take seconds to schedule
// a handler (the CLI default stays 2 s). / 本机测试的长轮询时间容差（命令行默认仍是 2 秒）。
const SLACK = 10_000
const EPOCH_RE = /^[0-9a-f]{1,32}$/   // an invalid epoch is still refused; a valid one is ignored / 非法纪元仍被拒绝，合法的被忽略

let chain
const servers = []
before(() => { chain = createFakeChain() })
after(async () => { for (const close of servers) await close() })

// The reference relay exactly as relay.test.mjs builds it: a signed delegation, the three methods, optional price.
// 与 relay.test.mjs 相同的参考中继：带签名委托、三个方法、可选价格。
function mkRelay({ priceBEM = '0', core = {}, provider = {}, methods } = {}) {
  const c = createRelayCore({ ...CORE, ...core })
  const manifest = {
    tapeapi: '0.1', name: 'relay.tape', circuits: ADDR.circuits, tokenId: '4246', container: ADDR.container, signer,
    delegation: { expires: EXPIRES, sig: signDigest(delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires: EXPIRES }), HOLDER_KEY) },
    endpoints: { live: ['http://127.0.0.1:1/tapeapi/v1'], async: false },
    methods: relayManifestMethods({ priceBEM }),
    ...(priceBEM !== '0' ? { payment: { escrow: ADDR.escrow, unit: 'BEM', decimals: 8 } } : {}),
  }
  return createProvider({
    manifest, signerKey: SIGNER_KEY, rpcUrls: RPC, quorum: 2, chainId: 56, fetch: chain.fetch, allowHttp: true, escrowCacheMs: 0,
    minVoucherLifeS: 0, log: () => {}, rateLimit: false, methods: { ...relayMethods(c), ...(methods ? methods(c) : {}) }, ...provider,
  })
}
async function serveNative(provider) {
  const srv = await provider.listen(0)
  servers.push(() => provider.close())
  return `http://127.0.0.1:${srv.address().port}`
}
// Responses pass through `transform` before leaving: a broken relay built out of a correct one.
// 响应离开前经过 `transform`：用正确的实现构造坏的实现。
async function serveWrapped(provider, transform) {
  const srv = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const raw = Buffer.concat(chunks).toString('utf8')
    const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
    const resp = await provider.handleRequest(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers, body: hasBody ? raw : undefined }), { clientIp: '127.0.0.1' })
    const text = await resp.text()
    let obj; try { obj = JSON.parse(text) } catch { obj = undefined }
    let reqBody; try { reqBody = safeParseJSON(raw) } catch { reqBody = undefined }
    const pathMethod = new URL(req.url, 'http://x').pathname.split('/').pop()
    const out = (obj && typeof obj.sig === 'string' && transform({ obj, reqBody, pathMethod })) || null
    const headers = Object.fromEntries(resp.headers); delete headers['content-length']
    res.writeHead(resp.status, headers); res.end(resp.status === 204 ? undefined : out ? JSON.stringify(out) : text)
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  servers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()) }))
  return `http://127.0.0.1:${srv.address().port}`
}
// Re-sign a (modified) envelope for the request that produced it, with the relay's own key: only the content is wrong.
// 用中继自己的密钥为产生它的请求重签（修改过的）信封：错的只有内容。
const reSign = (e, reqBody, method) => ({ ...e, sig: signResponse({ container: e.container, id: e.id, method, params: reqBody?.params ?? {}, ok: e.ok, body: e.ok ? e.result : e.error, ts: e.ts }, SIGNER_KEY) })
const onResult = (methodName, fn) => ({ obj, reqBody, pathMethod }) =>
  pathMethod === methodName && obj.ok === true ? reSign({ ...obj, result: fn(obj.result) }, reqBody, pathMethod) : null

const mustFails = (results) => results.filter((r) => r.level === 'MUST' && r.status === 'fail')
const shouldFails = (results) => results.filter((r) => r.level === 'SHOULD' && r.status === 'fail')
const failIds = (results) => [...new Set(mustFails(results).map((r) => r.id))].sort()
const show = (results) => formatText(results.filter((r) => r.status !== 'pass'), { must: {}, should: {} }).split('\nMUST:')[0]
const passed = (results, id) => results.some((r) => r.id === id && r.status === 'pass')

// Every relay check that must actually run (not skip) against a free reference relay. / 免费参考中继上必须实际执行的检查。
const FREE_RELAY_IDS = [
  'tap26.relay.manifest.methods', 'tap26.relay.manifest.handshake-free', 'tap26.relay.manifest.recv-free',
  'tap26.relay.recv.unknown-room', 'tap26.relay.recv.no-create', 'tap26.relay.recv.next', 'tap26.relay.recv.result-shape',
  'tap26.relay.post.result-shape', 'tap26.relay.epoch.format', 'tap26.relay.epoch.every-method', 'tap26.relay.epoch.length', 'tap26.relay.epoch.random',
  'tap26.relay.epoch.mismatch-resets', 'tap26.relay.index.increasing', 'tap26.relay.recv.order', 'tap26.relay.recv.content', 'tap26.relay.recv.after',
  'tap26.relay.envelope.bound', 'tap26.relay.request.bad-params',
  'tap26.relay.send.max-wire', 'tap26.relay.send.oversize', 'tap26.relay.send.oversize.code', 'tap26.relay.recv.fits-cap', 'tap26.relay.recv.progress', 'tap26.relay.recv.paging-order',
  'tap26.relay.longpoll.bounded', 'tap26.relay.longpoll.holds', 'tap26.relay.longpoll.wakes', 'tap26.relay.longpoll.full-length',
  'tap26.relay.handshake.accept', 'tap26.relay.handshake.refuse-other', 'tap26.relay.handshake.refuse-code', 'tap26.relay.handshake.size', 'tap26.relay.handshake.room-limit',
  'tap26.relay.kept.survives-flood', 'tap26.relay.kept.order', 'tap26.relay.kept.source-cap',
  'tap21.envelope.sig-recovers', 'tap21.envelope.id-echo', 'tap21.response.size-cap',
]

test('reference relay (free, native listen()) passes every MUST and every SHOULD, and every relay check ran', async () => {
  const { results, summary } = await runRelaySuite({ slackMs: SLACK, url: await serveNative(mkRelay()) })
  assert.deepEqual(mustFails(results), [], show(results))
  assert.deepEqual(shouldFails(results), [], show(results))
  assert.equal(summary.conformant, true)
  for (const id of FREE_RELAY_IDS) assert.ok(passed(results, id), `${id} did not pass:\n${show(results.filter((r) => r.id === id))}`)
  // The protected-ring check was exercised: frames really were evicted around the invite. / 受保护环确实被检验到：邀请周围确有帧被挤掉。
  assert.match(results.find((r) => r.id === 'tap26.relay.kept.survives-flood').message, /frames evicted, invite and epoch message kept/)
  assert.match(results.find((r) => r.id === 'tap26.relay.kept.source-cap').message, /^refused after 8$/)
  assert.match(results.find((r) => r.id === 'tap26.relay.handshake.room-limit').message, /^refused after 8$/)
})

test('reference relay, priced relaySend: handshake still free, paid checks skipped with a reason, 0 MUST / 0 SHOULD failures', async () => {
  const { results } = await runRelaySuite({ slackMs: SLACK, url: await serveNative(mkRelay({ priceBEM: '0.00001' })) })
  assert.deepEqual(mustFails(results), [], show(results))
  assert.deepEqual(shouldFails(results), [], show(results))
  assert.ok(passed(results, 'tap26.relay.handshake.no-payment'))
  for (const id of ['tap26.relay.recv.fits-cap', 'tap26.relay.kept.survives-flood', 'tap26.relay.kept.source-cap']) {
    const r = results.find((x) => x.id === id)
    assert.equal(r?.status, 'skip', id); assert.match(r.message, /relaySend costs 0\.00001 BEM/)
  }
  // Rooms, indices, epochs and long-poll still ran, over the free handshake path. / 房间、序号、纪元与长轮询仍经免费握手通道执行。
  for (const id of ['tap26.relay.index.increasing', 'tap26.relay.recv.order', 'tap26.relay.epoch.mismatch-resets', 'tap26.relay.longpoll.wakes', 'tap26.relay.longpoll.full-length']) assert.ok(passed(results, id), id)
})

test('reference relay behind a rate limit: the suite waits out each 429, checks it, and still passes', async () => {
  // The concurrent burst (checkRateLimit) makes the 429 certain; relying on the suite's own pace flaked under load. The
  // window is 4 s, not 1 s: on a slow CI runner the 155-call burst spanned a 1 s window boundary and never saw a 429.
  // 用并发突发（checkRateLimit）确保出现 429。窗口用 4 秒而非 1 秒：CI 机器较慢时，155 次突发会跨过 1 秒窗口边界，从而看不到 429。
  const { results } = await runRelaySuite({ slackMs: SLACK, url: await serveNative(mkRelay({ provider: { rateLimit: { free: 150, windowMs: 4000 } } })), checkRateLimit: 150 })
  assert.deepEqual(mustFails(results), [], show(results))
  for (const id of ['tap21.ratelimit.unsigned', 'tap21.ratelimit.retry-after', 'tap21.ratelimit.code', 'tap21.ratelimit.retryAfterS']) assert.ok(passed(results, id), `${id}:\n${show(results)}`)
  assert.ok(passed(results, 'tap26.relay.kept.survives-flood'))
})

// ---- deliberately broken relays / 故意做坏的中继 ----

test('BROKEN: returns frames newest-first (validly signed) -> tap26.relay.recv.order fails', async () => {
  const url = await serveWrapped(mkRelay(), onResult('relayRecv', (x) => ({ ...x, frames: [...x.frames].reverse() })))
  const { results, summary } = await runRelaySuite({ slackMs: SLACK, url })
  assert.equal(summary.conformant, false)
  assert.ok(failIds(results).includes('tap26.relay.recv.order'), show(results))
  assert.equal(results.filter((r) => r.id === 'tap21.envelope.sig-recovers' && r.status === 'fail').length, 0, 'every envelope is validly signed')
})

test('BROKEN: drops the epoch from post answers -> tap26.relay.post.result-shape fails', async () => {
  const drop = ({ epoch, ...rest }) => rest
  const url = await serveWrapped(mkRelay(), (a) => onResult('relaySend', drop)(a) || onResult('relayHandshake', drop)(a))
  const { results } = await runRelaySuite({ slackMs: SLACK, url })
  assert.ok(failIds(results).includes('tap26.relay.post.result-shape'), show(results))
})

test('BROKEN: ignores the client\'s epoch (answers a stale cursor as if it were current) -> only tap26.relay.epoch.mismatch-resets fails', async () => {
  const url = await serveNative(mkRelay({ methods: (c) => ({ relayRecv: async ({ room, after = -1, waitMs = 0, epoch }) => c.recv(room, after, waitMs, EPOCH_RE.test(epoch ?? '0') ? undefined : epoch) }) }))
  const { results } = await runRelaySuite({ slackMs: SLACK, url })
  assert.deepEqual(failIds(results), ['tap26.relay.epoch.mismatch-resets'], show(results))
  assert.deepEqual(shouldFails(results), [], show(results))
})

test('BROKEN: relayHandshake is a free relaySend (carries anything) -> tap26.relay.handshake.refuse-other fails', async () => {
  const url = await serveNative(mkRelay({ methods: (c) => ({ relayHandshake: async ({ room, frame }, ctx) => c.send(room, frame, { source: sourceOf(ctx) }) }) }))
  const { results } = await runRelaySuite({ slackMs: SLACK, url })
  assert.deepEqual(failIds(results), ['tap26.relay.handshake.refuse-other'], show(results))
})

test('BROKEN: returns the whole backlog (no byte budget) -> tap26.relay.recv.fits-cap fails (the answer exceeds 1 MiB and becomes INTERNAL)', async () => {
  const url = await serveNative(mkRelay({ core: { maxRecvBytes: 64 * 1024 * 1024 } }))
  const { results } = await runRelaySuite({ slackMs: SLACK, url })
  assert.ok(failIds(results).includes('tap26.relay.recv.fits-cap'), show(results))
  assert.ok(failIds(results).includes('tap26.relay.recv.progress'), 'the cursor never advances')
})

test('BROKEN: waitMs cap above the handler deadline -> tap26.relay.longpoll.full-length fails (INTERNAL instead of an empty answer)', async () => {
  const url = await serveNative(mkRelay({ core: { maxWaitMs: 3000 }, provider: { handlerTimeoutMs: 1500 } }))
  const { results } = await runRelaySuite({ slackMs: SLACK, url })
  assert.deepEqual(failIds(results), ['tap26.relay.longpoll.full-length'], show(results))
  assert.match(results.find((r) => r.id === 'tap26.relay.longpoll.full-length' && r.status === 'fail').message, /INTERNAL/)
})

test('BROKEN: a flood evicts sealed invites and epoch messages (no protected ring) -> tap26.relay.kept.survives-flood fails', async () => {
  // Simulated by hiding every 0x03 / 0x04 frame whose index is older than the newest 256. / 以隐藏最新 256 条之前的 0x03 / 0x04 模拟。
  const url = await serveWrapped(mkRelay(), onResult('relayRecv', (x) => {
    const kept = (f) => [3, 4].includes(Buffer.from(f.frame, 'base64')[0])
    return { ...x, frames: x.frames.filter((f) => !(kept(f) && x.frames.length > 256)) }
  }))
  const { results } = await runRelaySuite({ slackMs: SLACK, url })
  assert.deepEqual(failIds(results), ['tap26.relay.kept.survives-flood'], show(results))
})

test('BROKEN: relayRecv on an unknown room invents an epoch -> tap26.relay.recv.unknown-room fails', async () => {
  const url = await serveWrapped(mkRelay(), onResult('relayRecv', (x) => (x.epoch === null ? { ...x, epoch: 'deadbeef' } : x)))
  const { results } = await runRelaySuite({ slackMs: SLACK, url })
  assert.ok(failIds(results).includes('tap26.relay.recv.unknown-room'), show(results))
})

test('CLI: exit 0 + JUnit for the reference relay, exit 1 for a broken one', async () => {
  const good = await serveNative(mkRelay())
  const bad = await serveNative(mkRelay({ methods: (c) => ({ relayRecv: async ({ room, after = -1, waitMs = 0, epoch }) => c.recv(room, after, waitMs, EPOCH_RE.test(epoch ?? '0') ? undefined : epoch) }) }))
  const dir = mkdtempSync(join(tmpdir(), 'tapeapi-relay-conf-'))
  // spawnSync would block this process's event loop, and with it the in-process relay. / 同步子进程会阻塞本进程里的中继。
  const run = (url, junit) => new Promise((resolve) => {
    const p = spawn(process.execPath, [RELAY, '--url', url, '--quiet', '--junit', junit, '--json', junit + '.json'])
    let out = ''; p.stdout.on('data', (d) => { out += d }); p.stderr.on('data', (d) => { out += d })
    p.on('close', (code) => resolve({ code, out }))
  })
  const g = await run(good, join(dir, 'good.xml'))
  assert.equal(g.code, 0, g.out); assert.match(g.out, /RESULT: CONFORMANT/)
  assert.match(readFileSync(join(dir, 'good.xml'), 'utf8'), /<testsuites name="tapeapi-relay-conformance" tests="\d+" failures="0">/)
  assert.equal(JSON.parse(readFileSync(join(dir, 'good.xml.json'), 'utf8')).summary.conformant, true)
  const b = await run(bad, join(dir, 'bad.xml'))
  assert.equal(b.code, 1, b.out); assert.match(b.out, /FAIL  MUST   tap26\.relay\.epoch\.mismatch-resets/)
  assert.match(readFileSync(join(dir, 'bad.xml'), 'utf8'), /<failure type="MUST"/)
  assert.equal(spawnSync(process.execPath, [RELAY]).status, 2) // no --url: usage error / 缺 --url：用法错误
})
