// TAP-23 §6 vectors (spec/vectors/tap-23-attested.json): two providers signed with TEST keys answer one attested read.
// The recorded envelopes are replayed, byte for byte, through the SDK's real callQuorum: the agreeing cases are accepted,
// every counterexample is ATTEST_DISAGREE. spec/vectors/verify.py checks the same file independently.
// TAP-23 §6 向量：两个用**测试密钥**签名的提供者回答同一次见证读取。录好的信封逐字节回放给 SDK 真正的 callQuorum：
// 一致的用例被接受，每个反例都是 ATTEST_DISAGREE。spec/vectors/verify.py 独立核对同一个文件。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createTapeAPI } from '../src/index.js'
import { privateKeyToAddress, recoverResponseSigner } from '../src/sig.js'

const v = JSON.parse(readFileSync(new URL('../../spec/vectors/tap-23-attested.json', import.meta.url), 'utf8'))
const manifestOf = (p) => ({
  tapeapi: '0.1', name: `TAP-23 vector provider ${p.tag}`,
  circuits: '0x0000000000000000000000000000000000000c1c', tokenId: p.tag === 'A' ? '1' : '2',
  container: p.container, signer: p.signerAddress,
  endpoints: { live: [p.endpoint], async: false },
  methods: [v.descriptor],
  payment: { escrow: null, unit: 'BEM', decimals: 8 },
})

// Replays the recorded envelope of the provider behind the URL; checks the request is the vector's, byte for byte.
// 回放 URL 背后那个提供者录好的信封；并核对请求就是向量里的那一个。
const replay = (c) => async (url, init) => {
  const body = JSON.parse(init.body)
  assert.deepEqual({ id: body.id, method: body.method, params: body.params }, v.request)
  const side = url.startsWith(v.providers[0].endpoint) ? c.a : url.startsWith(v.providers[1].endpoint) ? c.b : null
  assert.ok(side, `unexpected url ${url}`)
  return new Response(JSON.stringify(side.envelope), { status: 200, headers: { 'content-type': 'application/json' } })
}
const run = async (c) => {
  // The envelopes carry a fixed ts from 2026; a wide skew window lets them verify today. / 信封的 ts 固定，放宽时间窗才能验证。
  const api = createTapeAPI({ chainId: 56, dev: true, maxSkewS: 1e12, fetch: replay(c) })
  const services = [await api.resolve({ dev: manifestOf(v.providers[0]) }), await api.resolve({ dev: manifestOf(v.providers[1]) })]
  return api.callQuorum(services, v.request.method, v.request.params, { id: v.request.id })
}

test('TAP-23 vectors: the providers are two TEST keys, two containers and two origins', () => {
  assert.match(v.testKeys, /TEST KEYS/)
  const [a, b] = v.providers
  for (const p of v.providers) assert.equal(privateKeyToAddress(p.signerKey), p.signerAddress)
  assert.notEqual(a.container.toLowerCase(), b.container.toLowerCase())
  assert.notEqual(a.signerAddress, b.signerAddress)
  assert.notEqual(new URL(a.endpoint).origin, new URL(b.endpoint).origin)
  assert.deepEqual(v.descriptor.attestedRead, { kind: 'eth_call', chains: [1] })
})

test('TAP-23 vectors: every envelope recovers to its provider over the vector request (TAP-21 §3.3)', () => {
  for (const c of v.cases) {
    for (const [side, p] of [[c.a, v.providers[0]], [c.b, v.providers[1]]]) {
      const e = side.envelope
      assert.equal(e.id, v.request.id)
      assert.equal(recoverResponseSigner({ container: p.container, id: v.request.id, method: v.request.method, params: v.request.params, ok: true, body: e.result, ts: e.ts }, e.sig), p.signerAddress, c.name)
      assert.equal(side.recoversTo, p.signerAddress, c.name)
      // §3.3: exactly the profile's fields, and the echoed chain and block / 恰好是轮廓的字段，回显链与区块
      for (const k of Object.keys(e.result)) assert.ok(['chainId', 'blockNumber', 'blockHash', 'stateRoot', 'blockRef', 'result'].includes(k), k)
      assert.equal(e.result.chainId, v.request.params.chainId)
      assert.equal(e.result.blockNumber, v.request.params.block)
    }
  }
})

test('TAP-23 vectors: callQuorum accepts the agreeing pairs and rejects each counterexample with ATTEST_DISAGREE', async () => {
  assert.ok(v.cases.filter((c) => c.expect === 'agree').length >= 1)
  assert.ok(v.cases.filter((c) => c.expect === 'ATTEST_DISAGREE').length >= 1)
  for (const c of v.cases) {
    if (c.expect === 'agree') {
      const r = await run(c)
      assert.equal(r.verified, true, c.name)
      assert.equal(r.agreed.length, 2, c.name)
      assert.deepEqual(r.disagreed, [], c.name)
      assert.equal(r.result.result, v.ethereum.result, c.name)
      assert.equal(r.result.blockHash, v.ethereum.blockHash, c.name)
    } else {
      await assert.rejects(run(c), (e) => { assert.equal(e.code, c.expect, c.name); return true })
    }
  }
})

test('TAP-23 vectors: an envelope moved to the other provider no longer verifies (the container is in the digest)', async () => {
  const c = v.cases[0]
  const swapped = { ...c, b: { ...c.b, envelope: { ...c.a.envelope, container: v.providers[1].container } } }
  await assert.rejects(run(swapped), (e) => e.code === 'QUORUM_FAILED' && e.failed.some((f) => f.code === 'BAD_SIGNATURE'))
})
