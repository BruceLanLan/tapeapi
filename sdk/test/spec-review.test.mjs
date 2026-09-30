// Spec-vs-code disagreements found by the spec review (SD-n), client side and spec text. Each test failed before its
// fix. Where the SPEC was wrong, the test reads both halves of the spec (English is authoritative; the Chinese half
// must say the same). / 规范审查发现的规范与代码不一致（SD-n），客户端侧与规范文本。每条测试在修复前都失败。
// 规范有误的条目，测试同时读取规范的中英两半。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createTapeAPI, validateManifest, MANIFEST_KEY } from '../src/index.js'
import { readJsonBounded } from '../src/rpc.js'
import { relayTransport } from '../src/channel.js'
import { privateKeyToAddress, signDigest, delegationDigest } from '../src/sig.js'
import { createProvider } from '../../server/src/index.js'
import { createFakeChain, ADDR } from './helpers/fake-chain.mjs'

const HOLDER_KEY = '0x' + '11'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32)
const holder = privateKeyToAddress(HOLDER_KEY), signer = privateKeyToAddress(SIGNER_KEY)
const RPC = ['http://rpc1', 'http://rpc2']
const nowS = () => Math.floor(Date.now() / 1000)
const EXPIRES = nowS() + 300 * 86400
const ZERO = '0x' + '00'.repeat(20)

const delegation = (expires = EXPIRES, key = HOLDER_KEY) => ({ expires, sig: signDigest(delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires }), key) })
const manifestFor = (endpoints, extra = {}) => ({
  tapeapi: '0.1', name: 'SD', circuits: ADDR.circuits, tokenId: '4246', container: ADDR.container, signer,
  delegation: delegation(), endpoints: { live: endpoints, async: false },
  methods: [{ name: 'ping', priceBEM: '0', params: {}, returns: { v: 'number' } }], ...extra,
})

// A chain with the circuit, its container and a manifest; `routes` answers the service's endpoints by host.
// 一条带电路、容器与清单的链；`routes` 按主机回答服务端点。
function world({ manifest, owner = holder, routes = {}, directory } = {}) {
  const chain = createFakeChain()
  if (owner) chain.setOwner(4246, owner)
  chain.setAccount(4246, ADDR.container)
  chain.writeFile(ADDR.container, MANIFEST_KEY, JSON.stringify(manifest))
  const hits = []
  const fetch = async (url, init) => {
    const u = String(url)
    if (u.startsWith('http://rpc')) return chain.fetch(u, init)
    const host = new URL(u).host
    hits.push(host)
    if (!routes[host]) throw new TypeError(`fetch failed: ${host}`)
    return routes[host](u, init)
  }
  const api = createTapeAPI({ rpcUrls: RPC, quorum: 2, chainId: 56, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, allowHttp: true, fetch, ...(directory ? { directory } : {}) })
  return { chain, api, hits }
}
const provider = () => createProvider({
  manifest: manifestFor(['http://svc.test/tapeapi/v1']), signerKey: SIGNER_KEY, rpcUrls: RPC, quorum: 2, chainId: 56,
  fetch: createFakeChain().fetch, allowHttp: true, log: () => {}, rateLimit: false, methods: { ping: async () => ({ v: 1 }) },
})
const registryReads = (chain) => chain.state.calls.filter((c) => c.to.toLowerCase() === ADDR.siteRegistry.toLowerCase()).length

// Both halves of a spec, split where the Chinese translation starts. / 规范的两半，从中文译文标题处切开。
const spec = (n) => {
  const text = readFileSync(new URL(`../../spec/TAPI-${n}.md`, import.meta.url), 'utf8')
  const [en, zh] = text.split(new RegExp(`^# TAPI-${n}：`, 'm'))
  assert.ok(zh, `TAPI-${n} has a Chinese half`)
  return { en, zh }
}

