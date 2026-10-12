// 2.0, item 1 of the 2.0 list: the TAP-10 conformance mode is the default of createTapeAPI()
// (design points D-1..D-6; docs/guides/upgrade-2.0.md). Offline, on the conform chain (helpers/conform-chain.mjs, the TAP-10 addresses).
//   default     conform left out = 'tap10'; dev: true = the 1.x resolution (D-1), no warning
//   D-6         conform: false / null = the 1.x resolution, deprecated: one onWarning (code DEPRECATED) per client, when it is
//               made; none from the clients the SDK makes itself (forChain); never an error, never another behaviour
//   D-1, D-2    under the default, a configuration that is not TAP-10's is INVALID_ARGUMENT when the client is made, and
//               the message says to pass conform: false; an explicit conform: 'tap10' gets the plain message
//   D-3         a directory label is refused by the default resolve, before any request
//   D-4         forChain passes the choice on, in both directions (also in conform-messaging.test.mjs)
//   D-5         the command lines take --no-conform; the doctor says which resolution it used, and under the default an
//               unactivated name fails activation (a 2.0 client answers unpaid) instead of only warning
// Each test here fails on the code before 87f6a6d (1.x default). GOLDEN TAP10-0 (default-mode-trace.test.mjs, conform:
// false) and GOLDEN TAP10-2.0 (conform-default-trace.test.mjs) pin the requests of both resolutions.
// 2.0 第 1 项：一致模式成为 createTapeAPI() 的默认。全部离线，在 conform 假链上。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createTapeAPI, MANIFEST_KEY, MAINNET, CHAINS, TapeAPIError, sig } from '../src/index.js'
import { diagnose, formatReport } from '../src/doctor.js'
import { createConformChain } from './helpers/conform-chain.mjs'
import { ADDR } from './helpers/fake-chain.mjs'

const T = 1_790_000_000
const RPC = ['http://rpc1', 'http://rpc2', 'http://rpc3']
const HOLDER_KEY = '0x' + '11'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32)
const holder = sig.privateKeyToAddress(HOLDER_KEY), signer = sig.privateKeyToAddress(SIGNER_KEY)
const EXPIRES = T + 30 * 86_400

function world() {
  const chain = createConformChain()
  chain.state.headTime = T
  const c = chain.circuit(4246, { holder })
  chain.setAccount(4246, c.container)   // the hub's derivation, read by the 1.x resolution / 1.x 解析读的 hub 推导
  chain.writeFile(c.container, MANIFEST_KEY, JSON.stringify({
    tapeapi: '0.1', name: 'Default', circuits: c.circuits, tokenId: c.tokenId, container: c.container, signer,
    delegation: { expires: EXPIRES, sig: sig.signDigest(sig.delegationDigest(56, MAINNET.hub, { container: c.container, signer, expires: EXPIRES }), HOLDER_KEY) },
    endpoints: { live: ['https://api.example.com/tapeapi/v1'], async: false },
    methods: [{ name: 'ping', priceBEM: '0', params: {}, returns: {} }],
  }))
  return { chain, c }
}
const mk = (chain, o = {}) => createTapeAPI({ rpcUrls: RPC, fetch: chain.fetch, clock: () => T, quiet: true, ...o })
const status = (code, st) => (e) => e instanceof TapeAPIError && e.code === code && e.data?.status === st
const hint = (re) => (e) => e instanceof TapeAPIError && e.code === 'INVALID_ARGUMENT' && re.test(e.message) && /pass conform: false/.test(e.message)

test('2.0 default: createTapeAPI() without conform resolves as TAP-10 / TAP-11 (activation read, data.status, svc.conform)', async () => {
  const { chain, c } = world()
  const warned = []
  const api = mk(chain, { onWarning: (w) => warned.push(w) })
  const svc = await api.resolve('4246.7.tape')
  assert.equal(svc.container, c.container)
  assert.equal(svc.conform?.status, 'resolved'); assert.equal(svc.pinned?.mode, 'tap10')
  for (const fn of ['isOpened', 'isLive', 'cpuCount']) assert.ok(chain.conform.log.some((x) => x.fn === fn), fn)
  chain.setUnactivated()
  await assert.rejects(mk(chain).resolve('4246.7.tape'), status('SITE_STATUS', 'unpaid'))
  assert.deepEqual(warned.filter((w) => w.code === 'DEPRECATED'), [], 'the default does not warn')
})

