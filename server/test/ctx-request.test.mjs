// @experimental: handlers see ctx.request, a frozen JSON copy of the request's top-level members
// other than method and params (id, a voucher if sent, any member TAP-13 does not define such as `grant`). Nothing the
// provider signs changes: the envelope binds (id, method, params) as before, and an unknown top-level member is ignored
// by the provider itself (tested here). @tapeapi/interop reads it.
// 处理器看到 ctx.request（method、params 之外顶层成员的冻结副本）；签名内容不变，未知顶层成员被服务端本身忽略。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProvider } from '../src/index.js'
import { sig } from '@tapeapi/sdk'
import { ADDR } from '../../sdk/test/helpers/fake-chain.mjs'

const HOLDER_KEY = '0x' + '11'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32)
const signer = sig.privateKeyToAddress(SIGNER_KEY)
const expires = Math.floor(Date.now() / 1000) + 30 * 86400
const manifest = {
  tapeapi: '0.1', name: 'Ctx', circuits: ADDR.circuits, tokenId: '4246', container: ADDR.container, signer,
  delegation: { expires, sig: sig.signDigest(sig.delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires }), HOLDER_KEY) },
  endpoints: { live: ['https://ctx.example/tapeapi/v1'], async: false },
  methods: [{ name: 'echo', priceBEM: '0', params: {}, returns: {} }],
}

test('ctx.request: the id and every top-level member but method and params, frozen; the signed envelope is the same with or without an unknown member', async () => {
  const seen = []
  const p = createProvider({ manifest, signerKey: SIGNER_KEY, rateLimit: false, log: () => {}, methods: { echo: (params, ctx) => { seen.push(ctx.request); return { ok: 1 } } } })
  const call = (body) => p.handleRequest(new Request('https://ctx.example/tapeapi/v1/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).then((r) => r.json())
  const plain = await call({ id: 'r1', method: 'echo', params: { a: 1 } })
  const extra = await call({ id: 'r1', method: 'echo', params: { a: 1 }, grant: { v: 1, nested: { x: [1] } } })
  assert.deepEqual(seen[0], { id: 'r1' })
  assert.deepEqual(seen[1], { id: 'r1', grant: { v: 1, nested: { x: [1] } } })
  assert.ok(Object.isFrozen(seen[1]) && Object.isFrozen(seen[1].grant.nested.x))
  assert.equal(plain.ok, true)
  assert.deepEqual(extra.result, plain.result)
  for (const env of [plain, extra]) assert.equal(sig.recoverResponseSigner({ container: env.container, id: env.id, method: 'echo', params: { a: 1 }, ok: true, body: env.result, ts: env.ts }, env.sig), signer)
})

// @experimental (FIXED G-3, for @tapeapi/interop): ctx.onSigned is told the envelope that is about to be sent;
// ctx.resend(env) sends again, byte for byte, an ok envelope this provider signed over this very request, and nothing else.
// ctx.onSigned 得知即将发出的信封；ctx.resend 只原样重发本服务对同一请求签过的成功信封，别的一律 INTERNAL。
test('FIXED G-3 (server hooks): ctx.onSigned sees a frozen copy of the sent envelope (not for an error, not for one too large to send); ctx.resend sends it again byte for byte; a hook that throws does not stop the answer', async () => {
  const kept = new Map(), logs = []
  let mode = 'normal'
  const echo = (params, ctx) => {
    if (mode === 'resend') return ctx.resend(kept.get(ctx.request.id))
    if (mode === 'throwing') { ctx.onSigned(() => { throw new Error('hook broke') }); return { ok: 2 } }
    ctx.onSigned((env) => { kept.set(env.id, env) })
    if (mode === 'error') throw new Error('handler failed')
    if (mode === 'big') return { blob: 'x'.repeat(1_100_000) }
    return { ok: 1, at: params }
  }
  const p = createProvider({ manifest, signerKey: SIGNER_KEY, rateLimit: false, log: (...a) => logs.push(a.join(' ')), methods: { echo } })
  const call = (body) => p.handleRequest(new Request('https://ctx.example/tapeapi/v1/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  const first = await (await call({ id: 's1', method: 'echo', params: { a: 1 } })).text()
  assert.deepEqual(kept.get('s1'), JSON.parse(first))
  assert.ok(Object.isFrozen(kept.get('s1')) && Object.isFrozen(kept.get('s1').result.at))
  mode = 'resend'
  const again = await call({ id: 's1', method: 'echo', params: { a: 1 } })
  assert.equal(again.status, 200)
  assert.equal(await again.text(), first, 'byte for byte')
  for (const m of ['error', 'big']) {
    mode = m
    const r = await (await call({ id: `e-${m}`, method: 'echo', params: {} })).json()
    assert.equal(r.ok, false)
    assert.equal(kept.has(`e-${m}`), false, `${m}: not kept`)
  }
  mode = 'throwing'
  const r = await (await call({ id: 't1', method: 'echo', params: {} })).json()
  assert.equal(r.ok, true)
  assert.ok(logs.some((l) => /ctx\.onSigned hook failed/.test(l)))
})

test('FIXED G-3 (server hooks): ctx.resend refuses (INTERNAL, generic outward) an envelope for another id or other params, a changed result or signature, an error envelope, another provider\'s, or no envelope', async () => {
  let saved = null, give = (e) => e
  const echo = (params, ctx) => { if (saved) return ctx.resend(give(saved)); ctx.onSigned((env) => { saved = env }); return { ok: 1 } }
  const p = createProvider({ manifest, signerKey: SIGNER_KEY, rateLimit: false, log: () => {}, methods: { echo } })
  const call = (body) => p.handleRequest(new Request('https://ctx.example/tapeapi/v1/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).then((r) => r.json())
  const ok = await call({ id: 'r1', method: 'echo', params: { a: 1 } })
  const copy = () => JSON.parse(JSON.stringify(saved))
  const otherKey = '0x' + '33'.repeat(32)
  const cases = [
    ['another id', () => saved, { id: 'r2', params: { a: 1 } }],
    ['other params', () => saved, { id: 'r1', params: { a: 2 } }],
    ['changed result', () => ({ ...copy(), result: { ok: 2 } }), { id: 'r1', params: { a: 1 } }],
    ['changed signature', () => ({ ...copy(), sig: sig.signResponse({ container: ok.container, id: 'r1', method: 'echo', params: { a: 1 }, ok: true, body: ok.result, ts: ok.ts }, otherKey) }), { id: 'r1', params: { a: 1 } }],
    ['an error envelope', () => ({ ...copy(), ok: false, error: { code: 'BAD_REQUEST', message: 'x' } }), { id: 'r1', params: { a: 1 } }],
    ['no envelope', () => undefined, { id: 'r1', params: { a: 1 } }],
  ]
  for (const [what, env, req] of cases) {
    give = env
    const r = await call({ id: req.id, method: 'echo', params: req.params })
    assert.equal(r.ok, false, what)
    assert.deepEqual(r.error, { code: 'INTERNAL', message: 'internal error' }, what)
  }
  give = (e) => e
  assert.equal(JSON.stringify(await call({ id: 'r1', method: 'echo', params: { a: 1 } })), JSON.stringify(ok), 'the real one still goes')
})