test('FIXED SD-2: every BAD_SIGNATURE re-reads the manifest from step 2, not only a foreign signing key', async () => {
  const p = provider()
  const routes = {
    // Answers with a valid signature but the wrong id: an envelope-binding failure that recovers to the right key.
    // 签名有效但 id 不对：签名恢复出正确密钥的信封绑定失败。
    'svc.test': async (u, init) => {
      const env = await (await p.handleRequest(new Request(u, init), { clientIp: '203.0.113.9' })).json()
      return Response.json({ ...env, id: 'someone-else' })
    },
    'svc2.test': (u, init) => p.handleRequest(new Request(u, init), { clientIp: '203.0.113.9' }),
  }
  const { chain, api } = world({ manifest: manifestFor(['http://svc.test/tapeapi/v1']), routes })
  const svc = await api.resolve(ADDR.container)
  // The holder has since moved the service; only a re-read can learn that. / 持有人已迁移服务，只有重读才能得知。
  chain.writeFile(ADDR.container, MANIFEST_KEY, JSON.stringify(manifestFor(['http://svc2.test/tapeapi/v1'])))
  const before = registryReads(chain)
  await assert.rejects(api.call(svc, 'ping', {}), (e) => e.code === 'BAD_SIGNATURE' && /id mismatch/.test(e.message))
  assert.ok(registryReads(chain) > before, 'TAPI-21 §3.4: the manifest was re-read on BAD_SIGNATURE')
  assert.equal(svc.manifest.endpoints.live[0], 'http://svc2.test/tapeapi/v1', 'the re-read updated the handle in place')
  const r = await api.call(svc, 'ping', {})
  assert.deepEqual(r.result, { v: 1 }, 'the next call reaches the new endpoint')
  // Throttled per service (TAPI-21 §3.4 SHOULD): a second failure within the window does not read again.
  // 按服务限频：窗口内第二次失败不再读链。
  chain.writeFile(ADDR.container, MANIFEST_KEY, JSON.stringify(manifestFor(['http://svc.test/tapeapi/v1'])))
  svc.manifest.endpoints.live = ['http://svc.test/tapeapi/v1']
  const mid = registryReads(chain)
  await assert.rejects(api.call(svc, 'ping', {}), (e) => e.code === 'BAD_SIGNATURE')
  assert.equal(registryReads(chain), mid, 'no second re-read inside the throttle window')
})

test('FIXED SD-3: a burned circuit is MANIFEST_INVALID (step 4) even when its delegation has also expired (step 5)', async () => {
  const { api } = world({ manifest: manifestFor(['http://svc.test/tapeapi/v1'], { delegation: delegation(nowS() - 10) }), owner: null })
  await assert.rejects(api.resolve(ADDR.container), (e) => e.code === 'MANIFEST_INVALID' && /ownerOf/.test(e.message))
  // A live circuit with an expired delegation is still DELEGATION_INVALID / 活着的电路、过期的委托仍是 DELEGATION_INVALID
  const live = world({ manifest: manifestFor(['http://svc.test/tapeapi/v1'], { delegation: delegation(nowS() - 10) }) })
  await assert.rejects(live.api.resolve(ADDR.container), (e) => e.code === 'DELEGATION_INVALID' && /expired/.test(e.message))
})

test('FIXED SD-4: a contract holder\'s delegation longer than 65 bytes (TAPI-20 §3.3/§3.4) resolves through EIP-1271', async () => {
  const safe = '0x' + '99'.repeat(20)
  const long = '0x' + 'ab'.repeat(130)   // e.g. two owners' signatures of a Safe / 例如 Safe 两位所有者的签名
  const m = manifestFor(['http://svc.test/tapeapi/v1'], { delegation: { expires: EXPIRES, sig: long } })
  const { chain, api } = world({ manifest: m, owner: safe })
  chain.setContractHolder(safe, delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires: EXPIRES }))
  const svc = await api.resolve(ADDR.container)
  assert.equal(svc.verified.delegation, true)
  assert.equal(svc.verified.holder.toLowerCase(), safe)
  // A holder that does not accept it: DELEGATION_INVALID, never MANIFEST_INVALID / 持有人不认可：DELEGATION_INVALID
  const other = world({ manifest: m, owner: safe })
  await assert.rejects(other.api.resolve(ADDR.container), (e) => e.code === 'DELEGATION_INVALID' && /EIP-1271/.test(e.message))
  // Structural bounds stay: odd length or over 1024 bytes is MANIFEST_INVALID / 结构上限仍在
  assert.throws(() => validateManifest({ ...m, delegation: { expires: EXPIRES, sig: '0x' + 'ab'.repeat(1025) } }), (e) => e.code === 'MANIFEST_INVALID')
  assert.throws(() => validateManifest({ ...m, delegation: { expires: EXPIRES, sig: long + 'a' } }), (e) => e.code === 'MANIFEST_INVALID')
  const { en, zh } = spec(20)
  assert.match(en, /passes a longer `sig`, up to 1024 bytes/)
  assert.match(zh, /更长的 `sig`（与 TAPI-26 通道记录相同，至多 1024 字节）直接交给 EIP-1271/)
})