test('D-6: conform: false and null are the 1.x resolution, with one DEPRECATED warning per client when it is made; dev: true is the 1.x resolution without a warning', async () => {
  const { chain, c } = world()
  chain.setUnactivated()   // the 1.x resolution does not read activation / 1.x 解析不读激活
  for (const conform of [false, null]) {
    const warned = []
    const api = mk(chain, { conform, onWarning: (w) => warned.push(w), chains: { 8453: { rpcUrls: ['http://rpc8453-a', 'http://rpc8453-b'] } } })
    assert.equal(warned.length, 1, String(conform))
    assert.equal(warned[0].code, 'DEPRECATED'); assert.equal(warned[0].option, 'conform'); assert.match(warned[0].message, /deprecated in 2\.x/)
    const svc = await api.resolve('4246.7.tape')
    assert.equal(svc.container, c.container); assert.equal(svc.conform, undefined); assert.equal(svc.pinned, undefined)
    api.forChain(8453); api.forChain(196)
    assert.equal(warned.length, 1, 'resolve and the sub-clients the SDK makes do not warn again')
  }
  const warned = []
  const dev = mk(chain, { dev: true, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, factory: ADDR.factory, onWarning: (w) => warned.push(w) })
  assert.equal(warned.length, 0, 'dev: true is not deprecated')
  await assert.rejects(dev.resolve('4246.7.tape'))   // the fake chain's own hub has no service: only that it was made / 只验证能建立
  // a reporter that throws never breaks the client / 抛错的报告函数不影响客户端
  assert.doesNotThrow(() => mk(chain, { conform: false, onWarning: () => { throw new Error('x') } }))
  // only 'tap10', false, null or nothing / 只接受 'tap10'、false、null 或不传
  for (const v of [true, 0, '', 'TAP10', {}]) assert.throws(() => mk(chain, { conform: v }), (e) => e.code === 'INVALID_ARGUMENT' && /false \(the 1\.x resolution, deprecated\)/.test(e.message), String(v))
})

test('D-1, D-2: under the default a configuration that is not TAP-10\'s fails when the client is made, naming conform: false; conform: false takes it', () => {
  const { chain } = world()
  const own = '0x' + '12'.repeat(20)
  const cases = [
    [{ hub: ADDR.hub }, /DeWEB hub TAP-10 lists/], [{ factory: ADDR.factory }, /factory TAP-10 lists/], [{ siteRegistry: ADDR.siteRegistry }, /siteRegistry proxies TAP-10 lists/],
    [{ opener: own }, /opener TAP-10 lists/], [{ binding: own }, /binding proxies/],
    [{ chainId: 31337, factory: own }, /TAP-10 chain only \(56, 196, 8453\); chain 31337 has no TAP-10 lists/], [{ chainId: 97, factory: own }, /chain 97 has no TAP-10 lists/],
    [{ pin: 'latest' }, /cannot be combined/], [{ pin: true }, /cannot be combined/], [{ pin: false }, /cannot be combined/], [{ pin: { tag: 'finalized' } }, /cannot be combined/],
  ]
  for (const [o, re] of cases) {
    assert.throws(() => mk(chain, o), hint(re), JSON.stringify(o))
    assert.doesNotThrow(() => mk(chain, { ...o, conform: false, onWarning: () => {} }), JSON.stringify(o))
    // an explicit conform: 'tap10' was asked for: the plain message / 显式要求一致模式：不附加提示
    assert.throws(() => mk(chain, { ...o, conform: 'tap10' }), (e) => e.code === 'INVALID_ARGUMENT' && re.test(e.message) && !/pass conform: false/.test(e.message), JSON.stringify(o))
  }
  assert.doesNotThrow(() => mk(chain, { pin: 'tap10' }), "pin: 'tap10' is the default's own pin")
  // forChain: a chains[n] option that is not TAP-10's is refused on first use, with the hint / 子客户端同样附加提示
  const parent = mk(chain, { chains: { 8453: { hub: own } } })
  assert.throws(() => parent.forChain(8453), hint(/DeWEB hub TAP-10 lists for chain 8453/))
})

