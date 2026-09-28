// callQuorum：多提供者一致，永不多数投票 / callQuorum: multi-provider agreement, never a majority vote.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTapeAPI, TapeAPIError } from '../src/index.js'
import { privateKeyToAddress } from '../src/sig.js'
import { createProvider } from '../../server/src/index.js'
import { ADDR } from './helpers/fake-chain.mjs'

// 五个独立提供者（不同容器、不同签名密钥），dev 模式无需链 / five independent providers, dev mode needs no chain.
const N = 5
const keys = Array.from({ length: N }, (_, i) => '0x' + (0xa1 + i).toString(16).repeat(32))
const containers = Array.from({ length: N }, (_, i) => '0x' + (0x61 + i).toString(16).repeat(20))
const answers = {} // container(lower) -> result returned by `read`
const providers = []
const services = []
let api

before(async () => {
  api = createTapeAPI({ chainId: 56, dev: true, escrow: ADDR.escrow })
  for (let i = 0; i < N; i++) {
    const manifest = {
      tapeapi: '0.1', name: `AR${i}`, circuits: ADDR.circuits, tokenId: String(100 + i), container: containers[i], signer: privateKeyToAddress(keys[i]),
      endpoints: { live: ['http://127.0.0.1:0/tapeapi/v1'], async: false },
      methods: [{ name: 'read', priceBEM: '0', params: { chainId: 'number' }, returns: { value: 'string' } }],
      payment: { escrow: ADDR.escrow, unit: 'BEM', decimals: 8 },
    }
    const p = createProvider({ minVoucherLifeS: 0,  manifest, signerKey: keys[i], dev: true, methods: { read: async () => {
      const a = answers[containers[i]]
      // a signed revert (TAP-23 §3.3) or a signed refusal / 签名的回滚或签名的拒答
      if (a?.__revert) throw new TapeAPIError('INTERNAL', 'execution reverted', { data: { revert: a.__revert } })
      if (a?.__refuse) throw new TapeAPIError('BAD_REQUEST', 'block not available')
      return a
    } } }) // dev: http endpoints
    const srv = await p.listen(0)
    manifest.endpoints.live = [`http://127.0.0.1:${srv.address().port}/tapeapi/v1`]
    providers.push(p)
    services.push(await api.resolve({ dev: manifest }))
  }
})
after(async () => { for (const p of providers) await p.close() })

const set = (...vals) => vals.forEach((v, i) => { answers[containers[i]] = v })
const three = () => services.slice(0, 3)