test('FIXED SD-5: HTTP 429 with a non-JSON body is RATE_LIMITED; the voucher is not carried on to the next endpoint', async () => {
  const p = provider()
  const routes = {
    'a.test': async () => new Response('<html>Too Many Requests</html>', { status: 429, headers: { 'content-type': 'text/html', 'retry-after': '7' } }),
    'b.test': (u, init) => p.handleRequest(new Request(u, init), { clientIp: '203.0.113.9' }),
  }
  const { api, hits } = world({ manifest: manifestFor(['http://a.test/tapeapi/v1', 'http://b.test/tapeapi/v1']), routes })
  const svc = await api.resolve(ADDR.container)
  await assert.rejects(api.call(svc, 'ping', {}), (e) => e.code === 'RATE_LIMITED' && e.data?.retryAfterS === 7)
  assert.deepEqual(hits, ['a.test'], 'TAPI-21 §3.4: a 429 is the answer, not a transport failure')
})

test('FIXED SD-6: the 1 MiB cap is measured in UTF-8 bytes on the no-stream path too', async () => {
  const LIMIT = 1024 * 1024
  const body = JSON.stringify('€'.repeat(400_000))   // 400,002 UTF-16 units, 1,200,002 UTF-8 bytes
  const textOnly = { headers: { get: () => null }, text: async () => body }
  await assert.rejects(readJsonBounded(textOnly, LIMIT, { code: 'PROVIDER_UNAVAILABLE' }), (e) => e.code === 'PROVIDER_UNAVAILABLE' && e.tooLarge === true)
  const bufferOnly = { headers: { get: () => null }, arrayBuffer: async () => new TextEncoder().encode(body).buffer, text: async () => body }
  await assert.rejects(readJsonBounded(bufferOnly, LIMIT, { code: 'PROVIDER_UNAVAILABLE' }), (e) => e.tooLarge === true)
  // Under the cap in bytes still parses / 字节数在上限内照常解析
  const small = { headers: { get: () => null }, text: async () => JSON.stringify('€'.repeat(1000)) }
  assert.equal(await readJsonBounded(small, LIMIT), '€'.repeat(1000))
})

test('FIXED SD-7: a manifest read from the chain cannot switch off the zero-escrow rule with its own `dev` field', () => {
  const priced = manifestFor(['https://svc.example/tapeapi/v1'], {
    dev: true, methods: [{ name: 'ping', priceBEM: '0.0001', params: {}, returns: {} }], payment: { escrow: ZERO, unit: 'BEM', decimals: 8 },
  })
  assert.throws(() => validateManifest(priced), (e) => e.code === 'MANIFEST_INVALID' && /zero address/.test(e.message))
  // A provider checking its own dev manifest (no delegation required) still boots / 提供者自检 dev 清单仍可启动
  assert.equal(validateManifest(priced, { requireDelegation: false }).payment.escrow, ZERO)
})