test('D-3: a directory label is refused by the default resolve before any request; conform: false still reads the directory', async () => {
  const { chain, c } = world()
  chain.register({ label: 'golden', container: c.container, circuits: c.circuits, tokenId: 4246 })
  const n = chain.conform.log.length
  await assert.rejects(mk(chain, { directory: ADDR.directory }).resolve('golden'), status('INVALID_ARGUMENT', 'input-error'))
  assert.equal(chain.conform.log.length, n, 'nothing sent')
  assert.equal((await mk(chain, { conform: false, onWarning: () => {}, directory: ADDR.directory }).resolve('golden')).container, c.container)
  assert.ok(chain.conform.log.some((x) => x.to === ADDR.directory.toLowerCase()), 'conform: false asked the directory')
})

test('D-4: forChain passes the default on (a conformance sub-client) and conform: false on (a 1.x sub-client)', async () => {
  const worlds = { 56: world(), 8453: (() => { const chain = createConformChain({ chainId: 8453 }); chain.state.headTime = T; return { chain, c: chain.circuit(4246, { holder }) } })() }
  const fetch = (url, init) => worlds[/rpc8453/.test(url) ? 8453 : 56].chain.fetch(url, init)
  const chains = { 8453: { rpcUrls: ['http://rpc8453-a', 'http://rpc8453-b', 'http://rpc8453-c'] } }
  const byDefault = createTapeAPI({ rpcUrls: RPC, fetch, clock: () => T, quiet: true, chains })
  await assert.rejects(byDefault.forChain(8453).resolve('4246.3.7.tape'), status('MANIFEST_INVALID', 'no-manifest'))
  assert.ok(worlds[8453].chain.conform.log.some((x) => x.fn === 'isOpened' && x.to === CHAINS[8453].opener.toLowerCase()), 'the Base sub-client reads the opener')
  const legacy = createTapeAPI({ conform: false, onWarning: () => {}, rpcUrls: RPC, fetch, clock: () => T, quiet: true, chains })
  const from = worlds[8453].chain.conform.log.length
  await assert.rejects(legacy.forChain(8453).resolve('4246.3.7.tape'), (e) => e instanceof TapeAPIError && e.data?.status === undefined)
  assert.ok(!worlds[8453].chain.conform.log.slice(from).some((x) => x.fn === 'isOpened'), 'the 1.x sub-client reads no opener')
})

test('D-5 doctor: under the default an unactivated name fails activation (resolution tap10) and the delegation is not checked twice; with conform: false it only warns (resolution 1.x)', async () => {
  const { chain } = world()
  chain.setCode(chain.containerOf(ADDR.circuits, 4246))
  chain.setUnactivated()
  const fetch = async () => { throw new Error('offline') }
  const strict = await diagnose('4246.7.tape', { api: mk(chain), fetch, now: () => T })
  const by = (rep, id) => rep.checks.find((x) => x.id === id)
  assert.equal(strict.resolution, 'tap10')
  assert.equal(by(strict, 'activation').status, 'fail', formatReport(strict, { lang: 'en' }))
  assert.match(by(strict, 'activation').detail, /Since 2\.0 this is a failure: the default client/)
  assert.match(by(strict, 'activation').detailZh, /自 2\.0 起这是失败/)
  assert.equal(by(strict, 'manifest-format').status, 'pass', 'the chain checks go on')
  assert.equal(by(strict, 'delegation').status, 'skip'); assert.match(by(strict, 'delegation').detail, /"activation" did not pass/)
  assert.equal(strict.exitCode, 1)
  assert.match(formatReport(strict, { lang: 'en' }), /^ {3}resolution: TAP-10 \/ TAP-11 \(the default since 2\.0; --no-conform for the 1\.x one\)$/m)
  const legacy = await diagnose('4246.7.tape', { api: mk(chain, { conform: false, onWarning: () => {} }), fetch, now: () => T })
  assert.equal(legacy.resolution, '1.x')
  assert.equal(by(legacy, 'activation').status, 'warn')
  assert.doesNotMatch(by(legacy, 'activation').detail, /Since 2\.0/)
  assert.equal(by(legacy, 'delegation').status, 'pass', formatReport(legacy, { lang: 'en' }))
  assert.match(formatReport(legacy, { lang: 'zh' }), /解析：1\.x（conform: false，已弃用）/)
  // activated but not opened: the delegation check says the site status, not a manifest problem / 已激活但未开通：委托项照实报站点状态
  const w2 = world()
  w2.chain.setCode(w2.chain.containerOf(ADDR.circuits, 4246))
  w2.chain.setOpened(ADDR.circuits, 4246, false)
  const closed = await diagnose('4246.7.tape', { api: mk(w2.chain), fetch, now: () => T })
  assert.equal(by(closed, 'activation').status, 'pass')
  assert.equal(by(closed, 'delegation').status, 'fail')
  assert.match(by(closed, 'delegation').detail, /^a 2\.0 client \(the default, TAP-10 \/ TAP-11\) refuses this service: not-opened: /)
  assert.match(by(closed, 'delegation').fix.en, /container opener/)
})

