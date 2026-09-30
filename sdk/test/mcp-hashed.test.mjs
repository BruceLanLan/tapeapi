// Hash-only MCP receipts and verify links (the 2026 Q4 plan, privacy item 4 of the "do now" list): the TAPI-21 digest
// rebuilt from its two inner hashes is the same 32 bytes, so a receipt that carries only those hashes still verifies;
// verifyLink carries that form by default and the full receipt only when asked; low-entropy params stay guessable from
// their hash, which is said and shown here. The signed envelope and the digest are unchanged. No network.
// 只带哈希的 MCP 回执与核验链接：由两个内层哈希重建的 TAPI-21 摘要与原摘要逐字节相同，所以只带这两个哈希的回执仍能核验；
// verifyLink 默认放这种形态，要求时才放完整回执；低熵参数仍可从哈希猜出，这里写明并演示。签名信封与摘要都不变。不联网。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { receiptOf, hashReceipt, verifyLink, toolResultOf, fromBase64Url, VERIFY_BASE } from '../src/mcp.js'
import { signResponse, responseDigest, responseDigestFromHashes, responseRequestHash, responseBodyHash, recoverResponseSignerFromHashes, recoverResponseSigner, privateKeyToAddress } from '../src/sig.js'
import { bytesToHex } from '../src/abi.js'

const KEY = '0x' + '42'.repeat(32)
const SIGNER = privateKeyToAddress(KEY)
const CIRCUITS = '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414', CONTAINER = '0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8'
const vectors = JSON.parse(readFileSync(new URL('../../spec/vectors/tapi-21-envelope.json', import.meta.url), 'utf8'))

function signed({ method = 'balance', params = { address: '0x086bFB1908B1DF8C0c4412f28E4DD22Bdd52d715' }, ok = true, body = { balance: '12.5' }, id = 'mcp-1', ts = 1790000000 } = {}) {
  const env = { id, ok, container: CONTAINER, ts, ...(ok ? { result: body } : { error: body }), block: 7 }
  env.sig = signResponse({ container: CONTAINER, id, method, params, ok, body, ts }, KEY)
  return receiptOf({ envelope: env, method, params, circuits: CIRCUITS, tokenId: '11', name: '11.1013.tape' })
}
const hashedEnv = (h) => ({ container: h.service.container, id: h.id, requestHash: h.requestHash, ok: h.ok, bodyHash: h.bodyHash, ts: h.ts })

test('the digest rebuilt from the two inner hashes is byte for byte the TAPI-21 digest (every published envelope vector too)', () => {
  const cases = [
    { container: CONTAINER, id: 'x', method: 'm', params: {}, ok: true, body: null, ts: 0 },
    { container: CONTAINER, id: 'ünïcödé', method: 'bnbUsd', params: { a: [1, 2, { b: 'c' }] }, ok: false, body: { code: 'BAD_REQUEST', message: 'no' }, ts: 2 ** 40 },
  ]
  // The published vectors: their intermediate keccakRequest and keccakBody are exactly the two hashes, and the digest
  // rebuilt from those intermediates is the published digest. / 已发布向量：中间值正是这两个哈希，由它们重建的摘要即已发布摘要。
  assert.ok(vectors.cases.length >= 4)
  for (const v of vectors.cases) {
    assert.equal(responseRequestHash({ method: v.method, params: v.params }), v.intermediate.keccakRequest, v.name)
    assert.equal(responseBodyHash(v.body), v.intermediate.keccakBody, v.name)
    assert.equal('0x' + bytesToHex(responseDigestFromHashes({ container: vectors.container, id: v.id, requestHash: v.intermediate.keccakRequest, ok: v.ok, bodyHash: v.intermediate.keccakBody, ts: v.ts })), v.digest, v.name)
    cases.push({ container: vectors.container, id: v.id, method: v.method, params: v.params, ok: v.ok, body: v.body, ts: v.ts })
  }
  for (const c of cases) {
    const a = responseDigest(c)
    const b = responseDigestFromHashes({ container: c.container, id: c.id, requestHash: responseRequestHash(c), ok: c.ok, bodyHash: responseBodyHash(c.body), ts: c.ts })
    assert.equal(bytesToHex(b), bytesToHex(a))
  }
  assert.throws(() => responseDigestFromHashes({ container: CONTAINER, id: 'x', requestHash: '0x' + 'AB'.repeat(32), ok: true, bodyHash: '0x' + '00'.repeat(32), ts: 1 }), /requestHash/)
  assert.throws(() => responseDigestFromHashes({ container: CONTAINER, id: 'x', requestHash: '0x' + 'ab'.repeat(32), ok: true, bodyHash: '00'.repeat(32), ts: 1 }), /bodyHash/)
})

