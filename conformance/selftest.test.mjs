// Self-test of the conformance suite: the reference provider must pass every MUST, and deliberately broken
// providers must fail, each on the check that names its defect.
// 一致性套件的自测：参考提供者须通过全部 MUST；故意做坏的提供者必须失败，且失败在点名其缺陷的那一项上。
//
//   node --test conformance/selftest.test.mjs
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProvider } from '../server/src/index.js'
import { createFakeChain, ADDR } from '../sdk/test/helpers/fake-chain.mjs'
import { privateKeyToAddress, signDigest, delegationDigest, signResponse, personalDigest, keccak256 } from '../sdk/src/sig.js'
import { concatBytes, utf8ToBytes, hexToBytes } from '../sdk/src/abi.js'
import { parseUnits } from '../sdk/src/manifest.js'
import { runSuite, failed, formatText } from './run.mjs'

const RUN = fileURLToPath(new URL('./run.mjs', import.meta.url))
const SIGNER_KEY = '0x' + '22'.repeat(32), CONSUMER_KEY = '0x' + '33'.repeat(32), SESSION_KEY = '0x' + '44'.repeat(32), HOLDER_KEY = '0x' + '11'.repeat(32)
const WRONG_KEY = '0x' + '77'.repeat(32)
const signer = privateKeyToAddress(SIGNER_KEY), consumer = privateKeyToAddress(CONSUMER_KEY), sessionAddr = privateKeyToAddress(SESSION_KEY)
const RPC = ['http://rpc1', 'http://rpc2']
const nowS = () => Math.floor(Date.now() / 1000)
const PAID = { paidMethod: 'circuitHolder', consumerKey: CONSUMER_KEY, sessionKey: SESSION_KEY }

let chain, manifest
const servers = []

function mkProvider(extra = {}) {
  return createProvider({
    manifest, signerKey: SIGNER_KEY, rpcUrls: RPC, quorum: 2, chainId: 56, fetch: chain.fetch, escrowCacheMs: 0, allowHttp: true,
    minVoucherLifeS: 300, rateLimit: false,
    methods: {
      blockNumber: async (_p, ctx) => ({ blockNumber: ctx.block }),
      circuitHolder: async (_p, ctx) => ({ holder: '0x' + '99'.repeat(20), consumer: ctx.consumer }),
    },
    ...extra,
  })
}
// The deployed Node entry point, exactly as an operator runs it. / 与运营方部署时完全相同的 Node 入口。
async function serveNative(provider) {
  const srv = await provider.listen(0)
  servers.push(() => provider.close())
  return `http://127.0.0.1:${srv.address().port}`
}
// A provider whose responses pass through `transform` before leaving: the way to build a broken provider
// out of a correct one. / 响应离开前经过 `transform` 的提供者：用正确的实现构造坏的实现。
async function serveWrapped(provider, transform) {
  const srv = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const raw = Buffer.concat(chunks).toString('utf8')
    const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
    const request = new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers, body: hasBody ? raw : undefined })
    const resp = await provider.handleRequest(request, { clientIp: '127.0.0.1' })
    const text = await resp.text()
    let obj; try { obj = JSON.parse(text) } catch { obj = undefined }
    let reqBody; try { reqBody = safeParseJSON(raw) } catch { reqBody = undefined } // what the provider parsed / 提供者解析到的内容
    const pathMethod = new URL(req.url, 'http://x').pathname.split('/').pop()
    const out = transform({ status: resp.status, headers: Object.fromEntries(resp.headers), obj, reqBody, pathMethod }) || {}
    const status = out.status ?? resp.status, headers = out.headers ?? Object.fromEntries(resp.headers)
    const body = out.obj !== undefined ? JSON.stringify(out.obj) : text
    delete headers['content-length']
    res.writeHead(status, headers); res.end(status === 204 ? undefined : body)
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  servers.push(() => new Promise((r) => srv.close(() => r())))
  return `http://127.0.0.1:${srv.address().port}`
}
// Re-sign an envelope for the request that produced it (id from the envelope, params from the request).
// 为产生它的请求重签信封（id 取自信封，params 取自请求）。
const reSign = (env, reqBody, pathMethod, key, overrides = {}) => {
  const e = { ...env, ...overrides }
  const params = reqBody && typeof reqBody.params === 'object' && reqBody.params !== null && !Array.isArray(reqBody.params) ? reqBody.params : {}
  e.sig = signResponse({ container: e.container, id: e.id, method: pathMethod, params, ok: e.ok, body: e.ok ? e.result : e.error, ts: e.ts }, key)
  return e
}

