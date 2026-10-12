// GOLDEN TAP10-2.0: the 2.0 default (the TAP-10 conformance mode, createTapeAPI() without `conform`), request by request.
// The same eleven scenarios as the conform: false golden test (default-mode-trace.test.mjs, GOLDEN TAP10-0), under the same
// names, on the conform chain (helpers/conform-chain.mjs: the fake chain plus the opener, the DomainBinding, the factory's
// cpuCount and per-node heads, at the TAP-10 addresses of each chain), with a fixed clock: for each step, every JSON-RPC
// request the client sent (node, batch or not, method and params; never the JSON-RPC id) and what the caller got back
// (the service, or the error's code, message and data). Every client here leaves `conform` out. A configuration the
// default refuses (a pin other than 'tap10', a directory label, a processor contract#ID without allChains) is recorded
// as the error it gets (with data.status, except the construction errors): that refusal is part of the 2.0 default. Both
// golden tests are kept from now on, commit by commit.
// Regenerate only on purpose: UPDATE_GOLDEN=1 node --test sdk/test/conform-default-trace.test.mjs (and say why in the commit).
// 黄金测试 TAP10-2.0：2.0 的默认（TAP-10 一致模式，不传 conform 的 createTapeAPI()）逐个请求。与 conform: false 的黄金测试
// （default-mode-trace.test.mjs，TAP10-0）同样 11 个场景、同样的名字，在 conform 假链上、固定时钟下录制：每一步客户端发出的每个
// JSON-RPC 请求与调用方拿到的结果。这里的客户端都不传 conform。默认拒绝的配置（'tap10' 以外的 pin、目录标签、不开 allChains 的
// 处理器合约#ID）按它得到的错误（带 data.status）记录：这种拒绝本身就是 2.0 默认的一部分。两份黄金测试此后每次提交都要保持。
// 只在有意时重新生成：UPDATE_GOLDEN=1 node --test sdk/test/conform-default-trace.test.mjs（并在提交信息里说明原因）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createTapeAPI, MANIFEST_KEY, CHANNEL_KEYS_KEY, MAINNET, CHAINS, channel, sig, canonicalJSON, TapeAPIError } from '../src/index.js'
import { createConformChain } from './helpers/conform-chain.mjs'
import { ADDR } from './helpers/fake-chain.mjs'

const FIXTURE = fileURLToPath(new URL('./fixtures/conform-default-trace.json', import.meta.url))
const T = 1_790_000_000                       // the fixed clock (2026-09-21T14:13:20Z), as in GOLDEN TAP10-0 / 固定时钟
const clock = () => T
const RPC = ['http://rpc1', 'http://rpc2', 'http://rpc3']
const HOLDER_KEY = '0x' + '11'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32), OTHER_KEY = '0x' + '33'.repeat(32)
const holder = sig.privateKeyToAddress(HOLDER_KEY), signer = sig.privateKeyToAddress(SIGNER_KEY)
const EXPIRES = T + 30 * 86_400

