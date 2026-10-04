// The 1.0 interface freeze review (1.0 plan G1): each "must" item as a test.
// 1.0 接口冻结审查的"必须"项，逐条写成测试。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TapeAPIError, createTapeAPI, createRpc } from '../src/index.js'

const invalid = (re) => (e) => e instanceof TapeAPIError && e.code === 'INVALID_ARGUMENT' && (!re || re.test(e.message))

test('FIXED G1-M1: a configuration or argument mistake is INVALID_ARGUMENT, before any request, never a runtime code', async () => {
  let requests = 0
  const fetch = async () => { requests++; throw new Error('no network in this test') }
  assert.throws(() => createRpc({ urls: ['https://a.example', 'https://b.example'], quorum: 0, fetch }), invalid(/quorum/))
  assert.throws(() => createRpc({ urls: [], fetch }), invalid(/no rpc urls/))
  const api = createTapeAPI({ fetch })
  await assert.rejects(api.resolve(42), invalid(/unsupported resolve target/))
  await assert.rejects(api.resolve('some-label'), invalid(/directory address not configured/))
  await assert.rejects(api.chain.channelKeys('nope'), invalid(/container address/))
  await assert.rejects(api.chainOfContainer('nope'), invalid())
  assert.throws(() => api.forChain(97), invalid(/not a TapeOut chain/))
  assert.throws(() => api.payer({ consumer: 'nope', sessionKey: '0x' + '11'.repeat(32) }), invalid(/consumer/))
  assert.throws(() => api.tx.approve({}), invalid())
  assert.throws(() => api.tx.fund('0x' + '22'.repeat(20), 1n), invalid(/escrow address not configured/))
  await assert.rejects(api.callQuorum([], 'x', {}), invalid(/non-empty/))
  // A chain read without nodes is a configuration mistake too: not RPC_UNAVAILABLE, which a caller would retry.
  // 没配节点就读链也是配置错误：不是调用方会重试的 RPC_UNAVAILABLE。
  await assert.rejects(api.chain.ownerOf('0x' + '33'.repeat(20), 1), invalid(/rpcUrls not configured/))
  assert.equal(requests, 0, 'nothing was sent')
})

test('FIXED G1-M2: TapeAPIError keeps a fixed set of top-level fields; any other detail is in data, with a read-only 0.x alias', () => {
  const e = new TapeAPIError('RPC_ERROR', 'boom', { rpcCode: 3, rpcRevert: true, tooLarge: true, httpStatus: 502, signed: false })
  assert.equal(e.code, 'RPC_ERROR'); assert.equal(e.message, 'boom'); assert.equal(e.name, 'TapeAPIError')
  assert.deepEqual(e.data, { rpcCode: 3, rpcRevert: true, tooLarge: true })
  assert.equal(e.httpStatus, 502); assert.equal(e.signed, false)
  // deprecated aliases, one per key, read-only and not enumerable / 弃用别名：只读、不可枚举
  assert.equal(e.rpcCode, 3); assert.equal(e.rpcRevert, true); assert.equal(e.tooLarge, true)
  assert.deepEqual(Object.keys(e).sort(), ['code', 'data', 'httpStatus', 'name', 'signed'])
  assert.throws(() => { 'use strict'; e.tooLarge = false }, TypeError)
  // an explicit data object is merged, not replaced / 显式的 data 被合并，不被替换
  const q = new TapeAPIError('QUORUM_FAILED', 'x', { data: { method: 'read' }, agreed: [], failed: [{ code: 'INTERNAL' }] })
  assert.deepEqual(q.data, { method: 'read', agreed: [], failed: [{ code: 'INTERNAL' }] })
  assert.deepEqual(q.failed, [{ code: 'INTERNAL' }])
  // extra never overrides the code, the name or the message; cause is the standard Error cause
  const c = new TapeAPIError('NOT_FOUND', 'm', { code: 'OTHER', name: 'X', message: 'y', cause: 'why' })
  assert.equal(c.code, 'NOT_FOUND'); assert.equal(c.name, 'TapeAPIError'); assert.equal(c.message, 'm'); assert.equal(c.cause, 'why')
  assert.equal(c.data, undefined)
  // data alone stays as given / 只有 data 时原样保留
  const d = new TapeAPIError('PRICE_CHANGED', 'p', { data: { price: '1' } })
  assert.deepEqual(d.data, { price: '1' })
})