before(async () => {
  chain = createFakeChain()
  chain.setChannel(consumer, ADDR.container, parseUnits('0.001'))
  chain.setSession(consumer, ADDR.container, sessionAddr, nowS() + 20 * 86400)
  const expires = nowS() + 300 * 86400
  manifest = {
    tapeapi: '0.1', name: 'Conformance', circuits: ADDR.circuits, tokenId: '4246', container: ADDR.container, signer,
    delegation: { expires, sig: signDigest(delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires }), HOLDER_KEY) },
    endpoints: { live: ['http://127.0.0.1/tapeapi/v1'], async: false },
    methods: [
      { name: 'blockNumber', priceBEM: '0', params: {}, returns: { blockNumber: 'number' } },
      { name: 'circuitHolder', priceBEM: '0.0001', params: { circuits: 'address', tokenId: 'string' }, returns: { holder: 'address' } },
    ],
    payment: { escrow: ADDR.escrow, unit: 'BEM', decimals: 8 },
  }
})
after(async () => { for (const close of servers) await close() })

const mustFails = (results) => results.filter(r => r.level === 'MUST' && r.status === 'fail')
const show = (results) => formatText(results.filter(r => r.status !== 'pass'), { must: {}, should: {} }).split('\nMUST:')[0]

test('reference provider (native listen(), paid + rate-limit checks) passes every MUST', async () => {
  const base = await serveNative(mkProvider({ rateLimit: { free: 40, windowMs: 60_000 } }))
  const { results, summary } = await runSuite({ url: base, ...PAID, checkRateLimit: 40 })
  assert.deepEqual(mustFails(results), [], show(results))
  assert.equal(summary.conformant, true)
  // The checks that matter actually ran, rather than being skipped. / 关键检查确实执行了，而非被跳过。
  for (const id of ['tap21.envelope.sig-recovers', 'tap21.canon.request-hash', 'tap21.tamper.ok-flip', 'tap21.tamper.body', 'tap21.method-not-found',
    'tap21.request.malformed-json', 'tap21.request.duplicate-key', 'tap21.request.proto-key', 'tap22.payment-required', 'tap22.payment-required.data.price',
    'tap22.payment-required.price-matches-manifest', 'tap22.bad-voucher.data.price.non-stale',
    'tap22.bad-voucher.data.lastCumulative', 'tap22.bad-voucher.data.onChainClaimed', 'tap22.bad-voucher.data.price', 'tap22.bad-voucher.minVoucherLifeS',
    'tap21.ratelimit.unsigned', 'tap21.ratelimit.retry-after', 'tap21.ratelimit.code']) {
    assert.ok(results.some(r => r.id === id && r.status === 'pass'), `${id} did not pass:\n${show(results.filter(r => r.id === id))}`)
  }
  // Both stale-voucher shapes were exercised: cumulative 0 and lastCumulative + price − 1.
  assert.ok(results.some(r => r.id === 'tap22.bad-voucher.data.price' && /last\+price-1/.test(r.context) && r.status === 'pass'))
  // Record the SHOULD-level observations for the report. / 记录 SHOULD 级别的观察结果，供报告使用。
  const shouldFails = results.filter(r => r.level === 'SHOULD' && r.status === 'fail').map(r => `${r.id} [${r.context}] ${r.message}`)
  console.log('# reference SHOULD failures (native listen()):\n# ' + (shouldFails.join('\n# ') || '(none)'))
})

test('reference provider via its Fetch-API entry (handleRequest) passes every MUST', async () => {
  const base = await serveWrapped(mkProvider(), () => null)
  const { results } = await runSuite({ url: base, ...PAID })
  assert.deepEqual(mustFails(results), [], show(results))
  const shouldFails = results.filter(r => r.level === 'SHOULD' && r.status === 'fail').map(r => `${r.id} [${r.context}] ${r.message}`)
  console.log('# reference SHOULD failures (handleRequest):\n# ' + (shouldFails.join('\n# ') || '(none)'))
})

test('BROKEN: signs with the wrong key -> tap21.envelope.sig-recovers fails', async () => {
  const base = await serveWrapped(mkProvider(), ({ obj, reqBody, pathMethod }) =>
    obj && typeof obj.sig === 'string' ? { obj: reSign(obj, reqBody, pathMethod, WRONG_KEY) } : null)
  const { results, summary } = await runSuite({ url: base, ...PAID })
  assert.equal(summary.conformant, false)
  assert.ok(failed(results, 'tap21.envelope.sig-recovers').length > 0)
  assert.equal(failed(results, 'tap21.envelope.id-echo').length, 0)      // only the signature is wrong / 只有签名错
  assert.equal(failed(results, 'tap21.envelope.container').length, 0)
})

