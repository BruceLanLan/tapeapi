// GOLDEN TAP10-0: the default mode, request by request. Recorded BEFORE the TAP-10 conformance mode (1.4) was started, on a
// fixed, deterministic fake chain and a fixed clock: for each resolution below, every JSON-RPC request the client sent
// (node, batch or not, method and params; never the JSON-RPC id) and what the caller got back (the service, or the error's
// code, message and data). The conformance mode is an opt-in (createTapeAPI({ conform: 'tap10' })); without it, 1.x must
// send the same requests, in the same order, and return the same results and errors, byte for byte. The one change to the
// default mode that 1.4 allows, the TAP-10 §3.1 name ranges (#ID <= 10^18, processor <= 10^9), is deliberately NOT in
// here (no name in this file is out of range): it has its own tests.
// Regenerate only on purpose: UPDATE_GOLDEN=1 node --test sdk/test/default-mode-trace.test.mjs (and say why in the commit).
// 黄金测试 TAP10-0：默认模式逐个请求。在动工做 TAP-10 一致模式（1.4）之前，用固定、确定性的假链与固定时钟录制：下面每次解析，
// 客户端发出的每个 JSON-RPC 请求（节点、是否批量、方法与参数；不含 JSON-RPC id），以及调用方拿到的结果（服务对象，或错误的
// code、message、data）。一致模式需显式开启；不开时，1.x 必须逐字节发出同样的请求、同样的顺序，返回同样的结果与错误。1.4 唯一
// 允许改变的默认行为——TAP-10 §3.1 的名字范围——刻意不放进来（本文件里没有超范围的名字），另有单独的测试。
// 只在有意时重新生成：UPDATE_GOLDEN=1 node --test sdk/test/default-mode-trace.test.mjs（并在提交信息里说明原因）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createTapeAPI, MANIFEST_KEY, CHANNEL_KEYS_KEY, MAINNET, CHAINS, security, channel, sig, canonicalJSON, TapeAPIError } from '../src/index.js'
import { createFakeChain, ADDR } from './helpers/fake-chain.mjs'

const FIXTURE = fileURLToPath(new URL('./fixtures/default-mode-trace.json', import.meta.url))
const T = 1_790_000_000                       // the fixed clock (2026-09-21T14:13:20Z) / 固定时钟
const clock = () => T
const RPC = ['http://rpc1', 'http://rpc2', 'http://rpc3']
const HOLDER_KEY = '0x' + '11'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32), OTHER_KEY = '0x' + '33'.repeat(32)
const holder = sig.privateKeyToAddress(HOLDER_KEY), signer = sig.privateKeyToAddress(SIGNER_KEY)
const EXPIRES = T + 30 * 86_400

function manifestFor({ chainId = 56, hub = ADDR.hub, container = ADDR.container, circuits = ADDR.circuits, tokenId = '4246', key = HOLDER_KEY } = {}) {
  return {
    tapeapi: '0.1', name: 'Golden', circuits, tokenId, container, signer,
    delegation: { expires: EXPIRES, sig: sig.signDigest(sig.delegationDigest(chainId, hub, { container, signer, expires: EXPIRES }), key) },
    endpoints: { live: ['https://api.example.com/tapeapi/v1'], async: false },
    methods: [{ name: 'ping', priceBEM: '0', params: {}, returns: {} }],
  }
}
// A full, valid service on the fake chain / 假链上一个完整有效的服务
function service(chain, { container = ADDR.container, tokenId = 4246, ...m } = {}) {
  chain.setOwner(tokenId, holder); chain.setAccount(tokenId, container); chain.setContainerToken(container, { tokenId, chainId: m.chainId ?? 56 })
  chain.writeFile(container, MANIFEST_KEY, JSON.stringify(manifestFor({ container, tokenId: String(tokenId), ...m })))
  return chain
}
function world(chainOpts) {
  const chain = createFakeChain(chainOpts)
  chain.state.headTime = T
  const log = []
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    log.push({ url, batch: Array.isArray(body), calls: (Array.isArray(body) ? body : [body]).map((r) => ({ method: r.method, params: r.params })) })
    return chain.fetch(url, init)
  }
  return { chain, log, fetch }
}
const base = (fetch, o = {}) => ({ rpcUrls: RPC, quorum: 2, fetch, clock, quiet: true, onWarning: () => {}, ...o })
const fake = (fetch, o = {}) => createTapeAPI(base(fetch, { hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, factory: ADDR.factory, ...o }))
const json = (x) => JSON.parse(JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? `${v}n` : v)))
async function outcome(p) {
  try { return { ok: json(await p) } } catch (e) {
    if (!(e instanceof TapeAPIError)) throw e
    return { error: { code: e.code, message: e.message, ...(e.data !== undefined ? { data: json(e.data) } : {}) } }
  }
}
// One step: run `fn`, keep the requests it sent and its outcome / 一步：运行 fn，记下它发出的请求与结果
async function step(w, fn) { const from = w.log.length; const out = await outcome(fn()); return { requests: w.log.slice(from), ...out } }