test('hashReceipt: params and result (or error) replaced by their hashes; it recovers to the same signer; a v 2 receipt is returned as it is', () => {
  for (const r of [signed(), signed({ ok: false, body: { code: 'BAD_REQUEST', message: 'address must be 0x…' } })]) {
    const h = hashReceipt(r)
    assert.deepEqual(Object.keys(h), ['v', 'service', 'method', 'requestHash', 'id', 'ts', 'ok', 'bodyHash', 'block', 'sig'])
    assert.equal(h.v, 2); assert.equal(h.sig, r.sig); assert.deepEqual(h.service, r.service)
    assert.equal(recoverResponseSignerFromHashes(hashedEnv(h), h.sig), SIGNER)
    assert.equal(recoverResponseSigner({ container: CONTAINER, id: r.id, method: r.method, params: r.params, ok: r.ok, body: r.ok ? r.result : r.error, ts: r.ts }, r.sig), SIGNER, 'the full receipt still verifies as before')
    const text = JSON.stringify(h)
    assert.ok(!text.includes('0x086bFB1908B1DF8C0c4412f28E4DD22Bdd52d715') && !text.includes('12.5') && !text.includes('address must'), 'no params, result or error text')
    assert.equal(hashReceipt(h), h)
  }
  assert.throws(() => hashReceipt(null), /object/)
})

test('verifyLink: hashes only by default, the whole receipt with { content: true }; toolResultOf says which', () => {
  const r = signed()
  const payload = (link) => JSON.parse(fromBase64Url(link.split('#r=')[1]))
  assert.ok(verifyLink(r).startsWith(VERIFY_BASE + '#r='))
  assert.deepEqual(payload(verifyLink(r)), hashReceipt(r))
  assert.deepEqual(payload(verifyLink(r, 'https://self.example/verify/', { content: true })), r)
  assert.ok(verifyLink(r, 'https://self.example/verify/').startsWith('https://self.example/verify/#r='), 'a self-hosted page works the same')
  assert.deepEqual(payload(verifyLink(hashReceipt(r), VERIFY_BASE, { content: true })), hashReceipt(r), 'a hash-only receipt cannot be turned back')
  const def = toolResultOf({ receipt: r, checkedBy: 'client', signer: SIGNER })
  assert.match(def.content[1].text, /Verify: \S+ \(The link carries hashes only, not the params or result\.\)$/)
  assert.deepEqual(def._meta['fun.tapeapi/receipt'], r, 'the receipt in _meta (for the caller) is the whole one')
  const full = toolResultOf({ receipt: r, checkedBy: 'client', signer: SIGNER, linkContent: true })
  assert.match(full.content[1].text, /\(The link contains this call's params and result\.\)$/)
  assert.deepEqual(payload(/Verify: (\S+)/.exec(full.content[1].text)[1]), r)
})

test('CONFIRMED (documented limit): low-entropy params are still guessable from requestHash, so hashes protect only what cannot be enumerated', () => {
  // A token-id lookup: 4,400 circuits of processor #0 are a small set; hashing each candidate finds the one asked.
  // 查 token id：处理器 #0 的 4,400 枚电路是个小集合；对每个候选取哈希就能找出被问的那一个。
  const h = hashReceipt(signed({ method: 'ownerOf', params: { circuits: CIRCUITS, tokenId: '1234' }, body: { holder: '0x0000000000000000000000000000000000000001' } }))
  let found = null
  for (let i = 0; i < 4400 && !found; i++) if (responseRequestHash({ method: 'ownerOf', params: { circuits: CIRCUITS, tokenId: String(i) } }) === h.requestHash) found = String(i)
  assert.equal(found, '1234')
  const doc = readFileSync(new URL('../src/mcp.js', import.meta.url), 'utf8')
  assert.match(doc, /params from a small set \(an address, a token id, a[\s\S]{0,12}price pair\) can be confirmed by hashing candidates/)
})