test('BROKEN: signs its 429 -> tap21.ratelimit.unsigned fails (Retry-After and code still pass)', async () => {
  const base = await serveWrapped(mkProvider({ rateLimit: { free: 30, windowMs: 60_000 } }), ({ status, obj }) =>
    status === 429 ? { obj: { ...obj, sig: '0x' + 'ab'.repeat(65) } } : null)
  const { results, summary } = await runSuite({ url: base, checkRateLimit: 30 })
  assert.equal(summary.conformant, false)
  assert.equal(failed(results, 'tap21.ratelimit.unsigned').length, 1, show(results))
  assert.ok(results.some(r => r.id === 'tap21.ratelimit.retry-after' && r.status === 'pass'))
  assert.ok(results.some(r => r.id === 'tap21.ratelimit.code' && r.status === 'pass'))
  assert.deepEqual(mustFails(results).map(r => r.id), ['tap21.ratelimit.unsigned'])
})

test('BROKEN: BAD_VOUCHER without data.price (correctly re-signed) -> tap22.bad-voucher.data.price fails', async () => {
  const base = await serveWrapped(mkProvider(), ({ obj, reqBody, pathMethod }) => {
    if (obj?.error?.code !== 'BAD_VOUCHER' || !obj.error.data) return null
    const error = { ...obj.error, data: { ...obj.error.data } }
    delete error.data.price
    return { obj: reSign({ ...obj, error }, reqBody, pathMethod, SIGNER_KEY) }
  })
  const { results, summary } = await runSuite({ url: base, ...PAID })
  assert.equal(summary.conformant, false)
  assert.ok(failed(results, 'tap22.bad-voucher.data.price').length > 0)
  assert.equal(failed(results, 'tap21.envelope.sig-recovers').length, 0) // the envelope itself is valid / 信封本身有效
  assert.equal(failed(results, 'tap22.bad-voucher.data.lastCumulative').length, 0)
  assert.deepEqual([...new Set(mustFails(results).map(r => r.id))].sort(), ['tap22.bad-voucher.data.price', 'tap22.bad-voucher.data.price.non-stale'])
})

test('BROKEN: PAYMENT_REQUIRED quoting data.price in BEM units ("0.0001") -> tap22.payment-required.data.price fails', async () => {
  const base = await serveWrapped(mkProvider(), ({ obj, reqBody, pathMethod }) => {
    if (obj?.error?.code !== 'PAYMENT_REQUIRED') return null
    return { obj: reSign({ ...obj, error: { ...obj.error, data: { price: '0.0001' } } }, reqBody, pathMethod, SIGNER_KEY) }
  })
  const { results, summary } = await runSuite({ url: base, ...PAID })
  assert.equal(summary.conformant, false)
  assert.deepEqual([...new Set(mustFails(results).map(r => r.id))], ['tap22.payment-required.data.price'])
})

test('HOSTILE: inflated, unproven lastCumulative -> the suite refuses to sign above 0 (TAP-22 §3.2 drain)', async () => {
  const seen = []
  const base = await serveWrapped(mkProvider(), ({ obj, reqBody, pathMethod }) => {
    if (reqBody?.voucher) seen.push(BigInt(reqBody.voucher.cumulative))
    if (obj?.error?.code !== 'BAD_VOUCHER' || obj.error.data?.lastCumulative === undefined) return null
    const { voucher, ...data } = obj.error.data
    return { obj: reSign({ ...obj, error: { ...obj.error, data: { ...data, lastCumulative: '999999999999' } } }, reqBody, pathMethod, SIGNER_KEY) }
  })
  const { results } = await runSuite({ url: base, ...PAID })
  assert.ok(seen.length > 0)
  assert.deepEqual([...new Set(seen)], [0n], 'only cumulative-0 vouchers may be signed for an unproven figure')
  assert.ok(results.some(r => r.id === 'tap22.bad-voucher.below-last-plus-price' && r.status === 'skip'), show(results))
})