test('FIXED G1-M3/M5/M13: the public subpaths expose no test hooks, no bare-hex toHex and no internal helpers', async () => {
  const { channel } = await import('../src/index.js')
  const pubChannel = await import('@tapeapi/sdk/channel')
  const pubRpc = await import('@tapeapi/sdk/rpc')
  for (const ns of [channel, pubChannel]) {
    for (const name of ['toHex', 'fromHex', 'toBase64', 'fromBase64', '_keySchedule', '_busMerge', '_busKindOf']) assert.equal(name in ns, false, name)
    for (const name of ['createInvite', 'acceptInvite', 'completeInvite', 'busTransport', 'busReader', 'inboxRoom', 'relayTransport']) assert.equal(typeof ns[name], 'function', name)
  }
  assert.deepEqual(Object.keys(pubRpc).sort(), ['RPC_BODY_LIMIT', 'createRpc'])
  // every toHex left in the public API carries 0x / 公开接口里剩下的 toHex 都带 0x
  const { abi, sig } = await import('../src/index.js')
  assert.equal(abi.toHex(Uint8Array.of(1, 2)), '0x0102')
  assert.equal('toHex' in sig, false, 'sig no longer re-exports the byte helpers (S1)')
})

test('FIXED G1-M9: relayTransport takes { service }; the 0.x option svc is refused with a pointer to the upgrade guide', async () => {
  const { channel } = await import('../src/index.js')
  const api = { call: async () => ({ result: { frames: [], next: -1, epoch: null } }) }
  assert.throws(() => channel.relayTransport({ api, svc: {}, inbound: 'aa'.repeat(32), outbound: 'bb'.repeat(32) }), invalid(/renamed in 1\.0/))
  assert.throws(() => channel.relayTransport({ api, inbound: 'aa'.repeat(32), outbound: 'bb'.repeat(32) }), invalid(/service/))
  const t = channel.relayTransport({ api, service: { manifest: { methods: [] } }, inbound: 'aa'.repeat(32), outbound: 'bb'.repeat(32) })
  assert.equal(typeof t.send, 'function')
})

test('FIXED G1-M4: every `now` is Unix seconds; a group takes `clock` (a function of Unix seconds) and refuses the 0.x ms `now`', async () => {
  const { group: G, channel } = await import('../src/index.js')
  const identity = channel.generateIdentity()
  const self = { container: '0x' + 'a1'.repeat(20), chainId: 56 }
  await assert.rejects(G.createGroup({ self, identity, now: () => Date.now() }), invalid(/renamed in 1\.0.*clock/))
  await assert.rejects(G.createGroup({ self, identity, clock: 1789000000 }), invalid(/function/))
  const T = 1789000000.5
  const { group, epochWire } = await G.createGroup({ self, identity, clock: () => T, verifyMember: 'trust-roster' })
  assert.equal(group.roster.issued, Math.floor(T), 'issued is the clock, in seconds')
  const wire = group.seal('x')
  // seq = clock ms << 16 (TAPI-27 §3.4): the seconds clock is converted, not truncated to whole seconds
  const seq = new DataView(wire.buffer, wire.byteOffset + 29, 8).getBigUint64(0)
  assert.equal(seq >> 16n, 1789000000500n)
  assert.throws(() => G.joinGroup({ self, identity, invite: { gid: group.gid, owner: self }, ownerKeys: {}, now: () => 0 }), invalid(/renamed/))
  void epochWire
})