test('strict by default (TAP-23 §3.4): 2 of 3 agree but one dissents -> rejected, not accepted', async () => {
  set({ value: '0xabc', block: 100 }, { block: 100, value: '0xabc' }, { value: '0xdef', block: 100 })
  await assert.rejects(api.callQuorum(three(), 'read', { chainId: 1 }), (e) => {
    assert.equal(e.code, 'QUORUM_FAILED')
    assert.match(e.message, /rejects on any disagreement/)
    assert.deepEqual(e.agreed, []); assert.equal(e.groups.length, 2)
    return true
  })
})
test("onDissent:'quorum' accepts the one group reaching quorum and reports the dissenter", async () => {
  set({ value: '0xabc', block: 100 }, { block: 100, value: '0xabc' }, { value: '0xdef', block: 100 }) // key order differs, canonicalJSON equal
  const r = await api.callQuorum(three(), 'read', { chainId: 1 }, { onDissent: 'quorum' })
  assert.deepEqual(r.result, { value: '0xabc', block: 100 })
  assert.deepEqual(r.agreed.map(a => a.toLowerCase()), [containers[0], containers[1]])
  assert.deepEqual(r.disagreed.map(a => a.toLowerCase()), [containers[2]])
  assert.deepEqual(r.failed, [])
  assert.equal(r.verified, true); assert.equal(r.quorum, 2)
  assert.equal(r.responses.length, 2); assert.ok(r.responses.every(x => x.verified && /^0x/.test(x.sig)))
  assert.equal(r.groups.length, 2)
})
test('all agree -> disagreed is empty', async () => {
  set({ value: 'same' }, { value: 'same' }, { value: 'same' })
  const r = await api.callQuorum(three(), 'read', {})
  assert.equal(r.agreed.length, 3); assert.deepEqual(r.disagreed, [])
})
test('fail: all three differ -> QUORUM_FAILED with every result reported, none chosen', async () => {
  set({ value: 'a' }, { value: 'b' }, { value: 'c' })
  await assert.rejects(api.callQuorum(three(), 'read', {}), (e) => {
    assert.ok(e instanceof TapeAPIError); assert.equal(e.code, 'QUORUM_FAILED')
    assert.match(e.message, /rejects on any disagreement/)
    assert.deepEqual(e.agreed, []); assert.equal(e.disagreed.length, 3); assert.equal(e.groups.length, 3); assert.deepEqual(e.failed, [])
    return true
  })
})
test('no majority vote: 2-2 and 3-2 splits are ambiguous; 3-1 passes because only one group reaches quorum', async () => {
  const four = services.slice(0, 4)
  const Q = { onDissent: 'quorum' }   // 这些语义只在降级模式下才有意义 / these semantics only exist in the weaker mode
  set({ value: 'x' }, { value: 'x' }, { value: 'y' }, { value: 'y' })
  await assert.rejects(api.callQuorum(four, 'read', {}, Q), (e) => e.code === 'QUORUM_FAILED' && /ambiguous/.test(e.message) && e.groups.length === 2)
  // 3 vs 2 with quorum 2: both groups reach quorum, so size does NOT decide / 3 对 2 且 quorum=2：两组都达标，规模不决定结果
  set({ value: 'x' }, { value: 'x' }, { value: 'x' }, { value: 'y' }, { value: 'y' })
  await assert.rejects(api.callQuorum(services, 'read', {}, Q), (e) => e.code === 'QUORUM_FAILED' && /ambiguous/.test(e.message))
  // 3 vs 1: only the x group reaches 2 -> accepted, dissenter reported / 只有 x 组达标
  set({ value: 'x' }, { value: 'x' }, { value: 'x' }, { value: 'y' })
  const r = await api.callQuorum(four, 'read', {}, Q)
  assert.equal(r.agreed.length, 3); assert.deepEqual(r.disagreed.map(a => a.toLowerCase()), [containers[3]])
  // raising quorum to 3 resolves the 3-2 case: only x reaches 3 / quorum 提到 3 后 3 对 2 可通过
  set({ value: 'x' }, { value: 'x' }, { value: 'x' }, { value: 'y' }, { value: 'y' })
  const r3 = await api.callQuorum(services, 'read', {}, { quorum: 3, onDissent: 'quorum' })
  assert.equal(r3.agreed.length, 3); assert.equal(r3.disagreed.length, 2)
})
test('unreachable provider counts as failed, not disagreed; remaining quorum still succeeds', async () => {
  set({ value: 'ok' }, { value: 'ok' }, { value: 'ok' })
  const dead = { ...services[2], manifest: { ...services[2].manifest, endpoints: { live: ['http://127.0.0.1:1/tapeapi/v1'], async: false } } }
  const r = await api.callQuorum([services[0], services[1], dead], 'read', {}, { timeoutMs: 2000 })
  assert.equal(r.agreed.length, 2); assert.deepEqual(r.disagreed, [])
  assert.equal(r.failed.length, 1); assert.equal(r.failed[0].code, 'PROVIDER_UNAVAILABLE'); assert.equal(r.failed[0].container.toLowerCase(), containers[2])
  // with only one live answer the quorum fails / 只剩一个可验证答案 -> 失败
  await assert.rejects(api.callQuorum([services[0], dead], 'read', {}, { timeoutMs: 2000 }), (e) => e.code === 'QUORUM_FAILED' && /only 1\/2/.test(e.message))
})
test('a tampered envelope is a failed (BAD_SIGNATURE) answer, never a vote', async () => {
  set({ value: 'true' }, { value: 'true' }, { value: 'true' })
  const evilPort = new URL(services[2].manifest.endpoints.live[0]).port
  const evil = createTapeAPI({
    chainId: 56, dev: true, escrow: ADDR.escrow,
    fetch: async (url, init) => {
      const res = await fetch(url, init)
      if (new URL(url).port !== evilPort) return res
      const j = await res.json(); j.result.value = 'false' // MITM edits the payload / 中间人篡改
      return new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const r = await evil.callQuorum(three(), 'read', {})
  assert.deepEqual(r.result, { value: 'true' }); assert.equal(r.agreed.length, 2)
  assert.deepEqual(r.disagreed, []); assert.equal(r.failed[0].code, 'BAD_SIGNATURE')
})
test('argument validation: empty, too few providers, duplicates, bad quorum', async () => {
  await assert.rejects(api.callQuorum([], 'read', {}), (e) => e.code === 'INVALID_ARGUMENT' && /non-empty/.test(e.message))
  await assert.rejects(api.callQuorum([services[0]], 'read', {}), (e) => e.code === 'QUORUM_FAILED' && /at least 2/.test(e.message))
  await assert.rejects(api.callQuorum([services[0], services[0]], 'read', {}), (e) => e.code === 'QUORUM_FAILED' && /duplicate/.test(e.message))
  await assert.rejects(api.callQuorum(three(), 'read', {}, { quorum: 0 }), (e) => /positive integer/.test(e.message))
  await assert.rejects(api.callQuorum(three(), 'nope', {}), (e) => e.code === 'QUORUM_FAILED' && e.failed.every(f => f.code === 'METHOD_NOT_FOUND'))
  // TAP-23 §3.4(1): quorum 1 is refused unless spelled out / quorum 1 须显式开启
  await assert.rejects(api.callQuorum([services[0]], 'read', {}, { quorum: 1 }), (e) => e.code === 'QUORUM_FAILED' && /allowSingleProvider/.test(e.message))
  set({ value: 'solo' })
  const r = await api.callQuorum([services[0]], 'read', {}, { quorum: 1, allowSingleProvider: true })
  assert.deepEqual(r.result, { value: 'solo' }); assert.equal(r.agreed.length, 1)
})

// A resolved service with a different container but the given holder / origin, reusing a real service's signer.
// 伪造一个容器不同、但持有人或来源相同的已解析服务。
const alias = (s, { holder, live, container = '0x' + '7a'.repeat(20) } = {}) => ({
  ...s, container, verified: { ...s.verified, holder: holder ?? s.verified.holder },
  manifest: { ...s.manifest, container, endpoints: { ...s.manifest.endpoints, live: live ?? s.manifest.endpoints.live } },
})
test('TAP-23 §3.5: two services sharing a holder or an origin are one source, and are refused before any call', async () => {
  const h = '0x' + '99'.repeat(20)
  const a = { ...services[0], verified: { ...services[0].verified, holder: h } }
  const b = alias(services[1], { holder: h.toUpperCase().replace('0X', '0x') })
  await assert.rejects(api.callQuorum([a, b], 'read', {}), (e) => e.code === 'QUORUM_FAILED' && /share holder/.test(e.message))
  const sameOrigin = alias(services[1], { live: [services[0].manifest.endpoints.live[0].replace('/tapeapi/v1', '/other/tapeapi/v1')] })
  await assert.rejects(api.callQuorum([services[0], sameOrigin], 'read', {}), (e) => e.code === 'QUORUM_FAILED' && /share origin/.test(e.message))
})

test('TAP-23 attested reads: ATTEST_DISAGREE on dissent, no tolerance, explicit numeric block, listed chain', async () => {
  const ar = (s) => ({ ...s, manifest: { ...s.manifest, methods: s.manifest.methods.map((m) => ({ ...m, attestedRead: { kind: 'eth_call', chains: [1] } })) } })
  const trio = three().map(ar)
  const res = (hash, result, extra = {}) => ({ chainId: 1, blockNumber: 100, blockHash: hash, result, ...extra })
  const H = (n) => '0x' + String(n).repeat(64)
  set(res(H(1), '0x01'), res(H(1), '0x01'), res(H(1), '0x02'))
  await assert.rejects(api.callQuorum(trio, 'read', { chainId: 1, block: 100 }), (e) => e.code === 'ATTEST_DISAGREE')
  // stateRoot is compared only when both carry it / stateRoot 仅在双方都有时比较
  set(res(H(1), '0x01', { stateRoot: H(5) }), res(H(1), '0x01'), res(H(1), '0x01', { stateRoot: H(5) }))
  assert.equal((await api.callQuorum(trio, 'read', { chainId: 1, block: 100 })).agreed.length, 3)
  set(res(H(1), '0x01', { stateRoot: H(5) }), res(H(1), '0x01'), res(H(1), '0x01', { stateRoot: H(6) }))
  await assert.rejects(api.callQuorum(trio, 'read', { chainId: 1, block: 100 }), (e) => e.code === 'ATTEST_DISAGREE' && /stateRoot/.test(e.message))
  await assert.rejects(api.callQuorum(trio, 'read', { chainId: 1, block: 'finalized' }), (e) => e.code === 'QUORUM_FAILED' && /numeric params.block/.test(e.message))
  await assert.rejects(api.callQuorum(trio, 'read', { chainId: 1 }), (e) => /numeric params.block/.test(e.message))
  await assert.rejects(api.callQuorum(trio, 'read', { chainId: 8453, block: 100 }), (e) => /does not list chainId 8453/.test(e.message))
  await assert.rejects(api.callQuorum(trio, 'read', { chainId: 1, block: 100 }, { compare: { paths: ['result'], relTolBps: 10 } }), (e) => /tolerance MUST NOT/.test(e.message))
})
test('dev-mode services expose contribution 0', () => {
  for (const s of services) assert.equal(s.contribution, 0)
})

// ---- 数值容差比较 / opt-in tolerant comparison (cross-source prices are never byte-identical) ----

test('compare.relTolBps groups prices within tolerance; the rest of the shape must still match', async () => {
  const mk = (price) => ({ price, pair: '0xabc', blockPinned: { number: 100 } })
  // ±1%，与 Venus BoundValidator 同量级：前两个一致，第三个不一致 / within 1%, like Venus's BoundValidator
  set(mk('753.72'), mk('754.10'), mk('812.00'))
  const r = await api.callQuorum(three(), 'read', {}, { quorum: 2, onDissent: 'quorum', compare: { relTolBps: 100, paths: ['price'] } })
  assert.equal(r.agreed.length, 2)
  assert.equal(r.result.price, '753.72', 'the first answer represents the bucket')
  assert.equal(r.disagreed.length, 1)

  // 收紧到 0.01% 后无人一致 / a tighter tolerance leaves no agreement
  await assert.rejects(
    api.callQuorum(three(), 'read', {}, { quorum: 2, onDissent: 'quorum', compare: { relTolBps: 1, paths: ['price'] } }),
    (e) => e.code === 'QUORUM_FAILED',
  )
})

test('tolerance never relaxes the non-numeric fields', async () => {
  set(
    { price: '100', blockPinned: { number: 100 } },
    { price: '100.5', blockPinned: { number: 101 } },   // 区块不同，不得一致 / different block must not agree
    { price: '999', blockPinned: { number: 999 } },
  )
  await assert.rejects(
    api.callQuorum(three(), 'read', {}, { quorum: 2, compare: { relTolBps: 100, paths: ['price'] } }),
    (e) => e.code === 'QUORUM_FAILED',
  )
})

test('a malformed compare configuration is the caller error, and is caught before any request is sent', async () => {
  set({ price: '1' }, { price: '1' }, { price: '1' })
  let sent = 0
  const counting = createTapeAPI({
    chainId: 56, dev: true, escrow: ADDR.escrow,
    fetch: async (u, i) => { sent++; return fetch(u, i) },
  })
  for (const compare of [{ relTolBps: -1, paths: ['price'] }, { relTolBps: 100, paths: [] }, { relTolBps: 100, paths: [''] }, { relTolBps: 100, paths: ['a..b'] }, { relTolBps: 100, paths: [3] }]) {
    await assert.rejects(
      counting.callQuorum(three(), 'read', {}, { quorum: 2, compare }),
      (e) => e.code === 'INVALID_ARGUMENT',
    )
  }
  // H-03：形状错误在发请求之前就拒绝，付费方法不会白花钱 / rejected before any (paid) request goes out
  assert.equal(sent, 0)
  await assert.rejects(counting.callQuorum(three(), 'read', {}, { quorum: 2, onDissent: 'majority' }), (e) => /onDissent/.test(e.message))
  assert.equal(sent, 0)
})

// H-03：路径在某个提供者的结果里缺失/不是数字，是**那一家**的失败，不能拖垮整次调用。
// A path missing (or non-numeric) in ONE provider's result is that provider's failure, not the caller's.
test('H-03: a provider whose result lacks the compared path is `failed`, the rest still reach quorum', async () => {
  set({ price: 100 }, { price: 100 }, { other: 1 })
  const r = await api.callQuorum(three(), 'read', {}, { quorum: 2, compare: { relTolBps: 100, paths: ['price'] } })
  assert.equal(r.agreed.length, 2); assert.deepEqual(r.disagreed, [])
  assert.equal(r.failed.length, 1); assert.equal(r.failed[0].code, 'COMPARE_PATH_INVALID')
  assert.equal(r.failed[0].container.toLowerCase(), containers[2])
  // 所有人都缺该路径 -> QUORUM_FAILED，理由在 failed 里，而不是 BAD_REQUEST / all missing -> QUORUM_FAILED with reasons
  await assert.rejects(api.callQuorum(three(), 'read', {}, { quorum: 2, compare: { relTolBps: 100, paths: ['nope'] } }),
    (e) => e.code === 'QUORUM_FAILED' && e.failed.length === 3 && e.failed.every((f) => f.code === 'COMPARE_PATH_INVALID'))
})

// H-01：桶必须是容差关系下的团 / a bucket must be a clique under the tolerance relation.
test('H-01: a middling malicious answer cannot glue two honest providers that disagree', async () => {
  // 诚实 A=100 与 B=102 相差 1.96% > 1%，本不该一致；恶意 M=101 与两者都在 1% 内。
  // honest A=100 and B=102 are 1.96% apart (outside 1%); malicious M=101 is within 1% of both.
  const compare = { relTolBps: 100, paths: ['price'] }
  set({ price: 101 }, { price: 100 }, { price: 102 })   // M 排在最前，最容易成为桶代表 / M first: the worst case
  await assert.rejects(api.callQuorum(three(), 'read', {}, { quorum: 2, compare }),
    (e) => e.code === 'QUORUM_FAILED' && /rejects on any disagreement/.test(e.message))
  // 降级模式下也不会出现"三家一致"的假象：M 与 A 成团（0.99%），B 与 A 不在容差内只能另起一桶。
  // Not even the weaker mode sees a 3-way agreement: M+A form the only clique, B cannot join it.
  const q = await api.callQuorum(three(), 'read', {}, { quorum: 2, compare, onDissent: 'quorum' })
  assert.equal(q.agreed.length, 2, 'a bridged 3-way agreement must be impossible')
  assert.deepEqual(q.agreed.map((a) => a.toLowerCase()), [containers[0], containers[1]])
  assert.deepEqual(q.disagreed.map((a) => a.toLowerCase()), [containers[2]])
  // 团不变式：被接受的桶里任意两个成员都在容差内 / clique invariant on an accepted bucket
  set({ price: 100 }, { price: 100.5 }, { price: 100.9 })  // 两两最大相差 0.89% < 1% / pairwise max 0.89%
  const ok = await api.callQuorum(three(), 'read', {}, { quorum: 3, compare })
  assert.equal(ok.agreed.length, 3)
})

// H-02：容差只放宽数值，不放宽类型 / the tolerance relaxes the value, never the type.
test('H-02: "100" and 100 never share a bucket, and only strict decimal strings count as numbers', async () => {
  const compare = { relTolBps: 0, paths: ['price'] }
  set({ price: '100' }, { price: 100 }, { price: 100 })
  const r = await api.callQuorum(three(), 'read', {}, { quorum: 2, compare, onDissent: 'quorum' })
  assert.equal(typeof r.result.price, 'number', 'the string answer must not represent the numeric bucket')
  assert.deepEqual(r.disagreed.map((a) => a.toLowerCase()), [containers[0]])
  // 0x64 / 1e2 / 带空白 / 空串都不是十进制数，属于该提供者的失败 / not decimals: that provider fails
  for (const v of ['0x64', '1e2', ' 100 ', '', 'Infinity', 'NaN', '+100']) {
    set({ price: v }, { price: 100 }, { price: 100 })
    const x = await api.callQuorum(three(), 'read', {}, { quorum: 2, compare })
    assert.equal(x.failed.length, 1, v); assert.equal(x.failed[0].code, 'COMPARE_PATH_INVALID', v)
    assert.equal(x.agreed.length, 2, v)
  }
  // 负数与小数的十进制字符串仍然可用（示例里的 meanTick / 价格）/ negative and fractional decimal strings still work
  set({ price: '-1.5' }, { price: '-1.5001' }, { price: '0' })
  const neg = await api.callQuorum(three(), 'read', {}, { quorum: 2, compare: { relTolBps: 100, paths: ['price'] }, onDissent: 'quorum' })
  assert.equal(neg.agreed.length, 2)
})

// SD-10 (owner's decision 2026-09-27): a signed revert is a statement about chain state, so it counts as disagreement;
// a signed refusal stays neutral so one provider without the block cannot veto the others.
// SD-10（2026-09-27 定）：签名的回滚是对链上状态的陈述，算作不一致；签名的拒答保持中立，没有该区块的提供者不能否决其他人。
test('FIXED SD-10: a signed revert beside agreeing results is disagreement (strict rejects), and reverts never win', async () => {
  set({ value: '0xabc' }, { value: '0xabc' }, { __revert: '0x08c379a0' })
  await assert.rejects(api.callQuorum(three(), 'read', { chainId: 1 }), (e) => e.code === 'QUORUM_FAILED' && /rejects on any disagreement/.test(e.message))
  const q = await api.callQuorum(three(), 'read', { chainId: 1 }, { onDissent: 'quorum' })
  assert.deepEqual(q.result, { value: '0xabc' }, 'quorum mode: the agreeing pair still wins')
  assert.deepEqual(q.disagreed.map((a) => a.toLowerCase()), [containers[2]], 'the reverting provider is a dissenter')
  set({ __revert: '0x01' }, { __revert: '0x01' }, { value: '0xabc' })
  await assert.rejects(api.callQuorum(three(), 'read', { chainId: 1 }, { onDissent: 'quorum' }), (e) => e.code === 'QUORUM_FAILED' && /agree the call reverts/.test(e.message), 'two colluding reverts cannot become the accepted result')
  set({ __revert: '0x01' }, { __revert: '0x01' }, { __revert: '0x01' })
  await assert.rejects(api.callQuorum(three(), 'read', { chainId: 1 }), (e) => /agree the call reverts/.test(e.message))
})
test('FIXED SD-10: a signed refusal (not a revert) stays neutral: two agreeing answers still pass in strict mode', async () => {
  set({ value: '0xabc' }, { value: '0xabc' }, { __refuse: true })
  const r = await api.callQuorum(three(), 'read', { chainId: 1 })
  assert.deepEqual(r.result, { value: '0xabc' })
  assert.equal(r.failed.length, 1); assert.equal(r.failed[0].code, 'BAD_REQUEST')
})