test('BROKEN: hashes the request with JSON.stringify instead of JCS -> tap21.canon.request-hash fails, nothing else', async () => {
  // v2 digest with a non-canonical request hash; body hash stays canonical. / 请求哈希不规范的 v2 摘要。
  const badDigest = (e, method, params) => keccak256(concatBytes(
    utf8ToBytes('TAPI-1/resp/v2'), hexToBytes(e.container), keccak256(utf8ToBytes(e.id)),
    keccak256(utf8ToBytes(JSON.stringify({ method, params }))), new Uint8Array([e.ok ? 1 : 0]),
    keccak256(utf8ToBytes(canonical(e.ok ? e.result : e.error))), u64(e.ts)))
  const base = await serveWrapped(mkProvider(), ({ obj, reqBody, pathMethod }) => {
    if (!obj || typeof obj.sig !== 'string') return null
    const params = reqBody?.params && typeof reqBody.params === 'object' && !Array.isArray(reqBody.params) ? reqBody.params : {}
    return { obj: { ...obj, sig: signDigest(personalDigest(badDigest(obj, pathMethod, params)), SIGNER_KEY) } }
  })
  const { results } = await runSuite({ url: base, ...PAID })
  assert.deepEqual([...new Set(mustFails(results).map(r => r.id))], ['tap21.canon.request-hash'], show(results))
})

test('BROKEN: clock 1000 s behind (validly signed) -> tap21.envelope.ts-window fails', async () => {
  const base = await serveWrapped(mkProvider(), ({ obj, reqBody, pathMethod }) =>
    obj && typeof obj.sig === 'string' ? { obj: reSign(obj, reqBody, pathMethod, SIGNER_KEY, { ts: obj.ts - 1000 }) } : null)
  const { results } = await runSuite({ url: base })
  assert.deepEqual([...new Set(mustFails(results).map(r => r.id))], ['tap21.envelope.ts-window'], show(results))
})

test('BROKEN: METHOD_NOT_FOUND answered as a signed ok:true -> tap21.method-not-found fails', async () => {
  const base = await serveWrapped(mkProvider(), ({ obj, reqBody, pathMethod }) => {
    if (obj?.error?.code !== 'METHOD_NOT_FOUND') return null
    const { error, ...rest } = obj
    return { status: 200, obj: reSign({ ...rest, ok: true, result: { hello: 'world' } }, reqBody, pathMethod, SIGNER_KEY) }
  })
  const { results } = await runSuite({ url: base })
  assert.ok(failed(results, 'tap21.method-not-found').length === 1, show(results))
})

test('CLI: exit 0 + JUnit for a conformant provider, exit 1 for a broken one', async () => {
  const good = await serveNative(mkProvider())
  const bad = await serveWrapped(mkProvider(), ({ obj, reqBody, pathMethod }) =>
    obj && typeof obj.sig === 'string' ? { obj: reSign(obj, reqBody, pathMethod, WRONG_KEY) } : null)
  const dir = mkdtempSync(join(tmpdir(), 'tapeapi-conf-'))
  const run = (url, junit) => new Promise((resolve) => {
    // spawnSync would block this process's event loop, and with it the in-process provider. / 同步子进程会阻塞本进程里的提供者。
    import('node:child_process').then(({ spawn }) => {
      const p = spawn(process.execPath, [RUN, '--url', url, '--quiet', '--junit', junit, '--paid-method', 'circuitHolder', '--consumer-key', CONSUMER_KEY, '--session-key', SESSION_KEY])
      let out = ''; p.stdout.on('data', (d) => { out += d }); p.stderr.on('data', (d) => { out += d })
      p.on('close', (code) => resolve({ code, out }))
    })
  })
  const g = await run(good, join(dir, 'good.xml'))
  assert.equal(g.code, 0, g.out); assert.match(g.out, /RESULT: CONFORMANT/)
  const gx = readFileSync(join(dir, 'good.xml'), 'utf8')
  assert.match(gx, /<testsuites name="tapeapi-conformance" tests="\d+" failures="0">/)
  const b = await run(bad, join(dir, 'bad.xml'))
  assert.equal(b.code, 1, b.out); assert.match(b.out, /FAIL  MUST   tap21\.envelope\.sig-recovers/)
  assert.match(readFileSync(join(dir, 'bad.xml'), 'utf8'), /<failure type="MUST"/)
  assert.equal(spawnSync(process.execPath, [RUN]).status, 2) // no --url: usage error / 缺 --url：用法错误
})

// Local helpers for the JSON.stringify-canon broken provider. / 供"JSON.stringify 规范化"坏实现使用的本地工具。
import { canonicalJSON as canonical, safeParseJSON } from '../sdk/src/canon.js'
function u64(n) { const b = new Uint8Array(8); let x = BigInt(n); for (let i = 7; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n } return b }