// FIXED RC-6 (review 2026-09-29, O P1-3 / F P1-1): `relays` meant two things in one namespace: createGroup's relays are
// references { url, container } (a TAPI-27 roster field), the delivery functions' relays were clients { api, service }.
// The delivery options are relayClients and busClients now; every old name is refused with a pointer to the upgrade
// guide. / `relays` 在同一命名空间里有两种含义：createGroup 的是引用，投递函数的是客户端。投递参数改名 relayClients / busClients。
test('FIXED RC-6: group delivery takes relayClients: [{ api, service }] and busClients: [...]; relays / buses / relay / bus / svc are refused', async () => {
  const { group: G, channel, deliverGroupUpdate, checkGroupInvites } = await import('../src/index.js')
  const identity = channel.generateIdentity()
  const self = { container: '0x' + 'a1'.repeat(20), chainId: 56 }
  // createGroup keeps `relays`, the roster's references / createGroup 保留 relays（名单里的引用）
  const { group } = await G.createGroup({ self, identity, verifyMember: 'trust-roster', relays: [{ url: 'https://relay.example/tapeapi/v1', container: '0x' + '3e'.repeat(20) }] })
  assert.deepEqual(group.roster.relays, [{ url: 'https://relay.example/tapeapi/v1', container: '0x' + '3e'.repeat(20) }])
  const api = { call: async () => ({ result: { i: 0, epoch: '0x01' } }) }
  const service = { container: '0x' + '3e'.repeat(20), manifest: { methods: [] } }
  for (const [old, now] of [['relays', 'relayClients'], ['relay', 'relayClients'], ['buses', 'busClients'], ['bus', 'busClients']]) {
    await assert.rejects(deliverGroupUpdate({ group, [old]: [] }), invalid(new RegExp(`\`${old}\` was renamed .*\`${now}\`.*upgrade-1\.0`)))
  }
  await assert.rejects(checkGroupInvites({ self, identity, relays: [{ api, service }] }), invalid(/`relays` was renamed .*`relayClients`/))
  await assert.rejects(checkGroupInvites({ self, identity, relay: [{ api, service }] }), invalid(/`relay` was renamed .*`relayClients`/))
  await assert.rejects(deliverGroupUpdate({ group, relayClients: { api, service } }), invalid(/relayClients must be a list/))
  await assert.rejects(deliverGroupUpdate({ group, relayClients: [{ api, svc: service }] }), invalid(/`svc` was renamed/))
  await assert.rejects(deliverGroupUpdate({ group, relayClients: [{ url: 'https://relay.example/tapeapi/v1', container: service.container }] }), invalid(/relayClients\[0\] needs \{ api, service \}/))
  await assert.rejects(deliverGroupUpdate({ group }), invalid(/relayClients \[\{ api, service \}\] or busClients/))
  const r = await deliverGroupUpdate({ group, relayClients: [{ api, service }] })
  assert.equal(r.ok, true)
  await assert.rejects(checkGroupInvites({ self, identity }), invalid(/relayClients \[\{ api, service \}\] is required/))
})

test('G1-S5/S7: a call the caller aborted or that timed out says so in data; addresses include the factory', async () => {
  const { createTapeAPI: mk, MAINNET } = await import('../src/index.js')
  const api = mk({ dev: true, fetch: (u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))) })
  assert.equal(api.addresses.factory, MAINNET.factory)
  const svc = await api.resolve({ dev: { tapeapi: '0.1', circuits: '0x' + '00'.repeat(20), tokenId: '0', container: '0x' + '00'.repeat(20), signer: '0x' + '11'.repeat(20), delegation: null, dev: true, endpoints: { live: ['http://127.0.0.1:1/tapeapi/v1'], async: false }, methods: [{ name: 'm', priceBEM: '0', params: {}, returns: {} }] } })
  await assert.rejects(api.call(svc, 'm', {}, { timeoutMs: 20 }), (e) => e.code === 'PROVIDER_UNAVAILABLE' && e.data?.timedOut === true)
  const ac = new AbortController(); setTimeout(() => ac.abort(), 10)
  await assert.rejects(api.call(svc, 'm', {}, { signal: ac.signal, timeoutMs: 5000 }), (e) => e.code === 'PROVIDER_UNAVAILABLE' && e.data?.aborted === true)
})