function manifestFor(c, { chainId = 56, key = HOLDER_KEY } = {}) {
  return {
    tapeapi: '0.1', name: 'Golden', circuits: c.circuits, tokenId: c.tokenId, container: c.container, signer,
    delegation: { expires: EXPIRES, sig: sig.signDigest(sig.delegationDigest(chainId, MAINNET.hub, { container: c.container, signer, expires: EXPIRES }), key) },
    endpoints: { live: ['https://api.example.com/tapeapi/v1'], async: false },
    methods: [{ name: 'ping', priceBEM: '0', params: {}, returns: {} }],
  }
}
// A full, valid TAP-10 service: #4246 of processor 7, opened by the opener, activated, holder, manifest
// 一个完整有效的 TAP-10 服务：7 号处理器 #4246，已开通、已激活、有持有人与清单
function world({ chainId = 56, manifest = true, key } = {}) {
  const chain = createConformChain({ chainId })
  chain.state.headTime = T
  const c = chain.circuit(4246, { holder })
  if (manifest) chain.writeFile(c.container, MANIFEST_KEY, JSON.stringify(manifestFor(c, { chainId, key })))
  const log = []
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    log.push({ url, batch: Array.isArray(body), calls: (Array.isArray(body) ? body : [body]).map((r) => ({ method: r.method, params: r.params })) })
    return chain.fetch(url, init)
  }
  return { chain, c, log, fetch }
}
// No `conform`: the 2.0 default / 不传 conform：2.0 的默认
const base = (fetch, o = {}) => ({ rpcUrls: RPC, quorum: 2, fetch, clock, quiet: true, onWarning: () => {}, ...o })
const def = (fetch, o = {}) => createTapeAPI(base(fetch, o))
const json = (x) => JSON.parse(JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? `${v}n` : v)))
async function outcome(p) {
  try { return { ok: json(await p) } } catch (e) {
    if (!(e instanceof TapeAPIError)) throw e
    return { error: { code: e.code, message: e.message, ...(e.data !== undefined ? { data: json(e.data) } : {}) } }
  }
}
// One step: run `fn` (async, so an error while making the client is an outcome too), keep its requests and its outcome
// 一步：运行 fn（异步，建客户端时的错误也算结果），记下它发出的请求与结果
async function step(w, fn) { const from = w.log.length; const out = await outcome((async () => fn())()); return { requests: w.log.slice(from), ...out } }
const fixedRandom = (seed) => (n) => Uint8Array.from({ length: n }, (_, i) => (seed * 31 + i * 7) & 0xff)