test('D-5: tapeapi-mcp, tapeapi-verify and tapeapi-doctor document --no-conform and accept it; mcp and verify say which resolution they use', () => {
  const bin = (n) => fileURLToPath(new URL(`../bin/${n}.js`, import.meta.url))
  for (const n of ['tapeapi-mcp', 'tapeapi-verify', 'tapeapi-doctor']) {
    const help = spawnSync(process.execPath, [bin(n), '--help'], { encoding: 'utf8' })
    assert.equal(help.status, 0, n); assert.match(help.stdout, /--no-conform +resolve as 1\.x did \(createTapeAPI\(\{ conform: false \}\), deprecated\)/, n)
    // accepted (not "unknown option"): with --help after it, the usage is printed and the exit status is 0
    // 被接受（不是"未知选项"）：后面跟 --help 时打印用法、退出码 0
    const r = spawnSync(process.execPath, [bin(n), '--no-conform', '--help'], { encoding: 'utf8' })
    assert.equal(r.status, 0, `${n}: ${r.stderr}`); assert.doesNotMatch(r.stderr, /unknown option/)
  }
  // tapeapi-mcp and tapeapi-verify say which resolution they use (stderr), before reading anything: nodes that refuse at once
  // tapeapi-mcp 与 tapeapi-verify 在读链之前说明所用的解析（stderr）；节点立即拒绝连接
  const dead = ['--rpc', 'http://127.0.0.1:9,http://localhost:9']
  for (const n of ['tapeapi-mcp', 'tapeapi-verify']) {
    const def = spawnSync(process.execPath, [bin(n), ...dead, '11.1013.tape'], { encoding: 'utf8', timeout: 8000 })
    assert.match(def.stderr, /resolution: TAP-10 \/ TAP-11 \(the default since 2\.0; --no-conform for the 1\.x one\)/, n)
    const old = spawnSync(process.execPath, [bin(n), ...dead, '--no-conform', '11.1013.tape'], { encoding: 'utf8', timeout: 8000 })
    assert.match(old.stderr, /resolution: 1\.x \(--no-conform: conform: false, deprecated\)/, n)
    assert.match(old.stderr, /DEPRECATED: conform: false is the 1\.x resolution/, `${n}: the SDK's warning`)
  }
})

test('D-6 hardening: the internal options are not reachable from createTapeAPI() options: a `_router` neither silences the DEPRECATED warning nor takes over forChain, and a `_rpc` is not taken', async () => {
  const { chain, c } = world()
  // Before: `_router: () => {}` switched the warning off and made forChain(n) return whatever the function did.
  const warned = []
  const hijack = { calls: 0 }
  const api = mk(chain, { conform: false, onWarning: (w) => warned.push(w), _router: (n) => { hijack.calls++; return { hijacked: n } }, _rpc: { ethCall: () => { throw new Error('a caller-supplied _rpc must not be used') } } })
  assert.equal(warned.filter((w) => w.code === 'DEPRECATED').length, 1, 'the warning is still reported')
  const sub = api.forChain(8453)
  assert.equal(hijack.calls, 0, 'forChain does not route through a caller-supplied _router')
  assert.notDeepEqual(sub, { hijacked: 8453 })
  assert.equal(typeof sub.resolve, 'function', 'forChain made a real sub-client')
  assert.equal(api.forChain(8453), sub, 'one client per chain, as before')
  // the client still reads through its own RPC client: a resolve reaches the chain and answers
  assert.equal((await api.resolve('4246.7.tape')).container, c.container)
  // and the sub-clients and siblings the SDK makes inside itself still do not warn again
  api.forChain(196)
  assert.equal(warned.filter((w) => w.code === 'DEPRECATED').length, 1)
  // a default client (conform 'tap10'): the conformance sibling is made by the SDK with its own router, which still refuses other chains
  const def = mk(chain, { _router: () => { throw new Error('a caller-supplied _router must not be used') } })
  assert.equal(typeof def.forChain(8453).resolve, 'function')
  assert.deepEqual(Object.getOwnPropertyNames(def).filter((k) => k.startsWith('_')), [], 'no underscore member on the client')
})