test('FIXED G1-S4: the RPC timeout is rpcTimeoutMs in createTapeAPI, its chains and createProvider; timeoutMs is refused there', async () => {
  const { createTapeAPI: mk } = await import('../src/index.js')
  const { createProvider } = await import('../../server/src/index.js')
  assert.throws(() => mk({ timeoutMs: 1000 }), invalid(/renamed `rpcTimeoutMs`.*upgrade-1\.0/))
  assert.throws(() => mk({ chains: { 196: { timeoutMs: 1000 } } }), invalid(/chains\[196\].*rpcTimeoutMs/))
  assert.throws(() => createProvider({ manifest: {}, signerKey: '0x' + '11'.repeat(32), methods: {}, timeoutMs: 1000 }), invalid(/rpcTimeoutMs/))
  const api = mk({ rpcUrls: ['https://a.example', 'https://b.example'], quorum: 2, rpcTimeoutMs: 1234, chains: { 196: { rpcUrls: ['https://c.example', 'https://d.example'], rpcTimeoutMs: 999 } }, fetch: async () => { throw new Error('offline') } })
  assert.ok(api.rpc)
  assert.equal(api.forChain(196).chainId, 196)
})

test('FIXED G1-S6: every tokenId and processor the SDK returns is a decimal string; inputs take any BigNumberish', async () => {
  const { createFakeChain, ADDR } = await import('./helpers/fake-chain.mjs')
  const { createTapeAPI: mk, parseTapeName } = await import('../src/index.js')
  const chain = createFakeChain()
  const container = '0x' + '5a'.repeat(20)
  chain.setContainerToken(container, { tokenId: 4246 })
  const api = mk({ rpcUrls: ['http://rpc1', 'http://rpc2'], quorum: 2, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, factory: ADDR.factory, fetch: chain.fetch })
  const t = await api.chain.tokenOf(container)
  assert.equal(t.tokenId, '4246')
  assert.equal(typeof t.circuits, 'string')
  const p = parseTapeName('4246.1013.tape')
  assert.deepEqual([p.tokenId, p.processor], ['4246', '1013'])
})