const SCENARIOS = {
  'name: a valid service, cold then warm on the same client': async () => {
    const w = world(); const api = def(w.fetch)
    return [await step(w, () => api.resolve('4246.7.tape')), await step(w, () => api.resolve('4246.7'))]
  },
  'pair { circuits, tokenId }': async () => {
    const w = world(); const api = def(w.fetch)
    return [await step(w, () => api.resolve({ circuits: w.c.circuits, tokenId: 4246 }))]
  },
  'container address, and { chainId, container }': async () => {
    const w = world(); const api = def(w.fetch)
    return [await step(w, () => api.resolve(w.c.container)), await step(w, () => api.resolve({ chainId: 56, container: w.c.container }))]
  },
  'directory label, registered and not; label without a directory': async () => {
    const w = world(); w.chain.register({ label: 'golden', container: w.c.container, circuits: w.c.circuits, tokenId: 4246 })
    const api = def(w.fetch, { directory: ADDR.directory })
    const bare = def(w.fetch)
    return [await step(w, () => api.resolve('golden')), await step(w, () => api.resolve('nobody')), await step(w, () => bare.resolve('golden'))]
  },
  'spellings TAP-10 accepts but the default mode refuses or reads as a label': async () => {
    const w = world(); const api = def(w.fetch); const withDir = def(w.fetch, { directory: ADDR.directory })
    const out = []
    for (const s of ['#4246@7', '4246@7', 'tape://4246.7.tape/', 'web+tape://4246.7/', '4246.7.TAPE', `${w.c.circuits}#4246`, '4246', ' 4246.7.tape ']) out.push(await step(w, () => api.resolve(s)))
    out.push(await step(w, () => withDir.resolve('4246')))
    return out
  },
  'input errors and no-such-cpu': async () => {
    const w = world(); const api = def(w.fetch)
    const out = []
    for (const s of ['04246.7', '0.7.tape', '1.0.5', '1.4.5', '1.999999', '4246.8.tape']) out.push(await step(w, () => api.resolve(s)))
    out.push(await step(w, () => api.resolve(42)))
    return out
  },
  'missing manifest, token with no owner, counterfeit processor, wrong delegation': async () => {
    const out = []
    { const w = world({ manifest: false }); out.push(await step(w, () => def(w.fetch).resolve('4246.7.tape'))) }
    { const w = world(); w.chain.state.owners.delete('4246'); out.push(await step(w, () => def(w.fetch).resolve('4246.7.tape'))) }
    { const w = world(); w.chain.setCounterfeit(w.c.circuits); out.push(await step(w, () => def(w.fetch).resolve({ circuits: w.c.circuits, tokenId: 4246 }))) }
    { const w = world({ key: OTHER_KEY }); out.push(await step(w, () => def(w.fetch).resolve('4246.7.tape'))) }
    { const w = world(); w.chain.setFileInfo(w.c.container, MANIFEST_KEY, { size: 10 }); out.push(await step(w, () => def(w.fetch).resolve('4246.7.tape'))) }
    // 2.0 adds the site statuses: unactivated (unpaid) and not opened / 2.0 新增站点状态：未激活与未开通
    { const w = world(); w.chain.setUnactivated(); out.push(await step(w, () => def(w.fetch).resolve('4246.7.tape'))) }
    { const w = world(); w.chain.setOpened(w.c.circuits, 4246, false); out.push(await step(w, () => def(w.fetch).resolve('4246.7.tape'))) }
    return out
  },
  'node faults: one node down, one node disagreeing': async () => {
    const out = []
    { const w = world(); w.chain.setFault('http://rpc3', 'http500'); out.push(await step(w, () => def(w.fetch).resolve('4246.7.tape'))) }
    { const w = world(); w.chain.setFault('http://rpc2', 'rpcerror'); out.push(await step(w, () => def(w.fetch).resolve('4246.7.tape'))) }
    return out
  },
  'mainnet addresses: sentinel warn and strict, a pinned client': async () => {
    // The conform chain has the mainnet addresses throughout; the pins the 1.x scenario used are refused when the client is
    // made (D-2). / conform 假链全程是主网地址；1.x 场景用的钉块选项在建客户端时被拒（D-2）。
    const out = []
    { const w = world(); out.push(await step(w, () => def(w.fetch).resolve('4246.7.tape'))) }
    { const w = world(); w.chain.setImplementation(CHAINS[56].siteRegistry, '0x' + 'ab'.repeat(20)); out.push(await step(w, () => def(w.fetch).resolve('4246.7.tape'))); out.push(await step(w, () => def(w.fetch, { sentinel: 'strict' }).resolve('4246.7.tape'))) }
    { const w = world(); w.chain.setImplementation(MAINNET.hub, '0x' + 'ee'.repeat(20)); out.push(await step(w, () => def(w.fetch).resolve('4246.7.tape'))); out.push(await step(w, () => def(w.fetch, { sentinel: 'strict' }).resolve('4246.7.tape'))) }
    { const w = world(); out.push(await step(w, () => def(w.fetch, { pin: true }).resolve('4246.7.tape'))) }
    { const w = world(); out.push(await step(w, () => def(w.fetch, { pin: { by: 'number', tag: 'latest' }, sentinel: 'off' }).resolve(w.c.container))) }
    { const w = world(); out.push(await step(w, () => def(w.fetch, { pin: 'tap10', sentinel: 'off' }).resolve(w.c.container))) }
    return out
  },
  'another chain: a Base name through the forChain sub-client': async () => {
    const out = []
    const w = world({ chainId: 8453 })
    const api = createTapeAPI(base(w.fetch, { rpcUrls: ['http://rpc9', 'http://rpc8'], chains: { 8453: { rpcUrls: RPC } } }))
    out.push(await step(w, () => api.resolve('4246.3.7.tape')))
    out.push(await step(w, () => api.forChain(8453).resolve({ circuits: w.c.circuits, tokenId: 4246 })))
    return out
  },
  'messaging reads 1.4 leaves alone: channelKeys and tapeSendKey': async () => {
    const out = []
    const w = world()
    const id = channel.generateIdentity(fixedRandom(5))
    const hex = (b) => '0x' + Buffer.from(b).toString('hex')
    const keys = { container: w.c.container, x25519: hex(id.x25519.publicKey), ed25519: hex(id.ed25519.publicKey), inbox: {}, issued: T - 60, expires: T + 30 * 86_400 }
    w.chain.writeFile(w.c.container, CHANNEL_KEYS_KEY, canonicalJSON({ tapechannel: '1', chainId: 56, ...keys, sig: sig.signDigest(sig.channelKeysDigest(56, MAINNET.hub, keys), HOLDER_KEY) }))
    w.chain.setTapeSendKey(w.c.container, { circuits: w.c.circuits, tokenId: 4246, key: '0x' + '5a'.repeat(32), holder })
    const api = def(w.fetch)
    out.push(await step(w, () => api.chain.channelKeys(w.c.container)))
    out.push(await step(w, () => api.chain.tapeSendKey(w.c.container)))
    out.push(await step(w, () => api.chain.tapeSendKey({ circuits: w.c.circuits, tokenId: 4246 })))
    // activation is a site rule only (TAP-10 §12.2): unactivated, the messaging reads go on / 激活只是站点规则：未激活时消息读取照常
    w.chain.setUnactivated()
    out.push(await step(w, () => api.chain.channelKeys(w.c.container, { fresh: true })))
    return out
  },
}

