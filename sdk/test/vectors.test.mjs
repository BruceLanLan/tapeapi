// 规范向量既是 SDK 的测试，也是第二个实现的自检对象 / The spec vectors test the SDK and give a second
// implementation something to check itself against. spec/vectors/verify.py is that second implementation,
// written in Python from the spec alone; `npm test` runs it here so the two can never drift apart unnoticed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { canonicalJSON, safeParseJSON, TapeAPIError } from '../src/index.js'
import { responseDigest, delegationDigest, voucherDigest, signDigest, recoverAddress, privateKeyToAddress } from '../src/sig.js'
import { toHex, keccak256, utf8ToBytes } from '../src/abi.js'

const load = (n) => JSON.parse(readFileSync(new URL(`../../spec/vectors/${n}`, import.meta.url), 'utf8'))
const k = (s) => toHex(keccak256(utf8ToBytes(s)))

test('TAP-21 §3.3 canonical JSON vectors', () => {
  const v = load('tap-21-canon.json')
  assert.ok(v.positive.length >= 10)
  for (const c of v.positive) {
    assert.equal(canonicalJSON(c.input), c.canonical, c.name)
    assert.equal(k(c.canonical), c.keccak256, c.name)
  }
  // The ordering rule the JS object model quietly broke: sorted as strings, "10" comes before "2".
  // JS 对象模型曾悄悄破坏的排序规则：按字符串排，"10" 在 "2" 之前。
  assert.equal(canonicalJSON({ 10: 1, 2: 1, 1: 1 }), '{"1":1,"10":1,"2":1}')
  for (const c of v.negative) {
    if (c.text !== undefined) {
      assert.throws(() => safeParseJSON(c.text), (e) => e instanceof TapeAPIError && e.code === c.expect, c.name)
    } else if (c.value !== undefined) {
      assert.throws(() => canonicalJSON({ v: c.value }), (e) => e.code === c.expect, c.name)
    }
  }
})

test('TAP-21 §3.2 envelope digest vectors, including every intermediate hash', () => {
  const v = load('tap-21-envelope.json')
  assert.equal(privateKeyToAddress(v.signerKey), v.signerAddress)
  for (const c of v.cases) {
    const i = c.intermediate
    assert.equal(canonicalJSON({ method: c.method, params: c.params }), i.canonicalRequest, c.name)
    assert.equal(k(c.id), i.keccakId, c.name)
    assert.equal(k(i.canonicalRequest), i.keccakRequest, c.name)
    assert.equal(canonicalJSON(c.body), i.canonicalBody, c.name)
    assert.equal(k(i.canonicalBody), i.keccakBody, c.name)
    const d = responseDigest({ container: v.container, id: c.id, method: c.method, params: c.params, ok: c.ok, body: c.body, ts: c.ts })
    assert.equal(toHex(d), c.digest, c.name)
    assert.equal(signDigest(d, v.signerKey), c.sig, c.name)
    assert.equal(recoverAddress(d, c.sig).toLowerCase(), c.recoversTo.toLowerCase(), c.name)
  }
  // ok is inside the digest, so a signed error cannot be relabelled as a success / ok 在摘要里，签过名的错误无法被改标成成功
  const e = v.cases.find((c) => c.ok === false)
  const flipped = responseDigest({ container: v.container, id: e.id, method: e.method, params: e.params, ok: true, body: e.body, ts: e.ts })
  assert.notEqual(toHex(flipped), e.digest)
})

test('TAP-20 §3.4 delegation and TAP-22 §3.1 voucher digest vectors', () => {
  const d = load('tap-20-delegation.json')
  for (const c of d.cases) {
    const digest = delegationDigest(d.domain.chainId, d.domain.verifyingContract, c)
    assert.equal(toHex(digest), c.digest, c.name)
    assert.equal(recoverAddress(digest, c.sig).toLowerCase(), d.holderAddress.toLowerCase(), c.name)
  }
  const v = load('tap-22-voucher.json')
  for (const c of v.cases) {
    const digest = voucherDigest(v.domain.chainId, v.domain.verifyingContract, c)
    assert.equal(toHex(digest), c.digest, c.name)
    assert.equal(recoverAddress(digest, c.sig).toLowerCase(), v.consumerAddress.toLowerCase(), c.name)
  }
  // the same figures on another channel must not produce the same digest / 同样的数字换一条通道必须是不同的摘要
  assert.notEqual(v.cases[0].digest, v.cases[2].digest)
})

test('an independent Python implementation, written from the spec alone, agrees', () => {
  // If this fails, the specification is ambiguous: two honest implementers read it and disagreed.
  // 这条失败意味着规范有歧义：两个诚实的实现者读了它却得出不同结果。
  // fileURLToPath, not .pathname: a path containing a space arrives percent-encoded otherwise.
  // 用 fileURLToPath 而不是 .pathname：带空格的路径会被百分号编码。
  const out = execFileSync('python3', [fileURLToPath(new URL('../../spec/vectors/verify.py', import.meta.url))], { encoding: 'utf8' })
  assert.match(out, /^ok: \d+ checks/, out)
})

test('TAP-26 channel vectors: the real handshake, driven with the fixed secrets, reproduces every value', async () => {
  const { channel } = await import('../src/index.js')
  const v = load('tap-26-channel.json')
  const hx = (h) => channel.fromHex(h)
  // A random source that replays the vector's secrets in the order createInvite / acceptInvite draw them.
  // 按 createInvite / acceptInvite 的抽取顺序回放向量中的秘密值。
  const replay = (...chunks) => { let i = 0; return (n) => { const c = chunks[i++]; assert.equal(c.length, n); return c } }
  const A = { container: v.initiator.container, chainId: v.initiator.chainId }
  const B = { container: v.responder.container, chainId: v.responder.chainId }
  const { invite, pending } = channel.createInvite({
    self: { ...A, staticSecret: hx(v.initiator.staticSecret) }, peer: { ...B, staticPublic: v.responder.staticPublic },
    relays: v.invite.relays, ttlS: v.invite.exp - 1789000000, now: 1789000000,
    random: replay(hx(v.invite.cid), hx(v.initiator.ephemeralSecret)),
  })
  assert.deepEqual(invite, v.invite)
  const { accept, session: bob } = channel.acceptInvite({
    self: { ...B, staticSecret: hx(v.responder.staticSecret) }, peer: { ...A, staticPublic: v.initiator.staticPublic },
    invite, now: 1789000000, random: replay(hx(v.responder.ephemeralSecret)),
  })
  assert.deepEqual(accept, v.accept)
  const { ready, session: alice } = channel.completeInvite(pending, accept, { now: 1789000000 })
  assert.deepEqual(ready, v.ready)
  bob.confirm(ready, { now: 1789000000 })
  assert.equal(alice.transcript, v.intermediate.transcript)
  for (const f of v.frames) {
    const [from, to] = f.from === 'initiator' ? [alice, bob] : [bob, alice]
    assert.equal(channel.toHex(from.seal(f.plaintext)), f.frame, `frame ${JSON.stringify(f.plaintext)}`)
    assert.equal(to.open(hx(f.frame), { text: true }).data, f.plaintext)
  }
})