// FIXED RC-7 (review 2026-09-29, O P1-4 / F P1-4): whatever can be imported is promised by 1.0, so the frozen surface is
// narrowed. `ai` is a public face (ai-public.js): what the guides, READMEs and examples use is Stable; what the server,
// the website and the scripts still reach through the package root is kept and marked @internal; the rest (used by
// nothing outside ai.js and its tests) is no longer exported there. group.senderKey and group.buildEpoch leave the
// public `group` namespace. The whole bus-privacy subpath is @experimental.
// FIXED RC-7：能 import 到的都算 1.0 的承诺，所以缩小冻结面。ai 走公开门面；group 去掉 senderKey、buildEpoch；bus-privacy 整体实验性。
const AI_STABLE = ['FORMATS', 'MANIFEST_FIELD', 'RECEIPT_HEADER', 'RECEIPT_METHOD', 'SIDECAR_ERROR_HEADER', 'VERIFY_ERROR_HEADER', 'createVerifyingFetch', 'decodeReceiptHeader', 'formatFor', 'readSseReceipt', 'scanSse', 'sha256Hex', 'usageOf', 'validateAIField', 'verifyUsageReceipt']
const AI_INTERNAL = ['FORWARD_HEADERS', 'MODEL_ID_MAX', 'SESSION_HEADERS', 'apiPath', 'completeOf', 'createSseScanner', 'encodeReceipt', 'envelopeProblems', 'formatOfMethod', 'forwardsHeader', 'isAnswerId', 'isSessionHeader', 'modelEntryOf', 'priceProblems', 'pricingOf', 'receiptComment', 'requestUsageBody']
// The JSDoc block right above each `export` line of a declaration file (null when there is none).
// 声明文件里每个 export 行正上方的 JSDoc 块（没有时为 null）。
function docsOfExports(text) {
  const out = new Map()
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /^export\s+(?:declare\s+(?:function|const|class|let)|interface|type|\*\s+as)\s+([A-Za-z_$][\w$]*)/.exec(lines[i])
    if (!m) continue
    let doc = null
    if (/\*\/\s*$/.test(lines[i - 1] ?? '')) {
      let j = i - 1
      while (j >= 0 && !/^\s*\/\*\*/.test(lines[j])) j--
      doc = lines.slice(j, i).join('\n')
    }
    if (!out.has(m[1])) out.set(m[1], doc)
  }
  return out
}
test('FIXED RC-7: ai is a public face (Stable + @internal, the rest not exported), group has no senderKey / buildEpoch, bus-privacy is @experimental', async () => {
  const { readFileSync } = await import('node:fs')
  const root = await import('../src/index.js')
  const sub = await import('@tapeapi/sdk/ai')
  const want = [...AI_STABLE, ...AI_INTERNAL].sort()
  assert.deepEqual(Object.keys(root.ai).sort(), want)
  assert.deepEqual(Object.keys(sub).sort(), want)
  for (const gone of ['amountOf', 'sentinelOf', 'sseDigestOfPayloads', 'saltRequestBody', 'rootOf', 'CURRENCIES', 'PRICE_UNIT']) assert.equal(gone in root.ai, false, gone)
  assert.equal(typeof (await import('../src/ai.js')).amountOf, 'function', 'the implementation module still has it (tests, the CLI)')
  assert.equal('senderKey' in root.group, false); assert.equal('buildEpoch' in root.group, false)
  assert.equal(typeof (await import('../src/group.js')).buildEpoch, 'function')
  const aiDocs = docsOfExports(readFileSync(new URL('../types/ai.d.ts', import.meta.url), 'utf8'))
  for (const n of AI_INTERNAL) assert.match(aiDocs.get(n) ?? '', /@internal/, `ai.${n} is @internal`)
  for (const n of AI_STABLE) assert.doesNotMatch(aiDocs.get(n) ?? '', /@internal|@experimental/, `ai.${n} is Stable`)
  const bp = docsOfExports(readFileSync(new URL('../types/bus-privacy.d.ts', import.meta.url), 'utf8'))
  assert.ok(bp.size >= 15)
  for (const [n, doc] of bp) assert.match(doc ?? '', /@experimental/, `bus-privacy ${n} is @experimental`)
  assert.match(docsOfExports(readFileSync(new URL('../types/index.d.ts', import.meta.url), 'utf8')).get('busPrivacy') ?? '', /@experimental/)
})

// FIXED RC-10 (review 2026-09-29, O P1-7): a group clock returning milliseconds (Date.now, the 0.x default) was taken as
// seconds: the owner's side did not complain and posted an epoch issued ~1.7e12, which every member then refused as
// "issued in the future". A clock whose value is above 1e11 (year 5138 in seconds) or not a finite number is refused on
// both sides. / 返回毫秒的群时钟曾被当成秒：群主一侧不报错，成员一侧只看到"issued in the future"。现在两侧都拒绝。
test('FIXED RC-10: a group clock that returns milliseconds (or not a number) is INVALID_ARGUMENT for the owner and the member', async () => {
  const { group: G, channel } = await import('../src/index.js')
  const identity = channel.generateIdentity()
  const self = { container: '0x' + 'a1'.repeat(20), chainId: 56 }
  const secondsOnly = invalid(/clock must return Unix seconds/)
  for (const clock of [Date.now, () => Date.now(), () => NaN, () => '1789000000', () => Infinity]) {
    await assert.rejects(G.createGroup({ self, identity, clock, verifyMember: 'trust-roster' }), secondsOnly, String(clock))
    assert.throws(() => G.joinGroup({ self, identity, invite: { gid: '00'.repeat(16), owner: self }, ownerKeys: {}, clock }), secondsOnly)
    await assert.rejects(G.resumeGroup({ self, identity, snapshot: {}, clock }), secondsOnly)
  }
  const { group } = await G.createGroup({ self, identity, clock: () => Date.now() / 1000, verifyMember: 'trust-roster' })
  assert.ok(Math.abs(group.roster.issued - Date.now() / 1000) < 5)
})