async function record() {
  const out = {}
  for (const [name, run] of Object.entries(SCENARIOS)) out[name] = await run()
  return out
}

const now = await record()
if (process.env.UPDATE_GOLDEN === '1') {
  writeFileSync(FIXTURE, JSON.stringify({ about: 'GOLDEN TAP10-2.0: the 2.0 default (the TAP-10 conformance mode, no conform option) on the conform chain: requests and results. See sdk/test/conform-default-trace.test.mjs.', clock: T, scenarios: now }, null, 1) + '\n')
}
const golden = JSON.parse(readFileSync(FIXTURE, 'utf8'))

test('GOLDEN TAP10-2.0: the fixture covers the eleven scenarios of GOLDEN TAP10-0, each step with requests and an outcome', () => {
  assert.equal(golden.clock, T)
  assert.deepEqual(Object.keys(golden.scenarios), Object.keys(SCENARIOS))
  const zero = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/default-mode-trace.json', import.meta.url)), 'utf8'))
  assert.deepEqual(Object.keys(golden.scenarios), Object.keys(zero.scenarios), 'the same scenarios, by name, as the conform: false golden test')
  const steps = Object.values(golden.scenarios).flat()
  assert.ok(steps.length >= 40, `${steps.length} steps`)
  assert.ok(steps.every((s) => ('ok' in s) !== ('error' in s)))
  assert.ok(steps.filter((s) => s.ok).length >= 10 && steps.filter((s) => s.error).length >= 15)
  // every error of a resolution or a read carries data.status (TAP-10 / TAP-11 outcome names); the only ones without it are
  // the construction errors (D-2: a pin other than 'tap10'), which say to pass conform: false and send nothing
  // 解析或读取的每个错误都带 data.status；不带的只有建客户端时的错误（D-2），它们写明传 conform: false、不发请求
  for (const s of steps.filter((x) => x.error)) {
    if (s.error.data?.status === undefined) { assert.equal(s.requests.length, 0); assert.match(s.error.message, /cannot be combined with another pin option.*pass conform: false/); continue }
    assert.equal(typeof s.error.data.status, 'string', `${s.error.code}: ${s.error.message}`)
  }
  assert.equal(steps.filter((x) => x.error && x.error.data?.status === undefined).length, 2)
})

for (const name of Object.keys(SCENARIOS)) {
  test(`GOLDEN TAP10-2.0: ${name}: the same requests in the same order, the same results and errors`, () => {
    const want = golden.scenarios[name], got = now[name]
    assert.equal(got.length, want.length)
    got.forEach((s, i) => {
      assert.deepEqual(s.requests, want[i].requests, `step ${i}: requests`)
      assert.deepEqual({ ...s, requests: undefined }, { ...want[i], requests: undefined }, `step ${i}: outcome`)
    })
  })
}