test('FIXED SD-7: TAPI-20 states what the code enforces (proto-key method names, optional unit/decimals, zero escrow, directory cross-check, error bucketing)', () => {
  const { en, zh } = spec(20)
  assert.match(en, /and not `__proto__`, `constructor` or `prototype`: TAPI-21 §3\.1 forbids/)
  assert.match(zh, /且不得为 `__proto__`、`constructor` 或 `prototype`/)
  assert.throws(() => validateManifest(manifestFor(['https://s.example/v1'], { methods: [{ name: 'constructor', priceBEM: '0', params: {}, returns: {} }] })), (e) => e.code === 'MANIFEST_INVALID')
  assert.match(en, /`unit` and `decimals` carry no information[^|]*either may be omitted/)
  assert.match(zh, /`unit` 与 `decimals` 都是固定值，不携带信息：二者均可省略/)
  const bare = validateManifest(manifestFor(['https://s.example/v1'], { methods: [{ name: 'ping', priceBEM: '0.1', params: {}, returns: {} }], payment: { escrow: ADDR.escrow } }))
  assert.deepEqual([bare.payment.unit, bare.payment.decimals], ['BEM', 8])
  assert.match(en, /and then `escrow` is a non-zero address/)
  assert.match(zh, /此时 `escrow` 为非零地址/)
  assert.match(en, /MAY also compare the directory's record for the resolved container \(`serviceOf`\)/)
  assert.match(zh, /MAY 另外把目录中该容器的记录（`serviceOf`）与清单的 `\(circuits, tokenId\)` 比较/)
  assert.match(en, /compared across nodes by its `code` and by whether it reports a revert/)
  assert.match(zh, /节点之间按其 `code` 以及它是否报告回滚/)
})

test('FIXED SD-8: TAPI-20 §3.5 says a burned circuit makes register/update revert with NotHolder, as the contract does', () => {
  const { en, zh } = spec(20)
  assert.doesNotMatch(en, /not revert the transaction/)
  assert.match(en, /MUST be treated as "no holder", so the call is refused \(the reference contract reverts with `NotHolder\(\)`\)/)
  assert.doesNotMatch(zh, /而非让交易回滚/)
  assert.match(zh, /MUST 视为"没有持有者"，调用因此被拒绝（参考合约以 `NotHolder\(\)` 回滚）/)
  const sol = readFileSync(new URL('../../contracts/src/ServiceDirectory.sol', import.meta.url), 'utf8')
  assert.match(sol, /if \(_holderOf\(circuits, tokenId\) != msg\.sender\) revert NotHolder\(\);/)
})

test('FIXED SD-9: relayRecv always carries `epoch`, null until the relay has named one (TAPI-26 §3.5)', async () => {
  const sent = []
  let epoch = null
  const api = { call: async (svc, method, params) => { sent.push(params); return { result: { frames: [], next: -1, epoch } } } }
  const t = relayTransport({ api, svc: { manifest: { methods: [] } }, inbound: 'aa'.repeat(32), outbound: 'bb'.repeat(32) })
  await t.poll(0)
  assert.ok(Object.hasOwn(sent[0], 'epoch'), 'the field is present')
  assert.equal(sent[0].epoch, null)
  epoch = '0123abcd'
  await t.poll(0); await t.poll(0)
  assert.equal(sent[2].epoch, '0123abcd', 'the last epoch seen is sent back')
  const { en, zh } = spec(26)
  assert.match(en, /A relay SHOULD also accept a request with no `epoch` field/)
  assert.match(zh, /中继 SHOULD 同时接受不带 `epoch` 字段的请求/)
})

test('FIXED SD-10: TAPI-23 §3.4 compares a signed revert like an answer (never accepted) and keeps other signed errors neutral', () => {
  const { en, zh } = spec(23)
  assert.match(en, /A verified error envelope that carries revert data \(§3\.3\) is also a statement about chain state/)
  assert.match(en, /a group of reverts is never accepted as a result\. Any other verified error envelope is a refusal/)
  assert.match(zh, /带回滚数据（§3\.3）的已验证错误信封同样是对链上状态的陈述/)
  assert.match(zh, /一组回滚永远不会被接受为结果。其他已验证错误信封都是拒答/)
})

test('FIXED SD-11: TAPI-24 §3.2 lets a Solver add informative fields beside { quote, sig, escrow }', () => {
  const { en, zh } = spec(24)
  assert.match(en, /A Solver MAY add informative fields beside these three/)
  assert.match(zh, /Solver MAY 在这三个字段之外附加信息性字段/)
  const solver = readFileSync(new URL('../../examples/defi-rfq-solver/index.mjs', import.meta.url), 'utf8')
  assert.match(solver, /return \{ quote, sig: signature, escrow, typehash: QUOTE_TYPEHASH, digest, domain \}/, 'the example this sentence describes')
})

test('FIXED SD-12: TapeOut names follow TapeKit SPEC §2.2; a non-canonical spelling is refused and never looked up as a label', async () => {
  const { api, chain } = world({ manifest: manifestFor(['http://svc.test/tapeapi/v1']), directory: ADDR.directory })
  assert.equal((await api.resolve('4246.7.tape')).container, ADDR.container)
  assert.equal((await api.resolve('4246.7')).container, ADDR.container, 'the suffix-less form TapeKit §2.4 tolerates is the same name')
  const lookups = () => chain.state.calls.filter((c) => c.name === 'resolve').length
  const before = lookups()
  for (const bad of ['04246.7.tape', '4246.07.tape', '4246.7.TAPE', '4246.7.Tape', '0.7.tape', '#4246@7', '4246@7', 'tape://4246.7.tape/']) {
    await assert.rejects(api.resolve(bad), (e) => e.code === 'MANIFEST_INVALID' && /canonical form/.test(e.message), bad)
  }
  assert.equal(lookups(), before, 'no name-shaped string reached the directory')
  const { en, zh } = spec(20)
  assert.match(en, /canonical form per TapeKit SPEC §2\.2/)
  assert.match(zh, /规范形式见 TapeKit SPEC §2\.2/)
})

test('FIXED SD-13: stale code comments corrected', () => {
  const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
  const channel = src('../src/channel.js'), index = src('../src/index.js'), server = src('../../server/src/index.js')
  assert.doesNotMatch(channel, /about 5,200 blocks/)
  assert.doesNotMatch(channel, /publicnode \(the default node set\)/)
  assert.doesNotMatch(index, /directory, escrow：合约地址，默认为主网/)
  assert.doesNotMatch(index, /is what a provider following TAPI-22 §3\.2 literally may send/)
  assert.doesNotMatch(index, /TAPI-27 §3\.3 step 5: a verifier for group rosters/)
  assert.doesNotMatch(server, /TAPI-22 §3\.3: every BAD_VOUCHER/)
  assert.doesNotMatch(server, /TAPI-21 §7 rather than papered over/)
})