// The mainnet configuration of chain 56 (real addresses): the sentinel reads the hub and SiteRegistry slots and derives the
// container locally. / 链 56 的主网配置（真实地址）：哨兵读 hub 与 SiteRegistry 的实现槽，并在本地推导容器。
const mainnetContainer = () => security.erc6551Account({ registry: CHAINS[56].erc6551Registry, implementation: CHAINS[56].accountImplementation, chainId: 56, tokenContract: ADDR.circuits, tokenId: 4246 })
const fixedRandom = (seed) => (n) => Uint8Array.from({ length: n }, (_, i) => (seed * 31 + i * 7) & 0xff)

const SCENARIOS = {
  'name: a valid service, cold then warm on the same client': async () => {
    const w = world(); service(w.chain); const api = fake(w.fetch)
    return [await step(w, () => api.resolve('4246.7.tape')), await step(w, () => api.resolve('4246.7'))]
  },
  'pair { circuits, tokenId }': async () => {
    const w = world(); service(w.chain); const api = fake(w.fetch)
    return [await step(w, () => api.resolve({ circuits: ADDR.circuits, tokenId: 4246 }))]
  },
  'container address, and { chainId, container }': async () => {
    const w = world(); service(w.chain); const api = fake(w.fetch)
    return [await step(w, () => api.resolve(ADDR.container)), await step(w, () => api.resolve({ chainId: 56, container: ADDR.container }))]
  },
  'directory label, registered and not; label without a directory': async () => {
    const w = world(); service(w.chain); w.chain.register({ label: 'golden', container: ADDR.container, tokenId: 4246 })
    const api = fake(w.fetch, { directory: ADDR.directory })
    const bare = fake(w.fetch)
    return [await step(w, () => api.resolve('golden')), await step(w, () => api.resolve('nobody')), await step(w, () => bare.resolve('golden'))]
  },
  'spellings TAP-10 accepts but the default mode refuses or reads as a label': async () => {
    const w = world(); service(w.chain); const api = fake(w.fetch); const withDir = fake(w.fetch, { directory: ADDR.directory })
    const out = []
    for (const s of ['#4246@7', '4246@7', 'tape://4246.7.tape/', 'web+tape://4246.7/', '4246.7.TAPE', `${ADDR.circuits}#4246`, '4246', ' 4246.7.tape ']) out.push(await step(w, () => api.resolve(s)))
    out.push(await step(w, () => withDir.resolve('4246')))
    return out
  },
  'input errors and no-such-cpu': async () => {
    const w = world(); service(w.chain); const api = fake(w.fetch)
    const out = []
    for (const s of ['04246.7', '0.7.tape', '1.0.5', '1.4.5', '1.999999', '4246.8.tape']) out.push(await step(w, () => api.resolve(s)))
    out.push(await step(w, () => api.resolve(42)))
    return out
  },
  'missing manifest, token with no owner, counterfeit processor, wrong delegation': async () => {
    const out = []
    { const w = world(); w.chain.setAccount(4246, ADDR.container); w.chain.setOwner(4246, holder); out.push(await step(w, () => fake(w.fetch).resolve('4246.7.tape'))) }
    { const w = world(); service(w.chain); w.chain.state.owners.delete('4246'); out.push(await step(w, () => fake(w.fetch).resolve('4246.7.tape'))) }
    { const w = world(); service(w.chain); w.chain.setCounterfeit(ADDR.circuits); out.push(await step(w, () => fake(w.fetch).resolve({ circuits: ADDR.circuits, tokenId: 4246 }))) }
    { const w = world(); service(w.chain, { key: OTHER_KEY }); out.push(await step(w, () => fake(w.fetch).resolve('4246.7.tape'))) }
    { const w = world(); service(w.chain); w.chain.setFileInfo(ADDR.container, MANIFEST_KEY, { size: 10 }); out.push(await step(w, () => fake(w.fetch).resolve('4246.7.tape'))) }
    return out
  },
  'node faults: one node down, one node disagreeing': async () => {
    const out = []
    { const w = world(); service(w.chain); w.chain.setFault('http://rpc3', 'http500'); out.push(await step(w, () => fake(w.fetch).resolve('4246.7.tape'))) }
    { const w = world(); service(w.chain); w.chain.setFault('http://rpc2', 'rpcerror'); out.push(await step(w, () => fake(w.fetch).resolve('4246.7.tape'))) }
    return out
  },
  'mainnet addresses: sentinel warn and strict, a pinned client': async () => {
    const out = []
    const c = mainnetContainer()
    const mk = (w, o) => createTapeAPI(base(w.fetch, o))
    { const w = world(); service(w.chain, { container: c, hub: MAINNET.hub }); out.push(await step(w, () => mk(w).resolve('4246.7.tape'))) }
    { const w = world(); service(w.chain, { container: c, hub: MAINNET.hub }); w.chain.setImplementation(CHAINS[56].siteRegistry, '0x' + 'ab'.repeat(20)); out.push(await step(w, () => mk(w).resolve('4246.7.tape'))); out.push(await step(w, () => mk(w, { sentinel: 'strict' }).resolve('4246.7.tape'))) }
    { const w = world(); service(w.chain, { container: c, hub: MAINNET.hub }); out.push(await step(w, () => mk(w, { pin: true }).resolve('4246.7.tape'))) }
    { const w = world(); service(w.chain, { container: c, hub: MAINNET.hub }); out.push(await step(w, () => mk(w, { pin: { by: 'number', tag: 'latest' }, sentinel: 'off' }).resolve(c))) }
    return out
  },
  'another chain: a Base name through the forChain sub-client': async () => {
    const out = []
    const w = world({ chainId: 8453, addr: { ...ADDR, factory: CHAINS[8453].factory } })
    service(w.chain, { chainId: 8453, hub: MAINNET.hub })
    const api = createTapeAPI(base(w.fetch, { rpcUrls: ['http://rpc9', 'http://rpc8'], chains: { 8453: { rpcUrls: RPC } } }))
    out.push(await step(w, () => api.resolve('4246.3.7.tape')))
    out.push(await step(w, () => api.forChain(8453).resolve({ circuits: ADDR.circuits, tokenId: 4246 })))
    return out
  },
  'messaging reads 1.4 leaves alone: channelKeys and tapeSendKey': async () => {
    const out = []
    const w = world(); service(w.chain)
    const id = channel.generateIdentity(fixedRandom(5))
    const hex = (b) => '0x' + Buffer.from(b).toString('hex')
    const keys = { container: ADDR.container, x25519: hex(id.x25519.publicKey), ed25519: hex(id.ed25519.publicKey), inbox: {}, issued: T - 60, expires: T + 30 * 86_400 }
    w.chain.writeFile(ADDR.container, CHANNEL_KEYS_KEY, canonicalJSON({ tapechannel: '1', chainId: 56, ...keys, sig: sig.signDigest(sig.channelKeysDigest(56, ADDR.hub, keys), HOLDER_KEY) }))
    w.chain.setTapeSendKey(ADDR.container, { tokenId: 4246, key: '0x' + '5a'.repeat(32), holder })
    const api = fake(w.fetch)
    out.push(await step(w, () => api.chain.channelKeys(ADDR.container)))
    out.push(await step(w, () => api.chain.tapeSendKey(ADDR.container)))
    out.push(await step(w, () => api.chain.tapeSendKey({ circuits: ADDR.circuits, tokenId: 4246 })))
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
  writeFileSync(FIXTURE, JSON.stringify({ about: 'GOLDEN TAP10-0: default-mode requests and results, recorded before the TAP-10 conformance mode. See sdk/test/default-mode-trace.test.mjs.', clock: T, scenarios: now }, null, 1) + '\n')
}
const golden = JSON.parse(readFileSync(FIXTURE, 'utf8'))

test('GOLDEN TAP10-0: the fixture covers every scenario, each with requests and an outcome', () => {
  assert.equal(golden.clock, T)
  assert.deepEqual(Object.keys(golden.scenarios), Object.keys(SCENARIOS))
  const steps = Object.values(golden.scenarios).flat()
  assert.ok(steps.length >= 40, `${steps.length} resolutions`)
  assert.ok(steps.every((s) => ('ok' in s) !== ('error' in s)))
  assert.ok(steps.filter((s) => s.ok).length >= 15 && steps.filter((s) => s.error).length >= 15)
})

for (const name of Object.keys(SCENARIOS)) {
  test(`GOLDEN TAP10-0: ${name}: the same requests in the same order, the same results and errors`, () => {
    const want = golden.scenarios[name], got = now[name]
    assert.equal(got.length, want.length)
    got.forEach((s, i) => {
      assert.deepEqual(s.requests, want[i].requests, `step ${i}: requests`)
      assert.deepEqual({ ...s, requests: undefined }, { ...want[i], requests: undefined }, `step ${i}: outcome`)
    })
  })
}
